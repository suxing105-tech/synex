"""FastAPI 路由层 smoke 测试。"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import repository
from app.db import init_pool
from app.indexer import Indexer
from app.main import app
from app.events import get_bus

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




# ---------- 重命名 + 打开位置（右键菜单） ----------

def test_rename_filename_success(client):
    """PATCH /filename → 200 + 更新后的 summary，磁盘文件名真的被改了。"""
    from pathlib import Path
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    before = client.get(f"/api/images/{img_id}").json()
    old_path = Path(before["path"])
    assert old_path.exists()

    r = client.patch(f"/api/images/{img_id}/filename", json={"filename": "renamed"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["filename"] == "renamed.png"
    assert not old_path.exists()
    assert Path(body["path"]).exists()
    assert body["path"] != before["path"]

    again = client.get(f"/api/images/{img_id}").json()
    assert again["filename"] == "renamed.png"


def test_rename_filename_keeps_extension(client):
    """用户给的新名不带扩展名 → 自动保留原扩展名。给错扩展名也强制保留原扩展名。"""
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    r1 = client.patch(f"/api/images/{img_id}/filename", json={"filename": "noext"})
    assert r1.status_code == 200
    assert r1.json()["filename"] == "noext.png"

    # 给错扩展名也要归位
    r2 = client.patch(f"/api/images/{img_id}/filename", json={"filename": "wrong.txt"})
    assert r2.status_code == 200
    assert r2.json()["filename"] == "wrong.png"


def test_rename_filename_rejects_empty(client):
    """空字符串 / 纯空白 → 400。"""
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    for bad in ("", "   "):
        r = client.patch(f"/api/images/{img_id}/filename", json={"filename": bad})
        assert r.status_code == 400, (bad, r.text)


def test_rename_filename_rejects_path_separator(client):
    """文件名含路径分隔符或 .. → 400，绝不能跨目录。"""
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    for bad in ("../oops.png", "a/b.png", "..", "."):
        r = client.patch(f"/api/images/{img_id}/filename", json={"filename": bad})
        assert r.status_code == 400, (bad, r.text)


def test_rename_filename_rejects_invalid_chars(client):
    """Windows 非法字符 → 400。"""
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    for bad in ("a:b.png", "a*b.png", "a?b.png", 'a"b.png', "a<b.png", "a|b.png"):
        r = client.patch(f"/api/images/{img_id}/filename", json={"filename": bad})
        assert r.status_code == 400, (bad, r.text)


def test_rename_filename_not_found(client):
    """不存在的 id → 404。"""
    r = client.patch("/api/images/999999/filename", json={"filename": "x"})
    assert r.status_code == 404

def test_rename_filename_conflict_returns_409(client):
    """同目录已有同名文件 → 409；目标已存在时必须不改文件。"""
    import shutil
    from pathlib import Path
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    before = client.get(f"/api/images/{img_id}").json()
    old_path = Path(before["path"])
    assert old_path.exists()

    # 在同目录手动放一份冲突文件
    conflict = old_path.parent / "alpha.png"
    conflict.write_bytes(b"placeholder-not-a-real-png")

    try:
        r = client.patch(f"/api/images/{img_id}/filename", json={"filename": "alpha"})
        assert r.status_code == 409, r.text
        # 原文件必须没被动过
        assert old_path.exists(), "原文件不应被改动"
        # 数据库的 filename 也不能变
        again = client.get(f"/api/images/{img_id}").json()
        assert again["filename"] == before["filename"]
    finally:
        if conflict.exists():
            conflict.unlink()


def test_reveal_endpoint_returns_200(client):
    """POST /reveal → 200 + ok，path 在 body 里出现。"""
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    r = client.post(f"/api/images/{img_id}/reveal")
    # CI / 沙盒里 subprocess.Popen 会启动 explorer，可能略延迟但不会报错。
    # 我们只校验路径存在 + 200/ok。
    if r.status_code == 200:
        body = r.json()
        assert body["ok"] is True
        assert body["id"] == img_id
        assert body["path"].endswith(".png")
    else:
        # 在完全无 GUI 环境下 subprocess 可能报 ENOENT → 500
        assert r.status_code == 500

def test_reveal_not_found(client):
    """不存在的 id → 404。"""
    r = client.post("/api/images/999999/reveal")
    assert r.status_code == 404


def test_reveal_returns_method_field(client):
    """成功 → 200 + method 字段非空。"""
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    r = client.post(f"/api/images/{img_id}/reveal")
    # 有 GUI 环境：method 非 noop；无 GUI：依然 200（不抛 500）
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["method"]  # 至少有一个 method，empty 字符串视为 false
    assert body["platform"]


# ---------- 删除图片（缩略图 / 预览一并清） ----------

def test_delete_image_default_removes_file_and_previews(client):
    """DELETE 默认 remove_file=True：原文件 + 预览缓存全清。"""
    from pathlib import Path
    from app.config import previews_dir
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    info = client.get(f"/api/images/{img_id}").json()
    orig_path = Path(info["path"])
    assert orig_path.exists()

    # 先请求一次 file?max=512，触发预览落盘
    r1 = client.get(f"/api/images/{img_id}/file", params={"max": 512})
    assert r1.status_code == 200
    cache_p512 = previews_dir() / f"{img_id}_max512.webp"
    assert cache_p512.exists(), "preview cache should be created"

    # 删
    r = client.delete(f"/api/images/{img_id}")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["removed_file"] is True
    assert body["cleaned_previews"] >= 1

    # 原文件没了
    assert not orig_path.exists()
    # 预览没了
    assert not cache_p512.exists()
    # DB 行没了
    detail = client.get(f"/api/images/{img_id}")
    assert detail.status_code == 404


def test_delete_image_not_found(client):
    r = client.delete("/api/images/999999")
    assert r.status_code == 404


def test_delete_image_remove_file_false_keeps_orig_clears_preview(client):
    """remove_file=False：保留原文件，但 previews/{id}_*.webp 仍然清。"""
    from pathlib import Path
    from app.config import previews_dir
    img_id = client.get("/api/images", params={"limit": 1}).json()["items"][0]["id"]
    info = client.get(f"/api/images/{img_id}").json()
    orig_path = Path(info["path"])

    # 触发预览
    client.get(f"/api/images/{img_id}/file", params={"max": 256})
    cache = previews_dir() / f"{img_id}_max256.webp"
    assert cache.exists()

    r = client.delete(f"/api/images/{img_id}", params={"remove_file": "false"})
    assert r.status_code == 200
    assert orig_path.exists(), "原文件不应被删"
    assert not cache.exists(), "预览应被清"


def test_logo_endpoint_serves_png(client):
    """GET /logo.png 直返 PNG 字节，Cache-Control 走 1 天缓存。"""
    r = client.get("/logo.png")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert len(r.content) > 100, f"logo bytes too small: {len(r.content)}"
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n", "should be a real PNG"
    cc = r.headers.get("cache-control", "")
    assert "max-age" in cc


import asyncio
import json

@pytest.mark.asyncio
async def test_import_broadcasts_image_indexed(client):
    """拖入图片入库后必须把 image_indexed 推到 EventBus，前端 WS 才能刷新 feed。

    不广播 → 前端要手动刷新页面才看到新图（回归：拖入后不显示缩略图）。
    """
    from app.config import inbox_dir
    bus = get_bus()
    q = await bus.subscribe()
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (10, 20, 30)).save(buf, format="PNG")
    buf.seek(0)
    r = client.post(
        "/api/images/import",
        files=[("files", ("drop.png", buf, "image/png"))],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    new_id = body["saved"][0]["id"]
    # 给事件循环最多 1s 时间把 payload 推进订阅队列
    try:
        payload = await asyncio.wait_for(q.get(), timeout=1.0)
    finally:
        await bus.unsubscribe(q)
    assert payload["type"] == "image_indexed", payload
    assert payload["id"] == new_id
    assert payload["filename"] == "drop.png"
    assert payload["path"].endswith("drop.png")
    # 推出来的 inbox 文件应已入库
    assert Path(payload["path"]).exists()

def test_feed_includes_max_in_original_url(client):
    """feed 返回的 original_url 默认带 max=1024 → 后端出 webp 预览。"""
    items = client.get("/api/images", params={"limit": 5}).json()["items"]
    for it in items:
        url = it["original_url"]
        assert "max=1024" in url, f"original_url should include max=1024: {url}"
        assert "v=" in url
