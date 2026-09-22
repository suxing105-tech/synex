"""system folder（watch dir 子目录自动镜像）相关测试。"""
from __future__ import annotations

from pathlib import Path

import pytest

from app import repository
from app.db import get_pool, init_pool
from app.indexer import Indexer

from .conftest import make_png


# ---------- helpers ----------


def _reset_folders_table():
    """每个测试用一套干净的 folders / image_folders 状态。"""
    conn = get_pool().main()
    conn.execute("DELETE FROM image_folders")
    conn.execute("DELETE FROM folders WHERE name != '灵感' AND name != '草稿'")


# ---------- migrate_system_folders 幂等 ----------


def test_migrate_system_folders_idempotent(tmp_data_dir):
    """二次调用不应抛错；旧库补齐 is_system / path 列。"""
    init_pool()
    conn = get_pool().main()
    # 模拟"已有库"的形态：去掉列
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(folders)").fetchall()}
    if "is_system" in cols:
        # SQLite ALTER TABLE DROP COLUMN 限制较大；不模拟退回，直接验证幂等
        from app.db import migrate_system_folders

        migrate_system_folders(conn)
        migrate_system_folders(conn)
        migrate_system_folders(conn)
    cols_after = {r["name"] for r in conn.execute("PRAGMA table_info(folders)").fetchall()}
    assert "is_system" in cols_after
    assert "path" in cols_after
    # 索引存在
    idx = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index'").fetchall()}
    assert "idx_folders_path" in idx


# ---------- ensure_system_folder_chain ----------


def test_ensure_system_folder_chain_nested(tmp_data_dir):
    """多级嵌套子目录自动建立 chain。"""
    init_pool()
    watch = tmp_data_dir / "watch"
    watch.mkdir()
    a = watch / "krea2"
    a.mkdir()
    b = a / "foo"
    b.mkdir()
    c = b / "bar.png"
    c.write_bytes(b"x")  # 占位

    folder_id = repository.ensure_system_folder_chain(c, watch)
    assert folder_id is not None

    # 三层：krea2 / foo / bar -> 各自应有一个 system folder 记录
    rows = repository.folder_tree()
    flat = []
    def walk(nodes):
        for n in nodes:
            flat.append(n)
            walk(n["children"])
    walk(rows)
    names = {n["name"] for n in flat if n["is_system"]}
    assert names == {"krea2", "foo"}
    # chain 顺序：krea2 是根（parent_id=None），foo 的 parent 是 krea2
    krea2 = next(n for n in flat if n["name"] == "krea2" and n["is_system"])
    foo = next(n for n in flat if n["name"] == "foo" and n["is_system"])
    assert krea2["parent_id"] is None
    assert foo["parent_id"] == krea2["id"]


def test_ensure_system_folder_chain_idempotent(tmp_data_dir):
    """同一路径重复调用不会重建。"""
    init_pool()
    watch = tmp_data_dir / "watch"
    watch.mkdir()
    (watch / "sub").mkdir()
    f = watch / "sub" / "img.png"
    f.write_bytes(b"x")

    fid1 = repository.ensure_system_folder_chain(f, watch)
    fid2 = repository.ensure_system_folder_chain(f, watch)
    assert fid1 == fid2

    rows = repository.folder_tree()
    system_rows = [n for n in rows if n["is_system"]]
    assert len(system_rows) == 1  # 只一个根 system folder
    assert system_rows[0]["name"] == "sub"


def test_ensure_system_folder_chain_top_level_returns_none(tmp_data_dir):
    """文件直接放在 watch root 下 → 返回 None（不属于任何 system folder）。"""
    init_pool()
    watch = tmp_data_dir / "watch"
    watch.mkdir()
    f = watch / "img.png"
    f.write_bytes(b"x")
    assert repository.ensure_system_folder_chain(f, watch) is None


def test_ensure_system_folder_chain_outside_watch_returns_none(tmp_data_dir):
    """文件不在 watch root 下 → 返回 None。"""
    init_pool()
    watch = tmp_data_dir / "watch"
    watch.mkdir()
    other = tmp_data_dir / "other"
    other.mkdir()
    f = other / "img.png"
    f.write_bytes(b"x")
    assert repository.ensure_system_folder_chain(f, watch) is None


