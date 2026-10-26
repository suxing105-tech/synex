"""SQLite schema、feed 查询、文件夹树测试。"""
from __future__ import annotations

from pathlib import Path

import pytest

from app import repository
from app.db import ensure_fts_triggers, fts_is_healthy, get_pool, init_pool, migrate_fts, transaction
from app.indexer import Indexer

from .conftest import make_comfy_prompt, make_png


@pytest.fixture
def seeded_db(tmp_path: Path, monkeypatch):
    """5 张图的索引：3 张带 prompt，2 张空白。"""
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path))
    import importlib

    from app import config, db

    importlib.reload(config)
    importlib.reload(db)
    init_pool()
    p1 = make_png(tmp_path / "a.png", prompt=make_comfy_prompt("red cat", "ugly", seed=1))
    p2 = make_png(tmp_path / "b.png", prompt=make_comfy_prompt("blue sky", "dark", seed=2))
    p3 = make_png(tmp_path / "c.png", prompt=make_comfy_prompt("green forest", "low quality", seed=3))
    p4 = make_png(tmp_path / "d.png")
    p5 = make_png(tmp_path / "e.png")
    indexer = Indexer()
    for p in (p1, p2, p3, p4, p5):
        indexer._process_path_sync(p)
    # 创建两个文件夹并指派
    folder_a = repository.folder_create("灵感", None)
    folder_b = repository.folder_create("草稿", None)
    conn = get_pool().main()
    for img_id in [r["id"] for r in conn.execute("SELECT id FROM images ORDER BY id LIMIT 3").fetchall()]:
        repository.assign_folder(img_id, folder_a["id"])
    return tmp_path


def test_init_schema_runs_idempotently(tmp_data_dir):
    """二次执行 SCHEMA 不应抛错。"""
    init_pool()
    init_pool()
    conn = get_pool().main()
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    names = {r["name"] for r in rows}
    assert "images" in names
    assert "folders" in names
    assert "tags" in names
    assert "images_fts" in names


def test_indexer_inserts_image(seeded_db):
    conn = get_pool().main()
    n = conn.execute("SELECT COUNT(*) AS c FROM images").fetchone()["c"]
    assert n == 5
    pos = conn.execute("SELECT positive_prompt FROM images WHERE filename='a.png'").fetchone()["positive_prompt"]
    assert pos == "red cat"


def test_feed_returns_all(seeded_db):
    items, total = repository.feed(limit=10)
    assert total == 5
    assert len(items) == 5


def test_feed_search_fts(seeded_db):
    items, total = repository.feed(q="cat", limit=10)
    assert total >= 1
    assert any("cat" in (it["filename"] + it["model"] or "") or it["id"] for it in items)


def test_feed_filter_by_folder_includes_descendants(seeded_db):
    """子文件夹被删后图片应能在父文件夹下被筛到。"""
    conn = get_pool().main()
    child_id = repository.folder_create("子集", None)["id"]
    # 把父"灵感"移到子集下
    parent_id = conn.execute("SELECT id FROM folders WHERE name='灵感'").fetchone()["id"]
    repository.folder_update(parent_id, parent_id=child_id)
    items, total = repository.feed(folder_id=child_id, limit=10)
    # 应包含父文件夹的图片（递归）
    assert total >= 1


def test_feed_has_no_view_parameter(seeded_db):
    """view（收藏 / 最近生成）已从查询里去掉，只剩内容类型过滤。"""
    import inspect

    params = inspect.signature(repository.feed).parameters
    assert "view" not in params
    items, total = repository.feed(kind="image", limit=10)
    assert total == 5


def test_folder_tree_counts_by_kind(seeded_db):
    tree = repository.folder_tree()
    assert any(n["name"] == "灵感" for n in tree)
    inspiration = next(n for n in tree if n["name"] == "灵感")
    # 契约：四类键恒在（文本数由 /api/folders 填，仓储层至少给 0），total 恒等于四项之和
    assert set(inspiration["counts"]) == {"image", "video", "audio", "text"}
    assert inspiration["counts"]["image"] >= 3
    assert inspiration["counts"]["video"] == 0
    assert inspiration["counts"]["audio"] == 0
    assert inspiration["total"] == sum(inspiration["counts"].values())


