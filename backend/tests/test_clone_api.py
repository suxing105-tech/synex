"""一键同款 HTTP 层：模板 CRUD、导入预检、生成入参校验。

和生成链路测试同样的原则：任何 ComfyUI 请求都被假 transport 截住，
测试绝不会在开发者本机正在跑的 ComfyUI 里排队出图。
"""
from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app import clone_jobs
from app.comfyui_client import ComfyUIClient
from app.db import init_pool
from app.main import app

from .conftest import make_png

UI_WORKFLOW = {"nodes": [{"id": 1, "type": "KSampler"}], "links": []}

API_WORKFLOW = {
    "13": {"class_type": "ResolutionSelector", "inputs": {"aspect_ratio": "1:1 (Square)", "megapixels": 1.5}},
    "540": {"class_type": "CR Prompt Text", "inputs": {"prompt": "内置提示词"}},
    "543": {"class_type": "LoadImage", "inputs": {"image": "a.png"}, "_meta": {"title": "加载图像"}},
    "582": {"class_type": "TextEncodeQwenImage21", "inputs": {"prompt": "内置提示词", "negative_prompt": "糊"}},
    "600": {"class_type": "SaveImage", "inputs": {"images": ["582", 0]}},
}

OBJECT_INFO = {
    "ResolutionSelector": {"input": {"required": {
        "aspect_ratio": ["COMBO", {"options": ["1:1 (Square)", "9:16 (Portrait Widescreen)"], "default": "1:1 (Square)"}],
        "megapixels": ["FLOAT", {"default": 1.5, "min": 0.1, "max": 4.0, "step": 0.1}],
    }}}
}


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path))
    import importlib

    from app import config, db

    importlib.reload(config)
    importlib.reload(db)
    init_pool()
    clone_jobs.reset_for_tests()
    # 生成链路的 ComfyUIClient 默认换成「连不上」：这个文件只测 HTTP 语义，
    # 校验一旦通过就会真去探测 ComfyUI，不拦的话测试会排进开发者本机正在跑的那个 ComfyUI。
    real = ComfyUIClient

    def make(url, **kwargs):
        def refuse(request):
            raise httpx.ConnectError("tests must not touch a real ComfyUI", request=request)
        kwargs["transport"] = httpx.MockTransport(refuse)
        return real(url, **kwargs)

    monkeypatch.setattr("app.clone_jobs.ComfyUIClient", make)
    # 建模板（没带槽位时）也会去要一次 object_info 补控件，同理拦下来，别连真机 8188。
    monkeypatch.setattr("app.routes.clone.ComfyUIClient", make)
    with TestClient(app) as c:
        yield c
    clone_jobs.reset_for_tests()


