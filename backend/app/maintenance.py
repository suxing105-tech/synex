"""仅桌面持有随机令牌；更新期间冻结写请求并备份一致数据库。"""
from __future__ import annotations

import asyncio
import hmac
import os
import shutil
import sqlite3
import threading
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from starlette.responses import JSONResponse
from .config import data_dir
from .db import get_pool
from .indexer import get_indexer
from .version import VERSION, DESKTOP_PROTOCOL


class WriteGate:
    def __init__(self):
        self.lock = threading.Lock()
        self.active = 0
        self.frozen = False

    def enter(self):
        with self.lock:
            if self.frozen:
                return False
            self.active += 1
            return True

    def leave(self):
        with self.lock:
            self.active -= 1

    def freeze(self):
        with self.lock:
            if self.active or self.frozen:
                return False
            self.frozen = True
            return True

    def release(self):
        with self.lock:
            self.frozen = False


gate = WriteGate()


class WriteGateMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        tracked = (scope["type"] == "http" and scope.get("method") not in ("GET", "HEAD", "OPTIONS")
                   and not scope.get("path", "").startswith("/api/desktop/"))
        if tracked and not gate.enter():
            return await JSONResponse({"detail": "正在准备更新，请稍后再试"}, status_code=409)(scope, receive, send)
        try:
            await self.app(scope, receive, send)
        finally:
            if tracked:
                gate.leave()


router = APIRouter(prefix="/api/desktop", tags=["desktop"])


def authorize(request: Request):
    token = os.environ.get("SUXING_CONTROL_TOKEN", "")
    if not token or not hmac.compare_digest(request.headers.get("x-suxing-control", ""), token):
        raise HTTPException(403, "仅允许桌面程序控制更新")


@router.get("/status")
def status():
    return {"version": VERSION, "protocol": DESKTOP_PROTOCOL,
            "busy": gate.active > 0 or get_indexer().get_progress()["running"], "prepared": gate.frozen}


def backup_data():
    base = data_dir()
    backup = base.parent / "update-backups" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8])
    required = get_pool().path.stat().st_size * 2 + 32 * 1024 * 1024
    if shutil.disk_usage(base).free < required:
        raise OSError("磁盘空间不足，无法备份图库数据")
    backup.mkdir(parents=True)
    with sqlite3.connect(backup / "db.sqlite") as target:
        source = sqlite3.connect(get_pool().path)
        try:
            source.backup(target)
        finally:
            source.close()
        if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise OSError("数据库备份校验失败")
    config = base / "config.json"
    if config.exists():
        shutil.copy2(config, backup / "config.json")
    (backup / "version.txt").write_text(VERSION, encoding="utf-8")
    return str(backup)


async def resume():
    await get_indexer().resume_after_update()
    gate.release()


@router.post("/prepare-update")
async def prepare(request: Request):
    authorize(request)
    if get_indexer().get_progress()["running"] or not gate.freeze():
        raise HTTPException(409, "正在导入或保存图片，请完成后再安装更新")
    try:
        await get_indexer().pause_for_update()
        backup = await asyncio.to_thread(backup_data)
        return {"ok": True, "backup": backup}
    except Exception as exc:
        await resume()
        raise HTTPException(500, f"更新准备失败：{exc}") from exc


@router.post("/cancel-update")
async def cancel(request: Request):
    authorize(request)
    await resume()
    return {"ok": True}


@router.post("/shutdown")
async def shutdown(request: Request):
    authorize(request)
    if not gate.frozen:
        raise HTTPException(409, "请先完成更新准备")
    callback = getattr(request.app.state, "desktop_shutdown", None)
    if callback is None:
        raise HTTPException(503, "当前启动方式不支持桌面更新")
    asyncio.get_running_loop().call_later(.2, callback)
    return {"ok": True}
