from __future__ import annotations

import asyncio
import base64
import io
import json
import sys

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from app import reverse_prompts as service
from app.routes.reverse_prompts import router


@pytest.fixture
def client(init_db):
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        yield client


@pytest.fixture
def image_id(init_db, tmp_path):
    path = tmp_path / "sample.png"
    Image.new("RGBA", (32, 16), (255, 0, 0, 100)).save(path)
    return init_db.main().execute(
        "INSERT INTO images(path,filename,mtime,size_bytes,positive_prompt) VALUES(?,?,?,?,?)",
        (str(path), path.name, path.stat().st_mtime, path.stat().st_size, "original prompt"),
    ).lastrowid


def draft(**kwargs):
    return {"name": "视觉模型", "base_url": "https://example.com/api/v1/", "model": "vision", "timeout": 120, **kwargs}


def test_config_crud_and_key_storage(client, init_db):
    key = "test-credential-only"
    result = client.post("/api/model-configs", json=draft(api_key=key))
    assert result.status_code == 200
    data = result.json()
    assert key not in result.text and data["has_api_key"]
    row = service.get_config(data["id"])
    assert service.key_for(row) == key
    assert row["credential"] != key.encode()
    if sys.platform == "win32":
        service._session_keys.clear()
        assert service.key_for(service.get_config(data["id"])) == key
    assert client.get("/api/reverse-prompt-settings").json()["default_model_id"] == data["id"]
    client.patch(f'/api/model-configs/{data["id"]}', json={"name": "改名"})
    assert service.key_for(service.get_config(data["id"])) == key
    client.patch(f'/api/model-configs/{data["id"]}', json={"api_key": "replacement"})
    assert service.key_for(service.get_config(data["id"])) == "replacement"
    cleared = client.patch(f'/api/model-configs/{data["id"]}', json={"api_key": ""})
    assert not cleared.json()["has_api_key"]
    assert client.delete(f'/api/model-configs/{data["id"]}').status_code == 200
    assert client.get("/api/reverse-prompt-settings").json()["default_model_id"] is None


def test_session_keys_never_persist(client, monkeypatch):
    monkeypatch.setattr(service.sys, "platform", "linux")
    row = client.post("/api/model-configs", json=draft(api_key="session-only")).json()
    assert service.get_config(row["id"])["credential"] is None
    assert service.key_for(service.get_config(row["id"])) == "session-only"
    service._session_keys.clear()
    assert not client.get("/api/model-configs").json()[0]["has_api_key"]


def test_multiple_models_and_preferences(client):
    first = client.post("/api/model-configs", json=draft(name="模型一")).json()
    second = client.post("/api/model-configs", json=draft(name="模型二", model="other")).json()
    assert len(client.get("/api/model-configs").json()) == 2
    assert client.get("/api/reverse-prompt-settings").json()["default_model_id"] == first["id"]
    changed = client.put("/api/reverse-prompt-settings", json={"default_model_id": second["id"], "instruction": "突出光线"})
    assert changed.status_code == 200 and changed.json()["instruction"] == "突出光线"
    assert client.put("/api/reverse-prompt-settings", json={"default_model_id": 9999, "instruction": "bad"}).status_code == 404
    assert client.get("/api/reverse-prompt-settings").json()["default_model_id"] == second["id"]
    client.delete(f'/api/model-configs/{first["id"]}')
    assert client.get("/api/reverse-prompt-settings").json()["default_model_id"] == second["id"]


@pytest.mark.parametrize("url,expected", [
    ("https://example.com/vendor/v1/", "https://example.com/vendor/v1"),
    ("https://example.com/v1/chat/completions/", "https://example.com/v1"),
    ("http://127.0.0.1:8080/v1", "http://127.0.0.1:8080/v1"),
    ("http://192.168.1.10/v1", "http://192.168.1.10/v1"),
])
def test_url(url, expected):
    assert service.normalize_url(url) == expected


