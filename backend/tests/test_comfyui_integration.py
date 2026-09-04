"""ComfyUI 集成端到端测试：probe + status + open_workflow + config。

覆盖：
- ``probe()`` 离线返回 False（用 monkeypatch 替成 ``URLError``）。
- ``/api/integrations/comfyui/status`` 返回 ``enabled`` 与 ``running`` 字段。
- ``PUT /config`` 更新 ``data/config.json`` 并触发重探测。
- ``POST /open_workflow/<id>``：
  - 图片无 workflow → 400 ``no_workflow``
  - 图片不存在 → 404
  - 有 workflow + comfyui 离线 → 409 ``comfyui_offline``（待实现），目前为写文件 + 返回 offline 信息
  - 有 workflow + comfyui 在线（mock） → 200，``file_path`` 落盘，``browser_opened`` 字段存在
- ``ImageSummary.has_workflow`` 字段在 feed 中能正确返回。
"""
from __future__ import annotations

import urllib.error
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.db import init_pool
from app.indexer import Indexer
from app.integrations import comfyui
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
    # 不启动 lifespan，避免 watchdog 在 tmp_path 下创建文件
    p1 = make_png(
        tmp_path / "a.png",
        prompt=make_comfy_prompt("hello", "low quality"),
        workflow={"a": 1},
    )
    Indexer()._process_path_sync(p1)
    p2 = make_png(tmp_path / "b.png", prompt=make_comfy_prompt("plain", ""))  # 无 workflow
    Indexer()._process_path_sync(p2)
    with TestClient(app) as c:
        yield c



@pytest.fixture
def offline_probe(monkeypatch):
    """让 comfyui.probe 一律返回 False，避免依赖本机是否真在跑。"""
    monkeypatch.setattr("app.routes.comfyui.probe", lambda url: False)
    return monkeypatch


@pytest.fixture
def online_probe(monkeypatch):
    """让 comfyui.probe 一律返回 True，模拟本机 ComfyUI 在线。"""
    monkeypatch.setattr("app.routes.comfyui.probe", lambda url: True)
    return monkeypatch
# ---------- probe() ----------


def test_probe_offline(monkeypatch):
    """指向不存在的端口 → probe 返回 False。"""

    def _fail(*a, **kw):
        raise urllib.error.URLError("refused")

    monkeypatch.setattr(urllib.request, "urlopen", _fail)
    assert comfyui.probe("http://127.0.0.1:1") is False


def test_probe_online(monkeypatch):
    """模拟 200 → probe 返回 True。"""

    class _Resp:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def _ok(*a, **kw):
        return _Resp()

    monkeypatch.setattr(urllib.request, "urlopen", _ok)
    assert comfyui.probe("http://127.0.0.1:8188") is True


def test_probe_timeout(monkeypatch):
    """超时 → False。"""

    def _timeout(*a, **kw):
        raise TimeoutError("slow")

    monkeypatch.setattr(urllib.request, "urlopen", _timeout)
    assert comfyui.probe("http://127.0.0.1:8188") is False


# ---------- /status ----------


def test_status_offline(client, offline_probe):
    r = client.get("/api/integrations/comfyui/status")
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is True
    assert body["running"] is False  # 探测不到 8188
    assert body["url"] == "http://127.0.0.1:8188"
    assert body["checked_at"] > 0


def test_status_disabled(client):
    client.put("/api/integrations/comfyui/config", json={"enabled": False})
    r = client.get("/api/integrations/comfyui/status")
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is False
    assert body["running"] is False  # 禁用时直接返回 False，不探测


# ---------- /config ----------


def test_update_config_invalid_url(client):
    r = client.put("/api/integrations/comfyui/config", json={"url": "ftp://x"})
    assert r.status_code == 400


def test_update_config_empty_url(client):
    r = client.put("/api/integrations/comfyui/config", json={"url": "   "})
    assert r.status_code == 400


