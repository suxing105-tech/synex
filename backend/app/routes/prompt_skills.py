"""提示词优化接口：技能清单的增删改查，加上「按这条技能优化一次」。

SafeValidationRoute 沿用反推那一条：校验失败时 Pydantic 默认会把整个请求体回显出来，
而这里的请求体里可能有一整份 SKILL.md，甚至用户误粘的东西。
"""
from __future__ import annotations

from fastapi import APIRouter, File, Form, UploadFile
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from .. import prompt_skills as service
from .. import prompt_translate
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
    # 撞名了怎么办：ask=先问（默认）、replace=换掉原来那条、new=另存一条。
    # 口径在 service 的 CONFLICT_MODES，这里不重复校验，免得两处说法不一致。
    on_conflict: str = "ask"


class PathImportInput(BaseModel):
    """导入那一个入口：挑中或拖进来的路径，md、.zip、一整个目录都从这儿走。"""

    model_config = ConfigDict(str_strip_whitespace=True)
    paths: list[str] = Field(min_length=1, max_length=service.MAX_IMPORT_SOURCES)
    on_conflict: str = "ask"


class PackageFileInput(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    content: str = Field(default="", max_length=2_000_000)


class PackageUploadInput(BaseModel):
    """浏览器开发模式选文件夹：前端把读到的文件内容传上来。"""

    model_config = ConfigDict(str_strip_whitespace=True)
    root: str = Field(default="", max_length=200)
    files: list[PackageFileInput] = Field(default_factory=list, max_length=500)
    on_conflict: str = "ask"


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
    # 弹窗上选定的参数（戏种、武打速度、时长、比例）压成一行送进来。
    # 500 是上限不是目标：它拼在系统提示尾部，太长会开始稀释技能正文本身。
    context: str = Field(default="", max_length=500)
    refs: list[RefInput] = Field(default_factory=list, max_length=service.MAX_REF_IMAGES)


@router.get("/prompt-skills")
def list_skills():
    return service.list_skills()


@router.post("/prompt-skills")
def create_skill(payload: SkillInput):
    return service.save_skill(payload.model_dump())


@router.post("/prompt-skills/import")
def import_skill(payload: ImportInput):
    """浏览器版的一份 md 原文。返回 imported / conflicts / skipped 四类导入结果共用的形状。"""
    return service.import_from_markdown(payload.content, payload.filename,
                                        on_conflict=payload.on_conflict)


@router.post("/prompt-skills/import-path")
async def import_path(payload: PathImportInput):
    """桌面版那一个「导入技能」入口：md、.zip、一整个技能包文件夹都收在这儿。

    扫盘、开压缩包都是阻塞 IO：放线程池里，别把事件循环占住。
    """
    return await run_in_threadpool(service.import_from_paths, payload.paths, payload.on_conflict)


@router.post("/prompt-skills/import-archive")
async def import_archive(file: UploadFile = File(...), on_conflict: str = Form("ask")):
    """浏览器版没有磁盘路径可给，压缩包只能整份上传；后端在内存里读，不解压到盘上。"""
    blob = await file.read()
    return await run_in_threadpool(service.import_from_archive_bytes, blob,
                                   file.filename or "技能包.zip", on_conflict)


@router.post("/prompt-skills/import-package/upload")
def import_package_upload(payload: PackageUploadInput):
    return service.import_from_upload_dir(payload.root,
                                          [item.model_dump() for item in payload.files],
                                          payload.on_conflict)


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


class TranslateInput(BaseModel):
    """提示词框那颗中英互译要的正文。上限和优化那一条对齐：框里最长就这么长。"""

    model_config = ConfigDict(str_strip_whitespace=True)
    text: str = Field(min_length=1, max_length=50000)


@router.post("/prompt-skills/{skill_id}/optimize")
async def optimize(skill_id: int, payload: OptimizeInput):
    return await service.optimize(skill=service.get_skill(skill_id), prompt=payload.prompt,
                                 kind=payload.kind, refs=[item.model_dump() for item in payload.refs],
                                 context=payload.context)


@router.post("/translate-prompt")
async def translate_prompt(payload: TranslateInput):
    """提示词框右下角那颗中英互译：正文翻成另一种语言，方向按正文主体语言判，不问人。

    不写库、不缓存——第二下要回原文、第三下要重新翻，缓存只会把旧译文扣在新原文上。
    """
    return await prompt_translate.translate(payload.text)
