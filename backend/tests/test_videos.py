"""视频管理测试：分类、元数据、索引、feed 过滤、统计、视频路由。"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from app import repository
from app.db import get_pool, init_pool
from app.indexer import Indexer

from .conftest import make_png


def make_video(path: Path, *, width: int = 64, height: int = 48, duration: float = 1.0) -> Path:
    """用 ffmpeg 生成一个极小的 h264 mp4。"""
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f", "lavfi",
            "-i", f"color=c=black:s={width}x{height}:d={duration}",
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert path.exists(), "ffmpeg 未能生成测试视频"
    return path


@pytest.fixture
def seeded_both(tmp_path: Path, monkeypatch):
    """一个图片 + 一个视频的库。"""
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path))
    import importlib

    from app import config, db

    importlib.reload(config)
    importlib.reload(db)
    init_pool()
    indexer = Indexer()
    make_png(tmp_path / "img.png")
    indexer._process_path_sync(tmp_path / "img.png")
    make_video(tmp_path / "clip.mp4")
    indexer._process_path_sync(tmp_path / "clip.mp4")
    return tmp_path


# ---------- parser ----------


def test_classify_formats(tmp_path: Path):
    from app.parser import classify, is_playable_video

    for ext, kind, playable in [
        (".png", "image", False),
        (".jpg", "image", False),
        (".mp4", "video", True),
        (".mov", "video", True),
        (".m4v", "video", True),
        (".webm", "video", True),
        (".mkv", "video", False),
        (".avi", "video", False),
        (".wmv", "video", False),
        (".flv", "video", False),
    ]:
        p = tmp_path / f"x{ext}"
        assert classify(p) == kind, ext
        assert is_playable_video(p) == playable, ext


def test_parse_video_metadata(tmp_path: Path):
    from app.parser import parse_video_metadata

    vid = make_video(tmp_path / "clip.mp4", width=320, height=240, duration=1.0)
    meta = parse_video_metadata(vid)
    assert meta["kind"] == "video"
    assert meta["width"] == 320
    assert meta["height"] == 240
    assert abs((meta["duration_seconds"] or 0) - 1.0) < 0.5
    assert meta["video_codec"] == "h264"
    assert meta["format"] == "MP4"
    # 图片字段保持空
    assert meta["positive_prompt"] == ""
    assert meta["negative_prompt"] == ""


def test_parse_video_metadata_corrupt_returns_empty(tmp_path: Path):
    from app.parser import parse_video_metadata

    p = tmp_path / "clip.mp4"
    p.write_bytes(b"not a real video")
    meta = parse_video_metadata(p)
    assert meta["width"] is None
    assert meta["duration_seconds"] is None


# ---------- indexer / feed / stats ----------


def test_indexer_stores_video_fields(seeded_both):
    conn = get_pool().main()
    row = conn.execute(
        "SELECT * FROM images WHERE kind = 'video'"
    ).fetchone()
    assert row is not None
    assert row["filename"] == "clip.mp4"
    assert row["width"] == 64
    assert row["height"] == 48
    assert row["duration_seconds"] is not None
    assert row["video_codec"] == "h264"


def test_feed_kind_filter(seeded_both):
    items_img, total_img = repository.feed(kind="image", limit=10)
    assert total_img == 1
    assert items_img[0]["kind"] == "image"
    assert items_img[0]["play_url"] is None

    items_vid, total_vid = repository.feed(kind="video", limit=10)
    assert total_vid == 1
    assert items_vid[0]["kind"] == "video"
    assert items_vid[0]["play_url"].startswith("/api/videos/")
    assert items_vid[0]["thumbnail_url"].startswith("/api/videos/")
    assert items_vid[0]["playable"] is True
    assert items_vid[0]["duration_seconds"] is not None


def test_stats_total_videos(seeded_both):
    s = repository.stats()
    assert s["total_images"] == 1
    assert s["total_videos"] == 1


# ---------- 路由 ----------


@pytest.fixture
def client(seeded_both):
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:
        yield c


def test_video_list_kind_param(client):
    r = client.get("/api/images", params={"kind": "video", "limit": 10})
    assert r.status_code == 200
    assert r.json()["total"] == 1
    assert r.json()["items"][0]["kind"] == "video"


def test_video_file_endpoint(client):
    vid_id = client.get("/api/images", params={"kind": "video"}).json()["items"][0]["id"]
    r = client.get(f"/api/videos/{vid_id}/file")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("video/")
    assert r.headers["accept-ranges"] == "bytes"
    assert "inline" in r.headers.get("content-disposition", "")
    assert "etag" in r.headers
    assert len(r.content) > 0


def test_video_file_range_request(client):
    vid_id = client.get("/api/images", params={"kind": "video"}).json()["items"][0]["id"]
    r = client.get(
        f"/api/videos/{vid_id}/file",
        headers={"Range": "bytes=0-3"},
    )
    assert r.status_code in (200, 206)


def test_video_thumb_endpoint(client):
    vid_id = client.get("/api/images", params={"kind": "video"}).json()["items"][0]["id"]
    r = client.get(f"/api/videos/{vid_id}/thumb")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/")
    assert r.content[:4] == b"RIFF"  # webp container


def test_video_open_endpoint_uses_system_player(client, monkeypatch):
    from app.routes import videos as videos_route

    called: dict = {}

    def fake_startfile(path: str):
        called["path"] = path

    monkeypatch.setattr(videos_route.os, "startfile", fake_startfile)
    vid_id = client.get("/api/images", params={"kind": "video"}).json()["items"][0]["id"]
    r = client.post(f"/api/videos/{vid_id}/open")
    assert r.status_code == 200
    assert called["path"].endswith("clip.mp4")


# ---------- 迁移 ----------


def test_migrate_media_kind_adds_columns_on_legacy_table(tmp_data_dir):
    """旧库（无 kind 列）跑迁移后补齐列且默认 'image'。"""
    from app.db import migrate_media_kind

    conn = get_pool().main()
    # 造一个"旧版" images 表：先删掉再重建（不带新增列）
    conn.execute("DROP TABLE IF EXISTS images")
    conn.execute(
        "CREATE TABLE images ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, "
        "filename TEXT NOT NULL, size_bytes INTEGER NOT NULL, mtime REAL NOT NULL, "
        "width INTEGER, height INTEGER, format TEXT, "
        "positive_prompt TEXT NOT NULL DEFAULT '', negative_prompt TEXT NOT NULL DEFAULT '', "
        "parameters TEXT NOT NULL DEFAULT '{}', workflow TEXT NOT NULL DEFAULT '', "
        "seed INTEGER, model TEXT, sampler TEXT, steps INTEGER, cfg REAL, "
        "thumb_path TEXT, thumb_status TEXT NOT NULL DEFAULT 'pending', "
        "favorite INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, "
        "indexed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    )
    migrate_media_kind(conn)
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(images)").fetchall()}
    assert "kind" in cols
    assert "duration_seconds" in cols
    assert "video_codec" in cols
    assert "audio_codec" in cols
    assert "fps" in cols
    # 幂等
    migrate_media_kind(conn)
