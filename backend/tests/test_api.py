"""FastAPI 路由层 smoke 测试。"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import repository
from app.db import init_pool
from app.indexer import Indexer
from app.main import app

from .conftest import make_comfy_prompt, make_png


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path))
    import importlib

    from app import config, db

    importlib.reload(config)
    importlib.reload(db)
    init_pool()
    # 不启动 lifespan（避免 watchdog 监听目录创建副作用），手动 lint + create db
    p1 = make_png(tmp_path / "x.png", prompt=make_comfy_prompt("hello world", "low quality", seed=99))
    Indexer()._process_path_sync(p1)
    with TestClient(app) as c:
        yield c


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_feed_returns_images(client):
    r = client.get("/api/images", params={"limit": 10})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["items"][0]["filename"] == "x.png"


def test_search(client):
    r = client.get("/api/images", params={"q": "hello"})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1


def test_favorite_toggle(client):
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    r = client.post(f"/api/images/{img_id}/favorite", params={"favorite": True})
    assert r.status_code == 200
    r = client.get(f"/api/images/{img_id}")
    assert r.json()["favorite"] is True


def test_folder_create_list(client):
    r = client.post("/api/folders", json={"name": "灵感"})
    assert r.status_code == 200
    folder_id = r.json()["id"]
    r = client.get("/api/folders")
    assert r.status_code == 200
    assert any(f["id"] == folder_id for f in r.json())


def test_assign_folder_and_filter(client):
    folder_id = client.post("/api/folders", json={"name": "草稿"}).json()["id"]
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    r = client.post(f"/api/images/{img_id}/folder", json={"folder_id": folder_id})
    assert r.status_code == 200
    r = client.get("/api/images", params={"folder_id": folder_id, "limit": 10})
    assert r.json()["total"] == 1


def test_settings_round_trip(client):
    """PUT /api/settings 接受 live_enabled，立刻回显。"""
    r = client.put("/api/settings", json={"live_enabled": False})
    assert r.status_code == 200
    assert r.json()["live_enabled"] is False


def test_scan_progress(client):
    r = client.get("/api/scan/progress")
    assert r.status_code == 200
    assert "running" in r.json()


def test_tags(client):
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    r = client.post(f"/api/images/{img_id}/tags", json={"tags": ["cat", "red"]})
    assert r.status_code == 200
    assert sorted(r.json()["tags"]) == ["cat", "red"]
    r = client.get("/api/tags")
    names = [t["name"] for t in r.json()]
    assert "cat" in names



def test_file_endpoint_serves_original_bytes(client):
    """GET /api/images/{id}/file 返回原图字节，附 ETag/Last-Modified/Cache-Control。"""
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    r = client.get(f"/api/images/{img_id}/file")
    assert r.status_code == 200
    # PNG 头部
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"
    # 缓存头
    assert "etag" in r.headers
    assert "last-modified" in r.headers
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_file_endpoint_returns_304_on_matching_etag(client):
    """带 If-None-Match（=当前 ETag）→ 304 不带 body。"""
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    r1 = client.get(f"/api/images/{img_id}/file")
    etag = r1.headers["etag"]
    r2 = client.get(f"/api/images/{img_id}/file", headers={"If-None-Match": etag})
    assert r2.status_code == 304
    assert r2.content == b""
    # 304 仍然带缓存头
    assert r2.headers["etag"] == etag
    assert r2.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_file_endpoint_returns_304_on_matching_last_modified(client):
    """带 If-Modified-Since（=当前 Last-Modified）→ 304 不带 body。"""
    import email.utils as _eu
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    r1 = client.get(f"/api/images/{img_id}/file")
    lm = r1.headers["last-modified"]
    # 解析校验
    parsed = _eu.parsedate_to_datetime(lm)
    assert parsed is not None
    # 用原值回送
    r2 = client.get(f"/api/images/{img_id}/file", headers={"If-Modified-Since": lm})
    assert r2.status_code == 304
    assert r2.content == b""


def test_file_endpoint_404_when_missing(client):
    """不存在的 image_id → 404。"""
    r = client.get("/api/images/999999/file")
    assert r.status_code == 404


def test_feed_includes_original_url(client):
    """feed 返回的每条 item 必须带 original_url，方便前端直接拿原图缩放。"""
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    items = client.get("/api/images", params={"limit": 10}).json()["items"]
    assert len(items) >= 1
    for it in items:
        assert "original_url" in it
        assert it["original_url"] is not None
        assert it["original_url"].startswith("/api/images/" + str(it["id"]) + "/file?")
        assert "max=1024" in it["original_url"]  # 默认带 max=1024 预览
        assert "v=" in it["original_url"]      # cache-bust

def test_file_endpoint_with_max_returns_webp_preview(client):
    """GET /api/images/{id}/file?max=1024 返回缩放后的 WebP 预览。

    验证：
    - content-type = image/webp
    - 文件大小 < 原图
    - previews/ 目录里生成了缓存
    """
    from app.config import previews_dir
    from PIL import Image
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]

    # 原图大小
    orig = client.get(f"/api/images/{img_id}/file")
    assert orig.status_code == 200
    orig_size = len(orig.content)

    # 预览
    r = client.get(f"/api/images/{img_id}/file", params={"max": 1024})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/webp"
    # 1024px webp 通常 200-500KB，原图通常 2-5MB → 必然更小
    assert len(r.content) < orig_size, f"preview should be smaller: {len(r.content)} vs {orig_size}"

    # 缓存落盘了
    cache = previews_dir() / f"{img_id}_max1024.webp"
    assert cache.exists(), f"preview cache missing: {cache}"
    with Image.open(cache) as im:
        # Pillow.thumbnail 只缩小不放大；test 夹具图是 8x8 不会到 1024，但一定 <= 1024
        assert max(im.size) <= 1024


def test_file_endpoint_with_max_304_on_cache_hit(client):
    """预览第二次请求（带 If-None-Match）→ 304。"""
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    r1 = client.get(f"/api/images/{img_id}/file", params={"max": 512})
    assert r1.status_code == 200
    etag = r1.headers["etag"]
    assert "max=512" in etag or "max512" in etag, f"etag should include max: {etag}"
    r2 = client.get(
        f"/api/images/{img_id}/file",
        params={"max": 512},
        headers={"If-None-Match": etag},
    )
    assert r2.status_code == 304
    assert r2.content == b""


def test_file_endpoint_with_different_max_uses_different_cache(client):
    """max=256 和 max=1024 是两个独立的缓存条目。"""
    from app.config import previews_dir
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    r256 = client.get(f"/api/images/{img_id}/file", params={"max": 256})
    r1024 = client.get(f"/api/images/{img_id}/file", params={"max": 1024})
    assert r256.status_code == 200
    assert r1024.status_code == 200
    assert (previews_dir() / f"{img_id}_max256.webp").exists()
    assert (previews_dir() / f"{img_id}_max1024.webp").exists()
    # ETag 必须不同
    assert r256.headers["etag"] != r1024.headers["etag"]


def test_file_endpoint_max_validation(client):
    """max 越界（<64 或 >4096）→ 422。"""
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    r1 = client.get(f"/api/images/{img_id}/file", params={"max": 32})
    assert r1.status_code == 422
    r2 = client.get(f"/api/images/{img_id}/file", params={"max": 8192})
    assert r2.status_code == 422


def test_feed_includes_max_in_original_url(client):
    """feed 返回的 original_url 默认带 max=1024 → 后端出 webp 预览。"""
    items = client.get("/api/images", params={"limit": 5}).json()["items"]
    for it in items:
        url = it["original_url"]
        assert "max=1024" in url, f"original_url should include max=1024: {url}"
        assert "v=" in url