# ---------- find_watch_root ----------


def test_find_watch_root_returns_deepest_match(tmp_data_dir):
    """多个嵌套 watch root 时选最深那个。"""
    init_pool()
    outer = (tmp_path := tmp_data_dir) / "outer"
    inner = outer / "inner"
    outer.mkdir()
    inner.mkdir()
    f = inner / "img.png"
    f.write_bytes(b"x")
    result = repository.find_watch_root(f, [outer, inner])
    assert result is not None
    assert result.resolve() == inner.resolve()


# ---------- get_folder_descendants ----------


def test_get_folder_descendants_includes_self_and_children(tmp_data_dir):
    init_pool()
    a = repository.folder_create("A", None)["id"]
    b = repository.folder_create("B", a)
    c = repository.folder_create("C", b["id"])
    ids = repository.get_folder_descendants(a)
    assert set(ids) == {a, b["id"], c["id"]}


# ---------- is_system_folder ----------


def test_is_system_folder(tmp_data_dir):
    init_pool()
    folder = repository.folder_create("user-folder", None)
    assert repository.is_system_folder(folder["id"]) is False
    conn = get_pool().main()
    conn.execute("UPDATE folders SET is_system = 1 WHERE id = ?", (folder["id"],))
    assert repository.is_system_folder(folder["id"]) is True


# ---------- backfill_system_folders ----------


def test_backfill_attach_existing_images_to_system_folders(tmp_data_dir, monkeypatch):
    """先索引若干图片到 watch root 的子目录，再 backfill，应把它们挂到对应 system folder。"""
    init_pool()
    watch = tmp_data_dir / "watch"
    watch.mkdir()
    (watch / "krea2").mkdir()
    (watch / "Audio").mkdir()
    p1 = watch / "krea2" / "a.png"
    p2 = watch / "krea2" / "b.png"
    p3 = watch / "Audio" / "c.png"
    for p in (p1, p2, p3):
        make_png(p)

    idx = Indexer()
    for p in (p1, p2, p3):
        idx._process_path_sync(p)

    # backfill 前应没有 system folder 关联
    conn = get_pool().main()
    n_before = conn.execute(
        "SELECT COUNT(*) AS c FROM image_folders if_ "
        "JOIN folders f ON f.id = if_.folder_id WHERE f.is_system = 1"
    ).fetchone()["c"]
    assert n_before == 0

    added = repository.backfill_system_folders([watch])
    assert added == 3

    # krea2 下 2 张、Audio 下 1 张
    tree = repository.folder_tree()
    flat = []
    def walk(nodes):
        for n in nodes:
            flat.append(n)
            walk(n["children"])
    walk(tree)
    sys_nodes = {n["name"]: n for n in flat if n["is_system"]}
    assert "krea2" in sys_nodes
    assert "Audio" in sys_nodes
    assert sys_nodes["krea2"]["image_count"] == 2
    assert sys_nodes["Audio"]["image_count"] == 1


def test_backfill_skips_outside_watch(tmp_data_dir):
    """不在 watch root 下的图片不会被 backfill；watch 顶层图片也不会。"""
    init_pool()
    watch = tmp_data_dir / "watch"
    watch.mkdir()
    (watch / "krea2").mkdir()
    other = tmp_data_dir / "other"
    other.mkdir()
    p_in_subdir = watch / "krea2" / "in.png"
    p_in_other = other / "out.png"
    for p in (p_in_subdir, p_in_other):
        make_png(p)
    idx = Indexer()
    for p in (p_in_subdir, p_in_other):
        idx._process_path_sync(p)

    added = repository.backfill_system_folders([watch])
    assert added == 1  # 只挂 watch/krea2/in.png


# ---------- indexer 自动挂 system folder ----------


