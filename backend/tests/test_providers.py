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


# ---------- RunningHub：一把 Key 走天下 ----------


def accounts_rows():
    from app import db

    return [dict(r) for r in db.get_pool().main().execute("SELECT * FROM gen_accounts ORDER BY id").fetchall()]


def runninghub_draft(**kwargs):
    return {"provider": "runninghub", "model": "some/deepseek-vl", **kwargs}


def test_runninghub_offers_one_key_for_both_uses(client):
    """它进的是服务商下拉，Key 却不归这条配置所有——这两件事必须同时成立，界面才说得通。"""
    preset = next(p for p in client.get("/api/model-providers").json() if p["id"] == "runninghub")
    assert preset["credential_scope"] == "cloud"
    assert preset["models_dynamic"] is True
    assert preset["base_url"] == "https://llm.runninghub.cn/v1"
    assert "一把 Key 走天下" in preset["note"]


def test_shared_key_presence_travels_with_the_preset(client):
    """界面要知道那把共用的 Key 存了没有，只能靠这条清单带回这个布尔——而且是布尔，不是 Key。"""
    def flag():
        return next(p for p in client.get("/api/model-providers").json() if p["id"] == "runninghub")["shared_has_key"]

    assert flag() is False
    client.post("/api/model-configs", json=runninghub_draft(api_key="RH-FLAG"))
    assert flag() is True
    assert "RH-FLAG" not in client.get("/api/model-providers").text


def test_runninghub_key_lives_in_the_cloud_account_not_the_config(client):
    """在模型配置里填的 Key 落到云端那条账号：两处读的是同一行，不是两份抄本。"""
    result = client.post("/api/model-configs", json=runninghub_draft(api_key="RH-SHARED-1")).json()
    row = service.get_config(result["id"])
    assert row["credential"] is None, "这条配置不许再存一份密文"
    assert service.key_for(row) == "RH-SHARED-1"
    assert result["has_api_key"] is True
    accounts = accounts_rows()
    assert len(accounts) == 1 and accounts[0]["provider"] == "runninghub"
    # 一键同款那一侧看到的是同一个账号：不用他再填第二遍
    from app.cloud import accounts as cloud_accounts

    assert cloud_accounts.usable_account() is not None
    assert cloud_accounts.key_for(cloud_accounts.usable_account()) == "RH-SHARED-1"


def test_key_typed_on_the_cloud_side_reaches_the_reverse_model(client):
    """反方向同理：在云端那张卡填的 Key，反推这边直接就能用。"""
    from app.cloud import accounts as cloud_accounts

    cloud_accounts.save_account({"api_key": "RH-SHARED-2", "name": "RunningHub"})
    result = client.post("/api/model-configs", json=runninghub_draft()).json()
    assert result["has_api_key"] is True
    assert service.key_for(service.get_config(result["id"])) == "RH-SHARED-2"


def test_clearing_the_shared_key_disables_both_uses(client):
    """一把就是真一把：清一次，反推与一键同款同时失效，界面必须照这个说。"""
    from app.cloud import accounts as cloud_accounts

    config = client.post("/api/model-configs", json=runninghub_draft(api_key="RH-SHARED-3")).json()
    assert cloud_accounts.usable_account() is not None
    cleared = client.patch(f"/api/model-configs/{config['id']}", json={"api_key": "", "model": "some/deepseek-vl"}).json()
    assert cleared["has_api_key"] is False
    assert service.key_for(service.get_config(config["id"])) == ""
    assert cloud_accounts.usable_account() is None


def test_patch_without_provider_keeps_it(client):
    """PATCH 不带 provider 时保留原值：只改模型的这一次编辑，不许把服务商抹成自定义。"""
    config = client.post("/api/model-configs", json=preset_draft(api_key="keep-me")).json()
    patched = client.patch(f"/api/model-configs/{config['id']}", json={"timeout": 300}).json()
    assert patched["provider"] == "qwen" and patched["has_api_key"] is True
    assert service.key_for(service.get_config(config["id"])) == "keep-me"


def test_editing_the_model_does_not_touch_the_key(client):
    """只改模型/超时不该把 Key 顺手带走——api_key 这个键没出现就是不动它。"""
    config = client.post("/api/model-configs", json=runninghub_draft(api_key="RH-SHARED-4")).json()
    patched = client.patch(f"/api/model-configs/{config['id']}", json={"model": "other/vision-model"}).json()
    assert patched["model"] == "other/vision-model" and patched["has_api_key"] is True


def test_deleting_the_runninghub_config_keeps_the_key(client):
    """删配置删的是这条模型记录，不是那把两处共用的 Key。"""
    from app.cloud import accounts as cloud_accounts

    config = client.post("/api/model-configs", json=runninghub_draft(api_key="RH-SHARED-5")).json()
    client.delete(f"/api/model-configs/{config['id']}")
    assert len(accounts_rows()) == 1
    assert cloud_accounts.public(accounts_rows()[0])["has_api_key"] is True


# ---------- 模型清单：现拉，不抄 ----------


def test_preset_model_list_still_comes_from_the_registry(client):
    out = client.get("/api/model-providers/qwen/models").json()
    assert out["source"] == "preset"
    assert out["models"][0]["id"] == "qwen2.5-vl-72b-instruct"


def test_dynamic_model_list_needs_the_key_first(client):
    out = client.get("/api/model-providers/runninghub/models").json()
    assert out["models"] == [] and out["source"] == "none"
    assert "API Key" in out["reason"]


def test_dynamic_model_list_lists_what_the_account_can_see(client, monkeypatch):
    """清单以服务商报的为准；只有「默认选中哪个」用字样猜，能选哪些一个字都不编。"""
    import httpx

    service._MODEL_CACHE.clear()
    client.post("/api/model-providers")  # 先让预设注册表被走过一遍（与真实使用顺序一致）
    conf = client.post("/api/model-configs", json=runninghub_draft(api_key="RH-MODELS")).json()
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json={"data": [{"id": "x/deepseek-v4.1-flash"}, {"id": "y/qwen2.5-vl-72b"}]})

    actual = httpx.AsyncClient
    monkeypatch.setattr(service.httpx, "AsyncClient",
                        lambda **kwargs: actual(transport=httpx.MockTransport(handler), **kwargs))
    out = client.get("/api/model-providers/runninghub/models").json()
    assert seen["url"] == "https://llm.runninghub.cn/v1/models"
    assert seen["auth"] == "Bearer RH-MODELS"
    assert [m["id"] for m in out["models"]] == ["x/deepseek-v4.1-flash", "y/qwen2.5-vl-72b"]
    assert [m for m in out["models"] if m["recommended"]] == [{"id": "y/qwen2.5-vl-72b", "label": "y/qwen2.5-vl-72b", "recommended": True}]
    assert out["source"] == "live" and conf["has_api_key"] is True
    service._MODEL_CACHE.clear()


def test_dynamic_model_list_failure_tells_how_to_proceed(client, monkeypatch):
    import httpx

    service._MODEL_CACHE.clear()
    client.post("/api/model-configs", json=runninghub_draft(api_key="RH-BAD"))

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="no such route")

    actual = httpx.AsyncClient
    monkeypatch.setattr(service.httpx, "AsyncClient",
                        lambda **kwargs: actual(transport=httpx.MockTransport(handler), **kwargs))
    resp = client.get("/api/model-providers/runninghub/models")
    assert resp.status_code == 502
    assert "手填模型 ID" in resp.json()["detail"]
    service._MODEL_CACHE.clear()


def test_custom_provider_has_no_model_list(client):
    assert client.get("/api/model-providers/custom/models").status_code == 422
