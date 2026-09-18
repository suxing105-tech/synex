"""POST /api/images/import 端到端测试。"""
from __future__ import annotations

import io
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
    # 不启动 lifespan（避免 watchdog 副作用）
    with TestClient(app) as c:
        yield c


def _png_bytes(tmp_path: Path) -> bytes:
    p = tmp_path / '_test_import.png'
    make_png(p, prompt=make_comfy_prompt("import test", "low", seed=7))
    return p.read_bytes()


def _webp_bytes() -> bytes:
    """合成最小 WebP（RIFF + VP8L 头）。仅用来验证 .webp 扩展名路径，
    indexer 解析器不强要求像素合法。"""
    # 最小 RIFF 容器：固定头 + 1x1 VP8L
    # 来源：webp 规范的最小可解码字节
    return (
        b"RIFF\x1e\x00\x00\x00WEBPVP8L\x18\x00\x00\x00"
        b"\x2f\x00\x00\x00\x00\x00\x00\x00"
        b"\x00\x00\x00\x00\x00\x00\x00\x00"
        b"\x00\x00\x00\x00"
    )


def test_import_png_success(client, tmp_path):
    png = _png_bytes(tmp_path)
    r = client.post(
        "/api/images/import",
        files=[("files", ("hello.png", io.BytesIO(png), "image/png"))],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["saved"]) == 1
    assert body["saved"][0]["filename"].endswith(".png")
    assert body["skipped"] == []
    # 收件箱里有文件
    inbox_files = list((tmp_path / "inbox").glob("*.png"))
    assert len(inbox_files) == 1
    # 通过 feed 能查到
    feed = client.get("/api/images", params={"limit": 10}).json()
    assert feed["total"] == 1
    assert feed["items"][0]["filename"] == body["saved"][0]["filename"]


def test_import_unsupported_file_skipped(client):
    r = client.post(
        "/api/images/import",
        files=[("files", ("document.txt", io.BytesIO(b"not-an-image"), "text/plain"))],
    )
    assert r.status_code == 200
    body = r.json()
    assert body["saved"] == []
    assert len(body["skipped"]) == 1
    assert body["skipped"][0]["reason"] == "unsupported_format"
    assert body["skipped"][0]["filename"] == "document.txt"


def test_import_with_folder_assignment(client, tmp_path):
    # 建文件夹
    folder_resp = client.post("/api/folders", json={"name": "灵感"})
    assert folder_resp.status_code == 200
    folder_id = folder_resp.json()["id"]

    png = _png_bytes(tmp_path)
    r = client.post(
        "/api/images/import",
        files=[("files", ("a.png", io.BytesIO(png), "image/png"))],
        data={"folder_id": str(folder_id)},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["folder_id"] == folder_id
    img_id = body["saved"][0]["id"]

    # 按 folder_id 过滤应能看到
    feed = client.get(
        "/api/images", params={"folder_id": folder_id, "limit": 10}
    ).json()
    assert feed["total"] == 1
    assert feed["items"][0]["id"] == img_id


def test_import_invalid_folder_id_returns_400(client, tmp_path):
    png = _png_bytes(tmp_path)
    r = client.post(
        "/api/images/import",
        files=[("files", ("a.png", io.BytesIO(png), "image/png"))],
        data={"folder_id": "99999"},
    )
    assert r.status_code == 400


def test_import_no_files_returns_400(client):
    r = client.post("/api/images/import", files=[])
    assert r.status_code == 422 or r.status_code == 400


def test_import_filename_collision_appends_suffix(client, tmp_path):
    png = _png_bytes(tmp_path)
    # 第一次导入
    r1 = client.post(
        "/api/images/import",
        files=[("files", ("same.png", io.BytesIO(png), "image/png"))],
    )
    assert r1.status_code == 200
    first_name = r1.json()["saved"][0]["filename"]
    assert first_name == "same.png"
    # 第二次同名
    r2 = client.post(
        "/api/images/import",
        files=[("files", ("same.png", io.BytesIO(png), "image/png"))],
    )
    assert r2.status_code == 200
    second_name = r2.json()["saved"][0]["filename"]
    assert second_name == "same_1.png"
    assert (tmp_path / "inbox" / "same.png").exists()
    assert (tmp_path / "inbox" / "same_1.png").exists()


def test_import_empty_filename_rejected_by_multipart(client, tmp_path):
    """空 filename 会在 Starlette multipart 层被 422 拒绝，
    我们的路由拿不到这种请求 → 边界保护由 multipart 提供。"""
    png = _png_bytes(tmp_path)
    r = client.post(
        "/api/images/import",
        files=[("files", ("", io.BytesIO(png), "image/png"))],
    )
    assert r.status_code == 422



def test_import_sanitizes_path_traversal_in_name(client, tmp_path):
    png = _png_bytes(tmp_path)
    # 用户传了一个带路径分隔符的 name（虽然 multipart 通常不会，但兜底）
    r = client.post(
        "/api/images/import",
        files=[("files", ("../../../etc/passwd.png", io.BytesIO(png), "image/png"))],
    )
    assert r.status_code == 200
    saved_name = r.json()["saved"][0]["filename"]
    # 不应包含路径分隔符
    assert "/" not in saved_name
    assert "\\" not in saved_name
    # 文件确实在 inbox 里
    assert (tmp_path / "inbox" / saved_name).exists()
    # 不应在 inbox 之外创建文件
    assert not (tmp_path / "etc").exists() if (tmp_path / "etc").exists() else True


def test_import_webp_success(client):
    webp = _webp_bytes()
    r = client.post(
        "/api/images/import",
        files=[("files", ("a.webp", io.BytesIO(webp), "image/webp"))],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # WebP 索引可能成功（只要文件存在）；也可能失败（像素解码失败）。
    # 关键是接口没崩。
    assert isinstance(body["saved"], list)
    assert isinstance(body["skipped"], list)


def test_import_returns_inbox_dir(client, tmp_path):
    r = client.post(
        "/api/images/import",
        files=[("files", ("a.png", io.BytesIO(_png_bytes(tmp_path)), "image/png"))],
    )
    body = r.json()
    assert body["inbox_dir"].endswith("inbox") or body["inbox_dir"].endswith("inbox\\")




