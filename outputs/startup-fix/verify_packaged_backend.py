"""实际打包后端验证：READY、健康接口、父进程退出释放端口、端口冲突。"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request

root = Path(__file__).resolve().parent
exe = root / "sidecar/python-backend.exe"
flags = subprocess.CREATE_NO_WINDOW
with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]

parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], creationflags=flags)
env = dict(os.environ, SUXING_PARENT_PID=str(parent.pid), SUXING_PORT=str(port),
           SUXING_DATA_DIR=str(root / "smoke-data"), PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")
try:
    with (root / "smoke.stdout").open("wb") as out, (root / "smoke.stderr").open("wb") as err:
        child = subprocess.Popen([str(exe)], env=env, stdout=out, stderr=err, creationflags=flags)
        try:
            deadline = time.monotonic() + 25
            while "READY " not in (root / "smoke.stdout").read_text(encoding="utf-8"):
                assert child.poll() is None, "后端提前退出"
                assert time.monotonic() < deadline, "未收到 READY"
                time.sleep(.1)
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=3) as response:
                assert json.load(response) == {"status": "ok"}
            assert "Application startup complete" in (root / "smoke.stderr").read_text(encoding="utf-8")
            parent.terminate()
            parent.wait(timeout=5)
            assert child.wait(timeout=10) == 0
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
    with socket.socket() as occupied:
        occupied.bind(("127.0.0.1", port))
        occupied.listen()
        env.pop("SUXING_PARENT_PID")
        result = subprocess.run([str(exe)], env=env, capture_output=True, timeout=25, creationflags=flags)
        assert result.returncode != 0
        assert b"READY " not in result.stdout
        (root / "conflict.stderr").write_bytes(result.stderr)
    print("PASS: packaged READY, health, parent-exit cleanup, port release, occupied-port failure")
finally:
    if parent.poll() is None:
        parent.kill()
    parent.wait(timeout=5)