def test_update_config_ok(client, tmp_path: Path):
    r = client.put(
        "/api/integrations/comfyui/config",
        json={"url": "http://127.0.0.1:9999", "enabled": True},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["url"] == "http://127.0.0.1:9999"
    # config.json 已落盘
    cfg_path = tmp_path / "config.json"
    assert cfg_path.exists()
    import json

    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    assert cfg["comfyui_url"] == "http://127.0.0.1:9999"
    assert cfg["comfyui_enabled"] is True


# ---------- /open_workflow ----------


def test_open_workflow_not_found(client):
    r = client.post("/api/integrations/comfyui/open_workflow/9999")
    assert r.status_code == 404


def test_open_workflow_no_workflow(client):
    """无 workflow 的图片（id=2） → 400 no_workflow。"""
    items = client.get("/api/images", params={"limit": 10}).json()["items"]
    target = next(x for x in items if x["filename"] == "b.png")
    r = client.post(f"/api/integrations/comfyui/open_workflow/{target['id']}")
    assert r.status_code == 400
    assert r.json()["detail"] == "no_workflow"


def test_open_workflow_disabled(client):
    client.put("/api/integrations/comfyui/config", json={"enabled": False})
    items = client.get("/api/images", params={"limit": 10}).json()["items"]
    target = next(x for x in items if x["filename"] == "a.png")
    r = client.post(f"/api/integrations/comfyui/open_workflow/{target['id']}")
    assert r.status_code == 403


def test_open_workflow_ok_comfyui_offline(client, tmp_path: Path, offline_probe):
    """comfyui 探测不到 → 仍落临时文件，browser_opened=False。"""
    items = client.get("/api/images", params={"limit": 10}).json()["items"]
    target = next(x for x in items if x["filename"] == "a.png")
    r = client.post(f"/api/integrations/comfyui/open_workflow/{target['id']}")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["browser_opened"] is False
    assert body["image_id"] == target["id"]
    # 文件已落盘到 tmp_path/comfyui_temp/<id>.json
    tmp = tmp_path / "comfyui_temp" / f"{target['id']}.json"
    assert tmp.exists()
    # 内容是原始 workflow JSON 字符串
    assert tmp.read_text(encoding="utf-8") == '{"a": 1}'


def test_open_workflow_ok_with_browser_open(client, tmp_path: Path, monkeypatch):
    """comfyui 在线 + monkeypatch webbrowser.open → browser_opened=True。"""
    # 让 probe 永远 True
    monkeypatch.setattr("app.integrations.comfyui.probe", lambda url: True)
    # 让 webbrowser.open 返回一个 truthy（True）对象
    monkeypatch.setattr("app.routes.comfyui.webbrowser.open", lambda *a, **kw: True)
    items = client.get("/api/images", params={"limit": 10}).json()["items"]
    target = next(x for x in items if x["filename"] == "a.png")
    r = client.post(f"/api/integrations/comfyui/open_workflow/{target['id']}")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["browser_opened"] is True
    assert "comfyui_temp" in body["file_path"]


# ---------- feed has_workflow 字段 ----------


def test_feed_has_workflow_field(client):
    """feed items 应携带 has_workflow 字段：有 workflow 的为 True，无的为 False。"""
    items = client.get("/api/images", params={"limit": 10}).json()["items"]
    a = next(x for x in items if x["filename"] == "a.png")
    b = next(x for x in items if x["filename"] == "b.png")
    assert a["has_workflow"] is True
    assert b["has_workflow"] is False


# ---------- temp 文件清理（可选） ----------


def test_list_temp_files(client):
    items = client.get("/api/images", params={"limit": 10}).json()["items"]
    target = next(x for x in items if x["filename"] == "a.png")
    client.post(f"/api/integrations/comfyui/open_workflow/{target['id']}")
    r = client.get("/api/integrations/comfyui/temp_files")
    assert r.status_code == 200
    body = r.json()
    assert f"{target['id']}.json" in body["files"]