def test_indexer_auto_assigns_system_folder_on_process(tmp_data_dir):
    """_process_path_sync 在 watch root 子目录的图片上应自动挂 system folder。"""
    init_pool()
    watch = tmp_data_dir / "watch"
    watch.mkdir()
    (watch / "krea2").mkdir()
    p = watch / "krea2" / "x.png"
    make_png(p)
    idx = Indexer()
    idx._watch_roots = [watch]  # 直接覆盖，避免从 cfg 加载
    payload = idx._process_path_sync(p)
    assert payload is not None

    conn = get_pool().main()
    sys_folders = conn.execute(
        "SELECT f.name, if_.image_id FROM image_folders if_ "
        "JOIN folders f ON f.id = if_.folder_id WHERE f.is_system = 1"
    ).fetchall()
    assert len(sys_folders) == 1
    assert sys_folders[0]["name"] == "krea2"
    assert sys_folders[0]["image_id"] == payload["id"]


def test_indexer_auto_assign_skipped_for_top_level(tmp_data_dir):
    """图片直接在 watch root 下（无子目录）→ 不挂 system folder。"""
    init_pool()
    watch = tmp_data_dir / "watch"
    watch.mkdir()
    p = watch / "top.png"
    make_png(p)
    idx = Indexer()
    idx._watch_roots = [watch]
    idx._process_path_sync(p)

    conn = get_pool().main()
    n = conn.execute(
        "SELECT COUNT(*) AS c FROM image_folders if_ "
        "JOIN folders f ON f.id = if_.folder_id WHERE f.is_system = 1"
    ).fetchone()["c"]
    assert n == 0


def test_indexer_auto_assign_preserves_user_assignment(tmp_data_dir):
    """如果图已被用户挂到 user folder，再次 _process_path_sync 不会把它移到 system folder。"""
    init_pool()
    watch = tmp_data_dir / "watch"
    watch.mkdir()
    (watch / "krea2").mkdir()
    p = watch / "krea2" / "x.png"
    make_png(p)
    idx = Indexer()
    idx._watch_roots = [watch]
    payload = idx._process_path_sync(p)
    image_id = payload["id"]

    # 模拟用户把图手动移到 user folder
    user_folder = repository.folder_create("我的精选", None)
    repository.assign_folder(image_id, user_folder["id"])

    # 再跑一次 process，user folder 关联不应被覆盖
    idx._process_path_sync(p)
    conn = get_pool().main()
    folders = conn.execute(
        "SELECT f.is_system, f.name FROM image_folders if_ "
        "JOIN folders f ON f.id = if_.folder_id WHERE if_.image_id = ?",
        (image_id,),
    ).fetchall()
    flags = sorted((bool(r["is_system"]), r["name"]) for r in folders)
    # 同时有 user folder + system folder（之前的实现是先挂 system，再 assign user；
    # 我们的实现是：已有 system folder 关联则跳过自动挂）
    sys_names = [r["name"] for r in folders if r["is_system"]]
    user_names = [r["name"] for r in folders if not r["is_system"]]
    assert "我的精选" in user_names


# ---------- API 校验 ----------


def test_api_patch_system_folder_updates_display_name(tmp_data_dir):
    """PATCH system folder 只修改显示名称，保留磁盘路径。"""
    from fastapi.testclient import TestClient

    from app.main import app
    from app.db import init_pool as _ip

    init_pool()
    client = TestClient(app)
    # 直接往 DB 插一个 system folder 记录
    conn = get_pool().main()
    cur = conn.execute(
        "INSERT INTO folders(parent_id, name, \"order\", is_system, path) "
        "VALUES(NULL, 'krea2', 0, 1, 'D:/watch/krea2')"
    )
    fid = cur.lastrowid

    r = client.patch(f"/api/folders/{fid}", json={"name": "新名字"})
    assert r.status_code == 200
    assert r.json()["name"] == "新名字"
    assert conn.execute("SELECT path FROM folders WHERE id = ?", (fid,)).fetchone()["path"] == "D:/watch/krea2"


def test_api_delete_system_folder_removes_disk_and_record(tmp_data_dir):
    """DELETE system folder（来源目录）应允许，并连同磁盘目录一并删除。"""
    from fastapi.testclient import TestClient

    from app.main import app

    init_pool()
    client = TestClient(app)
    conn = get_pool().main()
    # 造一个真实存在于磁盘的 system folder 目录
    disk_dir = tmp_data_dir / "Audio"
    disk_dir.mkdir()
    (disk_dir / "a.txt").write_text("x")
    cur = conn.execute(
        "INSERT INTO folders(parent_id, name, \"order\", is_system, path) "
        "VALUES(NULL, 'Audio', 0, 1, ?)",
        (str(disk_dir),),
    )
    fid = cur.lastrowid

    r = client.delete(f"/api/folders/{fid}")
    assert r.status_code == 200
    assert r.json().get("removed_disk") is True
    assert conn.execute("SELECT id FROM folders WHERE id = ?", (fid,)).fetchone() is None
    assert not disk_dir.exists()


