"""一键同款路由：同款工作流模板管理 + 生成任务。

和反推提示词同一原则：外部请求只从 sidecar 出发，前端只认这套 REST 加上
clone_progress 事件。ComfyUI 的地址与开关沿用已有的 comfyui_url / comfyui_enabled。
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from .. import clone_jobs, clone_sources, clone_templates
from ..comfyui_client import ComfyUIClient
from ..config import load_config

router = APIRouter(prefix="/api/clone", tags=["clone"])
log = logging.getLogger("suxing_gallery.clone")

OBJECT_INFO_TIMEOUT = 6.0


class InspectInput(BaseModel):
    workflow: Any | None = None
    path: str | None = None


class TemplateInput(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    workflow: Any | None = None
    path: str | None = None
    slots: list[dict] | None = None


class TemplatePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    workflow: Any | None = None
    slots: list[dict] | None = None
    is_active: bool | None = None


class ReferenceInput(BaseModel):
    slot: str = Field(min_length=1, max_length=80)
    image_id: int


class GenerateInput(BaseModel):
    template_id: int
    prompt: str = Field(min_length=1, max_length=50000)
    references: list[ReferenceInput] = Field(default_factory=list)
    controls: dict[str, Any] = Field(default_factory=dict)
    source_image_id: int | None = None


# ---------- helpers ----------


def _read_json_file(path: str) -> str:
    target = Path(path)
    if target.suffix.lower() != ".json":
        raise HTTPException(422, "只能导入 .json 工作流文件。")
    try:
        data = target.read_bytes()
    except OSError as exc:
        raise HTTPException(404, f"读不到这个文件：{exc.strerror or exc}") from exc
    # Windows「另存为」常见 GBK：先按 UTF-8（含 BOM）读，读不通再退回 GBK。
    for encoding in ("utf-8-sig", "utf-8", "gbk"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise HTTPException(422, "这个 JSON 的编码读不了，请用 UTF-8 重新导出一份。")


def _nodes_from_payload(workflow: Any, path: str | None) -> dict:
    raw = workflow if workflow is not None else (_read_json_file(path) if path else None)
    if raw is None:
        raise HTTPException(422, "把这份工作流本身或一个 .json 文件路径传进来。")
    try:
        return clone_templates.parse_workflow(raw)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


# 控件槽（比例下拉、分辨率数值）的选项和上下限只存在于 ComfyUI 的 object_info 里。
# 拿不到就不检测成 0 个然后当无事发生——用户只会以为这份工作流没有比例可挑。
NO_OBJECT_INFO_HINT = (
    "没能读到 ComfyUI 的节点信息（{reason}），所以比例、分辨率这类参数没能识别出来。"
    "可以先导入，等 ComfyUI 开着的时候在这份工作流上点「重新检测槽位」补回来。"
)


async def _object_info(nodes: dict) -> tuple[dict, str]:
    """导入时抓一次 object_info，把比例/分辨率的下拉选项缓存进模板。

    返回 (节点信息, 失败原因)。失败原因一定要带出来：提示词槽和参考位不依赖它，
    照样能认出来，只有控件槽会静默消失，不说的话没人知道少了什么、为什么少。
    """
    cfg = load_config()
    if not cfg.comfyui_enabled:
        return {}, "设置里 ComfyUI 是关闭状态"
    classes = [str(node.get("class_type") or "") for node in nodes.values() if isinstance(node, dict)]
    client = ComfyUIClient(cfg.comfyui_url, timeout=OBJECT_INFO_TIMEOUT)
    try:
        # 先探一次再逐个读节点定义：object_info 内部对单个类的失败是静默跳过的，
        # 不先探就分不清「ComfyUI 根本没开」和「开了但读不到这些节点」，提示也就只能含糊。
        if not await client.probe():
            return {}, f"ComfyUI 没在 {cfg.comfyui_url} 运行"
        info = await client.object_info([c for c in classes if c])
    except Exception as exc:  # noqa: BLE001 - 连不上是常态，只把原因翻成人话，别把导入炸掉
        log.info("object_info 读取失败: %s", exc)
        return {}, f"连不上 {cfg.comfyui_url}"
    finally:
        await client.aclose()
    if not info:
        return {}, f"{cfg.comfyui_url} 里读不到这份工作流用到的节点定义"
    return info, ""


def _suggested_name(path: str | None) -> str:
    if not path:
        return ""
    return Path(path).stem[:40]


# ---------- 模板 ----------


@router.get("/templates")
def list_templates() -> dict:
    return {"items": clone_templates.list_templates()}


@router.post("/templates/inspect")
async def inspect_template(payload: InspectInput) -> dict:
    """导入预览：返回检测到的槽位、可选控件候选、节点清单与建议名字。

    设置页拿这个结果给用户确认（提示词槽勾选、控件取舍），确认后才落库。
    """
    nodes = _nodes_from_payload(payload.workflow, payload.path)
    info, reason = await _object_info(nodes)
    detected = clone_templates.detect_slots(nodes, info or None)
    warnings = list(detected.get("warnings") or [])
    has_controls = _has_controls(detected.get("slots"))
    if reason and not has_controls:
        warnings.append(NO_OBJECT_INFO_HINT.format(reason=reason))
    return {**detected, "warnings": warnings, "suggested_name": _suggested_name(payload.path)}


def _has_controls(slots: list[dict] | None) -> bool:
    return any(str(s.get("kind")) in ("select", "number") for s in slots or [])


@router.post("/templates", status_code=201)
async def create_template(payload: TemplateInput) -> dict:
    nodes = _nodes_from_payload(payload.workflow, payload.path)
    slots = payload.slots
    warning = ""
    if slots is None:
        # 正常导入是「inspect 预检 → 前端把确认过的槽位传回来」。没带槽位等于绕过预检直接建模板
        # （命令行、脚本、以后的自动化都会这么干），这时也得去要一次 object_info：
        # 否则比例、分辨率这类控件会静默丢掉，弹窗里永远少那颗「画面参数」——真机就少过一次。
        info, reason = await _object_info(nodes)
        detected = clone_templates.detect_slots(nodes, info or None)
        slots = detected.get("slots") or []
        if reason and not _has_controls(slots):
            warning = NO_OBJECT_INFO_HINT.format(reason=reason)
    try:
        row = clone_templates.create_template(payload.name, nodes, slots)
    except clone_templates.DuplicateNameError as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {**row, "warning": warning} if warning else row


@router.get("/templates/{template_id}/workflow")
def download_workflow(template_id: int) -> Response:
    try:
        raw = clone_templates.workflow_json(template_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    return Response(content=raw, media_type="application/json")


@router.patch("/templates/{template_id}")
def patch_template(template_id: int, payload: TemplatePatch) -> dict:
    patch = payload.model_dump(exclude_none=True)
    if payload.workflow is not None:
        # 就地替换工作流：先按 API 格式校验，错误信息比"槽位找不到"好懂得多。
        patch["workflow"] = _nodes_from_payload(payload.workflow, None)
    try:
        return clone_templates.update_template(template_id, patch)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except clone_templates.DuplicateNameError as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/templates/{template_id}")
def delete_template(template_id: int) -> dict:
    try:
        clone_templates.delete_template(template_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"ok": True, "deleted": template_id}


@router.post("/templates/{template_id}/redetect")
async def redetect_template(template_id: int) -> dict:
    """按存着的工作流重新检测一遍槽位。

    存在的理由就是上面那条：导入那一刻 ComfyUI 没开，比例/分辨率就没了；
    现在它开着，不必重新导一次工作流也能把参数补回来。
    """
    try:
        nodes = clone_templates.get_template(template_id)["nodes"]
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    info, reason = await _object_info(nodes)
    if not info:
        raise HTTPException(409, f"还是没能读到 ComfyUI 的节点信息（{reason}），把它打开以后再点一次。")
    try:
        return clone_templates.redetect_slots(template_id, info)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/templates/{template_id}/nodes")
def template_nodes(template_id: int) -> dict:
    """设置页"手动绑定任意 node.input"用的节点清单。"""
    try:
        template = clone_templates.get_template(template_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"nodes": clone_templates.node_overview(template["nodes"])}


@router.get("/sources/{image_id}")
def image_sources(image_id: int) -> dict:
    """这张图当初喂了哪几张参考图。没记过就返回空列表，弹窗退回老行为。"""
    return clone_sources.lookup(image_id)


# ---------- 生成 ----------


@router.post("/generate", status_code=202)
async def generate(payload: GenerateInput) -> dict:
    references = [ref.model_dump() for ref in payload.references]
    # 生成方式是参考图数量的函数，不在请求里；槽位校验在 clone_jobs.start 里做
    # （换个调用方也绕不过），这里只管翻成 HTTP 语义。
    try:
        return await clone_jobs.start(
            template_id=payload.template_id,
            prompt=payload.prompt,
            references=references,
            controls=payload.controls,
            source_image_id=payload.source_image_id,
        )
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except (clone_jobs.CloneBusy, clone_jobs.CloneUnavailable) as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/jobs/current")
def current_job() -> dict:
    """前端重开弹窗/刷新后接管进度：任务状态在内存里，不在库里。"""
    return clone_jobs.public_state()


@router.post("/jobs/current/cancel")
async def cancel_job() -> dict:
    return await clone_jobs.cancel()
