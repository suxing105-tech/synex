"""ComfyUI 集成端到端测试：probe + status + open_workflow + config + 文件命名。

覆盖：
- ``probe()`` 离线 / 在线 / 超时。
- ``/api/integrations/comfyui/status`` 返回 ``enabled`` 与 ``running`` 字段。
- ``PUT /config`` 更新 ``data/config.json`` 并触发重探测。
- ``POST /open_workflow/<id>``：
  - 图片无 workflow → 400 ``no_workflow``
  - 图片不存在 → 404
  - 有 workflow + comfyui 离线 → 200，``browser_opened=False``，文件以图片文件名落盘
  - 有 workflow + comfyui 在线 → 200，``browser_opened=False``（后端不再弹窗）
  - 返回 ``workflow_name`` 等于图片文件名（去扩展名）
  - 冲突时自动追加 ``_1`` / ``_2`` 后缀
- ``sanitize_filename``：去扩展名 / 清洗非法字符 / 兜底
- ``ImageSummary.has_workflow`` 字段在 feed 中能正确返回。
"""
from __future__ import annotations

import os
import socket
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
    """让状态探测一律报「没在跑」，避免依赖本机是否真开着 ComfyUI。"""
    monkeypatch.setattr(
        "app.routes.comfyui.probe_detail",
        lambda url, timeout=None: comfyui.ProbeResult(False, "127.0.0.1:8188 上没有服务在监听", "refused"),
    )
    return monkeypatch


@pytest.fixture
def online_probe(monkeypatch):
    """让状态探测一律报「在跑」，模拟本机 ComfyUI 在线。"""
    monkeypatch.setattr("app.routes.comfyui.probe_detail", lambda url, timeout=None: comfyui.ProbeResult(True))
    return monkeypatch

# ---------- probe() ----------
#
# 这些用例一律打桩在 ``comfyui._open`` 上，不是 ``urllib.request.urlopen``：
# 探测走的是自建 opener（代理表为空），打桩 urlopen 已经拦不到它了——
# 真打 urlopen 的话，这台机器上开着 ComfyUI 就会一路全绿，把回归全放过。


def _refused(*a, **kw):
    raise urllib.error.URLError(ConnectionRefusedError("拒绝连接"))


def test_probe_offline(monkeypatch):
    """端口上没人 → False。"""
    monkeypatch.setattr(comfyui, "_open", _refused)
    assert comfyui.probe("http://127.0.0.1:1") is False


def test_probe_online(monkeypatch):
    """任一探测路径 200 → True。"""

    class _Resp:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(comfyui, "_open", lambda *a, **kw: _Resp())
    assert comfyui.probe("http://127.0.0.1:8188") is True


def test_probe_timeout(monkeypatch):
    """超时 → False，并且原因说得出超时。"""

    def _timeout(*a, **kw):
        raise TimeoutError("slow")

    monkeypatch.setattr(comfyui, "_open", _timeout)
    result = comfyui.probe_detail("http://127.0.0.1:8188", timeout=3.0)
    assert result.running is False
    assert result.reason_code == "timeout"
    assert "3 秒" in result.reason


def test_probe_reason_refused_names_host_and_port(monkeypatch):
    """「没连上」必须说清楚是哪儿没人监听——只说没连上等于把定位丢给用户。"""
    monkeypatch.setattr(comfyui, "_open", _refused)
    result = comfyui.probe_detail("http://127.0.0.1:8188")
    assert result.running is False
    assert result.reason_code == "refused"
    assert "127.0.0.1:8188" in result.reason


def test_probe_reason_http_error_is_not_running(monkeypatch):
    """有人应答但返回 5xx：不算在跑，原因要说「不像 ComfyUI」。"""

    def _boom(*a, **kw):
        raise urllib.error.HTTPError("http://127.0.0.1:8188/", 502, "Bad Gateway", {}, None)

    monkeypatch.setattr(comfyui, "_open", _boom)
    result = comfyui.probe_detail("http://127.0.0.1:8188")
    assert result.running is False
    assert result.reason_code == "http"
    assert "502" in result.reason


