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
    # 先把可能 raise 的副作用都收口成 4xx，绝对不让 5xx 漏到前端
    if not isinstance(payload, dict):
        raise HTTPException(400, "payload 必须是 JSON 对象")
    raw_path = payload.get("path")
    if raw_path is None or raw_path == "":
        cfg = load_config()
        if not cfg.watch_dirs:
            raise HTTPException(400, "尚未配置监听目录")
        targets = [Path(d) for d in cfg.watch_dirs]
    else:
        if not isinstance(raw_path, str):
            raise HTTPException(400, "path 必须是字符串")
        try:
            target = Path(raw_path).expanduser().resolve()
        except (OSError, ValueError, RuntimeError) as e:
            raise HTTPException(400, f"路径无法解析: {raw_path} ({e})")
        if not target.exists():
            raise HTTPException(400, f"路径不存在: {raw_path}")
        if not target.is_dir():
            raise HTTPException(400, f"路径不是目录: {raw_path}")
        targets = [target]

    def _scan() -> None:
        for t in targets:
            try:
                get_indexer().scan(t)
            except Exception as e:  # noqa: BLE001
                log.exception("scan failed: %s", e)

    background.add_task(_scan)
    return {"ok": True, "targets": [str(t) for t in targets]}





@router.get("/scan/progress")
def scan_progress() -> ScanProgress:
    return ScanProgress(**get_indexer().get_progress())


@router.get("/stats")
def stats():
    return repository.stats()
