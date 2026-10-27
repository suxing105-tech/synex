"""「复制音频」「复制文本文件」= 把原文件放上剪贴板（CF_HDROP），不是复制内容。

真实的 Set-Clipboard 不该在测试里动用户剪贴板，所以桩掉
windows_clipboard.copy_file_to_clipboard：只验路由有没有取到那条记录真正的磁盘路径，
以及异常怎么翻成状态码。这样非 Windows 上也能跑。
"""
from __future__ import annotations

import importlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import texts
from app.db import init_pool
from app.windows_clipboard import ClipboardFailed, ClipboardUnsupported

from .test_audio import make_audio


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path / "data"))
    from app import config, db

    importlib.reload(config)
    importlib.reload(db)
    (tmp_path / "data").mkdir()
    init_pool()
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def copied(monkeypatch):
    """替身：记下每条路由真正交给剪贴板的文件路径。"""
    seen: list[str] = []
    monkeypatch.setattr("app.clipboard_routes.copy_file_to_clipboard", lambda path: seen.append(str(path)))
    return seen


@pytest.fixture
def audio_row(client, tmp_path: Path):
    source = make_audio(tmp_path / "音频素材_00001.mp3", duration=0.4)
    saved = client.post(
        "/api/images/import",
        files=[("files", ("音频素材_00001.mp3", source.read_bytes(), "audio/mpeg"))],
    ).json()["saved"][0]
    row = client.get("/api/images", params={"kind": "audio"}).json()["items"][0]
    return {"id": row["id"], "path": saved["path"]}


@pytest.fixture
def text_row(tmp_path: Path):
    p = tmp_path / "剧本.md"
    p.write_text("# 开场\n中文提示词\n", encoding="utf-8")
    return {"id": texts.index(p)["id"], "path": str(p)}


def test_audio_copy_endpoint_puts_the_original_file_on_the_clipboard(client, copied, audio_row):
    response = client.post(f"/api/images/{audio_row['id']}/copy-file")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True and body["method"] == "clipboard" and body["id"] == audio_row["id"]
    assert copied == [audio_row["path"]]


def test_text_copy_endpoint_uses_the_document_path(client, copied, text_row):
    response = client.post(f"/api/texts/{text_row['id']}/copy-file")
    assert response.status_code == 200
    assert response.json()["path"] == text_row["path"]
    assert copied == [text_row["path"]]


def test_a_moved_file_reports_missing_instead_of_a_broken_copy(client, copied, text_row):
    Path(text_row["path"]).unlink()
    response = client.post(f"/api/texts/{text_row['id']}/copy-file")
    assert response.status_code == 404
    assert "不存在" in response.json()["detail"]
    assert copied == []


def test_unknown_ids_are_404(client, copied):
    assert client.post("/api/images/999999/copy-file").status_code == 404
    assert client.post("/api/texts/999999/copy-file").status_code == 404
    assert copied == []


def test_unsupported_platform_is_501_and_a_failed_copy_is_500(client, monkeypatch, text_row):
    def refuse(_path):
        raise ClipboardUnsupported("当前平台仅支持在 Windows 上复制文件到剪贴板")

    monkeypatch.setattr("app.clipboard_routes.copy_file_to_clipboard", refuse)
    response = client.post(f"/api/texts/{text_row['id']}/copy-file")
    assert response.status_code == 501

    def fail(_path):
        raise ClipboardFailed("复制失败：剪贴板被占用")

    monkeypatch.setattr("app.clipboard_routes.copy_file_to_clipboard", fail)
    response = client.post(f"/api/texts/{text_row['id']}/copy-file")
    assert response.status_code == 500
    assert "剪贴板被占用" in response.json()["detail"]
