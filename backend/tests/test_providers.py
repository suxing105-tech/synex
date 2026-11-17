"""预设服务商（provider preset）相关测试。"""
from __future__ import annotations

import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import reverse_prompts as service
from app.routes.reverse_prompts import router


@pytest.fixture(autouse=True)
def _clear_model_caches():
    """清单缓存和「别再去敲它」那本账都是进程级的：每条用例开头结尾各清一次，别互相闻味儿。"""
    service._MODEL_CACHE.clear()
    service._MODEL_FAIL_UNTIL.clear()
    yield
    service._MODEL_CACHE.clear()
    service._MODEL_FAIL_UNTIL.clear()


@pytest.fixture
def client(init_db):
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        yield client


def preset_draft(**kwargs):
    return {"provider": "qwen", "model": "qwen2.5-vl-72b-instruct", **kwargs}


def _stub_models(monkeypatch, data, status: int = 200, calls: list | None = None):
    """把「问一家要 /models」换成假的，顺手记下请求。返回 {"data":[...]}，status 用来演失败。"""
    import httpx

    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        if calls is not None:
            calls.append(str(request.url))
        if status >= 300:
            return httpx.Response(status, text="boom")
        return httpx.Response(200, json={"data": data})

    actual = httpx.AsyncClient
    monkeypatch.setattr(service.httpx, "AsyncClient",
                        lambda **kwargs: actual(transport=httpx.MockTransport(handler), **kwargs))
    return seen


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


def test_providers_only_claim_capabilities_we_actually_wired(client):
    """服务商选择页按能力过滤，只有已接入的生成能力可以声明。

    RunningHub 与 MiniMax 已接图像/视频/音频 API，MiniMax 也接文本模型；其余只有文本（反推）。
    虚报的代价是界面出现一张点进去什么都能选、试了才知道不行的卡。
    """
    presets = {p["id"]: p for p in client.get("/api/model-providers").json()}
    assert presets["runninghub"]["capabilities"] == ["text", "image", "video", "audio"]
    assert presets["runninghub"]["workflow_key"] is True
    assert presets["runninghub"]["console_url"] == "https://www.runninghub.cn"
    assert presets["minimax"]["capabilities"] == ["text", "image", "video", "audio"]
    assert presets["minimax"]["models"][0]["id"] == "MiniMax-H3-Image"
    others = [pid for pid in presets if pid not in ("runninghub", "minimax")]
    assert others and all(presets[pid]["capabilities"] == ["text"] for pid in others)
    assert all(presets[pid]["workflow_key"] is False for pid in others)


def test_minimax_text_model_list_excludes_media_generation_models(client):
    models = client.get("/api/model-providers/minimax/models").json()["models"]
    assert [item["id"] for item in models] == ["MiniMax-M3.1-Flash", "MiniMax-M3"]


def test_one_save_button_can_hand_over_both_keys(client):
    """一个「保存」交两把 Key：各落各的列，清一把不许动另一把。"""
    created = client.post("/api/model-configs",
                          json=runninghub_draft(api_key="RH-MODEL-2", workflow_api_key="RH-WF-2")).json()

    def flags():
        item = next(p for p in client.get("/api/model-providers").json() if p["id"] == "runninghub")
        return item["shared_has_key"], item["shared_has_workflow_key"]

    assert flags() == (True, True)
    client.patch(f"/api/model-configs/{created['id']}", json={"workflow_api_key": ""})
    assert flags() == (True, False)          # 模型那把一根毛都没动
    assert "RH-WF-2" not in client.get("/api/model-providers").text
    assert "RH-MODEL-2" not in client.get("/api/model-providers").text


def test_a_vendor_without_workflows_rejects_the_second_key(client):
    """别家没有「工作流 Key」这一说：往它身上塞第二把就当场 422，不悄悄收下再让谁都不读。"""
    bad = {"provider": "qwen", "model": "qwen2.5-vl-72b-instruct",
           "api_key": "sk-plain", "workflow_api_key": "wf-nope"}
    response = client.post("/api/model-configs", json=bad)
    assert response.status_code == 422
    assert "工作流" in response.json()["detail"]


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
    # 再次创作那一侧看到的是同一个账号：不用他再填第二遍
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
    """一把就是真一把：清一次，反推与再次创作同时失效，界面必须照这个说。"""
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
    # 2026-11-15 苏醒：下拉里不再放手输模型 ID，所以这句也不许再承诺那条不存在的路
    detail = resp.json()["detail"]
    assert "直接输入模型 ID" not in detail
    assert "认不出可用的语言模型" in detail
    service._MODEL_CACHE.clear()


