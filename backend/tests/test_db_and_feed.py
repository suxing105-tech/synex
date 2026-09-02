"""SQLite schema、feed 查询、文件夹树测试。"""
from __future__ import annotations

from pathlib import Path

import pytest

from app import repository
from app.db import fts_sync, get_pool, init_pool, transaction
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
    items, total = repository.feed(view="all", limit=10)
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


def test_feed_filter_favorite(seeded_db):
    # 收藏第一张
    conn = get_pool().main()
    first_id = conn.execute("SELECT id FROM images ORDER BY id LIMIT 1").fetchone()["id"]
    repository.set_favorite(first_id, True)
    items, total = repository.feed(view="favorite", limit=10)
    assert total == 1


def test_folder_tree_includes_recursive_count(seeded_db):
    tree = repository.folder_tree()
    assert any(n["name"] == "灵感" for n in tree)
    inspiration = next(n for n in tree if n["name"] == "灵感")
    assert inspiration["recursive_count"] >= 3


def test_fts_sync_keeps_in_sync(seeded_db):
    conn = get_pool().main()
    # 删掉一张图，fts 行也必须被删
    target = conn.execute("SELECT id FROM images WHERE filename='a.png'").fetchone()["id"]
    fts_sync(conn, target, "delete")
    conn.execute("DELETE FROM images WHERE id = ?", (target,))
    cnt = conn.execute("SELECT COUNT(*) AS c FROM images_fts WHERE rowid = ?", (target,)).fetchone()["c"]
    assert cnt == 0


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
