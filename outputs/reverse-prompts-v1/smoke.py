"""Packaged sidecar integration check with an isolated database and local model API.

Run from the repository root with backend/.venv/Scripts/python.exe.
--serve retains the isolated sidecar and mock API for browser inspection.
"""
import argparse
import base64
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
DATA = OUT / "smoke-data"
DATA.mkdir(exist_ok=True)
KEY = "synthetic-smoke-credential"


class MockModel(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        assert self.path == "/vendor/v1/chat/completions"
        assert self.headers.get("Authorization") == f"Bearer {KEY}"
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        url = body["messages"][1]["content"][1]["image_url"]["url"]
        im = Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1])))
        assert max(im.size) <= 2048
        text = json.dumps({"prompt_zh": "白色背景上，一朵红色花朵居中绽放，柔和自然光照亮细腻花瓣，简洁构图，写实摄影风格。", "prompt_en": "A red flower blooming in the center of a white background, soft natural light revealing delicate petals, minimalist composition, realistic photography."}, ensure_ascii=False)
        result = json.dumps({"choices": [{"message": {"content": text}}]}, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(result)))
        self.end_headers(); self.wfile.write(result)


def unused_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve", action="store_true")
    args = parser.parse_args()
    model_server = ThreadingHTTPServer(("127.0.0.1", 0), MockModel)
    threading.Thread(target=model_server.serve_forever, daemon=True).start()
    port = unused_port()
    env = {**os.environ, "SUXING_PORT": str(port), "SUXING_DATA_DIR": str(DATA), "SUXING_PARENT_PID": str(os.getpid())}
    env.pop("SUXING_CONTROL_TOKEN", None)
    exe = OUT / "sidecar" / "python-backend.exe"
    client = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=30)
    processes = []

    def launch():
        output = (OUT / "smoke.stdout").open("w", encoding="utf-8")
        errors = (OUT / "smoke.stderr").open("w", encoding="utf-8")
        proc = subprocess.Popen([str(exe)], env=env, stdout=output, stderr=errors, creationflags=subprocess.CREATE_NO_WINDOW)
        processes.append(proc)
        for _ in range(120):
            if proc.poll() is not None:
                raise RuntimeError("packaged sidecar exited")
            try:
                if client.get("/api/health").status_code == 200:
                    return proc
            except httpx.RequestError:
                pass
            time.sleep(.25)
        raise RuntimeError("packaged sidecar startup timeout")

    def stop(proc):
        # Terminate only the task-owned process tree (PyInstaller launcher + child).
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, check=False)
        proc.wait(timeout=15)

    try:
        proc = launch()
        configured = client.post("/api/model-configs", json={"name": "本地联调模型", "base_url": f"http://127.0.0.1:{model_server.server_port}/vendor/v1", "model": "mock-vision", "api_key": KEY}).json()
        assert configured["has_api_key"] and KEY not in json.dumps(configured)
        test = client.post("/api/model-configs/test", json={**configured, "config_id": configured["id"]})
        assert test.status_code == 200, test.text
        image = Image.new("RGB", (640, 480), "white")
        from PIL import ImageDraw
        draw = ImageDraw.Draw(image)
        for box in [(240, 130, 340, 270), (300, 130, 400, 270), (260, 230, 380, 340), (200, 180, 340, 280), (300, 180, 440, 280)]:
            draw.ellipse(box, fill=(210, 40, 60))
        draw.ellipse((290, 200, 350, 260), fill=(245, 190, 35))
        buffer = io.BytesIO(); image.save(buffer, "PNG")
        imported = client.post("/api/images/import", files={"files": ("反推测试花朵.png", buffer.getvalue(), "image/png")})
        assert imported.status_code == 200, imported.text
        image_id = imported.json()["saved"][0]["id"]
        route = f"/api/images/{image_id}/reverse-prompts"
        generated = client.post(route, json={"model_config_id": configured["id"]})
        assert generated.status_code == 200, generated.text
        record = generated.json()
        assert record["status"] == "complete"
        edited = client.post(route + "/edits", json={"parent_id": record["id"], "prompt_zh": "居中的红花，白色背景，柔和自然光。", "prompt_en": "Centered red flower, white background, soft natural light."})
        assert edited.status_code == 200
        assert client.get(route).json()["total"] == 2
        stop(proc); proc = launch()
        assert client.get(route).json()["total"] == 2
        # A successful call after restart proves the packaged DPAPI read path too.
        assert client.post(route, json={"model_config_id": configured["id"]}).status_code == 200
        client.put("/api/reverse-prompt-settings", json={"default_model_id": configured["id"], "instruction": "描述画面主体、构图和光线。"}).raise_for_status()
        report = {"packaged_backend": "passed", "encrypted_key_restart": "passed", "model_test": "passed", "image_import": "passed", "generation_and_edit": "passed", "history_restart": "passed", "backend_port": port, "image_id": image_id, "model_id": configured["id"]}
        (OUT / "smoke-result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False), flush=True)
        if args.serve:
            print("Serving isolated test data; Ctrl+C to stop.", flush=True)
            while True:
                time.sleep(1)
    finally:
        for proc in processes:
            if proc.poll() is None:
                stop(proc)
        model_server.shutdown()
        client.close()


if __name__ == "__main__":
    main()