def fake_models(monkeypatch, ids):
    """把 /models 换成一份写死的清单，返回 handler 见过的请求。"""
    import httpx

    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"data": [{"id": one} for one in ids]})

    actual = httpx.AsyncClient
    monkeypatch.setattr(service.httpx, "AsyncClient",
                        lambda **kwargs: actual(transport=httpx.MockTransport(handler), **kwargs))
    return seen


def test_model_list_drops_the_ones_that_cannot_chat(client, monkeypatch):
    """反推是发对话请求的：嵌入、语音、生图那几类列进来，选中只会换回一句 400。"""
    service._MODEL_CACHE.clear()
    client.post("/api/model-providers")
    client.post("/api/model-configs", json=runninghub_draft(api_key="RH-FILTER"))
    fake_models(monkeypatch, ["x/vision-chat-vl", "text-embedding-3-small", "whisper-1",
                              "MiniMax-TTS-2.6", "dall-e-3", "sora-video"])
    out = client.get("/api/model-providers/runninghub/models").json()
    assert [m["id"] for m in out["models"]] == ["x/vision-chat-vl"]
    assert [m["id"] for m in out["models"] if m["recommended"]] == ["x/vision-chat-vl"]
    service._MODEL_CACHE.clear()


def test_model_list_never_returns_empty_when_the_account_only_has_those(client, monkeypatch):
    """一家全是非对话模型时也别交白卷：原样列出来，至少看得见它到底有什么，推荐位仍要给一个。"""
    service._MODEL_CACHE.clear()
    client.post("/api/model-providers")
    client.post("/api/model-configs", json=runninghub_draft(api_key="RH-ODD"))
    fake_models(monkeypatch, ["text-embedding-3-small", "whisper-1"])
    out = client.get("/api/model-providers/runninghub/models").json()
    assert [m["id"] for m in out["models"]] == ["text-embedding-3-small", "whisper-1"]
    assert [m["id"] for m in out["models"] if m["recommended"]] == ["text-embedding-3-small"]
    service._MODEL_CACHE.clear()


def test_custom_provider_has_no_model_list(client):
    assert client.get("/api/model-providers/custom/models").status_code == 422


# ---------- 清除 Key：即时生效，而且从 Key 真正的家里拿 ----------


def shared_flags(client):
    item = next(p for p in client.get("/api/model-providers").json() if p["id"] == "runninghub")
    return item["shared_has_key"], item["shared_has_workflow_key"]


def test_clear_shared_key_endpoint_kills_both_uses(client):
    """「清除」这一个动作把反推与再次创作同时停用：它删的是同一把 Key。"""
    client.post("/api/model-configs", json=runninghub_draft(api_key="RH-CLEAR-1"))
    assert shared_flags(client) == (True, False)
    out = client.delete("/api/model-providers/runninghub/key")
    assert out.status_code == 200
    assert out.json() == {"shared_has_key": False, "shared_has_workflow_key": False}
    assert shared_flags(client) == (False, False)
    assert "RH-CLEAR-1" not in client.get("/api/model-providers").text


def test_clear_workflow_key_leaves_the_model_key_alone(client):
    """工作流那把单独清，模型那把一根毛都不动。"""
    client.post("/api/model-configs", json=runninghub_draft(api_key="RH-KEEP-1", workflow_api_key="RH-DROP-1"))
    assert shared_flags(client) == (True, True)
    client.delete("/api/model-providers/runninghub/key", params={"kind": "workflow"})
    assert shared_flags(client) == (True, False)
    assert "RH-KEEP-1" not in client.get("/api/model-providers").text


def test_clear_key_invents_no_account(client):
    """一个账号都没有时点「清除」，不许顺手凭空建出一条。"""
    assert accounts_rows() == []
    assert client.delete("/api/model-providers/runninghub/key").status_code == 200
    assert accounts_rows() == []


def test_clear_key_on_a_local_vendor_points_back_at_the_config(client):
    """别家的 Key 存在模型配置里：往服务商那条删，当场说清该去哪儿。"""
    resp = client.delete("/api/model-providers/qwen/key")
    assert resp.status_code == 400
    assert "模型配置" in resp.json()["detail"]