def test_probe_reason_dns(monkeypatch):
    """地址写成一个解析不了的主机名。"""

    def _gaierror(*a, **kw):
        raise urllib.error.URLError(socket.gaierror("no such host"))

    monkeypatch.setattr(comfyui, "_open", _gaierror)
    result = comfyui.probe_detail("http://comfyui-host:8188")
    assert result.reason_code == "dns"


def test_probe_ignores_environment_proxy():
    """环境变量里有代理也必须直连本机 ComfyUI。

    浏览器永远跳过 loopback，Python 不跳过。这一条不对，就会出现
    「ComfyUI 自己打得开、图库说连不上」，而且只在装了代理工具的机器上发生。
    """
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class _Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler 的命名
            body = b'{"system": {"comfyui_version": "0.43.0"}}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):  # 静音
            pass

    server = HTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    old = {k: os.environ.get(k) for k in ("HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy")}
    try:
        # 端口 9（discard）上不会有任何代理在听：一旦被用上，探测必然失败。
        os.environ["HTTP_PROXY"] = "http://127.0.0.1:9"
        os.environ["http_proxy"] = "http://127.0.0.1:9"
        os.environ.pop("NO_PROXY", None)
        os.environ.pop("no_proxy", None)
        url = f"http://127.0.0.1:{server.server_port}"
        assert comfyui.probe(url) is True
        assert comfyui.comfyui_version(url) == "0.43.0"
    finally:
        for key, value in old.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        server.shutdown()
        server.server_close()


