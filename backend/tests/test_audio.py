"""音频作为一等素材：分类、元数据、入库、feed URL、复制导入、波形与播放路由。"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from app import repository
from app.config import previews_dir
from app.db import get_pool, init_pool
from app.indexer import Indexer
from app.parser import (
    AUDIO_EXTS,
    AUDIO_PLAYABLE_EXTS,
    SUPPORTED_EXTS,
    classify,
    is_playable_audio,
    parse_audio_metadata,
)

from .conftest import make_png


def make_audio(path: Path, *, duration: float = 1.0) -> Path:
    """用 ffmpeg 生成一段极短的正弦音（编码器由扩展名决定）。"""
    subprocess.run(
        [
            "ffmpeg", "-y", "-f", "lavfi",
            "-i", f"sine=frequency=440:duration={duration}",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert path.exists(), "ffmpeg 未能生成测试音频"
    return path


@pytest.fixture
def seeded_audio(tmp_path: Path, monkeypatch):
    """一张图 + 一段 mp3。"""
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path))
    import importlib

    from app import config, db

    importlib.reload(config)
    importlib.reload(db)
    init_pool()
    indexer = Indexer()
    make_png(tmp_path / "img.png")
    indexer._process_path_sync(tmp_path / "img.png")
    make_audio(tmp_path / "tone.mp3")
    indexer._process_path_sync(tmp_path / "tone.mp3")
    return tmp_path


@pytest.fixture
def client(seeded_audio):
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


# ---------- parser ----------


def test_audio_extensions_are_supported_and_classified():
    assert SUPPORTED_EXTS >= AUDIO_EXTS
    for ext in AUDIO_EXTS:
        assert classify(Path(f"x{ext}")) == "audio"
    assert classify(Path("x.png")) == "image"
    assert classify(Path("x.mp4")) == "video"


def test_is_playable_audio_follows_container_table():
    for ext in AUDIO_PLAYABLE_EXTS:
        assert is_playable_audio(Path(f"x{ext}")) is True
    assert is_playable_audio(Path("x.wma")) is False
    assert is_playable_audio(Path("x.png")) is False


def test_parse_audio_metadata_never_raises(tmp_path, monkeypatch):
    """ffprobe 不在 PATH 时返回空字段，而不是抛异常打断扫描。"""
    def boom(*_args, **_kwargs):
        raise FileNotFoundError("ffprobe")

    monkeypatch.setattr("app.parser.subprocess.run", boom)
    meta = parse_audio_metadata(tmp_path / "missing.mp3")
    assert meta["kind"] == "audio"
    assert meta["duration_seconds"] is None
    assert meta["audio_codec"] is None
    assert meta["positive_prompt"] == ""


# ---------- 入库 ----------


def test_audio_indexed_as_first_class_media(seeded_audio):
    conn = get_pool().main()
    row = conn.execute("SELECT * FROM images WHERE filename='tone.mp3'").fetchone()
    assert row["kind"] == "audio"
    assert row["duration_seconds"] and row["duration_seconds"] > 0.5
    assert row["audio_codec"]
    # 音频没有画幅，也不能被当成图片送去 Pillow
    assert row["width"] is None
    assert row["height"] is None
    assert row["cover_path"] is None
    assert json.loads(row["parameters"]).get("audio", {}).get("sample_rate")


def test_audio_indexing_does_not_render_previews(seeded_audio):
    audio_id = get_pool().main().execute(
        "SELECT id FROM images WHERE filename='tone.mp3'"
    ).fetchone()["id"]
    assert not list(previews_dir().glob(f"{audio_id}_*"))


def test_audio_still_indexes_when_probe_fails(tmp_path, monkeypatch):
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path))
    import importlib

    from app import config, db

    importlib.reload(config)
    importlib.reload(db)
    init_pool()

    def boom(_path):
        raise RuntimeError("ffprobe crashed")

    monkeypatch.setattr("app.indexer.parse_audio_metadata", boom)
    make_audio(tmp_path / "broken.wav")
    payload = Indexer()._process_path_sync(tmp_path / "broken.wav")
    assert payload is not None
    row = get_pool().main().execute("SELECT * FROM images WHERE filename='broken.wav'").fetchone()
    assert row["kind"] == "audio"
    assert row["duration_seconds"] is None


def test_feed_url_shapes_for_audio(seeded_audio):
    items, total = repository.feed(kind="audio", limit=10)
    assert total == 1
    item = items[0]
    assert item["kind"] == "audio"
    assert item["thumbnail_url"].startswith("/api/audio/")
    assert "waveform" in item["thumbnail_url"]
    # 卡片是 21:9 横幅，默认出图必须同比例，否则 object-fit 要裁或留黑边
    assert "w=840" in item["thumbnail_url"] and "h=360" in item["thumbnail_url"]
    assert item["play_url"].startswith("/api/audio/") and "/file?" in item["play_url"]
    assert item["playable"] is True
    # 原图 URL 不能带 max，否则后端会拿 Pillow 去缩放音频
    assert "max=" not in (item["original_url"] or "")
    assert item["duration_seconds"] is not None


def test_stats_counts_audio_and_texts(seeded_audio):
    s = repository.stats()
    assert s["total_images"] == 1
    assert s["total_audio"] == 1
    assert s["total_videos"] == 0
    assert s["total_texts"] == 0
    assert "favorites" not in s


def test_original_file_endpoint_refuses_audio_preview(client):
    audio_id = client.get("/api/images", params={"kind": "audio"}).json()["items"][0]["id"]
    assert client.get(f"/api/images/{audio_id}/file", params={"max": 512}).status_code == 400


def test_reverse_prompts_reject_audio(client):
    audio_id = client.get("/api/images", params={"kind": "audio"}).json()["items"][0]["id"]
    r = client.post(f"/api/images/{audio_id}/reverse-prompts", json={})
    assert r.status_code == 400
    assert "音频" in r.json()["detail"]


def test_video_prompt_plans_reject_audio(client):
    audio_id = client.get("/api/images", params={"kind": "audio"}).json()["items"][0]["id"]
    r = client.post(
        f"/api/videos/{audio_id}/video-prompts/plans",
        json={"range_start_ms": 0, "range_end_ms": 1000, "units": [], "instruction": "x"},
    )
    assert r.status_code in (400, 404)


# ---------- 复制导入 ----------


def test_copy_files_accepts_audio(tmp_path, monkeypatch):
    from app import folder_storage
    from app.file_transfer import copy_files

    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path))
    import importlib

    from app import config, db

    importlib.reload(config)
    importlib.reload(db)
    init_pool()
    Indexer()
    folder = folder_storage.create_folder("audio-in", None)
    source = make_audio(tmp_path / "drag.mp3")

    result = copy_files([str(source)], folder["id"])

    assert result["skipped"] == []
    saved = Path(result["saved"][0]["path"])
    assert saved.is_file() and saved.read_bytes() == source.read_bytes()
    row = get_pool().main().execute(
        "SELECT kind FROM images WHERE filename=?", (saved.name,)
    ).fetchone()
    assert row["kind"] == "audio"


def test_copy_files_rejects_oversized_audio(tmp_path, monkeypatch):
    from app import folder_storage
    from app.file_transfer import copy_files

    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path))
    import importlib

    from app import config, db

    importlib.reload(config)
    importlib.reload(db)
    init_pool()
    Indexer()
    folder = folder_storage.create_folder("audio-in", None)
    huge = tmp_path / "huge.mp3"
    with huge.open("wb") as stream:
        stream.truncate(201 * 1024 * 1024)

    result = copy_files([str(huge)], folder["id"])

    assert result["saved"] == []
    assert result["skipped"][0]["reason"] == "超过 200MB"
    assert huge.exists()


# ---------- 路由 ----------


def test_audio_file_endpoint_serves_stream_with_ranges(client):
    audio_id = client.get("/api/images", params={"kind": "audio"}).json()["items"][0]["id"]
    r = client.get(f"/api/audio/{audio_id}/file")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("audio/")
    assert r.headers["accept-ranges"] == "bytes"
    assert len(r.content) > 0

    part = client.get(f"/api/audio/{audio_id}/file", headers={"Range": "bytes=0-3"})
    assert part.status_code == 206
    assert len(part.content) == 4
    assert part.headers["content-range"].startswith("bytes 0-3/")

    # 浏览器播放进度条常发 bytes=0-，按 RFC 7233 这是合法区间 → 206 + 全长
    whole = client.get(f"/api/audio/{audio_id}/file", headers={"Range": "bytes=0-"})
    assert whole.status_code == 206
    assert len(whole.content) == len(r.content)

    again = client.get(f"/api/audio/{audio_id}/file", headers={"If-None-Match": r.headers["etag"]})
    assert again.status_code == 304

    bad = client.get(f"/api/audio/{audio_id}/file", headers={"Range": "bytes=999999999-"})
    assert bad.status_code == 416


def test_audio_file_endpoint_rejects_image_ids(client):
    img_id = client.get("/api/images", params={"kind": "image"}).json()["items"][0]["id"]
    assert client.get(f"/api/audio/{img_id}/file").status_code == 404


def test_audio_waveform_is_generated_then_cached(client, monkeypatch):
    audio_id = client.get("/api/images", params={"kind": "audio"}).json()["items"][0]["id"]

    first = client.get(f"/api/audio/{audio_id}/waveform")
    assert first.status_code == 200
    assert first.content[:8] == b"\x89PNG\r\n\x1a\n"
    cached = client.get(f"/api/audio/{audio_id}/waveform")
    assert cached.status_code == 200
    assert cached.content == first.content
    assert list(previews_dir().glob(f"{audio_id}_wave_840x360_*.png"))

    # 第二次请求不能再重跑 ffmpeg：换成必然失败的 run，若被调用就会 404
    def failing_run(*_args, **_kwargs):
        raise AssertionError("波形已缓存，不该再调 ffmpeg")

    monkeypatch.setattr("app.thumbnails.subprocess.run", failing_run)
    assert client.get(f"/api/audio/{audio_id}/waveform").status_code == 200
    assert client.get(
        f"/api/audio/{audio_id}/waveform", headers={"If-None-Match": first.headers["etag"]}
    ).status_code == 304


def test_audio_waveform_404_without_ffmpeg(client, monkeypatch):
    audio_id = client.get("/api/images", params={"kind": "audio"}).json()["items"][0]["id"]

    def boom(*_args, **_kwargs):
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr("app.thumbnails.subprocess.run", boom)
    assert client.get(f"/api/audio/{audio_id}/waveform").status_code == 404


def test_audio_waveform_is_padded_to_the_card_aspect(client):
    """卡片统一 21:9 后，波形图整张也必须是被请求的尺寸，但波形只占中间一条。

    直接 showwavespic 会让波形铺满整张卡（糊成一块红），所以先画中间条
    再 pad 到请求尺寸 —— 这条断言钉住 pad 真的生效，别退回单段滤镜。
    """
    import io

    from PIL import Image

    audio_id = client.get("/api/images", params={"kind": "audio"}).json()["items"][0]["id"]
    r = client.get(f"/api/audio/{audio_id}/waveform", params={"w": 840, "h": 360})
    assert r.status_code == 200

    img = Image.open(io.BytesIO(r.content)).convert("RGBA")
    assert img.size == (840, 360)  # 与卡片同比例（21:9），object-fit 不用裁也不用留边
    alpha = img.getchannel("A")
    assert alpha.crop((0, 0, 840, 1)).getextrema() == (0, 0), "顶部必须是透明的"
    assert alpha.crop((0, 359, 840, 360)).getextrema() == (0, 0), "底部必须是透明的"
    assert alpha.crop((0, 180, 840, 181)).getextrema()[1] > 0, "中间应有波形像素"


def test_audio_waveform_size_param_changes_cache_file(client):
    audio_id = client.get("/api/images", params={"kind": "audio"}).json()["items"][0]["id"]
    r = client.get(f"/api/audio/{audio_id}/waveform", params={"w": 320, "h": 96})
    assert r.status_code == 200
    assert list(previews_dir().glob(f"{audio_id}_wave_320x96_*.png"))


def test_audio_open_falls_back_to_system_player(client, monkeypatch):
    from app.routes import audio as audio_route

    called: dict[str, str] = {}
    monkeypatch.setattr(
        audio_route.os, "startfile", lambda path: called.__setitem__("path", path)
    )
    audio_id = client.get("/api/images", params={"kind": "audio"}).json()["items"][0]["id"]
    r = client.post(f"/api/audio/{audio_id}/open")
    assert r.status_code == 200
    assert called["path"].endswith("tone.mp3")