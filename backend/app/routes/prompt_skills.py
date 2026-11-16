"""提示词优化接口：技能清单的增删改查，加上「按这条技能优化一次」。

SafeValidationRoute 沿用反推那一条：校验失败时 Pydantic 默认会把整个请求体回显出来，
而这里的请求体里可能有一整份 SKILL.md，甚至用户误粘的东西。
"""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from .. import prompt_skills as service
from .reverse_prompts import SafeValidationRoute

router = APIRouter(prefix="/api", tags=["prompt-skills"], route_class=SafeValidationRoute)


def kinds_default() -> list[str]:
    return list(service.KINDS)


class SkillInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=service.MAX_NAME)
    note: str = Field(default="", max_length=service.MAX_NOTE)
    kinds: list[str] = Field(default_factory=kinds_default)
    instruction: str = Field(min_length=1, max_length=service.MAX_INSTRUCTION)
    language: str = Field(default="auto", max_length=8)
    with_refs: bool = True


class SkillPatch(BaseModel):
    """改一条技能：没出现的字段一个字不动。"""

    model_config = ConfigDict(str_strip_whitespace=True)
    name: str | None = Field(default=None, min_length=1, max_length=service.MAX_NAME)
    note: str | None = Field(default=None, max_length=service.MAX_NOTE)
    kinds: list[str] | None = None
    instruction: str | None = Field(default=None, min_length=1, max_length=service.MAX_INSTRUCTION)
    language: str | None = Field(default=None, max_length=8)
    with_refs: bool | None = None


class ImportInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    filename: str = Field(default="", max_length=400)
    # 给的是「读到的原文」而不是「截断后的正文」：截断规则只有一个真源，在 service 里。
    content: str = Field(min_length=1, max_length=2_000_000)


class PackageImportInput(BaseModel):
    """桌面版导入：用户挑了一个文件夹，后端按路径扫盘。"""

    model_config = ConfigDict(str_strip_whitespace=True)
    path: str = Field(min_length=1, max_length=2000)


class PackageFileInput(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    content: str = Field(default="", max_length=2_000_000)


class PackageUploadInput(BaseModel):
    """浏览器开发模式导入：前端把读到的文件内容传上来。"""

    model_config = ConfigDict(str_strip_whitespace=True)
    root: str = Field(default="", max_length=200)
    files: list[PackageFileInput] = Field(default_factory=list, max_length=500)


class SettingsInput(BaseModel):
    default_image_skill: int | None = None
    default_video_skill: int | None = None


class RefInput(BaseModel):
    """一格参考图：ordinal 是提示词里的编号，不是「第几张送来的图」。"""

    ordinal: int = Field(ge=1, le=64)
    image_id: int = Field(ge=1)


class OptimizeInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    prompt: str = Field(min_length=1, max_length=50000)
    kind: str = Field(pattern="^(image|video)$")
    refs: list[RefInput] = Field(default_factory=list, max_length=service.MAX_REF_IMAGES)


@router.get("/prompt-skills")
def list_skills():
    return service.list_skills()


@router.post("/prompt-skills")
def create_skill(payload: SkillInput):
    return service.save_skill(payload.model_dump())


@router.post("/prompt-skills/import")
def import_skill(payload: ImportInput):
    return service.import_skill(payload.content, payload.filename)


@router.post("/prompt-skills/import-package")
async def import_package(payload: PackageImportInput):
    # 扫盘是阻塞 IO：放线程池里，别把事件循环占住。
    return await run_in_threadpool(service.import_package_from_path, payload.path)


@router.post("/prompt-skills/import-package/upload")
def import_package_upload(payload: PackageUploadInput):
    return service.import_package_from_upload(payload.root,
                                               [item.model_dump() for item in payload.files])


@router.get("/prompt-skills/{skill_id}/package")
def package_detail(skill_id: int):
    return service.package_detail(skill_id)


@router.patch("/prompt-skills/{skill_id}")
def update_skill(skill_id: int, payload: SkillPatch):
    return service.save_skill(payload.model_dump(exclude_none=True), skill_id)


@router.delete("/prompt-skills/{skill_id}")
def delete_skill(skill_id: int):
    return service.delete_skill(skill_id)


@router.post("/prompt-skills/{skill_id}/restore-default")
def restore_default(skill_id: int):
    return service.restore_default(skill_id)


@router.get("/prompt-skill-settings")
def get_settings():
    return service.settings()


@router.put("/prompt-skill-settings")
def update_settings(payload: SettingsInput):
    return service.save_settings(default_image_skill=payload.default_image_skill,
                                 default_video_skill=payload.default_video_skill)


@router.post("/prompt-skills/{skill_id}/optimize")
async def optimize(skill_id: int, payload: OptimizeInput):
    return await service.optimize(skill=service.get_skill(skill_id), prompt=payload.prompt,
                                 kind=payload.kind, refs=[item.model_dump() for item in payload.refs])
