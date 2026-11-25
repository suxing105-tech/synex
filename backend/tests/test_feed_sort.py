"""素材流排序：/api/images 与 /api/items 两条路共用一套口径。

侧栏「全部图片 / 视频 / 音频」走 /api/images，「所有素材」和「全部文本」走 /api/items。
右键菜单里的「排序」是全站一个开关，所以这两条路的 sort 取值和排序结果必须一致——
本文件主要钉的就是这件事：只测其中一条路，另一条写错了没人知道。
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import repository
from app.db import init_pool
from app.indexer import Indexer
from app.main import app

from .conftest import make_png

# 四个名字故意和 mtime 顺序反着来，否则「按名称」与「按时间」结果相同，测不出分支有没有生效。
# 中间那张用大写 B，钉住 NOCASE：a / B / c 必须挨着，不许因为大写被甩到后面去。
# 时间戳写死，不读墙上时钟——断言要永远可重复。
T_NAME_1 = 500_000
T_NAME_2 = 400_000
T_NAME_3 = 300_000
T_LATEST = 600_000
BY_NAME = ["a-alpha.png", "B-beta.png", "c-gamma.png", "x-latest.png"]
BY_TIME = ["x-latest.png", "a-alpha.png", "B-beta.png", "c-gamma.png"]
FIXTURES = (
    ("x-latest.png", T_LATEST),
    ("a-alpha.png", T_NAME_1),
    ("B-beta.png", T_NAME_2),
    ("c-gamma.png", T_NAME_3),
)


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    """建一份干净的库并起 TestClient，四张图由用例自己按名与时间反序地索引进去。

    自带这份而不从 test_api 导：把导进来的 fixture 名再当一次形参，就是 ruff 的 F811
    （仓库里已经有三处这种欠债，基线钉着，不许再添）。
    """
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path))
    import importlib

    from app import config, db

    importlib.reload(config)
    importlib.reload(db)
    init_pool()
    with TestClient(app) as c:
        yield c


def _index(tmp_path: Path) -> None:
    indexer = Indexer()
    for name, mtime in FIXTURES:
        path = tmp_path / name
        make_png(path)
        os.utime(path, (mtime, mtime))
        indexer._process_path_sync(path)


def _names(items) -> list[str]:
    return [it["filename"] for it in items]


# ---------- repository 层 ----------


def test_media_feed_defaults_to_newest_first(client, tmp_path):
    """不带 sort 仍是「新的在前」：0.2.22 撤掉工具栏排序按钮之后的行为一分不许变。"""
    _index(tmp_path)
    items, total = repository.feed(limit=50)
    assert total == 4
    assert _names(items) == BY_TIME


def test_media_feed_name_sort_is_case_insensitive(client, tmp_path):
    _index(tmp_path)
    items, _total = repository.feed(sort="name_asc", limit=50)
    assert _names(items) == BY_NAME
    assert _names(items) == sorted(_names(items), key=str.casefold)


def test_media_feed_name_sort_is_stable_across_pages(client, tmp_path):
    """同值不许翻页换序：第二排序键定死在 id 上，否则无限滚代会重复或漏项。"""
    _index(tmp_path)
    full, total = repository.feed(sort="name_asc", limit=50)
    collected: list = []
    for offset in range(0, total, 2):
        page, _t = repository.feed(sort="name_asc", limit=2, offset=offset)
        collected.extend(_names(page))
    assert collected == _names(full)


# ---------- 路由层 ----------


def test_images_route_passes_sort_through(client, tmp_path):
    _index(tmp_path)
    default = client.get("/api/images", params={"limit": 50}).json()
    assert _names(default["items"]) == BY_TIME
    named = client.get("/api/images", params={"limit": 50, "sort": "name_asc"}).json()
    assert _names(named["items"]) == BY_NAME


def test_feed_routes_reject_unknown_sort(client):
    """取值集合写死在 pattern 上：送错值当场拒，不许静默回落成默认——静默回落就是「点了没反应」。"""
    assert client.get("/api/images", params={"sort": "name_desc"}).status_code == 422
    assert client.get("/api/items", params={"sort": "mtime_asc"}).status_code == 422


def test_both_feed_routes_sort_the_same_way(client, tmp_path):
    """两条路的媒体顺序逐条一致：排序开关全站只有一个，口径分叉就是四种口径里三种不对。"""
    _index(tmp_path)
    for sort in ("mtime_desc", "name_asc"):
        media = client.get("/api/images", params={"limit": 50, "sort": sort}).json()["items"]
        unified = client.get("/api/items", params={"limit": 50, "sort": sort}).json()["items"]
        unified_media = [it["filename"] for it in unified if it["item_type"] == "media"]
        assert unified_media == _names(media), sort