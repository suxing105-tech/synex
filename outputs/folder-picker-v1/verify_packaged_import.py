"""Exercise the shipped backend with isolated directories, never user images."""
import json
import os
import socket
import subprocess
import time
import uuid
from pathlib import Path
from urllib.request import Request, build_opener, ProxyHandler
from urllib.error import HTTPError, URLError
from PIL import Image

output = Path(__file__).resolve().parent
base = output / "test-data" / uuid.uuid4().hex
data = base / "data"; data.mkdir(parents=True)
old = base / "原有目录"; old.mkdir()
new = base / "中文 output"; new.mkdir()
sub = new / "子文件夹"; sub.mkdir()
Image.new("RGB", (8, 8), "red").save(sub / "初始图片.png")
(data / "config.json").write_text(json.dumps({"watch_dirs": [str(old)], "live_enabled": True}), encoding="utf-8")
with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0)); port = probe.getsockname()[1]
token = uuid.uuid4().hex
env = {**os.environ, "SUXING_DATA_DIR": str(data), "SUXING_PORT": str(port), "SUXING_PARENT_PID": str(os.getpid()), "SUXING_CONTROL_TOKEN": token}
opener = build_opener(ProxyHandler({}))
def call(path, method="GET", body=None, auth=False):
    headers = {"Content-Type": "application/json"}
    if auth: headers["x-suxing-control"] = token
    req = Request(f"http://127.0.0.1:{port}{path}", method=method, headers=headers,
                  data=json.dumps(body).encode() if body is not None else (b"" if method == "POST" else None))
    with opener.open(req, timeout=15) as response: return json.load(response)
def wait_for(fn):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            if fn(): return
        except (URLError, ConnectionError): pass
        time.sleep(.15)
    raise AssertionError("Timed out waiting for packaged backend")

with (output / "import-smoke.stdout").open("w", encoding="utf-8") as out, (output / "import-smoke.stderr").open("w", encoding="utf-8") as err:
    child = subprocess.Popen([str(output / "sidecar/python-backend.exe")], env=env, stdout=out, stderr=err, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        wait_for(lambda: call("/api/desktop/status")["version"] == "0.2.1")
        before = call("/api/settings")["watch_dirs"]
        call("/api/directories/validate", "POST", {"path": str(new)})
        assert call("/api/settings")["watch_dirs"] == before
        call("/api/directories/import", "POST", {"path": str(new)})
        wait_for(lambda: not call("/api/scan/progress")["running"])
        assert call("/api/scan/progress")["indexed"] == 1
        assert call("/api/settings")["watch_dirs"] == [str(old), str(new)]
        call("/api/directories/import", "POST", {"path": str(new) + "/"})
        wait_for(lambda: not call("/api/scan/progress")["running"])
        assert len(call("/api/settings")["watch_dirs"]) == 2
        Image.new("RGB", (8, 8), "blue").save(new / "新增加图片.png")
        Image.new("RGB", (8, 8), "green").save(old / "原监听仍有效.png")
        wait_for(lambda: call("/api/stats")["total_images"] == 3)
        try: call("/api/directories/import", "POST", {"path": str(base / "不存在")})
        except HTTPError as e: assert e.code == 400
        else: raise AssertionError("invalid directory accepted")
        assert len(call("/api/settings")["watch_dirs"]) == 2
        call("/api/desktop/prepare-update", "POST", auth=True)
        try: call("/api/directories/import", "POST", {"path": str(new)})
        except HTTPError as e: assert e.code == 409
        else: raise AssertionError("update write freeze was bypassed")
        call("/api/desktop/shutdown", "POST", auth=True)
        assert child.wait(timeout=20) == 0
        with socket.socket() as probe: probe.bind(("127.0.0.1", port))
        (output / "packaged-import-verification.json").write_text(json.dumps({
            "version": "0.2.1", "chinese_path": True, "recursive_import": True,
            "existing_directories_preserved": True, "deduplicated": True,
            "new_and_existing_live_watch": True, "validation_without_writes": True,
            "invalid_path_rejected": True, "update_freeze_compatible": True,
            "shutdown_and_port_release": True}, indent=2), encoding="utf-8")
        print("Packaged import: validation, recursive import, old/new Live, deduplication and update protection PASS")
    finally:
        if child.poll() is None: child.terminate(); child.wait(timeout=10)
