"""Reverse prompt endpoints; all external requests originate from the backend."""
from __future__ import annotations

import base64
import io
import threading

from fastapi import APIRouter, HTTPException, Query
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from starlette.responses import JSONResponse
from pydantic import BaseModel, Field, SecretStr, ConfigDict
from PIL import Image, ImageDraw
from starlette.concurrency import run_in_threadpool

from .. import db, reverse_prompts as service

class SafeValidationRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def safe_handler(request):
            try:
                return await handler(request)
            except RequestValidationError:
                # Pydantic's default errors can echo an entire body, including api_key.
                return JSONResponse({"detail": "配置或请求参数无效，请检查必填项、超时范围与文本长度"}, status_code=422)
        return safe_handler


router = APIRouter(prefix="/api", tags=["reverse-prompts"], route_class=SafeValidationRoute)
_busy: set[int] = set()
_busy_lock = threading.Lock()


class ModelInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    base_url: str = Field(min_length=1, max_length=2048)
    model: str = Field(min_length=1, max_length=200)
    timeout: int = Field(default=120, ge=10, le=600)
    api_key: SecretStr | None = None


class ModelPatch(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str | None = Field(default=None, min_length=1, max_length=100)
    base_url: str | None = Field(default=None, min_length=1, max_length=2048)
    model: str | None = Field(default=None, min_length=1, max_length=200)
    timeout: int | None = Field(default=None, ge=10, le=600)
    api_key: SecretStr | None = None


class ModelTest(ModelInput):
    config_id: int | None = None


def config_values(payload):
    values = payload.model_dump(exclude_none=True)
    if payload.api_key is not None:
        key = payload.api_key.get_secret_value().strip()
        if any(ord(c) < 32 or ord(c) > 126 for c in key):
            raise HTTPException(422, "API Key 包含无效字符")
        values["api_key"] = key
    return values


class SettingsInput(BaseModel):
    default_model_id: int | None = None
    instruction: str = Field(min_length=1, max_length=12000)


class GenerateInput(BaseModel):
    model_config_id: int | None = None


class EditInput(BaseModel):
    parent_id: int
    prompt_zh: str = Field(min_length=1, max_length=50000)
    prompt_en: str = Field(min_length=1, max_length=50000)


@router.get("/model-configs")
def list_configs():
    rows = db.get_pool().main().execute("SELECT * FROM model_configs ORDER BY id").fetchall()
    return [service.public_config(row) for row in rows]


@router.post("/model-configs")
def create_config(payload: ModelInput):
    return service.save_config(config_values(payload))


@router.patch("/model-configs/{config_id}")
def update_config(config_id: int, payload: ModelPatch):
    return service.save_config(config_values(payload), config_id)


@router.delete("/model-configs/{config_id}")
def delete_config(config_id: int):
    service.get_config(config_id)
    db.get_pool().main().execute("DELETE FROM model_configs WHERE id=?", (config_id,))
    service._session_keys.pop(service.credential_scope(config_id), None)
    return {"ok": True}


@router.post("/model-configs/test")
async def test_config(payload: ModelTest):
    values = config_values(payload)
    config_id = values.pop("config_id", None)
    existing = service.get_config(config_id) if config_id is not None else None
    key = values.pop("api_key", None)
    if key is None:
        key = service.key_for(existing) if existing else ""
    image = Image.new("RGB", (128, 128), "white")
    ImageDraw.Draw(image).rectangle((32, 32, 96, 96), fill="red")
    output = io.BytesIO()
    image.save(output, "PNG")
    url = "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()
    text = await service.request_model(values, key, url, "请准确描述图片中心的形状和颜色。")
    return {"ok": True, "message": "接口已返回图片描述，请核对是否识别为白底红色方形。", "text": text}


@router.get("/reverse-prompt-settings")
def get_settings():
    return service.settings()


@router.put("/reverse-prompt-settings")
def update_settings(payload: SettingsInput):
    if not payload.instruction.strip():
        raise HTTPException(422, "反推指令不能为空")
    if payload.default_model_id is not None:
        service.get_config(payload.default_model_id)
    db.get_pool().main().execute("UPDATE reverse_prompt_settings SET default_model_id=?,instruction=? WHERE id=1",
                               (payload.default_model_id, payload.instruction.strip()))
    return service.settings()


@router.post("/images/{image_id}/reverse-prompts")
async def generate(image_id: int, payload: GenerateInput):
    with _busy_lock:
        if image_id in _busy:
            raise HTTPException(409, "这张图片正在反推，请等待完成")
        _busy.add(image_id)
    try:
        settings = service.settings()
        config_id = payload.model_config_id or settings["default_model_id"]
        if config_id is None:
            raise HTTPException(400, "请先配置并选择模型")
        config = service.get_config(config_id)
        key = service.key_for(config)
        instruction = settings["instruction"]
        if key:
            instruction = instruction.replace(key, "[已隐藏密钥]")
        data_url, fingerprint = await run_in_threadpool(service.prepare_image, service.image_path(image_id))
        text = await service.request_model(config, key, data_url, instruction)
        zh, en, status = service.parse_text(text)
        return service.insert_record(image_id, prompt_zh=zh, prompt_en=en, raw_text=text, status=status,
                                     source="generated", parent_id=None, model_name=config["name"], model=config["model"],
                                     instruction=instruction + service.OUTPUT_RULE, fingerprint=fingerprint)
    finally:
        with _busy_lock:
            _busy.discard(image_id)


@router.get("/images/{image_id}/reverse-prompts")
def history(image_id: int, limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0)):
    service.image_path(image_id)
    conn = db.get_pool().main()
    rows = conn.execute("SELECT * FROM reverse_prompts WHERE image_id=? ORDER BY id DESC LIMIT ? OFFSET ?",
                        (image_id, limit, offset)).fetchall()
    total = conn.execute("SELECT count(*) FROM reverse_prompts WHERE image_id=?", (image_id,)).fetchone()[0]
    fingerprint = service.current_fingerprint(image_id) if rows else None
    with _busy_lock:
        busy = image_id in _busy
    return {"items": [{**dict(row), "image_changed": fingerprint != row["fingerprint"]} for row in rows],
            "total": total, "limit": limit, "offset": offset, "running": busy}


@router.post("/images/{image_id}/reverse-prompts/edits")
def edit(image_id: int, payload: EditInput):
    row = db.get_pool().main().execute("SELECT * FROM reverse_prompts WHERE id=? AND image_id=?",
                                      (payload.parent_id, image_id)).fetchone()
    if not row:
        raise HTTPException(404, "原始版本不存在")
    if not payload.prompt_zh.strip() or not payload.prompt_en.strip():
        raise HTTPException(422, "中文和英文提示词均不能为空")
    return service.insert_record(image_id, prompt_zh=payload.prompt_zh.strip(), prompt_en=payload.prompt_en.strip(),
                                 raw_text="", status="complete", source="edited", parent_id=row["id"],
                                 model_name=row["model_name"], model=row["model"], instruction=row["instruction"], fingerprint=row["fingerprint"])