def test_clear_key_rejects_a_kind_that_vendor_has_not(client):
    client.post("/api/model-configs", json=runninghub_draft(api_key="RH-KIND"))
    assert client.delete("/api/model-providers/runninghub/key", params={"kind": "nonsense"}).status_code == 422


def test_clear_config_key_touches_only_the_key(client):
    """普通配置：清完 Key，名字/模型/地址一个字没变，也不用先把表单填全。"""
    created = client.post("/api/model-configs", json={
        "name": "本机视觉", "base_url": "https://example.com/v1", "model": "vl", "api_key": "sk-clear-1"}).json()
    assert client.delete("/api/model-configs/%s/key" % created["id"]).status_code == 200
    row = next(r for r in client.get("/api/model-configs").json() if r["id"] == created["id"])
    assert row["has_api_key"] is False
    assert row["name"] == "本机视觉" and row["model"] == "vl" and row["timeout"] == 120
    assert "sk-clear-1" not in client.get("/api/model-configs").text


def test_clear_config_key_refuses_the_shared_one(client):
    """共用 Key 那家的 Key 不在这条配置上：从这儿清会清错地方，顶回去。"""
    created = client.post("/api/model-configs", json=runninghub_draft(api_key="RH-SHARED-9")).json()
    resp = client.delete("/api/model-configs/%s/key" % created["id"])
    assert resp.status_code == 400
    assert shared_flags(client) == (True, False)


def test_clear_config_key_missing_config_is_404(client):
    assert client.delete("/api/model-configs/999999/key").status_code == 404


# ---------- 模型与 Key 分家：存 Key 不必先挑模型 ----------


def test_saving_a_key_needs_no_model(client):
    """一把 Key 先存住就算配好了：设置页只管服务商与 Key，模型留到用的时候挑。"""
    result = client.post("/api/model-configs", json={"provider": "qwen", "api_key": "k-no-model"})
    assert result.status_code == 200
    row = result.json()
    assert row["model"] == "" and row["has_api_key"] is True
    assert row["name"] == "通义千问 Qwen"          # 名字里不许出现「 · 」这种空模型尾巴
    assert service.key_for(service.get_config(row["id"])) == "k-no-model"


def test_picking_a_model_later_only_moves_the_model(client):
    """面板里挑一次模型只改那一个字段，不能顺手把 Key 或名字抹掉。"""
    row = client.post("/api/model-configs", json={"provider": "qwen", "api_key": "k-later"}).json()
    changed = client.patch(f'/api/model-configs/{row["id"]}', json={"model": "qwen-vl-max"}).json()
    assert changed["model"] == "qwen-vl-max" and changed["has_api_key"] is True
    assert changed["name"] == row["name"]
    assert service.key_for(service.get_config(row["id"])) == "k-later"


def test_a_config_without_a_model_still_reports_its_models(client, monkeypatch):
    """还没挑模型，不影响「这一家有哪些模型可挑」——先选服务商、再看模型就靠这条。"""
    import httpx

    _stub_models(monkeypatch, [{"id": "qwen2.5-vl-72b-instruct"}, {"id": "qwen3-vl-plus"}])
    row = client.post("/api/model-configs", json={"provider": "qwen", "api_key": "k"}).json()
    out = client.get(f'/api/model-configs/{row["id"]}/models').json()
    ids = [item["id"] for item in out["models"]]
    assert out["source"] == "live" and ids[0] == "qwen2.5-vl-72b-instruct"
    assert "qwen3-vl-plus" in ids, "这家新报回来的视觉模型要能看见"


def test_minimax_text_model_can_be_used_for_reverse_prompt_without_media_models(client, monkeypatch):
    """一把 Key 三用的一家：反推那一列只摆能看懂图的，生图生视频那几路不许混进来。"""
    import httpx

    _stub_models(monkeypatch, [{"id": "MiniMax-M3.1-Flash"}, {"id": "MiniMax-M3"},
                               {"id": "MiniMax-H3-Image"}, {"id": "MiniMax-H3"}])
    row = client.post("/api/model-configs", json={
        "provider": "minimax", "api_key": "minimax-generation-key"}).json()
    assert row["capabilities"] == ["text", "image", "video", "audio"]
    out = client.get(f'/api/model-configs/{row["id"]}/models').json()
    assert out["source"] == "live"
    assert [item["id"] for item in out["models"]] == ["MiniMax-M3.1-Flash", "MiniMax-M3"]