def test_api_folder_tree_includes_is_system(tmp_data_dir):
    """/api/folders tree 应包含 is_system 和 path 字段。"""
    from fastapi.testclient import TestClient

    from app.main import app

    init_pool()
    client = TestClient(app)
    conn = get_pool().main()
    conn.execute(
        "INSERT INTO folders(parent_id, name, \"order\", is_system, path) "
        "VALUES(NULL, 'krea2', 0, 1, 'D:/watch/krea2')"
    )
    conn.execute(
        "INSERT INTO folders(parent_id, name, \"order\") VALUES(NULL, '我的', 0)"
    )
    r = client.get("/api/folders")
    assert r.status_code == 200
    tree = r.json()
    sys_nodes = [n for n in tree if n.get("is_system")]
    user_nodes = [n for n in tree if not n.get("is_system")]
    assert any(n["name"] == "krea2" for n in sys_nodes)
    assert any(n["name"] == "我的" for n in user_nodes)


def test_api_feed_system_folder_returns_descendant_images(tmp_data_dir):
    """GET /api/images?folder_id=<system folder> 应返回自身 + 所有后代 folder 的图。"""
    from fastapi.testclient import TestClient

    from app.main import app

    init_pool()
    watch = tmp_data_dir / "watch"
    watch.mkdir()
    (watch / "krea2").mkdir()
    (watch / "krea2" / "foo").mkdir()
    p_top = watch / "krea2" / "a.png"
    p_nested = watch / "krea2" / "foo" / "b.png"
    for p in (p_top, p_nested):
        make_png(p)
    idx = Indexer()
    idx._watch_roots = [watch]
    for p in (p_top, p_nested):
        idx._process_path_sync(p)

    client = TestClient(app)
    tree = client.get("/api/folders").json()
    krea2 = next(n for n in tree if n["is_system"] and n["name"] == "krea2")
    r = client.get(f"/api/images?folder_id={krea2['id']}")
    assert r.status_code == 200
    data = r.json()
    assert data["total"] == 2
    paths = {item["path"] for item in data["items"]}
    assert any("krea2/foo" in p for p in paths)
    assert any(p.endswith("a.png") for p in paths)





# ---------- prune_missing_system_folders ----------


def test_prune_removes_deleted_system_folder(tmp_data_dir):
    """磁盘子目录被删除后，来源目录镜像应被清理。"""
    init_pool()
    watch = tmp_data_dir / "watch"
    watch.mkdir()
    gone = watch / "gone"
    gone.mkdir()
    keep = watch / "keep"
    keep.mkdir()

    # 建立来源目录镜像
    repository.ensure_system_folder_chain(gone / ".__sentinel__", watch)
    repository.ensure_system_folder_chain(keep / ".__sentinel__", watch)

    # 删除磁盘上的 gone 子目录（keep 保留）
    gone.rmdir()

    removed = repository.prune_missing_system_folders([watch])
    assert removed == 1

    rows = repository.folder_tree()
    names = [n["name"] for n in rows if n["is_system"]]
    assert "gone" not in names
    assert "keep" in names


def test_prune_does_not_touch_user_folders(tmp_data_dir):
    """用户手动创建的文件夹（is_system=0）即使无实体目录也绝不删除。"""
    init_pool()
    watch = tmp_data_dir / "watch"
    watch.mkdir()
    repository.folder_create("我的自定义", None)  # is_system=0, path=None

    removed = repository.prune_missing_system_folders([watch])
    assert removed == 0

    rows = repository.folder_tree()
    assert any(n["name"] == "我的自定义" and not n["is_system"] for n in rows)


