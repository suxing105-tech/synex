from pathlib import Path
from unittest.mock import AsyncMock
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.indexer import Indexer
from app.routes import settings as routes
from .conftest import make_png


@pytest.fixture
def directory_client(init_db, tmp_data_dir, monkeypatch):
    indexer = Indexer()
    indexer.watch_added_directory = AsyncMock()
    monkeypatch.setattr(routes, "get_indexer", lambda: indexer)
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app) as client:
        yield client, indexer, tmp_data_dir
    indexer.shutdown()


def test_import_preserves_old_directories_and_deduplicates(directory_client):
    client, indexer, base = directory_client
    old = base / "old"; old.mkdir()
    new = base / "中文 output"; new.mkdir()
    child = new / "子文件夹"; child.mkdir()
    make_png(child / "image.png")
    indexer.update_config(watch_dirs=[str(old)])
    response = client.post("/api/directories/import", json={"path": str(new)})
    assert response.status_code == 200, response.text
    assert indexer.config.watch_dirs == [str(old), str(new.resolve())]
    assert indexer.get_progress()["indexed"] == 1
    assert not indexer.get_progress()["running"]
    response = client.post("/api/directories/import", json={"path": str(new) + "/../中文 output/"})
    assert response.status_code == 200
    assert len(indexer.config.watch_dirs) == 2
    indexer.watch_added_directory.assert_awaited()


@pytest.mark.parametrize("kind", ["missing", "file", "empty", "permission"])
def test_invalid_paths_do_not_change_settings(directory_client, kind, monkeypatch):
    client, indexer, base = directory_client
    original = list(indexer.config.watch_dirs)
    target = base / "new"
    if kind == "file": target.write_text("file")
    if kind == "permission":
        target.mkdir()
        def denied(*args): raise PermissionError("denied")
        monkeypatch.setattr(routes.os, "scandir", denied)
    response = client.post("/api/directories/import", json={"path": "" if kind == "empty" else str(target)})
    assert response.status_code == 400, response.text
    assert indexer.config.watch_dirs == original
    indexer.watch_added_directory.assert_not_awaited()


def test_validation_has_no_side_effects_and_rechecks_at_import(directory_client):
    client, indexer, base = directory_client
    target = base / "transient"; target.mkdir()
    old = list(indexer.config.watch_dirs)
    assert client.post("/api/directories/validate", json={"path": str(target)}).status_code == 200
    assert indexer.config.watch_dirs == old
    target.rmdir()
    assert client.post("/api/directories/import", json={"path": str(target)}).status_code == 400
    assert indexer.config.watch_dirs == old


def test_empty_directory_is_saved_and_finishes(directory_client):
    client, indexer, base = directory_client
    target = base / "empty"; target.mkdir()
    assert client.post("/api/directories/import", json={"path": str(target)}).status_code == 200
    assert str(target) in indexer.config.watch_dirs
    assert indexer.get_progress()["total"] == 0
    assert indexer.get_progress()["error"] is None


def test_new_and_legacy_import_share_busy_guard(directory_client):
    client, indexer, base = directory_client
    assert routes._scan_request_lock.acquire(False)
    try:
        for path in ["/api/directories/import", "/api/scan"]:
            assert client.post(path, json={"path": str(base)}).status_code == 409
    finally: routes._scan_request_lock.release()
    assert not indexer.get_progress()["running"]


def test_scan_exception_is_reported_and_releases_guard(directory_client, monkeypatch):
    client, indexer, base = directory_client
    def fail(*args): raise OSError("unplugged")
    monkeypatch.setattr(indexer, "scan", fail)
    assert client.post("/api/directories/import", json={"path": str(base)}).status_code == 200
    assert indexer.get_progress()["error"]
    assert not indexer.get_progress()["running"]
    assert routes._scan_request_lock.acquire(False)
    routes._scan_request_lock.release()


def test_scan_reports_unreadable_subdirectory(init_db, tmp_data_dir, monkeypatch):
    from app import indexer as module
    indexer = Indexer()
    def walk(root, *, onerror, followlinks):
        onerror(PermissionError("subdirectory denied"))
        yield str(root), [], []
    monkeypatch.setattr(module.os, "walk", walk)
    try:
        progress = indexer.scan(tmp_data_dir)
        assert "1" in progress["error"]
        assert not progress["running"]
    finally: indexer.shutdown()


@pytest.mark.asyncio
async def test_added_watch_keeps_existing_watch_and_skips_covered_paths(init_db, tmp_data_dir):
    indexer = Indexer()
    class Observer:
        calls = []
        def schedule(self, handler, path, recursive): self.calls.append((path, recursive))
    observer = Observer()
    old = tmp_data_dir / "old"; old.mkdir()
    new = tmp_data_dir / "new"; new.mkdir()
    indexer._observer = observer
    indexer._watched_dirs = {str(old)}
    try:
        await indexer.watch_added_directory(new)
        await indexer.watch_added_directory(new)
        await indexer.watch_added_directory(old / "child")
        assert observer.calls == [(str(new), True)]
        assert str(old) in indexer._watched_dirs
    finally:
        indexer._observer = None
        indexer.shutdown()


def test_failed_settings_save_does_not_mutate_memory(init_db, monkeypatch):
    from app import indexer as module
    indexer = Indexer()
    original = list(indexer.config.watch_dirs)
    def fail(*args): raise OSError("disk full")
    monkeypatch.setattr(module, "save_config", fail)
    try:
        with pytest.raises(OSError): indexer.update_config(watch_dirs=["new"])
        assert indexer.config.watch_dirs == original
    finally: indexer.shutdown()