def test_a_config_model_list_for_a_missing_row_is_404(client):
    assert client.get("/api/model-configs/999/models").status_code == 404


def test_a_custom_config_asks_its_own_url_for_models(client, monkeypatch):
    """自定义服务不在注册表里：清单只能问它自己的 /models，Key 用它自己那把。"""
    import httpx

    service._MODEL_CACHE.clear()
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json={"data": [{"id": "local/vl"}]})

    actual = httpx.AsyncClient
    monkeypatch.setattr(service.httpx, "AsyncClient",
                        lambda **kwargs: actual(transport=httpx.MockTransport(handler), **kwargs))
    row = client.post("/api/model-configs", json={
        "name": "我的本地", "base_url": "http://127.0.0.1:8080/v1", "api_key": "LOCAL"}).json()
    out = client.get(f'/api/model-configs/{row["id"]}/models').json()
    assert seen["url"] == "http://127.0.0.1:8080/v1/models" and seen["auth"] == "Bearer LOCAL"
    assert [m["id"] for m in out["models"]] == ["local/vl"] and out["source"] == "live"
    service._MODEL_CACHE.clear()


def test_check_key_asks_the_model_list_and_costs_nothing(client, monkeypatch):
    """设置页那颗「检查 API Key」问的是清单：不碰模型、不进缓存、不外泄 Key。"""
    import httpx

    service._MODEL_CACHE.clear()
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json={"data": [{"id": "a-vl"}, {"id": "b-vl"}]})

    actual = httpx.AsyncClient
    monkeypatch.setattr(service.httpx, "AsyncClient",
                        lambda **kwargs: actual(transport=httpx.MockTransport(handler), **kwargs))
    spent = []
    monkeypatch.setattr(service, "request_model", lambda *args: spent.append(args))
    out = client.post("/api/model-configs/check-key", json={"provider": "qwen", "api_key": "CHECK-KEY"})
    assert out.status_code == 200 and out.json()["count"] == 2
    assert seen["url"] == "https://dashscope.aliyuncs.com/compatible-mode/v1/models"
    assert seen["auth"] == "Bearer CHECK-KEY"
    assert not spent, "检查 Key 不许顺手产生一次模型调用"
    assert "CHECK-KEY" not in out.text
    assert service._MODEL_CACHE == {}, "检查用的清单不进缓存：下次检查要看见新 Key 的真话"


def test_check_key_falls_back_to_the_saved_key(client, monkeypatch):
    import httpx

    row = client.post("/api/model-configs", json=preset_draft(api_key="SAVED-ONE")).json()
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json={"data": [{"id": "a-vl"}]})

    actual = httpx.AsyncClient
    monkeypatch.setattr(service.httpx, "AsyncClient",
                        lambda **kwargs: actual(transport=httpx.MockTransport(handler), **kwargs))
    out = client.post("/api/model-configs/check-key", json={"config_id": row["id"]})
    assert out.status_code == 200 and seen["auth"] == "Bearer SAVED-ONE"


def test_check_key_for_the_shared_key_needs_no_config(client, monkeypatch):
    """RunningHub 那把 Key 的家在云端账号：检查它不该先要求一条配置。"""
    import httpx

    client.post("/api/model-configs", json=runninghub_draft(api_key="RH-CHECK"))
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json={"data": [{"id": "x/vl"}]})

    actual = httpx.AsyncClient
    monkeypatch.setattr(service.httpx, "AsyncClient",
                        lambda **kwargs: actual(transport=httpx.MockTransport(handler), **kwargs))
    out = client.post("/api/model-configs/check-key", json={"provider": "runninghub"})
    assert out.status_code == 200 and out.json()["count"] == 1
    assert seen["url"] == "https://llm.runninghub.cn/v1/models" and seen["auth"] == "Bearer RH-CHECK"
    service._MODEL_CACHE.clear()


def test_check_key_with_nothing_to_check_says_so(client):
    resp = client.post("/api/model-configs/check-key", json={})
    assert resp.status_code == 422 and "Base URL" in resp.json()["detail"]


# ---------- 预设那几家也要现拉：下拉里要看得见服务商最新的模型 ----------


ZHIPU_TEXT_ONLY = [{"id": "glm-5.2"}, {"id": "glm-4.7"}, {"id": "glm-4.5-air"}, {"id": "embedding-3"}]


