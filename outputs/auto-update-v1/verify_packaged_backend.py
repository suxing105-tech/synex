"""Smoke test the real packaged sidecar using isolated data and an ephemeral port."""
import json
import os
import socket
import sqlite3
import subprocess
import time
import uuid
from pathlib import Path
from urllib.request import Request, build_opener, ProxyHandler
from urllib.error import HTTPError, URLError

root = Path(__file__).resolve().parent
data = root / "smoke-data" / uuid.uuid4().hex
data.mkdir(parents=True)
with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
token = uuid.uuid4().hex
env = {**os.environ, "SUXING_DATA_DIR": str(data), "SUXING_PORT": str(port),
       "SUXING_PARENT_PID": str(os.getpid()), "SUXING_CONTROL_TOKEN": token}
opener = build_opener(ProxyHandler({}))
def request(path, method="GET", body=None, auth=False):
    headers = {"Content-Type": "application/json"}
    if auth: headers["x-suxing-control"] = token
    req = Request(f"http://127.0.0.1:{port}{path}",
                  data=json.dumps(body).encode() if body is not None else (b"" if method == "POST" else None),
                  headers=headers, method=method)
    with opener.open(req, timeout=20) as result: return json.load(result)

with (root / "packaged-backend.stdout").open("w", encoding="utf-8") as out, (root / "packaged-backend.stderr").open("w", encoding="utf-8") as err:
    child = subprocess.Popen([str(root / "sidecar/python-backend.exe")], env=env, stdout=out, stderr=err,
                             creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        deadline = time.monotonic() + 35
        while True:
            try:
                status = request("/api/desktop/status")
                break
            except (URLError, ConnectionError):
                if child.poll() is not None or time.monotonic() > deadline: raise
                time.sleep(.2)
        assert status["version"] == "0.2.0", status
        assert status["protocol"] == 1
        with sqlite3.connect(data / "db.sqlite") as db:
            db.execute("INSERT INTO tags(name) VALUES ('升级保留测试')")
        prepared = request("/api/desktop/prepare-update", "POST", auth=True)
        with sqlite3.connect(Path(prepared["backup"]) / "db.sqlite") as saved:
            assert saved.execute("SELECT name FROM tags WHERE name='升级保留测试'").fetchone()
            assert saved.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        try: request("/api/settings", "PUT", {"live_enabled": False})
        except HTTPError as error: assert error.code == 409
        else: raise AssertionError("writes were not frozen")
        request("/api/desktop/cancel-update", "POST", auth=True)
        request("/api/settings", "PUT", {"live_enabled": False})
        request("/api/desktop/prepare-update", "POST", auth=True)
        request("/api/desktop/shutdown", "POST", auth=True)
        assert child.wait(timeout=20) == 0
        with socket.socket() as probe: probe.bind(("127.0.0.1", port))
        (root / "packaged-backend-verification.json").write_text(json.dumps({
            "version": status["version"], "backup_verified": True, "write_freeze_verified": True,
            "cancel_restores_writes": True, "graceful_shutdown": True, "port_released": True,
            "data": str(data), "backup": prepared["backup"]}, ensure_ascii=False, indent=2), encoding="utf-8")
        print("Packaged backend: backup, freeze, recovery, shutdown and port release PASS")
    finally:
        if child.poll() is None: child.terminate(); child.wait(timeout=10)