@pytest.mark.parametrize("url", ["http://example.com/v1", "ftp://localhost", "https://user:pass@example.com", "https://example.com?key=bad", "not-url"])
def test_bad_url(url):
    with pytest.raises(HTTPException):
        service.normalize_url(url)


def test_validation_does_not_echo_credentials(client):
    key = "private-test-value"
    for payload in [dict(api_key=key), draft(api_key=key, timeout=1), draft(api_key=key + "\ninvalid")]:
        response = client.post("/api/model-configs", json=payload)
        assert response.status_code == 422 and key not in response.text


def test_image_preparation(tmp_path):
    path = tmp_path / "large.png"
    Image.new("RGBA", (4000, 2000), (0, 0, 0, 0)).save(path)
    before = path.read_bytes()
    url, fingerprint = service.prepare_image(path)
    im = Image.open(io.BytesIO(base64.b64decode(url.split(",")[1])))
    assert im.size == (2048, 1024) and im.getpixel((0, 0)) == (255, 255, 255)
    assert im.format == "JPEG" and not im.getexif()
    assert path.read_bytes() == before and len(fingerprint) == 64
    small = tmp_path / "small.jpg"
    exif = Image.Exif(); exif[274] = 6
    Image.new("RGB", (32, 16)).save(small, exif=exif)
    encoded, _ = service.prepare_image(small)
    assert Image.open(io.BytesIO(base64.b64decode(encoded.split(",")[1]))).size == (16, 32)


def test_first_frame_and_invalid_files(tmp_path):
    path = tmp_path / "animated.gif"
    Image.new("RGB", (8, 8), "red").save(path, save_all=True, append_images=[Image.new("RGB", (8, 8), "blue")])
    url, _ = service.prepare_image(path)
    assert Image.open(io.BytesIO(base64.b64decode(url.split(",")[1]))).getpixel((0, 0))[0] > 240
    path.write_bytes(b"broken")
    with pytest.raises(HTTPException) as error:
        service.prepare_image(path)
    assert error.value.status_code == 422
    with pytest.raises(HTTPException) as error:
        service.prepare_image(tmp_path / "missing.png")
    assert error.value.status_code == 404


@pytest.mark.asyncio
async def test_protocol(monkeypatch):
    actual_client = httpx.AsyncClient
    captured = []
    def handler(request):
        captured.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"prompt_zh":"红花","prompt_en":"red flower"}'}}]})
    monkeypatch.setattr(service.httpx, "AsyncClient", lambda **kwargs: actual_client(transport=httpx.MockTransport(handler), **kwargs))
    result = await service.request_model(draft(), "fake-key", "data:image/jpeg;base64,YQ==", "describe")
    assert service.parse_text(result) == ("红花", "red flower", "complete")
    request = captured[0]
    assert str(request.url) == "https://example.com/api/v1/chat/completions"
    assert request.headers["authorization"] == "Bearer fake-key"
    payload = json.loads(request.content)
    assert payload["stream"] is False and "response_format" not in payload
    assert payload["messages"][1]["content"][1]["image_url"]["url"].startswith("data:")


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [400, 401, 403, 404, 429, 500, 302])
async def test_upstream_errors_redacted(monkeypatch, status):
    actual_client = httpx.AsyncClient
    count = 0
    def handler(request):
        nonlocal count
        count += 1
        return httpx.Response(status, text="private-key upstream body")
    monkeypatch.setattr(service.httpx, "AsyncClient", lambda **kwargs: actual_client(transport=httpx.MockTransport(handler), **kwargs))
    with pytest.raises(HTTPException) as error:
        await service.request_model(draft(), "private-key", "data:", "describe")
    assert "private-key" not in str(error.value.detail) and count == 1