def test_prune_skips_offline_drive(tmp_data_dir):
    """网络/离线盘（盘符不存在）不作为删除证据，应跳过。"""
    import os
    init_pool()
    watch = tmp_data_dir / "watch"
    watch.mkdir()

    # 手工造一个 is_system=1 且 path 位于"不存在盘符"下的镜像，模拟离线盘
    conn = get_pool().main()
    conn.execute(
        "INSERT INTO folders(parent_id, name, \"order\", is_system, path) "
        "VALUES(NULL, 'netdir', 0, 1, 'Z:/nonexistent/网盘')"
    )

    removed = repository.prune_missing_system_folders([watch])
    assert removed == 0
    conn = get_pool().main()
    assert conn.execute("SELECT COUNT(*) AS c FROM folders WHERE name='netdir'").fetchone()["c"] == 1


def test_prune_deletes_descendants_and_assignments(tmp_data_dir):
    """删除父目录镜像时级联清掉后代与 image_folders 归属。"""
    init_pool()
    watch = tmp_data_dir / "watch"
    watch.mkdir()
    parent = watch / "parent"
    child = parent / "child"
    child.mkdir(parents=True)
    img = make_png(child / "a.png")
    from app.indexer import Indexer
    idx = Indexer()
    try:
        idx._watch_roots = [watch]
        idx._process_path_sync(img)
        conn = get_pool().main()
        # 确认已挂到 system folder
        assert conn.execute(
            "SELECT COUNT(*) AS c FROM image_folders"
        ).fetchone()["c"] == 1
        # 删除整条磁盘目录
        import shutil
        shutil.rmtree(parent)
        removed = repository.prune_missing_system_folders([watch])
        assert removed >= 1
        conn = get_pool().main()
        assert conn.execute("SELECT COUNT(*) AS c FROM folders WHERE is_system=1").fetchone()["c"] == 0
        assert conn.execute("SELECT COUNT(*) AS c FROM image_folders").fetchone()["c"] == 0
    finally:
        idx.shutdown()


# ---------- 来源目录：移动 / 新建（system 子目录） ----------


def test_move_system_folder_reorders_within_same_section(tmp_data_dir):
    """来源目录上移/下移仅在同类（is_system）内排序，不与用户文件夹混排。"""
    init_pool()
    sys_a = repository.folder_create("SrcA", None, is_system=True)
    sys_b = repository.folder_create("SrcB", None, is_system=True)
    user_a = repository.folder_create("UsrA", None, is_system=False)

    repository.folder_move_order(sys_a["id"], "down")

    conn = get_pool().main()
    sys_rows = conn.execute(
        'SELECT id FROM folders WHERE is_system = 1 ORDER BY "order"'
    ).fetchall()
    assert [r["id"] for r in sys_rows] == [sys_b["id"], sys_a["id"]]
    user_rows = conn.execute(
        'SELECT id FROM folders WHERE is_system = 0 ORDER BY "order"'
    ).fetchall()
    assert [r["id"] for r in user_rows] == [user_a["id"]]


def test_create_folder_under_system_parent_is_system(tmp_data_dir):
    """在来源目录下新建文件夹应创建为 system 子目录（磁盘实体）。"""
    init_pool()
    sys_parent = repository.folder_create("Src", None, is_system=True)
    parent_dir = tmp_data_dir / "Src"
    parent_dir.mkdir()
    conn = get_pool().main()
    conn.execute("UPDATE folders SET path=? WHERE id=?", (str(parent_dir), sys_parent["id"]))

    from app import folder_storage
    result = folder_storage.create_folder("Sub", sys_parent["id"])

    assert result["is_system"] == 1
    assert (parent_dir / "Sub").is_dir()
    assert result["path"] == repository._normalize_path(str((parent_dir / "Sub").resolve()))


def test_api_move_system_folder_allowed(tmp_data_dir):
    """来源目录通过 API 上移/下移应被允许。"""
    from fastapi.testclient import TestClient

    from app.main import app

    init_pool()
    client = TestClient(app)
    sys_a = repository.folder_create("SrcA", None, is_system=True)
    repository.folder_create("SrcB", None, is_system=True)

    r = client.post(f"/api/folders/{sys_a['id']}/move?direction=down")
    assert r.status_code == 200
    assert r.json()["ok"] is True