def test_fts_index_is_derived_from_images(seeded_db):
    """索引由 images 上的触发器维护：删图不用手动同步，也不留已删图片的残留。

    回归背景：手写 fts_sync() 在 DELETE 之后才跑、旧值又一律写空串，把倒排表写坏了。
    """
    conn = get_pool().main()
    before = conn.execute("SELECT COUNT(*) AS c FROM images_fts").fetchone()["c"]
    target = conn.execute("SELECT id FROM images WHERE filename='a.png'").fetchone()["id"]
    conn.execute("DELETE FROM images WHERE id = ?", (target,))
    assert conn.execute("SELECT COUNT(*) AS c FROM images_fts WHERE rowid = ?", (target,)).fetchone()["c"] == 0
    assert conn.execute("SELECT COUNT(*) AS c FROM images_fts").fetchone()["c"] == before - 1
    assert conn.execute("SELECT COUNT(*) AS c FROM images_fts").fetchone()["c"] == \
        conn.execute("SELECT COUNT(*) AS c FROM images").fetchone()["c"]
    assert fts_is_healthy(conn)


def test_feed_search_filters_by_query(seeded_db):
    """搜索框输入必须真的过滤结果。曾经的故障是 /api/images?q= 直接 500，界面上毫无反应。"""
    items, total = repository.feed(q="blue")
    assert total == 1
    assert items[0]["filename"] == "b.png"
    items, total = repository.feed(q="png")
    assert total == 5
    items, total = repository.feed(q="nothingmatchesthis")
    assert total == 0


def test_feed_search_survives_broken_index(seeded_db):
    """索引不可用时搜索降级成模糊匹配，而不是整条请求失败。"""
    conn = get_pool().main()
    conn.execute("DROP TABLE images_fts")
    conn.execute("CREATE TABLE images_fts (not_an_fts_table INTEGER)")
    items, total = repository.feed(q="c.png")
    assert total == 1
    assert items[0]["filename"] == "c.png"


LEGACY_FTS = (
    "CREATE VIRTUAL TABLE images_fts USING fts5("
    "positive_prompt, negative_prompt, filename, model, "
    "content='', tokenize='unicode61 remove_diacritics 1')"
)


def test_legacy_contentless_index_is_migrated(seeded_db):
    """老库的 contentless 索引（含写坏的残留）在启动维护时换成派生索引。"""
    conn = get_pool().main()
    conn.execute("DROP TABLE images_fts")
    conn.execute(LEGACY_FTS)
    conn.execute(
        "INSERT INTO images_fts(rowid, positive_prompt, negative_prompt, filename, model) "
        "SELECT id, positive_prompt, negative_prompt, filename, COALESCE(model, '') FROM images"
    )
    # 复现线上状态：删图后索引里留着指向已删图片的残留（用户库 852 行 vs 510 张图）
    conn.execute(
        "INSERT INTO images_fts(rowid, positive_prompt, negative_prompt, filename, model) "
        "VALUES (999999, 'ghost', 'ghost', 'ghost.png', 'ghost')"
    )
    fts_rows = conn.execute("SELECT COUNT(*) AS c FROM images_fts").fetchone()["c"]
    img_rows = conn.execute("SELECT COUNT(*) AS c FROM images").fetchone()["c"]
    assert fts_rows == img_rows + 1

    assert migrate_fts(conn) == "migrated"
    ensure_fts_triggers(conn)
    assert fts_is_healthy(conn)
    assert conn.execute("SELECT COUNT(*) AS c FROM images_fts").fetchone()["c"] == \
        conn.execute("SELECT COUNT(*) AS c FROM images").fetchone()["c"]
    items, total = repository.feed(q="png")
    assert total == img_rows


def test_unusable_index_is_recreated(seeded_db):
    """索引对象本身坏了（连 rebuild 都救不了）时，删表按 images 重建。"""
    conn = get_pool().main()
    conn.execute("DROP TABLE images_fts")
    conn.execute("CREATE TABLE images_fts (not_an_fts_table INTEGER)")
    assert migrate_fts(conn) == "recreated"
    assert fts_is_healthy(conn)
    items, total = repository.feed(q="forest")
    assert total == 1

def test_tags_round_trip(seeded_db):
    img_id = get_pool().main().execute("SELECT id FROM images ORDER BY id LIMIT 1").fetchone()["id"]
    repository.set_tags(img_id, ["cat", "red", "cat"])
    detail = repository.image_detail(img_id)
    assert sorted(detail["tags"]) == ["cat", "red"]


def test_folder_move_order_swaps(tmp_data_dir):
    init_pool()
    a = repository.folder_create("A", None)
    b = repository.folder_create("B", None)
    repository.folder_move_order(a["id"], "down")
    # 现在 b 应该排在前面
    conn = get_pool().main()
    rows = conn.execute("SELECT id, \"order\" FROM folders ORDER BY \"order\"").fetchall()
    assert rows[0]["id"] == b["id"]
    assert rows[1]["id"] == a["id"]
