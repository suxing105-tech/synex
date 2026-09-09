import sqlite3
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import maintenance as m


@pytest.fixture
def client(monkeypatch, init_db, tmp_data_dir):
    monkeypatch.setenv("SUXING_CONTROL_TOKEN", "test-token")
    monkeypatch.setattr(m, "gate", m.WriteGate())
    monkeypatch.setattr(m, "get_pool", lambda: init_db)
    monkeypatch.setattr(m, "data_dir", lambda: tmp_data_dir)
    class Indexer:
        running = False
        pause_for_update = AsyncMock()
        resume_after_update = AsyncMock()
        def get_progress(self): return {"running": self.running}
    indexer = Indexer()
    monkeypatch.setattr(m, "get_indexer", lambda: indexer)
    app = FastAPI()
    app.add_middleware(m.WriteGateMiddleware)
    app.include_router(m.router)
    @app.post("/write")
    def write(): return {"ok": True}
    @app.get("/read")
    def read(): return {"ok": True}
    with TestClient(app) as c:
        c.indexer = indexer
        yield c


HEADERS = {"x-suxing-control": "test-token"}

@pytest.mark.parametrize("route", ["prepare-update", "cancel-update", "shutdown"])
def test_control_requires_secret(client, route):
    assert client.post(f"/api/desktop/{route}").status_code == 403
    assert client.post(f"/api/desktop/{route}", headers={"x-suxing-control": "wrong"}).status_code == 403
    assert not m.gate.frozen

def test_backup_contains_committed_wal_data_and_config(client, init_db, tmp_data_dir):
    db = init_db.main()
    db.execute("INSERT INTO tags(name) VALUES ('保留标签')")
    db.commit()
    (tmp_data_dir / "config.json").write_text('{"watch_dirs": ["D:/图片"]}', encoding="utf-8")
    response = client.post("/api/desktop/prepare-update", headers=HEADERS)
    assert response.status_code == 200, response.text
    backup = Path(response.json()["backup"])
    with sqlite3.connect(backup / "db.sqlite") as saved:
        assert saved.execute("SELECT name FROM tags").fetchone()[0] == "保留标签"
        assert saved.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert (backup / "config.json").read_bytes() == (tmp_data_dir / "config.json").read_bytes()
    assert client.post("/write").status_code == 409
    assert client.get("/read").status_code == 200
    assert client.post("/api/desktop/cancel-update", headers=HEADERS).status_code == 200
    assert client.post("/write").status_code == 200
    client.indexer.resume_after_update.assert_awaited_once()

def test_scan_and_active_writes_block_prepare(client):
    client.indexer.running = True
    assert client.post("/api/desktop/prepare-update", headers=HEADERS).status_code == 409
    client.indexer.running = False
    assert m.gate.enter()
    assert client.post("/api/desktop/prepare-update", headers=HEADERS).status_code == 409
    m.gate.leave()
    assert not m.gate.frozen

def test_backup_failure_resumes_writes(client, monkeypatch):
    def fail(): raise OSError("磁盘空间不足")
    monkeypatch.setattr(m, "backup_data", fail)
    response = client.post("/api/desktop/prepare-update", headers=HEADERS)
    assert response.status_code == 500
    assert "磁盘空间不足" in response.text
    assert client.post("/write").status_code == 200
    client.indexer.resume_after_update.assert_awaited_once()

def test_shutdown_requires_prepared_state(client):
    assert client.post("/api/desktop/shutdown", headers=HEADERS).status_code == 409
    m.gate.freeze()
    assert client.post("/api/desktop/shutdown", headers=HEADERS).status_code == 503

def test_gate_rejects_duplicate_prepare_and_tracks_writes():
    gate = m.WriteGate()
    assert gate.enter()
    assert not gate.freeze()
    gate.leave()
    assert gate.freeze()
    assert not gate.freeze()
    assert not gate.enter()
    gate.release()
    assert gate.enter()