def test_http_client_also_ignores_environment_proxy(monkeypatch):
    """执行链路那条（httpx）同样不能读环境代理：两条链路必须同一个口径。"""
    import asyncio
    import httpx

    from app.comfyui_client import ComfyUIClient

    client = ComfyUIClient("http://127.0.0.1:8188", transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    try:
        assert client._client.trust_env is False
    finally:
        asyncio.run(client.aclose())

# ---------- sanitize_filename ----------


def test_sanitize_filename_basic():
    """去扩展名 → stem。"""
    assert comfyui.sanitize_filename("foo.png") == "foo"
    assert comfyui.sanitize_filename("a/b/c.png") == "a_b_c"  # / 也算非法字符
    assert comfyui.sanitize_filename("no_ext") == "no_ext"


def test_sanitize_filename_unsafe_chars():
    """Windows / POSIX 非法字符 → 下划线。"""
    assert comfyui.sanitize_filename("a:b*c.png") == "a_b_c"
    assert comfyui.sanitize_filename("with spaces.png") == "with spaces"  # 空格保留
    assert comfyui.sanitize_filename("a\\b/c.png") == "a_b_c"
    assert comfyui.sanitize_filename("quote\"test.png") == "quote_test"


def test_sanitize_filename_empty_and_fallback():
    """空 / 纯符号 → ``workflow`` 兜底。"""
    assert comfyui.sanitize_filename("") == "workflow"
    assert comfyui.sanitize_filename("   ") == "workflow"
    assert comfyui.sanitize_filename("...png") == "workflow"


def test_sanitize_filename_length_cap():
    """超长 → 截断。"""
    long = "x" * 500
    out = comfyui.sanitize_filename(long + ".png")
    assert len(out) == comfyui._MAX_NAME_LEN
    assert out == "x" * comfyui._MAX_NAME_LEN


# ---------- write_workflow_temp ----------


def test_write_workflow_temp_uses_image_filename(tmp_path: Path, monkeypatch):
    """落盘文件名 = 图片文件名（去扩展名）。"""
    monkeypatch.setattr(comfyui, "data_dir", lambda: tmp_path)
    target = comfyui.write_workflow_temp("hello world.png", "{}")
    assert target is not None
    assert target.name == "hello world.json"
    assert target.exists()


def test_write_workflow_temp_collision_suffix(tmp_path: Path, monkeypatch):
    """重复同名 → ``_1`` / ``_2`` 后缀。"""
    monkeypatch.setattr(comfyui, "data_dir", lambda: tmp_path)
    p1 = comfyui.write_workflow_temp("dup.png", "{}")
    p2 = comfyui.write_workflow_temp("dup.png", "{}")
    p3 = comfyui.write_workflow_temp("dup.png", "{}")
    assert p1 is not None and p2 is not None and p3 is not None
    assert p1.name == "dup.json"
    assert p2.name == "dup_1.json"
    assert p3.name == "dup_2.json"
    assert p1.exists() and p2.exists() and p3.exists()


def test_write_workflow_temp_empty_returns_none(tmp_path: Path, monkeypatch):
    """空 workflow 字符串 → 返回 None。"""
    monkeypatch.setattr(comfyui, "data_dir", lambda: tmp_path)
    assert comfyui.write_workflow_temp("x.png", "") is None
    assert comfyui.write_workflow_temp("x.png", "   ") is None
    assert comfyui.write_workflow_temp("x.png", None) is None


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
    """comfyui 探测不到 → 仍落临时文件（文件名取自图片），browser_opened=False。"""
    items = client.get("/api/images", params={"limit": 10}).json()["items"]
    target = next(x for x in items if x["filename"] == "a.png")
    r = client.post(f"/api/integrations/comfyui/open_workflow/{target['id']}")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["browser_opened"] is False
    assert body["image_id"] == target["id"]
    assert body["workflow_name"] == "a"  # 取自图片 filename
    # 文件已落盘到 tmp_path/comfyui_temp/a.json
    tmp = tmp_path / "comfyui_temp" / "a.json"
    assert tmp.exists()
    assert tmp.read_text(encoding="utf-8") == '{"a": 1}'


def test_open_workflow_no_browser_open_online(client, tmp_path: Path, monkeypatch):
    """comfyui 在线 → 后端不再弹窗，browser_opened 恒为 False（前端负责复用窗口）。"""
    monkeypatch.setattr("app.integrations.comfyui.probe", lambda url: True)
    items = client.get("/api/images", params={"limit": 10}).json()["items"]
    target = next(x for x in items if x["filename"] == "a.png")
    r = client.post(f"/api/integrations/comfyui/open_workflow/{target['id']}")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["browser_opened"] is False
    assert body["workflow_name"] == "a"
    assert "comfyui_temp" in body["file_path"]


def test_open_workflow_same_filename_collision(client, tmp_path: Path, offline_probe):
    """同名图片两次发送 → 第二次走 ``_1`` 后缀，不会覆盖。"""
    items = client.get("/api/images", params={"limit": 10}).json()["items"]
    target = next(x for x in items if x["filename"] == "a.png")
    r1 = client.post(f"/api/integrations/comfyui/open_workflow/{target['id']}")
    r2 = client.post(f"/api/integrations/comfyui/open_workflow/{target['id']}")
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["file_path"].endswith("a.json")
    assert r2.json()["file_path"].endswith("a_1.json")
    assert (tmp_path / "comfyui_temp" / "a.json").exists()
    assert (tmp_path / "comfyui_temp" / "a_1.json").exists()


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
    assert "a.json" in body["files"]

# ---------- 扫本机 ComfyUI ----------

NETSTAT_SAMPLE = """
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1892
  TCP    127.0.0.1:8188         0.0.0.0:0              LISTENING       38988
  TCP    [::]:8000              [::]:0                 LISTENING       40000
  TCP    192.168.1.20:8188      0.0.0.0:0              LISTENING       41000
  TCP    127.0.0.1:54321        127.0.0.1:54322        ESTABLISHED     42000
  UDP    0.0.0.0:5353           *:*                                    43000
"""


def test_parse_netstat_listeners_only_loopback_and_only_listening():
    rows = comfyui.parse_netstat_listeners(NETSTAT_SAMPLE)
    assert ("127.0.0.1", 8188) in rows
    assert ("[::]", 8000) in rows
    assert ("0.0.0.0", 135) in rows
    # 局域网地址上的服务不是「本机 ComfyUI」，扫它就是替用户端口扫描别人的机器
    assert all(host != "192.168.1.20" for host, _ in rows)
    # 已连接的会话、UDP 行都不算监听
    assert all(port != 54321 for _, port in rows)


def test_url_for_maps_wildcard_addresses():
    assert comfyui.url_for("0.0.0.0", 8188) == "http://127.0.0.1:8188"
    assert comfyui.url_for("127.0.0.1", 8188) == "http://127.0.0.1:8188"
    # 只绑 IPv6 的 ComfyUI：不带方括号根本连不上
    assert comfyui.url_for("[::]", 8000) == "http://[::1]:8000"
    assert comfyui.url_for("::1", 8000) == "http://[::1]:8000"


def test_scan_candidates_only_lists_real_comfyui(monkeypatch):
    monkeypatch.setattr(
        comfyui,
        "loopback_listeners",
        lambda: [("127.0.0.1", 8188), ("[::]", 8000), ("127.0.0.1", 54321)],
    )
    known = {"http://127.0.0.1:8188": "0.43.0", "http://[::1]:8000": "0.340.0"}
    monkeypatch.setattr(comfyui, "comfyui_version", lambda url: known.get(url, ""))
    urls = [item["url"] for item in comfyui.scan_candidates(exclude_url="http://127.0.0.1:8188")]
    assert "http://127.0.0.1:8188" not in urls      # 当前地址不该再当候选
    assert "http://[::1]:8000" in urls              # 只绑 IPv6 的那台也要被认出来
    assert "http://127.0.0.1:54321" not in urls     # 应答了但不是 ComfyUI 的端口不列


def test_scan_candidates_sorts_common_ports_first(monkeypatch):
    monkeypatch.setattr(
        comfyui,
        "loopback_listeners",
        lambda: [("127.0.0.1", 57001), ("127.0.0.1", 8000)],
    )
    monkeypatch.setattr(comfyui, "comfyui_version", lambda url: "0.43.0")
    urls = [item["url"] for item in comfyui.scan_candidates()]
    assert urls.index("http://127.0.0.1:8000") == 0


# ---------- /status 与 /scan ----------


def test_status_carries_reason(client, offline_probe):
    r = client.get("/api/integrations/comfyui/status")
    assert r.status_code == 200
    body = r.json()
    assert body["running"] is False
    assert body["reason_code"] == "refused"
    assert "没有服务在监听" in body["reason"]


def test_status_draft_probes_without_saving(client, monkeypatch, tmp_path: Path):
    """设置页要能先验证刚敲进去的地址再保存：探草稿地址绝不能改 config.json。"""
    probed: list[str] = []

    def fake(url: str, timeout: float | None = None) -> comfyui.ProbeResult:
        probed.append(url)
        return comfyui.ProbeResult(url.endswith(":8000"))

    monkeypatch.setattr("app.routes.comfyui.probe_detail", fake)
    r = client.get("/api/integrations/comfyui/status", params={"draft": "http://127.0.0.1:8000"})
    assert r.status_code == 200
    assert r.json()["url"] == "http://127.0.0.1:8000"
    assert r.json()["running"] is True
    assert probed == ["http://127.0.0.1:8000"]
    cfg_path = tmp_path / "config.json"
    assert not cfg_path.exists() or "8000" not in cfg_path.read_text(encoding="utf-8")


def test_scan_lists_candidates_when_configured_url_is_dead(client, monkeypatch):
    monkeypatch.setattr(
        "app.routes.comfyui.probe_detail",
        lambda url, timeout=None: comfyui.ProbeResult(False, "127.0.0.1:8188 上没有服务在监听", "refused"),
    )
    monkeypatch.setattr(
        "app.routes.comfyui.scan_candidates",
        lambda exclude_url="": [{"url": "http://127.0.0.1:8000", "version": "0.43.0"}],
    )
    body = client.get("/api/integrations/comfyui/scan").json()
    assert body["running"] is False
    assert body["reason_code"] == "refused"
    assert body["candidates"] == [{"url": "http://127.0.0.1:8000", "version": "0.43.0"}]


def test_scan_skips_scanning_when_already_connected(client, monkeypatch):
    """没坏就别扫：当前地址连通时 /scan 不该再翻一遍端口。"""
    monkeypatch.setattr("app.routes.comfyui.probe_detail", lambda url, timeout=None: comfyui.ProbeResult(True))
    monkeypatch.setattr(
        "app.routes.comfyui.scan_candidates",
        lambda exclude_url="": pytest.fail("已经连上了就不该再扫端口"),
    )
    body = client.get("/api/integrations/comfyui/scan").json()
    assert body["running"] is True
    assert body["candidates"] == []
