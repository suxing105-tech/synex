"""「所有素材」统一流：四类混排、目录前缀过滤、搜索/标签/类型过滤、排序、分页与计数。"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from app import folder_storage, repository, texts
from app.db import get_pool, init_pool
from app.indexer import Indexer

from .conftest import make_png
from .test_audio import make_audio
from .test_videos import make_video

# 固定时间戳，混排顺序才可断言（1 天 = 86400）
T_NEW_IMAGE = 500_000
T_VIDEO = 400_000
T_AUDIO = 300_000
T_NEW_TEXT = 200_000
T_OLD_IMAGE = 100_000
T_TEXT_2 = 90_000
T_TEXT_OUTSIDE = 80_000


def _touch(path: Path, mtime: float) -> Path:
    os.utime(path, (mtime, mtime))
    return path


@pytest.fixture
def mixed(tmp_path: Path, monkeypatch):
    """2 图 + 1 视频 + 1 音频 + 3 文本，其中 3 媒体与 2 文本在同一个「素材」文件夹里。"""
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path))
    import importlib

    from app import config, db

    importlib.reload(config)
    importlib.reload(db)
    init_pool()
    indexer = Indexer()
    folder = folder_storage.create_folder("素材", None)
    inside = Path(folder["path"])
    outside = tmp_path / "outside"
    outside.mkdir()

    ids: dict[str, object] = {"folder_id": folder["id"]}

    img_new = _touch(
        make_png(inside / "a-red.png", prompt={"1": {"class_type": "Other", "inputs": {}}}),
        T_NEW_IMAGE,
    )
    # 直接用带 prompt 的 PNG，让 FTS/LIKE 都能命中「红色猫」
    from .conftest import make_comfy_prompt

    img_new.unlink()
    make_png(inside / "a-red.png", prompt=make_comfy_prompt("红色猫", "低清", seed=7))
    _touch(inside / "a-red.png", T_NEW_IMAGE)
    ids["image_new"] = indexer._process_path_sync(inside / "a-red.png")["id"]

    make_video(inside / "b-clip.mp4")
    _touch(inside / "b-clip.mp4", T_VIDEO)
    ids["video"] = indexer._process_path_sync(inside / "b-clip.mp4")["id"]

    make_audio(inside / "c-tone.mp3")
    _touch(inside / "c-tone.mp3", T_AUDIO)
    ids["audio"] = indexer._process_path_sync(inside / "c-tone.mp3")["id"]

    make_png(inside / "z-old.png")
    _touch(inside / "z-old.png", T_OLD_IMAGE)
    ids["image_old"] = indexer._process_path_sync(inside / "z-old.png")["id"]

    text_new = inside / "notes.md"
    text_new.write_text("# 笔记本\n\n这里写了一只 **红色猫** 的设定。", encoding="utf-8")
    _touch(text_new, T_NEW_TEXT)
    ids["text_new"] = texts.index(text_new)["id"]

    text_second = inside / "s-second.md"
    text_second.write_text("第二篇正文。", encoding="utf-8")
    _touch(text_second, T_TEXT_2)
    ids["text_second"] = texts.index(text_second)["id"]

    text_out = outside / "x-outside.txt"
    text_out.write_text("不在这个文件夹里的文本。", encoding="utf-8")
    _touch(text_out, T_TEXT_OUTSIDE)
    ids["text_outside"] = texts.index(text_out)["id"]

    for key in ("image_new", "video", "audio"):
        repository.assign_folder(ids[key], folder["id"])
    return ids


def _uids(items):
    return [(it["item_type"], it["id"]) for it in items]


# ---------- 混排与排序 ----------


def test_unified_feed_mixes_all_four_kinds_by_time(mixed):
    items, total, counts = repository.unified_feed(limit=50)
    assert total == 7
    assert [it["kind"] for it in items] == [
        "image", "video", "audio", "text", "image", "text", "text",
    ]
    assert counts == {"image": 2, "video": 1, "audio": 1, "text": 3}
    times = [it["mtime"] for it in items]
    assert times == sorted(times, reverse=True)


def test_unified_feed_name_sort_is_case_insensitive(mixed):
    items, _total, _counts = repository.unified_feed(sort="name_asc", limit=50)
    names = [it["filename"] for it in items]
    assert names == sorted(names, key=str.casefold)
    assert names[0] == "a-red.png"


def test_unified_feed_pagination_has_no_duplicates_or_gaps(mixed):
    full, total, _counts = repository.unified_feed(limit=50)
    collected: list = []
    for offset in range(0, total, 2):
        page, _t, _c = repository.unified_feed(limit=2, offset=offset)
        assert len(page) <= 2
        collected.extend(_uids(page))
    assert collected == _uids(full)


def test_text_and_media_ids_may_collide_but_stay_distinct(mixed):
    """texts.id 与 images.id 各自自增，靠 item_type 区分。"""
    items, _total, _counts = repository.unified_feed(limit=50)
    media_ids = {it["id"] for it in items if it["item_type"] == "media"}
    text_ids = {it["id"] for it in items if it["item_type"] == "text"}
    assert media_ids & text_ids  # 确实用上了重叠的 id
    assert len(_uids(items)) == len(set(_uids(items)))


# ---------- 过滤 ----------


def test_unified_feed_kinds_filter_keeps_full_counts(mixed):
    items, total, counts = repository.unified_feed(kinds=["image"], limit=50)
    assert total == 2
    assert {it["kind"] for it in items} == {"image"}
    # chips 要知道每一类还有多少，所以 counts 不跟着 kinds 缩水
    assert counts == {"image": 2, "video": 1, "audio": 1, "text": 3}


def test_unified_feed_multiple_kinds(mixed):
    items, total, _counts = repository.unified_feed(kinds=["video", "audio", "text"], limit=50)
    assert total == 5
    assert {it["kind"] for it in items} == {"video", "audio", "text"}


def test_unified_feed_empty_kinds_falls_back_to_everything(mixed):
    items, total, _counts = repository.unified_feed(kinds=[], limit=50)
    assert total == 7


def test_unified_feed_unknown_kind_is_ignored(mixed):
    _items, total, _counts = repository.unified_feed(kinds=["image", "spaceship"], limit=50)
    assert total == 2


def test_unified_feed_folder_filter_uses_disk_prefix_for_texts(mixed):
    items, total, counts = repository.unified_feed(folder_id=mixed["folder_id"], limit=50)
    assert total == 5
    # 素材目录里有两张图，但只有 a-red.png 被归到这个文件夹
    assert counts == {"image": 1, "video": 1, "audio": 1, "text": 2}
    names = {it["filename"] for it in items}
    assert "x-outside.txt" not in names
    assert "s-second.md" in names


def test_unified_feed_search_covers_media_and_text_bodies(mixed):
    items, total, _counts = repository.unified_feed(q="红色猫", limit=50)
    assert total == 2
    assert {it["filename"] for it in items} == {"a-red.png", "notes.md"}
    text_item = next(it for it in items if it["item_type"] == "text")
    assert "红色猫" in text_item["excerpt"]


def test_unified_feed_tag_filter_covers_both_tables(mixed):
    repository.set_tags(mixed["image_new"], ["猫"])
    texts.metadata(mixed["text_new"], ["猫"])
    items, total, _counts = repository.unified_feed(tag="猫", limit=50)
    assert total == 2
    assert {it["item_type"] for it in items} == {"media", "text"}


# ---------- 文本卡数据 ----------


def test_text_feed_item_shape(mixed):
    items, _total, _counts = repository.unified_feed(kinds=["text"], limit=50)
    note = next(it for it in items if it["filename"] == "notes.md")
    assert note["item_type"] == "text"
    assert note["kind"] == "text"
    assert note["format"] == "md"
    assert note["tags"] == []
    assert note["path"]
    # Markdown 装饰不进摘录
    assert "#" not in note["excerpt"] and "**" not in note["excerpt"]


def test_missing_text_files_are_excluded(mixed):
    path = next(
        Path(r["path"])
        for r in get_pool().main().execute("SELECT path FROM texts WHERE filename='x-outside.txt'")
    )
    path.unlink()
    conn = get_pool().main()
    conn.execute("UPDATE texts SET missing=1 WHERE path=?", (str(path),))
    _items, total, counts = repository.unified_feed(limit=50)
    assert counts["text"] == 2
    assert total == 6


# ---------- 侧栏计数 ----------


def test_folder_counts_split_by_kind_and_prefix(mixed, tmp_path):
    """/api/folders 的节点带 counts 四类 + total，文本按目录前缀归到各级父目录。"""
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        tree = client.get("/api/folders").json()

    node = next(n for n in tree if n["name"] == "素材")
    assert node["counts"] == {"image": 1, "video": 1, "audio": 1, "text": 2}
    assert node["total"] == 5 == sum(node["counts"].values())
    for gone in ("image_count", "recursive_count", "text_count"):
        assert gone not in node


def test_repository_folder_tree_exposes_four_keys_and_media_totals(mixed):
    """仓储层只可能数到媒体：text 键恒在但为 0，真实文本数由 /api/folders 填。

    形状必须固定成四类 + total == 四项之和，否则侧栏这类消费者拿到 3 个键的版本会自己猜。
    """
    tree = repository.folder_tree()
    node = next(n for n in tree if n["name"] == "素材")
    assert set(node["counts"]) == {"image", "video", "audio", "text"}
    assert node["counts"]["audio"] == 1
    assert node["counts"]["text"] == 0
    assert node["total"] == sum(node["counts"].values()) == 3


# ---------- 路由 ----------


def test_items_route_shape_and_kind_param(mixed):
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        body = client.get("/api/items", params={"limit": 50}).json()
        assert body["total"] == 7
        assert body["counts"] == {"image": 2, "video": 1, "audio": 1, "text": 3}
        assert len(body["items"]) == 7
        assert body["limit"] == 50 and body["offset"] == 0

        audio_only = client.get("/api/items", params={"kinds": "audio,text"}).json()
        assert audio_only["total"] == 4
        assert {it["kind"] for it in audio_only["items"]} == {"audio", "text"}

        page = client.get("/api/items", params={"limit": 3, "offset": 3}).json()
        assert len(page["items"]) == 3

        assert client.get("/api/items", params={"limit": 501}).status_code == 422
        assert client.get("/api/items", params={"sort": "nonsense"}).status_code == 422