def test_zhipu_registry_lists_the_current_vision_models():
    """智谱的清单只报账号开通的那几个，能读图的不全在里面——这张表得跟着最新一代走。"""
    from app import providers

    ids = [item["id"] for item in service.curated_models(providers.PRESETS["zhipu"])]
    assert ids[0] == "glm-4.6v", "推荐位给当下这一代最强的视觉模型"
    assert {"glm-5.3-flash", "glm-5.3-flashx", "glm-5v-turbo", "glm-4.6v-flash",
            "glm-4.5v", "glm-4.1v-thinking-flash"} <= set(ids)
    assert "glm-4v" not in ids and "glm-4v-plus" not in ids, "2024 年那两张老模型别留在兜底表里"
    assert not ({"glm-5", "glm-5.1", "glm-5.2", "glm-5.3", "glm-4.7"} & set(ids)), "纯文本档不能反推"


def test_zhipu_note_says_which_generation_can_read_images():
    """苏醒会问「5.3 怎么看不到」：这家的说明要当场答清——5.3 是纯文本，5.3 Flash 才收图。"""
    from app import providers

    note = providers.PRESETS["zhipu"]["note"]
    assert "GLM-5.3 Flash" in note and "纯文本" in note and "GLM-4.6V" in note


@pytest.mark.parametrize("model_id", [
    "glm-4.5v", "glm-4.6v", "glm-4.6v-flash", "glm-5v-turbo", "glm-4v", "glm-4v-flash",
    "qwen2.5-vl-72b-instruct", "moonshot-v1-8k-vision-preview", "internvl3-78b"])
def test_vision_hint_recognises_models_that_can_see(model_id):
    """智谱这一家的写法是 glm-4.6v：没有「4v」这种连写，旧写法一律认不出来。"""
    assert service._VISION_HINT.search(model_id)


@pytest.mark.parametrize("model_id", [
    "glm-4.5", "glm-4.5-air", "glm-4.6", "glm-5", "glm-5.2", "deepseek-v3", "gpt-4o-mini"])
def test_vision_hint_does_not_invent_vision(model_id):
    """纯文本模型不许被认成能看图：反推是发图过去，选中它只会换回一句 400。"""
    assert not service._VISION_HINT.search(model_id)


def test_preset_config_list_shows_what_the_account_reports(client, monkeypatch):
    """智谱下拉里能看见什么，以它自己报回来的为准——这就是「看不到最新模型」的正解。"""
    seen = _stub_models(monkeypatch, [{"id": "glm-4.6v"}, {"id": "glm-5.2"}, {"id": "glm-4.7"},
                                      {"id": "glm-5v-turbo"}, {"id": "glm-4v-flash"}, {"id": "embedding-3"}])
    row = client.post("/api/model-configs", json={"provider": "zhipu", "api_key": "ZHIPU-KEY"}).json()
    out = client.get(f'/api/model-configs/{row["id"]}/models').json()

    assert seen["url"] == "https://open.bigmodel.cn/api/paas/v4/models"
    assert seen["auth"] == "Bearer ZHIPU-KEY"
    assert out["source"] == "live"
    # 顺序：注册表里且这家确实报回来的 → 这家新报回来的视觉模型 → 注册表有、这家没报回来的
    assert [item["id"] for item in out["models"]] == [
        "glm-4.6v", "glm-5v-turbo", "glm-4v-flash", "glm-5.3-flash", "glm-5.3-flashx",
        "glm-4.6v-flash", "glm-4.5v", "glm-4.1v-thinking-flash"]
    assert out["models"][0]["label"] == "GLM-4.6V", "注册表里的展示名要跟着过来，别只剩一串 id"
    assert [item["id"] for item in out["models"] if item["recommended"]] == ["glm-4.6v"]
    assert "ZHIPU-KEY" not in str(out)
    # 挡在外面的那几个也要说得出数：清单确实读到了，只是那些是纯文本档
    assert out["hidden"] == 2, "glm-5.2 和 glm-4.7 被挡在反推这一列外面，要带回界面说明"


def test_preset_config_list_keeps_the_registry_when_the_account_reports_only_text(client, monkeypatch):
    """清单只报账号开着的模型：一个视觉模型都没报回来时不许把列表清空，兜底那几张得在。"""
    _stub_models(monkeypatch, ZHIPU_TEXT_ONLY)
    row = client.post("/api/model-configs", json={"provider": "zhipu", "api_key": "ZHIPU-KEY"}).json()
    out = client.get(f'/api/model-configs/{row["id"]}/models').json()

    assert [item["id"] for item in out["models"]][0] == "glm-4.6v"
    assert [item["id"] for item in out["models"] if item["recommended"]] == ["glm-4.6v"]


