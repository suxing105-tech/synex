"""用隔离数据目录验证最终打包后端的桌面导入链路。"""
import asyncio
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time
import urllib.request
import websockets

root = Path(__file__).resolve().parent
samples = root / "sample-images"
samples.mkdir(exist_ok=True)
shutil.copyfile(root.parents[1] / "frontend/public/logo.png", samples / "test-logo.png")
with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
base = f"http://127.0.0.1:{port}"
origin = "http://tauri.localhost"


def request(path, method="GET", body=None, extra=None):
    headers = {"Origin": origin, **(extra or {})}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    with urllib.request.urlopen(urllib.request.Request(base + path, data=data, headers=headers, method=method), timeout=5) as response:
        assert response.headers["access-control-allow-origin"] == origin
        return response.headers, response.read()


async def verify():
    request("/api/settings", "OPTIONS", extra={"Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type"})
    _, body = request("/api/settings", "PUT", {"watch_dirs": [str(samples)]})
    assert json.loads(body)["watch_dirs"] == [str(samples)]
    async with websockets.connect(f"ws://127.0.0.1:{port}/ws/events", origin=origin) as ws:
        request("/api/scan", "POST", {"path": str(samples)})
        event = json.loads(await asyncio.wait_for(ws.recv(), 10))
        assert event["type"] in {"scan_progress", "image_indexed"}
    deadline = time.monotonic() + 10
    while True:
        _, body = request("/api/images")
        feed = json.loads(body)
        if feed["items"]:
            break
        assert time.monotonic() < deadline
        await asyncio.sleep(.1)
    item = feed["items"][0]
    for image_path in [item["original_url"], f'/api/images/{item["id"]}/file']:
        headers, image = request(image_path)
        assert headers["content-type"].startswith("image/") and len(image) > 100
    print("PASS: desktop CORS preflight, save directory, scan, image preview, original image, WebSocket event")


env = dict(os.environ, SUXING_PORT=str(port), SUXING_DATA_DIR=str(root / "test-data"), SUXING_PARENT_PID=str(os.getpid()))
with (root / "import.stdout").open("wb") as out, (root / "import.stderr").open("wb") as err:
    child = subprocess.Popen([str(root / "sidecar/python-backend.exe")], env=env, stdout=out, stderr=err, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        deadline = time.monotonic() + 25
        while "READY " not in (root / "import.stdout").read_text(encoding="utf-8"):
            assert child.poll() is None, "后端提前退出"
            assert time.monotonic() < deadline, "后端启动超时"
            time.sleep(.1)
        asyncio.run(verify())
    finally:
        if child.poll() is None:
            child.terminate()
        child.wait(timeout=5)
