"""/api/settings + /api/scan + /api/stats 路由。"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException

from .. import repository
from ..config import Config, load_config, save_config
from ..events import get_bus
from ..indexer import get_indexer
from ..models import ConfigOut, ConfigUpdate, ScanProgress

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["settings"])


@router.get("/settings")
def get_settings() -> ConfigOut:
    cfg = load_config()
    return ConfigOut(**{k: getattr(cfg, k) for k in ConfigOut.model_fields})


@router.put("/settings")
def update_settings(payload: ConfigUpdate) -> ConfigOut:
    cfg = get_indexer().update_config(**{k: v for k, v in payload.model_dump().items() if v is not None})
    return ConfigOut(**{k: getattr(cfg, k) for k in ConfigOut.model_fields})


@router.post("/scan")
def trigger_scan(payload: dict, background: BackgroundTasks):
    """触发一次扫描。``path`` 可选，默认扫描所有 watch_dirs。

    注意：扫描是 UPSERT，已存在的图片会被重新解析，width/height 等新增字段会补齐。
    """
    path = payload.get("path")
    if path:
        targets = [Path(path).resolve()]
        if not targets[0].exists():
            raise HTTPException(400, f"路径不存在: {path}")
    else:
        cfg = load_config()
        if not cfg.watch_dirs:
            raise HTTPException(400, "尚未配置监听目录")
        targets = [Path(d) for d in cfg.watch_dirs]

    def _scan() -> None:
        for t in targets:
            try:
                get_indexer().scan(t)
            except Exception as e:  # noqa: BLE001
                log.exception("scan failed: %s", e)

    background.add_task(_scan)
    return {"ok": True, "targets": [str(t) for t in targets]}


@router.post("/thumbnails/rebuild")
def rebuild_thumbnails(payload: dict, background: BackgroundTasks):
    """一键重建所有缩略图。

    payload 可选 size / quality，未传则用当前 config。
    后台跑，不阻塞响应；通过 WebSocket `thumb_rebuild_*` 事件推进度。
    """
    size = payload.get("size")
    quality = payload.get("quality")
    if size is not None:
        try:
            size = int(size)
        except (TypeError, ValueError):
            raise HTTPException(400, "size 必须是整数")
        if not (64 <= size <= 2048):
            raise HTTPException(400, "size 必须在 64..2048 之间")
    if quality is not None:
        try:
            quality = int(quality)
        except (TypeError, ValueError):
            raise HTTPException(400, "quality 必须是整数")
        if not (40 <= quality <= 100):
            raise HTTPException(400, "quality 必须在 40..100 之间")

    def _run() -> None:
        try:
            get_indexer().rebuild_thumbnails(size=size, quality=quality, fire_event=True)
        except Exception as e:  # noqa: BLE001
            log.exception("rebuild thumbs failed: %s", e)

    background.add_task(_run)
    return {"ok": True, "started": True, "size": size, "quality": quality}


@router.get("/scan/progress")
def scan_progress() -> ScanProgress:
    return ScanProgress(**get_indexer().get_progress())


@router.get("/stats")
def stats():
    return repository.stats()
