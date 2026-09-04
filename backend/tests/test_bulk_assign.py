"""批量 assign_folder API + repository 测试。"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app import repository
from app.db import get_pool, init_pool
from app.indexer import Indexer

from .conftest import make_png


def _seed_images(tmp_path, n: int = 5) -> list[int]:
    """创建 n 张 PNG 索引进 DB，返回 image id 列表。"""
    for i in range(n):
        make_png(tmp_path / f"img_{i}.png")
    idx = Indexer()
    ids: list[int] = []
    for i in range(n):
        payload = idx._process_path_sync(tmp_path / f"img_{i}.png")
        assert payload is not None
        ids.append(payload["id"])
    return ids


# ---------- repository.bulk_assign_folder ----------


def test_bulk_assign_folder_basic(tmp_data_dir):
    init_pool()
    f1 = repository.folder_create("灵感", None)
    f2 = repository.folder_create("草稿", None)
    bulk_ids = _seed_images(tmp_data_dir, 5)

    # 全部挂到 f1
    repository.bulk_assign_folder(bulk_ids, f1["id"])
    conn = get_pool().main()
    n = conn.execute(
        "SELECT COUNT(*) AS c FROM image_folders WHERE folder_id = ?", (f1["id"],)
    ).fetchone()["c"]
    assert n == 5

    # 把前 3 张移到 f2（替换式：先从 f1 移出再挂 f2）
    repository.bulk_assign_folder(bulk_ids[:3], f2["id"])
    f1_after = conn.execute(
        "SELECT image_id FROM image_folders WHERE folder_id = ? ORDER BY image_id",
        (f1["id"],),
    ).fetchall()
    f2_after = conn.execute(
        "SELECT image_id FROM image_folders WHERE folder_id = ? ORDER BY image_id",
        (f2["id"],),
    ).fetchall()
    assert sorted(r["image_id"] for r in f1_after) == sorted(bulk_ids[3:])
    assert sorted(r["image_id"] for r in f2_after) == sorted(bulk_ids[:3])


def test_bulk_assign_folder_none_clears_user_folders(tmp_data_dir):
    """folder_id=None → 从所有 user folder 移出（保留 system folder）。"""
    init_pool()
    f1 = repository.folder_create("灵感", None)
    ids = _seed_images(tmp_data_dir, 2)

    repository.bulk_assign_folder(ids, f1["id"])
    conn = get_pool().main()
    assert conn.execute(
        "SELECT COUNT(*) AS c FROM image_folders WHERE folder_id = ?", (f1["id"],)
    ).fetchone()["c"] == 2

    # folder_id=None：清掉 user folder 归属
    repository.bulk_assign_folder(ids, None)
    assert conn.execute(
        "SELECT COUNT(*) AS c FROM image_folders WHERE folder_id = ?", (f1["id"],)
    ).fetchone()["c"] == 0


def test_bulk_assign_folder_preserves_system_folders(tmp_data_dir):
    """用户手动移到 user folder 时，不应覆盖 watch root 自动挂的 system folder。"""
    init_pool()
    user_f = repository.folder_create("灵感", None)
    user_f2 = repository.folder_create("草稿", None)
    conn = get_pool().main()
    cur = conn.execute(
        "INSERT INTO folders(parent_id, name, \"order\", is_system, path) "
        "VALUES(NULL, 'krea2', 0, 1, 'D:/watch/krea2')"
    )
    sys_f_id = cur.lastrowid

    ids = _seed_images(tmp_data_dir, 1)
    image_id = ids[0]
    # image 同时挂 system folder（自动）和 user folder（手动）
    conn.execute(
        "INSERT INTO image_folders(image_id, folder_id) VALUES(?, ?), (?, ?)",
        (image_id, sys_f_id, image_id, user_f["id"]),
    )

    # 再 bulk assign 到另一个 user folder
    repository.bulk_assign_folder([image_id], user_f2["id"])

    rows = conn.execute(
        "SELECT f.name, f.is_system FROM image_folders if_ "
        "JOIN folders f ON f.id = if_.folder_id WHERE if_.image_id = ?",
        (image_id,),
    ).fetchall()
    names = sorted((r["name"], bool(r["is_system"])) for r in rows)
    assert ("krea2", True) in names
    assert ("草稿", False) in names
    assert ("灵感", False) not in names


def test_bulk_assign_folder_rejects_system_target(tmp_data_dir):
    """folder_id 指向 system folder 应抛 ValueError。"""
    init_pool()
    conn = get_pool().main()
    cur = conn.execute(
        "INSERT INTO folders(parent_id, name, \"order\", is_system, path) "
        "VALUES(NULL, 'krea2', 0, 1, 'D:/watch/krea2')"
    )
    sys_id = cur.lastrowid
    ids = _seed_images(tmp_data_dir, 2)

    try:
        repository.bulk_assign_folder(ids, sys_id)
    except ValueError as e:
        assert "系统" in str(e) or "system" in str(e).lower()
    else:
        raise AssertionError("expected ValueError")


def test_bulk_assign_folder_rejects_missing_folder(tmp_data_dir):
    init_pool()
    ids = _seed_images(tmp_data_dir, 2)
    try:
        repository.bulk_assign_folder(ids, 9999)
    except ValueError as e:
        assert "不存在" in str(e)
    else:
        raise AssertionError("expected ValueError")


def test_bulk_assign_folder_empty_returns_zero(tmp_data_dir):
    init_pool()
    assert repository.bulk_assign_folder([], 1) == 0
    assert repository.bulk_assign_folder([], None) == 0


# ---------- API ----------


def test_api_bulk_assign_folder(tmp_data_dir):
    """POST /api/images/bulk-assign-folder 端到端。"""
    init_pool()
    from app.main import app

    ids = _seed_images(tmp_data_dir, 3)
    folder = repository.folder_create("目标", None)
    client = TestClient(app)

    r = client.post(
        "/api/images/bulk-assign-folder",
        json={"image_ids": ids, "folder_id": folder["id"]},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert sorted(data["ids"]) == sorted(ids)
    assert data["folder_id"] == folder["id"]

    conn = get_pool().main()
    n = conn.execute(
        "SELECT COUNT(*) AS c FROM image_folders WHERE folder_id = ?", (folder["id"],)
    ).fetchone()["c"]
    assert n == 3


def test_api_bulk_assign_folder_to_none(tmp_data_dir):
    """folder_id=null → 清空 user folder 归属。"""
    init_pool()
    from app.main import app

    ids = _seed_images(tmp_data_dir, 2)
    folder = repository.folder_create("草稿", None)
    client = TestClient(app)
    client.post(
        "/api/images/bulk-assign-folder",
        json={"image_ids": ids, "folder_id": folder["id"]},
    )
    # 再清空
    r = client.post(
        "/api/images/bulk-assign-folder",
        json={"image_ids": ids, "folder_id": None},
    )
    assert r.status_code == 200, r.text
    conn = get_pool().main()
    n = conn.execute(
        "SELECT COUNT(*) AS c FROM image_folders WHERE folder_id = ?", (folder["id"],)
    ).fetchone()["c"]
    assert n == 0


def test_api_bulk_assign_folder_rejects_empty_ids(tmp_data_dir):
    init_pool()
    from app.main import app

    client = TestClient(app)
    r = client.post("/api/images/bulk-assign-folder", json={"image_ids": [], "folder_id": 1})
    assert r.status_code == 400


def test_api_bulk_assign_folder_rejects_system_folder(tmp_data_dir):
    init_pool()
    from app.main import app

    conn = get_pool().main()
    cur = conn.execute(
        "INSERT INTO folders(parent_id, name, \"order\", is_system, path) "
        "VALUES(NULL, 'krea2', 0, 1, 'D:/watch/krea2')"
    )
    sys_id = cur.lastrowid

    client = TestClient(app)
    r = client.post(
        "/api/images/bulk-assign-folder",
        json={"image_ids": [1], "folder_id": sys_id},
    )
    assert r.status_code == 400
    assert "系统" in r.text or "system" in r.text.lower()


def test_api_bulk_assign_folder_rejects_missing_folder(tmp_data_dir):
    init_pool()
    from app.main import app

    client = TestClient(app)
    r = client.post(
        "/api/images/bulk-assign-folder",
        json={"image_ids": [1], "folder_id": 9999},
    )
    assert r.status_code == 400


def test_api_bulk_assign_folder_filters_non_int(tmp_data_dir):
    """image_ids 里的非 int 元素应被过滤掉（不是 400）。"""
    init_pool()
    from app.main import app

    ids = _seed_images(tmp_data_dir, 1)

    folder = repository.folder_create("目标", None)
    client = TestClient(app)
    r = client.post(
        "/api/images/bulk-assign-folder",
        json={"image_ids": [ids[0], "two", 3.5, None, True], "folder_id": folder["id"]},
    )
    assert r.status_code == 200
    assert r.json()["ids"] == [ids[0]]  # 只有 ids[0] 是合法 int


def test_api_bulk_assign_folder_invalid_json_types(tmp_data_dir):
    init_pool()
    from app.main import app

    client = TestClient(app)
    # image_ids 不是 list
    r = client.post(
        "/api/images/bulk-assign-folder",
        json={"image_ids": "not a list", "folder_id": 1},
    )
    assert r.status_code == 400
    # folder_id 类型不对
    r2 = client.post(
        "/api/images/bulk-assign-folder",
        json={"image_ids": [1], "folder_id": "five"},
    )
    assert r2.status_code == 400