@pytest.fixture
def comfy_online(monkeypatch):
    """导入时抓 object_info：把选项列表缓存进模板。"""
    def handler(request: httpx.Request) -> httpx.Response:
        name = request.url.path.rsplit("/", 1)[-1]
        return httpx.Response(200, json={name: OBJECT_INFO[name]} if name in OBJECT_INFO else {})

    real = ComfyUIClient

    def make(url, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(url, **kwargs)

    monkeypatch.setattr("app.routes.clone.ComfyUIClient", make)


def create(client, name="多图同款", **overrides):
    body = {"name": name, "workflow": API_WORKFLOW}
    body.update(overrides)
    return client.post("/api/clone/templates", json=body)


# ---------- 导入预检 ----------


def test_inspect_reports_slots_and_suggested_name(client, comfy_online):
    res = client.post("/api/clone/templates/inspect", json={"workflow": json.dumps(API_WORKFLOW, ensure_ascii=False)})
    assert res.status_code == 200
    body = res.json()
    assert [s["kind"] for s in body["slots"]] == ["prompt", "prompt", "image", "select", "number"]
    assert body["default_prompt"] == "内置提示词"
    assert body["suggested_name"] == ""
    assert any(n["node"] == "543" for n in body["nodes"])


def test_inspect_reads_a_json_file_from_disk_and_suggests_its_name(client, comfy_online, tmp_path):
    target = tmp_path / "多图编辑.json"
    target.write_text(json.dumps(API_WORKFLOW, ensure_ascii=False), encoding="utf-8")
    body = client.post("/api/clone/templates/inspect", json={"path": str(target)}).json()
    assert body["suggested_name"] == "多图编辑"
    assert body["slots"][0]["kind"] == "prompt"


def test_inspect_reads_gbk_saved_json(client, comfy_online, tmp_path):
    target = tmp_path / "另存为.json"
    target.write_bytes(json.dumps(API_WORKFLOW, ensure_ascii=False).encode("gbk"))
    assert client.post("/api/clone/templates/inspect", json={"path": str(target)}).status_code == 200


def test_inspect_rejects_ui_format_and_bad_paths(client, comfy_online, tmp_path):
    res = client.post("/api/clone/templates/inspect", json={"workflow": UI_WORKFLOW})
    assert res.status_code == 422 and "API 格式" in res.json()["detail"]
    assert client.post("/api/clone/templates/inspect", json={"path": str(tmp_path / "a.txt")}).status_code == 422
    assert client.post("/api/clone/templates/inspect", json={"path": str(tmp_path / "missing.json")}).status_code == 404
    assert client.post("/api/clone/templates/inspect", json={}).status_code == 422


def _cfg(enabled: bool, url: str = "http://127.0.0.1:8188"):
    return lambda: type("C", (), {"comfyui_enabled": enabled, "comfyui_url": url})()


def test_inspect_works_with_comfyui_offline(client, monkeypatch):
    """ComfyUI 没开也要能导入：提示词与参考位照样认出来，只是没有下拉控件。

    但「没有控件」不能静默发生——真机就被坑过一次：导入时 ComfyUI 没开，
    比例/分辨率就这么没了，弹窗里永远少一块，用户只会以为工作流没这两项。
    """
    def offline():
        raise AssertionError("集成关着就不该去连 ComfyUI")

    monkeypatch.setattr("app.routes.clone.ComfyUIClient", offline)
    monkeypatch.setattr("app.routes.clone.load_config", _cfg(False))
    body = client.post("/api/clone/templates/inspect", json={"workflow": API_WORKFLOW}).json()
    assert [s["kind"] for s in body["slots"]] == ["prompt", "prompt", "image"]
    assert any("重新检测槽位" in w for w in body["warnings"])


def test_inspect_warns_when_comfyui_is_unreachable(client, monkeypatch):
    """开着集成但连不上（ComfyUI 没启动）：同样要把参数没了这件事说出来。"""
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    real = ComfyUIClient

    def make(url, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(url, **kwargs)

    monkeypatch.setattr("app.routes.clone.ComfyUIClient", make)
    monkeypatch.setattr("app.routes.clone.load_config", _cfg(True, "http://127.0.0.1:8199"))
    body = client.post("/api/clone/templates/inspect", json={"workflow": API_WORKFLOW}).json()
    assert [s["kind"] for s in body["slots"]] == ["prompt", "prompt", "image"]
    warning = next(w for w in body["warnings"] if "重新检测槽位" in w)
    assert "8199" in warning


def test_import_with_comfyui_online_caches_control_options(client, comfy_online):
    inspected = client.post("/api/clone/templates/inspect", json={"workflow": API_WORKFLOW}).json()
    assert not [w for w in inspected["warnings"] if "重新检测槽位" in w]
    row = create(client, slots=inspected["slots"]).json()
    select = [s for s in row["slots"] if s["kind"] == "select"][0]
    assert select["options"] == ["1:1 (Square)", "9:16 (Portrait Widescreen)"]


def test_create_without_slots_keeps_controls_when_comfyui_is_online(client, comfy_online):
    """绕过预检直接建模板也不能丢控件。

    真机少过那颗「画面参数」就是这么来的：脚本只发 {name, path} 建模板，
    后端离线裸检测出 control_count=0，弹窗里那一整块参数就没了，而且没人说过。
    """
    row = create(client).json()
    assert row["control_count"] == 2
    assert [s["kind"] for s in row["slots"]] == ["prompt", "prompt", "image", "select", "number"]
    assert "warning" not in row


def test_create_without_slots_says_why_controls_are_missing(client):
    """ComfyUI 开着但连不上时照样建得成，只是要把少了什么、怎么补回来讲明白。"""
    row = create(client).json()
    assert row["control_count"] == 0
    assert "重新检测槽位" in row["warning"]


def test_create_with_slots_does_not_probe_comfyui(client, monkeypatch):
    """前端预检后带着槽位来建模板：这时候不该再多跑一次 object_info。"""
    def refuse():
        raise AssertionError("带槽位建模板不该再去连 ComfyUI")

    inspected = client.post("/api/clone/templates/inspect", json={"workflow": API_WORKFLOW}).json()
    monkeypatch.setattr("app.routes.clone._object_info", refuse)
    assert create(client, slots=inspected["slots"]).status_code == 201


def test_redetect_recovers_controls_after_offline_import(client, comfy_online, monkeypatch):
    """离线导入丢掉的参数，ComfyUI 开了以后点一下就补回来，不用重新导工作流。"""
    monkeypatch.setattr("app.routes.clone.load_config", _cfg(False))
    row = create(client).json()  # 导入时当它离线：拿不到 object_info → 没有控件
    assert row["control_count"] == 0
    monkeypatch.setattr("app.routes.clone.load_config", _cfg(True))
    res = client.post(f"/api/clone/templates/{row['id']}/redetect")
    assert res.status_code == 200
    after = res.json()
    assert after["control_count"] == 2
    assert [s["kind"] for s in after["slots"]] == ["prompt", "prompt", "image", "select", "number"]
    select = [s for s in after["slots"] if s["kind"] == "select"][0]
    assert select["options"] == ["1:1 (Square)", "9:16 (Portrait Widescreen)"]
    # 名字、当前标记和内置提示词都不该被这次重检测动到
    assert after["name"] == row["name"]
    assert after["is_active"] is True
    assert after["default_prompt"] == "内置提示词"
    assert [t["id"] for t in client.get("/api/clone/templates").json()["items"]] == [row["id"]]


def test_redetect_refuses_while_comfyui_is_offline(client, monkeypatch):
    row = create(client).json()
    monkeypatch.setattr("app.routes.clone.load_config", _cfg(False))
    res = client.post(f"/api/clone/templates/{row['id']}/redetect")
    assert res.status_code == 409
    assert "ComfyUI" in res.json()["detail"]
    # 没连上就不该动库：槽位还是原来那一套
    assert client.get("/api/clone/templates").json()["items"][0]["control_count"] == 0
    assert client.post("/api/clone/templates/999/redetect").status_code == 404


# ---------- 模板 CRUD ----------


def test_template_crud_round_trip(client):
    assert client.get("/api/clone/templates").json() == {"items": []}
    created = create(client)
    assert created.status_code == 201
    row = created.json()
    assert row["is_active"] is True and row["prompt_count"] == 2 and row["reference_count"] == 1
    assert "workflow" not in row

    renamed = client.patch(f"/api/clone/templates/{row['id']}", json={"name": " 改过了 "})
    assert renamed.json()["name"] == "改过了"
    assert json.loads(client.get(f"/api/clone/templates/{row['id']}/workflow").text)["543"]["class_type"] == "LoadImage"
    nodes = client.get(f"/api/clone/templates/{row['id']}/nodes").json()["nodes"]
    assert any(n["title"] == "加载图像" for n in nodes)

    assert client.delete(f"/api/clone/templates/{row['id']}").json()["deleted"] == row["id"]
    assert client.get("/api/clone/templates").json()["items"] == []


def test_duplicate_name_is_conflict_on_create_and_rename(client):
    a = create(client, "A").json()
    assert create(client, "A").status_code == 409
    create(client, "B")
    assert client.patch(f"/api/clone/templates/{a['id']}", json={"name": "B"}).status_code == 409


def test_bad_bodies_are_rejected_with_readable_chinese(client):
    assert create(client, "").status_code == 422
    assert create(client, "坏工作流", workflow=UI_WORKFLOW).status_code == 422
    res = create(client, "缺提示词", slots=[{"kind": "image", "node": "543", "input": "image"}])
    assert res.status_code == 400 and "提示词" in res.json()["detail"]
    assert client.patch("/api/clone/templates/4242", json={"name": "不存在"}).status_code == 404
    assert client.delete("/api/clone/templates/4242").status_code == 404
    assert client.get("/api/clone/templates/4242/workflow").status_code == 404


def test_active_flag_stays_exclusive(client):
    a = create(client, "A").json()
    b = create(client, "B").json()
    assert b["is_active"] is False
    assert client.patch(f"/api/clone/templates/{b['id']}", json={"is_active": True}).json()["is_active"] is True
    items = {t["name"]: t["is_active"] for t in client.get("/api/clone/templates").json()["items"]}
    assert items == {"A": False, "B": True}
    client.delete(f"/api/clone/templates/{b['id']}")
    assert [t for t in client.get("/api/clone/templates").json()["items"] if t["is_active"]][0]["name"] == "A"


GROW_WORKFLOW = {
    **API_WORKFLOW,
    "582": {
        "class_type": "TextEncodeQwenImage21",
        "inputs": {"prompt": "内置提示词", "negative_prompt": "糊", "images.image_1": ["543", 0]},
    },
}

# 素材组能长到几格只写在 object_info 的 autogrow template 里，工作流 JSON 本身看不出来。
GROW_INFO = {
    **OBJECT_INFO,
    "TextEncodeQwenImage21": {"input": {"required": {
        "images": ["COMFY_AUTOGROW_WORKFLOW_INPUT",
                   {"template": {"prefix": "image_", "min": 1, "max": 4, "type": "IMAGE"}}],
    }}},
}


@pytest.fixture
def comfy_online_grow(monkeypatch):
    """ComfyUI 在线，并且报得出 autogrow 上限。"""
    def handler(request: httpx.Request) -> httpx.Response:
        name = request.url.path.rsplit("/", 1)[-1]
        return httpx.Response(200, json={name: GROW_INFO[name]} if name in GROW_INFO else {})

    real = ComfyUIClient

    def make(url, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(url, **kwargs)

    monkeypatch.setattr("app.routes.clone.ComfyUIClient", make)


def _grow_names(slots):
    slot = next(s for s in slots if s["kind"] == "image")
    return sorted((slot.get("grow") or {}).get("names") or [])


def test_swapping_workflow_keeps_controls_and_reference_cells(client, comfy_online_grow):
    """就地换 JSON 会重算槽位，而控件选项和素材组格数只存在于 object_info。

    真机踩的是这条的漏网版：脚本换完工作流，比例/分辨率整块没了，9 格参考图缩回 2 格，
    弹窗看着像「这份工作流变笨了」，其实是被换工作流这一步悄悄降级了。
    """
    row = create(client, workflow=GROW_WORKFLOW).json()
    assert row["control_count"] == 2
    assert _grow_names(row["slots"]) == ["image_2", "image_3"]

    swapped = client.patch(f"/api/clone/templates/{row['id']}", json={"workflow": GROW_WORKFLOW}).json()
    assert "warning" not in swapped
    assert swapped["control_count"] == 2
    assert _grow_names(swapped["slots"]) == ["image_2", "image_3"]
    select = [s for s in swapped["slots"] if s["kind"] == "select"][0]
    assert select["options"] == ["1:1 (Square)", "9:16 (Portrait Widescreen)"]


def test_swapping_workflow_says_why_controls_are_missing(client):
    """换 JSON 时 ComfyUI 连不上：照样换得成，但少了什么、怎么补回来必须讲明白。"""
    row = create(client, workflow=GROW_WORKFLOW).json()
    swapped = client.patch(f"/api/clone/templates/{row['id']}", json={"workflow": GROW_WORKFLOW}).json()
    assert swapped["control_count"] == 0
    assert "重新检测槽位" in swapped["warning"]


def test_swapping_workflow_with_slots_does_not_probe_comfyui(client, comfy_online_grow, monkeypatch):
    """带着确认过的槽位换工作流时，别多跑一次 object_info。"""
    row = create(client, workflow=GROW_WORKFLOW).json()

    def refuse():
        raise AssertionError("带槽位换工作流不该再去连 ComfyUI")

    monkeypatch.setattr("app.routes.clone._object_info", refuse)
    kept = client.patch(f"/api/clone/templates/{row['id']}",
                        json={"workflow": GROW_WORKFLOW, "slots": row["slots"]})
    assert kept.status_code == 200
    assert _grow_names(kept.json()["slots"]) == ["image_2", "image_3"]


def test_swapping_workflow_rebinds_slots(client):
    row = create(client).json()
    nodes = {k: v for k, v in API_WORKFLOW.items() if k != "540"}
    updated = client.patch(f"/api/clone/templates/{row['id']}", json={"workflow": nodes}).json()
    assert [s["node"] for s in updated["slots"] if s["kind"] == "prompt"] == ["582"]


# ---------- 生成入参 ----------


def test_generate_validates_before_touching_comfyui(client):
    row = create(client).json()
    missing = client.post("/api/clone/generate", json={"template_id": 9999, "prompt": "x", "references": []})
    assert missing.status_code == 404
    empty_prompt = client.post("/api/clone/generate", json={"template_id": row["id"], "prompt": "", "references": []})
    assert empty_prompt.status_code == 422
    unknown_slot = client.post("/api/clone/generate", json={
        "template_id": row["id"], "prompt": "x",
        "references": [{"slot": "999.image", "image_id": 1}],
    })
    assert unknown_slot.status_code == 400 and "999.image" in unknown_slot.json()["detail"]
    twice = client.post("/api/clone/generate", json={
        "template_id": row["id"], "prompt": "x",
        "references": [{"slot": "543.image", "image_id": 1}, {"slot": "543.image", "image_id": 2}],
    })
    assert twice.status_code == 400 and "两遍" in twice.json()["detail"]
    # 空参考图不是参数错误：那就是文生图。它能过校验，卡在 ComfyUI 连不上（409）。
    text_only = client.post("/api/clone/generate", json={
        "template_id": row["id"], "prompt": "x", "references": [],
    })
    assert text_only.status_code == 409
    unknown_control = client.post("/api/clone/generate", json={
        "template_id": row["id"], "prompt": "x",
        "references": [{"slot": "543.image", "image_id": 1}], "controls": {"582.prompt": "x"},
    })
    assert unknown_control.status_code == 400
    # 文字位同理：工作流没声明的地方不许塞话，用户填了就得有个说法，不能静默丢
    unknown_text = client.post("/api/clone/generate", json={
        "template_id": row["id"], "prompt": "x",
        "references": [{"slot": "543.image", "image_id": 1}],
        "slot_prompts": {"999.ref_text": "参考音频里的原话"},
    })
    assert unknown_text.status_code == 400 and "999.ref_text" in unknown_text.json()["detail"]


def test_generate_refuses_without_comfyui_and_reports_busy_state(client, monkeypatch, tmp_path):
    """ComfyUI 没开 → 409，且错误文案要告诉用户去哪儿开。"""
    row = create(client).json()
    monkeypatch.setattr("app.clone_jobs.load_config", lambda: type("C", (), {"comfyui_enabled": False, "comfyui_url": "http://x"})())
    res = client.post("/api/clone/generate", json={
        "template_id": row["id"], "prompt": "x", "references": [{"slot": "543.image", "image_id": 1}],
    })
    assert res.status_code == 409 and "设置" in res.json()["detail"]
    assert client.get("/api/clone/jobs/current").json()["active"] is False
    assert client.post("/api/clone/jobs/current/cancel").json()["running"] is False
