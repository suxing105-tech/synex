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
    r = client.put("/api/settings", json={"thumb_size": 200})
    assert r.status_code == 200
    assert r.json()["thumb_size"] == 200


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