def test_preset_config_list_falls_back_and_stops_knocking(client, monkeypatch):
    """问不到就回注册表那一串，并且短时间内别反复敲同一家：不然每划过一家都要干等一次超时。"""
    calls: list = []
    _stub_models(monkeypatch, [], status=503, calls=calls)
    row = client.post("/api/model-configs", json={"provider": "zhipu", "api_key": "ZHIPU-BAD"}).json()

    first = client.get(f'/api/model-configs/{row["id"]}/models').json()
    assert first["source"] == "preset" and first["models"][0]["id"] == "glm-4.6v"
    assert "实时清单" in first["reason"]
    second = client.get(f'/api/model-configs/{row["id"]}/models').json()
    assert second["source"] == "preset"
    assert len(calls) == 1, "刚失败过就别马上再敲，界面那边是每次划过一家都会问一遍"


def test_preset_config_list_without_a_key_never_leaves_the_app(client, monkeypatch):
    """没配 Key 就不该往外发请求：直接给内置那张表，并说清配好之后会换成它自己报的。"""
    calls: list = []
    _stub_models(monkeypatch, [{"id": "glm-4.6v"}], calls=calls)
    row = client.post("/api/model-configs", json={"provider": "zhipu"}).json()
    assert row["has_api_key"] is False

    out = client.get(f'/api/model-configs/{row["id"]}/models').json()
    assert calls == [] and out["source"] == "preset"
    assert out["models"][0]["id"] == "glm-4.6v" and "Key" in out["reason"]


def test_preset_config_list_reuses_the_cached_list_for_ten_minutes(client, monkeypatch):
    """十分钟之内划过同一家不该反复敲它；过点了要重新问，否则清单又冻住了。"""
    calls: list = []
    _stub_models(monkeypatch, [{"id": "glm-4.6v"}], calls=calls)
    row = client.post("/api/model-configs", json={"provider": "zhipu", "api_key": "ZHIPU-OK"}).json()
    client.get(f'/api/model-configs/{row["id"]}/models')
    client.get(f'/api/model-configs/{row["id"]}/models')
    assert len(calls) == 1

    # 把那份缓存的落章时间往回拨过十分钟，下一次问就该真的再问一次
    cache_key = next(iter(service._MODEL_CACHE))
    stamp, cached = service._MODEL_CACHE[cache_key]
    service._MODEL_CACHE[cache_key] = (stamp - service.MODEL_CACHE_SECONDS - 1, cached)
    out = client.get(f'/api/model-configs/{row["id"]}/models').json()
    assert len(calls) == 2 and out["source"] == "live"


def test_media_models_do_not_slip_into_the_reverse_column():
    """名字里带 image 的生图模型（MiniMax-H3-Image）不许靠「看得懂图」混进反推那一列。"""
    curated = [{"id": "MiniMax-M3", "label": "MiniMax M3", "recommended": True}]
    live = [{"id": "MiniMax-H3-Image", "label": "MiniMax-H3-Image", "recommended": False},
            {"id": "MiniMax-H3", "label": "MiniMax-H3 视频", "recommended": False},
            {"id": "qwen3-vl-plus", "label": "qwen3-vl-plus", "recommended": False}]
    merged = service.merge_model_lists(curated, live, exclude={"MiniMax-H3-Image", "MiniMax-H3"})
    assert [item["id"] for item in merged] == ["qwen3-vl-plus", "MiniMax-M3"]
    assert [item["id"] for item in merged if item["recommended"]] == ["MiniMax-M3"]


def test_model_list_cache_ages_out():
    """缓存只判「有没有」不判「多久」，等于进程开一整天清单就冻在启动那一刻——这条钉住过期。"""
    stale = {"models": [{"id": "old-vl", "label": "old-vl", "recommended": True}], "source": "live", "reason": ""}
    service._MODEL_CACHE["probe"] = (time.monotonic() - service.MODEL_CACHE_SECONDS - 1, stale)
    assert service._cached_models("probe") is None
    service._MODEL_CACHE["probe"] = (time.monotonic(), stale)
    assert service._cached_models("probe") == stale
