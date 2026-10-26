"""FLAC 全链路：拖拽/粘贴导入 → 入库为音频 → 波形 → 播放 → 进统一流。

用户点名要 .flac。它本来就在 AUDIO_EXTS 里，真正会咬人的是导入接口的
单文件大小上限：音频曾按 100MB 的图片上限算，24bit 母带直接被记成 too_large。
"""
from __future__ import annotations

import importlib
import subprocess
from pathlib import Path

import pytest

from app.config import previews_dir
from app.db import init_pool
from app.indexer import Indexer
from app.parser import AUDIO_EXTS, AUDIO_PLAYABLE_EXTS, SUPPORTED_EXTS, classify, is_playable_audio

from .test_audio import make_audio


def make_flac(path: Path, *, duration: float = 1.5) -> Path:
    """24bit FLAC，和真实母带同一种容器/编码。"""
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}", "-c:a", "flac", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert path.exists(), "ffmpeg 未能生成 FLAC"
    return path


@pytest.fixture
def flac_env(tmp_path: Path, monkeypatch):
    """临时数据目录 + 一个放「用户手里的原始文件」的子目录（在数据目录之外）。"""
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path / "data"))
    from app import config, db

    importlib.reload(config)
    importlib.reload(db)
    (tmp_path / "data").mkdir()
    (tmp_path / "shelf").mkdir()
    init_pool()
    return tmp_path / "shelf"


@pytest.fixture
def client(flac_env):
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


def test_flac_is_listed_everywhere_it_needs_to_be():
    assert ".flac" in AUDIO_EXTS
    assert ".flac" in AUDIO_PLAYABLE_EXTS, "FLAC 不能进内嵌播放白名单的话就该走系统播放器"
    assert ".flac" in SUPPORTED_EXTS
    assert classify(Path("album.flac")) == "audio"
    assert is_playable_audio(Path("album.flac"))


def test_flac_imports_through_the_http_endpoint(client, flac_env):
    """拖到 feed / Ctrl+V 走的就是 /api/images/import，FLAC 不该被跳过。"""
    source = make_flac(flac_env / "母带.flac")
    body = client.post(
        "/api/images/import",
        files=[("files", ("母带.flac", source.read_bytes(), "audio/flac"))],
    ).json()
    assert body["skipped"] == []
    assert [item["filename"] for item in body["saved"]] == ["母带.flac"]

    row = client.get("/api/images", params={"kind": "audio"}).json()["items"][0]
    assert row["kind"] == "audio"
    assert row["filename"] == "母带.flac"
    assert row["duration_seconds"] and round(row["duration_seconds"]) == 2
    assert row["audio_codec"] == "flac"
    assert row["width"] is None and row["height"] is None
    assert "waveform" in row["thumbnail_url"]
    assert row["playable"] is True


def test_flac_import_is_not_capped_by_the_image_limit(client, flac_env, monkeypatch):
    """音频上限单独一档（200MB），不跟图片共用 100MB。

    这里把图片上限压到 8 字节：如果音频还走图片上限，这个导入就会被记 too_large。
    """
    from app.routes import images as images_route

    monkeypatch.setattr(images_route, "_MAX_IMAGE_BYTES", 8)
    assert images_route._MAX_AUDIO_BYTES > images_route._MAX_IMAGE_BYTES
    source = make_flac(flac_env / "cap.flac", duration=0.6)
    body = client.post(
        "/api/images/import",
        files=[("files", ("cap.flac", source.read_bytes(), "audio/flac"))],
    ).json()
    assert [item["filename"] for item in body["saved"]] == ["cap.flac"]
    assert body["skipped"] == []


def test_flac_serves_playback_and_waveform(client, flac_env):
    source = make_flac(flac_env / "play.flac", duration=1.0)
    client.post("/api/images/import", files=[("files", ("play.flac", source.read_bytes(), "audio/flac"))])
    audio_id = client.get("/api/images", params={"kind": "audio"}).json()["items"][0]["id"]

    stream = client.get(f"/api/audio/{audio_id}/file")
    assert stream.status_code == 200
    assert stream.headers["content-type"] == "audio/flac"
    part = client.get(f"/api/audio/{audio_id}/file", headers={"Range": "bytes=0-99"})
    assert part.status_code == 206

    wave = client.get(f"/api/audio/{audio_id}/waveform")
    assert wave.status_code == 200
    assert wave.content[:8] == b"\x89PNG\r\n\x1a\n"
    assert list(previews_dir().glob(f"{audio_id}_wave_840x360_*.png"))


def test_flac_shows_up_in_unified_feed_and_stats(client, flac_env):
    source = make_flac(flac_env / "all.flac", duration=1.0)
    client.post("/api/images/import", files=[("files", ("all.flac", source.read_bytes(), "audio/flac"))])
    items = client.get("/api/items", params={"kinds": "image,video,audio,text"}).json()
    audio_rows = [item for item in items["items"] if item["kind"] == "audio"]
    assert [row["filename"] for row in audio_rows] == ["all.flac"]
    assert audio_rows[0]["item_type"] == "media"
    assert items["counts"]["audio"] == 1
    assert client.get("/api/stats").json()["total_audio"] == 1


def test_flac_produces_no_image_preview(client, flac_env):
    """音频不产图：唯一的视觉就是懒生成的波形，扫描期不该往 previews 里塞海报。"""
    source = make_flac(flac_env / "noprev.flac", duration=0.6)
    indexer = Indexer()
    indexer._process_path_sync(source)
    assert list(previews_dir().glob("*")) == []
