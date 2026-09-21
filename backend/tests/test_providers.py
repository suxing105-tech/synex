"""预设服务商（provider preset）相关测试。"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import reverse_prompts as service
from app.routes.reverse_prompts import router


@pytest.fixture
def client(init_db):
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        yield client


def preset_draft(**kwargs):
    return {"provider": "qwen", "model": "qwen2.5-vl-72b-instruct", **kwargs}


def test_list_providers_no_secrets(client):
    data = client.get("/api/model-providers").json()
    ids = {p["id"] for p in data}
    assert {"openai", "gemini", "qwen", "doubao", "zhipu", "siliconflow", "moonshot", "deepseek"} <= ids
    assert all("api_key" not in p and "credential" not in p for p in data)
    qwen = next(p for p in data if p["id"] == "qwen")
    assert qwen["models"] and any(m["recommended"] for m in qwen["models"])
    assert qwen["models"][0]["recommended"] is True  # 推荐项排在首位


def test_create_preset_fills_base_url_and_name(client):
    result = client.post("/api/model-configs", json=preset_draft(api_key="preset-key")).json()
    assert result["provider"] == "qwen"
    assert result["base_url"] == "https://dashscope.aliyuncs.com/compatible-mode/v1"
    assert result["model"] == "qwen2.5-vl-72b-instruct"
    assert result["timeout"] == 120
    assert result["name"].startswith("通义千问 Qwen")
    row = service.get_config(result["id"])
    assert service.key_for(row) == "preset-key"
    assert row["provider"] == "qwen"


def test_preset_accepts_custom_model_id(client):
    # 豆包等使用 endpoint id（ep-...）时不被预设模型清单卡住
    result = client.post("/api/model-configs", json={
        "provider": "doubao", "model": "ep-20260101-xxxxx", "api_key": "k"}).json()
    assert result["provider"] == "doubao" and result["model"] == "ep-20260101-xxxxx"
    assert result["base_url"] == "https://ark.cn-beijing.volces.com/api/v3"


def test_preset_override_valid_base_url_stored(client):
    result = client.post("/api/model-configs", json=preset_draft(base_url="https://my-proxy.example.com/v1")).json()
    assert result["base_url"] == "https://my-proxy.example.com/v1"
    assert result["provider"] == "qwen"


def test_preset_override_bad_url_rejected(client):
    resp = client.post("/api/model-configs", json=preset_draft(base_url="https://user:pass@example.com"))
    assert resp.status_code == 422


def test_custom_requires_base_url(client):
    resp = client.post("/api/model-configs", json={"name": "自定义", "model": "some-vl"})
    assert resp.status_code == 422
    assert "Base URL" in resp.json()["detail"]


def test_unknown_provider_rejected(client):
    resp = client.post("/api/model-configs", json={"provider": "nope", "model": "x", "base_url": "https://a.com/v1"})
    assert resp.status_code == 422


def test_test_endpoint_resolves_preset_base_url(client, monkeypatch):
    calls = []
    async def response(*args):
        calls.append(args)
        return "白底红色方形"
    monkeypatch.setattr(service, "request_model", response)
    result = client.post("/api/model-configs/test", json=preset_draft(api_key="preset-key")).json()
    assert result["ok"]
    config, key, url, _ = calls[0]
    assert config["base_url"] == "https://dashscope.aliyuncs.com/compatible-mode/v1"
    assert config["model"] == "qwen2.5-vl-72b-instruct"
    assert key == "preset-key"
    assert url.startswith("data:image/png;base64,")


def test_old_rows_migrated_to_custom(client, init_db):
    # 新库（含 provider 列）里手动插入一条老结构数据（provider 为空）
    from app import db
    conn = db.get_pool().main()
    config_id = conn.execute(
        "INSERT INTO model_configs(name,base_url,model,timeout,credential,provider) "
        "VALUES(?,?,?,?,NULL,NULL)",
        ("旧配置", "https://example.com/v1", "old-vl", 120),
    ).lastrowid
    data = client.get("/api/model-configs").json()
    row = next(r for r in data if r["id"] == config_id)
    assert row["provider"] is None
    assert row["name"] == "旧配置" and row["base_url"] == "https://example.com/v1"
