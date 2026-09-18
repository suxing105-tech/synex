"""ComfyUI 集成路由：状态探测 + open_workflow + config 更新。

设计要点：
- 探测独立于图片，仅需 ComfyUI URL；前端可手动触发重探测。
- open_workflow 需要图片存在 + 携带 workflow；写临时文件后由前端负责
  打开 / 复用 ComfyUI 浏览器标签页（统一窗口名，浏览器自动复用）。
  后端不再调用 ``webbrowser.open``，避免 ``new=2`` 每次都新开标签页。
"""
from __future__ import annotations

import json
import logging
import time

from fastapi import APIRouter, HTTPException, Request

from ..config import load_config, save_config
from ..db import get_pool
from ..integrations.comfyui import DEFAULT_URL, comfyui_temp_dir, probe, write_workflow_temp
from ..models import ComfyuiConfigUpdate, ComfyuiStatus, OpenWorkflowResult

router = APIRouter(prefix="/api/integrations/comfyui", tags=["comfyui"])
log = logging.getLogger("suxing_gallery.comfyui")


# ---------- helpers ----------


def _current_url_and_enabled() -> tuple[str, bool]:
    cfg = load_config()
    return cfg.comfyui_url, cfg.comfyui_enabled


# ---------- 状态探测 ----------


@router.get("/status", response_model=ComfyuiStatus)
def get_status() -> ComfyuiStatus:
    """探测本机 ComfyUI 是否在跑（``/system_stats`` 或 ``/`` 任一 200 即视为在跑）。"""
    url, enabled = _current_url_and_enabled()
    if not enabled:
        return ComfyuiStatus(running=False, url=url, enabled=False, checked_at=time.time())
    running = probe(url)
    return ComfyuiStatus(running=running, url=url, enabled=enabled, checked_at=time.time())


# ---------- 配置更新 ----------


@router.put("/config", response_model=ComfyuiStatus)
def update_config(payload: ComfyuiConfigUpdate, request: Request) -> ComfyuiStatus:
    """更新 ComfyUI URL / enabled 开关，立刻重探测一次。"""
    cfg = load_config()
    if payload.url is not None:
        url = payload.url.strip()
        if not url:
            raise HTTPException(400, "url 不能为空")
        if not (url.startswith("http://") or url.startswith("https://")):
            raise HTTPException(400, "url 必须以 http:// 或 https:// 开头")
        cfg.comfyui_url = url.rstrip("/") or DEFAULT_URL
    if payload.enabled is not None:
        cfg.comfyui_enabled = payload.enabled
    save_config(cfg)
    # 复用 get_status 保证返回的 running / url 与 GET 一致
    return get_status()


# ---------- 打开工作流 ----------


@router.post("/open_workflow/{image_id}", response_model=OpenWorkflowResult)
def open_workflow(image_id: int) -> OpenWorkflowResult:
    """把图片的 workflow 写到 ``data/comfyui_temp/<image_filename>.json``。

    - 图片不存在 → 404
    - 图片无 workflow → 400 ``no_workflow``
    - 集成未启用 → 403 ``disabled``

    注意：浏览器标签页的「打开 / 复用」由前端负责（统一 ``suxing_comfyui``
    窗口名，浏览器自动复用），后端不再调用 ``webbrowser.open``。
    """
    cfg = load_config()
    if not cfg.comfyui_enabled:
        raise HTTPException(403, "ComfyUI 集成未启用（设置 → ComfyUI 集成）")

    pool = get_pool()
    row = pool.main().execute(
        "SELECT id, filename, workflow FROM images WHERE id = ?", (image_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, f"图片 {image_id} 不存在")
    image_filename = row["filename"] or f"image_{image_id}"
    workflow_json = row["workflow"] or ""
    if not workflow_json.strip():
        raise HTTPException(400, "no_workflow")

    try:
        workflow = json.loads(workflow_json)
        if not isinstance(workflow, dict):
            raise ValueError("工作流格式无效")
    except (ValueError, TypeError) as e:
        raise HTTPException(400, "图片工作流 JSON 无效") from e
    target = write_workflow_temp(image_filename, workflow_json)
    if not target:
        # 二次保险：上面已经判过空，这里只是兜底
        raise HTTPException(400, "no_workflow")

    comfyui_url = cfg.comfyui_url
    message = (
        f"工作流已追加：{target.name}（位于 {target.parent}）。"
        f"ComfyUI 中 File → Load 即可加载。"
    )
    return OpenWorkflowResult(
        ok=True,
        image_id=image_id,
        file_path=str(target),
        workflow_name=target.stem,
        comfyui_url=comfyui_url,
        browser_opened=False,  # 由前端管窗口复用，后端不负责弹窗
        message=message,
        workflow=workflow,
    )


# ---------- 调试辅助：列出临时文件 ----------


@router.get("/temp_files")
def list_temp_files() -> dict:
    """列出 ``data/comfyui_temp/`` 下的文件，便于调试（不做权限校验）。"""
    d = comfyui_temp_dir()
    return {
        "dir": str(d),
        "files": [p.name for p in sorted(d.glob("*.json"))],
    }