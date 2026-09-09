"""/api/settings + /api/scan + /api/stats 路由。"""
from __future__ import annotations

import asyncio
import logging
import os
import threading
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException

from .. import repository
from ..config import Config, load_config, save_config
from ..events import get_bus
from ..indexer import get_indexer
from ..models import ConfigOut, ConfigUpdate, ScanProgress

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["settings"])
_config_lock = asyncio.Lock()
_scan_request_lock = threading.Lock()


def validate_directory(raw_path: object) -> Path:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise HTTPException(400, "请选择或输入文件夹路径")
    try:
        target = Path(raw_path.strip()).expanduser().resolve(strict=True)
        if not target.is_dir():
            raise HTTPException(400, "请选择文件夹，而不是文件")
        # 实际打开目录，不能仅凭 exists 或权限位判断 Windows ACL。
        with os.scandir(target) as entries:
            next(entries, None)
        return target
    except FileNotFoundError:
        raise HTTPException(400, "文件夹不存在，请重新选择")
    except PermissionError:
        raise HTTPException(400, "无法读取该文件夹，请检查访问权限")
    except (OSError, ValueError, RuntimeError):
        raise HTTPException(400, "无法访问该文件夹，请检查路径或磁盘连接")


def directory_key(path: str | Path) -> str:
    return os.path.normcase(str(Path(path).expanduser().resolve()))


def run_scans(indexer, targets):
    try:
        for target in targets:
            indexer.scan(target)
    except Exception:
        log.exception("directory scan failed")
        indexer._set_progress(running=False, error="扫描未完成，请检查目录后重试")
    finally:
        _scan_request_lock.release()


@router.post("/directories/validate")
async def check_directory(payload: dict):
    target = await asyncio.to_thread(validate_directory, payload.get("path"))
    return {"path": str(target)}


@router.post("/directories/import")
async def import_directory(payload: dict, background: BackgroundTasks):
    # 验证先于任何设置修改；与旧扫描入口共享准入锁。
    target = await asyncio.to_thread(validate_directory, payload.get("path"))
    if not _scan_request_lock.acquire(blocking=False):
        raise HTTPException(409, "已有导入正在进行，请完成后再试")
    try:
        async with _config_lock:
            indexer = get_indexer()
            if indexer.get_progress()["running"]:
                raise HTTPException(409, "已有导入正在进行，请完成后再试")
            existing = list(indexer.config.watch_dirs)
            key = directory_key(target)
            if key not in {directory_key(d) for d in existing}:
                indexer.update_config(watch_dirs=[*existing, str(target)])
            # 把新目录接入正在运行的监听器；原来的监听不受影响。
            try:
                await indexer.watch_added_directory(target)
            except Exception:
                log.exception("watch new directory failed")
                raise HTTPException(500, "目录已添加，但监听未启动，请检查权限后重试")
            indexer._set_progress(running=True, scanned=0, indexed=0, total=0, current_path="", error=None)
            background.add_task(run_scans, indexer, [target])
            return {"ok": True, "path": str(target)}
    except Exception:
        _scan_request_lock.release()
        raise


@router.get("/settings")
def get_settings() -> ConfigOut:
    cfg = load_config()
    return ConfigOut(**{k: getattr(cfg, k) for k in ConfigOut.model_fields})


@router.put("/settings")
async def update_settings(payload: ConfigUpdate) -> ConfigOut:
    async with _config_lock:
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

    if not _scan_request_lock.acquire(blocking=False):
        raise HTTPException(409, "已有导入正在进行，请完成后再试")
    indexer = get_indexer()
    indexer._set_progress(running=True, scanned=0, indexed=0, total=0, current_path="", error=None)
    background.add_task(run_scans, indexer, targets)
    return {"ok": True, "targets": [str(t) for t in targets]}





@router.get("/scan/progress")
def scan_progress() -> ScanProgress:
    return ScanProgress(**get_indexer().get_progress())


@router.get("/stats")
def stats():
    return repository.stats()