@pytest.mark.asyncio
async def test_timeout_and_empty_response(monkeypatch):
    actual_client = httpx.AsyncClient
    def timeout(request):
        raise httpx.ReadTimeout("sensitive transport details", request=request)
    monkeypatch.setattr(service.httpx, "AsyncClient", lambda **kwargs: actual_client(transport=httpx.MockTransport(timeout), **kwargs))
    with pytest.raises(HTTPException) as error:
        await service.request_model(draft(), "", "data:", "describe")
    assert error.value.status_code == 504
    monkeypatch.setattr(service.httpx, "AsyncClient", lambda **kwargs: actual_client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={})), **kwargs))
    with pytest.raises(HTTPException) as error:
        await service.request_model(draft(), "", "data:", "describe")
    assert error.value.status_code == 502


def test_history_edit_rescan_and_model_deletion(client, image_id, init_db, monkeypatch):
    model_id = client.post("/api/model-configs", json=draft()).json()["id"]
    async def response(*args):
        return '```json\n{"prompt_zh":"红色","prompt_en":"red"}\n```'
    monkeypatch.setattr(service, "request_model", response)
    url = f"/api/images/{image_id}/reverse-prompts"
    first = client.post(url, json={}).json()
    assert first["source"] == "generated" and first["status"] == "complete"
    edited = client.post(url + "/edits", json={"parent_id": first["id"], "prompt_zh": "深红", "prompt_en": "dark red"}).json()
    assert edited["parent_id"] == first["id"] and edited["source"] == "edited"
    assert client.post(url + "/edits", json={"parent_id": 9999, "prompt_zh": "x", "prompt_en": "x"}).status_code == 404
    init_db.main().execute("UPDATE images SET positive_prompt='rescanned' WHERE id=?", (image_id,))
    client.delete(f"/api/model-configs/{model_id}")
    history = client.get(url, params={"limit": 1}).json()
    assert history["total"] == 2 and len(history["items"]) == 1
    assert history["items"][0]["model_name"] == "视觉模型"
    assert not history["items"][0]["image_changed"]
    Image.new("RGB", (32, 16), "blue").save(service.image_path(image_id))
    assert client.get(url).json()["items"][0]["image_changed"]
    service.initialize(init_db.main())
    assert client.get(url).json()["total"] == 2


def test_unstructured_and_failure_keep_history(client, image_id, monkeypatch):
    client.post("/api/model-configs", json=draft())
    async def raw(*args): return "原始内容"
    monkeypatch.setattr(service, "request_model", raw)
    url = f"/api/images/{image_id}/reverse-prompts"
    record = client.post(url, json={}).json()
    assert record["status"] == "unstructured" and record["raw_text"] == "原始内容"
    async def fail(*args): raise HTTPException(504, "超时")
    monkeypatch.setattr(service, "request_model", fail)
    assert client.post(url, json={}).status_code == 504
    assert client.get(url).json()["total"] == 1


@pytest.mark.asyncio
async def test_concurrent_and_deleted_image(client, image_id, monkeypatch, init_db):
    from app.routes.reverse_prompts import generate, GenerateInput
    client.post("/api/model-configs", json=draft())
    entered = asyncio.Event(); finish = asyncio.Event()
    async def wait(*args):
        entered.set(); await finish.wait()
        return '{"prompt_zh":"红","prompt_en":"red"}'
    monkeypatch.setattr(service, "request_model", wait)
    pending = asyncio.create_task(generate(image_id, GenerateInput()))
    await entered.wait()
    with pytest.raises(HTTPException) as error:
        await generate(image_id, GenerateInput())
    assert error.value.status_code == 409
    # No SQLite write transaction held while network request is pending.
    init_db.main().execute("DELETE FROM images WHERE id=?", (image_id,))
    finish.set()
    with pytest.raises(HTTPException) as error:
        await pending
    assert error.value.status_code == 404


def test_test_endpoint_uses_draft_and_builtin_image(client, monkeypatch):
    calls = []
    async def response(*args): calls.append(args); return "白底红色方形"
    monkeypatch.setattr(service, "request_model", response)
    result = client.post("/api/model-configs/test", json=draft(api_key="test-key"))
    assert result.status_code == 200 and result.json()["ok"]
    assert calls[0][1] == "test-key" and calls[0][2].startswith("data:image/png;base64,")
    assert client.get("/api/model-configs").json() == []
