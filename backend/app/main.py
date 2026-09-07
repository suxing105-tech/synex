"""FastAPI 应用入口。

启动序列：
1. 初始化 SQLite / FTS5。
2. 启动 watchdog 监听。
3. 挂载前端构建产物（``../frontend/dist``，如存在）+ 缩略图静态目录。
4. 注册路由。

WebSocket ``/ws/events`` 推送：图片入库 / 删除 / 缩略图就绪 / 扫描进度。
"""
from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import data_dir, load_config, save_config
from .db import get_pool, init_pool
from .events import get_bus
from .indexer import get_indexer
from .routes import comfyui as comfyui_route
from .routes import folders as folders_route
from .routes import images as images_route
from .routes import settings as settings_route
from .routes import tags as tags_route

log = logging.getLogger("suxing_gallery")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)

# 切换到 cwd 便于相对路径一致
os.chdir(Path(__file__).resolve().parent.parent)

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIST = BASE_DIR.parent / "frontend" / "dist"


def _schedule_emit(coro_factory: Callable[[dict], Any], payload: dict) -> None:
    """从 watchdog 线程切到 asyncio 循环。"""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.run_coroutine_threadsafe(coro_factory(payload), loop)
    except RuntimeError:
        pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_pool()
    pool = get_pool()
    # 启动日志：打印 sqlite 版本与 FTS5 状态
    try:
        conn = pool.main()
        v = conn.execute("SELECT sqlite_version() AS v").fetchone()["v"]
        fts_rows = conn.execute("PRAGMA compile_options").fetchall()
        has_fts5 = any(
            "FTS5" in (r[0] if isinstance(r, sqlite3.Row) else r[0])
            for r in fts_rows
        )
        log.info("sqlite %s · FTS5=%s · db=%s", v, has_fts5, pool.path)
    except Exception as e:  # noqa: BLE001
        log.warning("startup diag failed: %s", e)

    cfg = load_config()
    # 把已索引但未挂 system folder 的图按 watch_dirs 子目录挂上。
    # 这是一次性历史回填；之后由 indexer 自动维护。
    try:
        from pathlib import Path as _P
        from . import repository as _repo
        added = _repo.backfill_system_folders([_P(d) for d in cfg.watch_dirs])
        if added:
            log.info("backfilled %d images into system folders", added)
    except Exception as e:  # noqa: BLE001
        log.warning("backfill_system_folders failed: %s", e)
    if not cfg.watch_dirs:
        sample = data_dir() / "sample_images"
        sample.mkdir(parents=True, exist_ok=True)
        cfg.watch_dirs = [str(sample)]
        save_config(cfg)

    indexer = get_indexer()
    bus = get_bus()

    def _on_event(payload: dict) -> None:
        # 把 watchdog 线程的事件安全地切到 asyncio 循环
        try:
            loop = asyncio.get_running_loop()
            asyncio.run_coroutine_threadsafe(bus.publish(payload), loop)
        except RuntimeError:
            pass

    indexer.on_event = _on_event
    await indexer.start_watching(asyncio.get_running_loop())
    log.info("watching dirs: %s", cfg.watch_dirs)
    yield
    # 关闭
    indexer.shutdown()


app = FastAPI(title="苏醒图库", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(comfyui_route.router)
app.include_router(images_route.router)
app.include_router(folders_route.router)
app.include_router(tags_route.router)
app.include_router(settings_route.router)


# ---------- 静态资源 ----------



@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.websocket("/ws/events")
async def ws_events(ws: WebSocket):
    await ws.accept()
    queue = await get_bus().subscribe()
    log.info("ws connected: %s", ws.client)
    try:
        while True:
            payload = await queue.get()
            await ws.send_json(payload)
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        log.warning("ws error: %s", e)
    finally:
        await get_bus().unsubscribe(queue)


# ---------- 前端构建产物（SPA fallback） ----------


_FRONTEND_INDEX: Path | None = None
if FRONTEND_DIST.exists():
    _FRONTEND_INDEX = FRONTEND_DIST / "index.html"
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")

# /logo.png 直返：dev 模式 vite 服 public/*，但 uvicorn 直跑场景（如指 8000 没用 vite）
# 这里把 logo 当成顶层静态资源，避免 SPA fallback 把 .png 当路由吃掉变 index.html。
PUBLIC_DIR = BASE_DIR.parent / "frontend" / "public"


@app.get("/logo.png")
def _serve_logo():
    p = PUBLIC_DIR / "logo.png"
    if not p.exists():
        return JSONResponse({"error": "logo not found"}, status_code=404)
    return FileResponse(p, headers={"Cache-Control": "public, max-age=86400"})


@app.get("/")
async def root():
    if _FRONTEND_INDEX and _FRONTEND_INDEX.exists():
        return FileResponse(_FRONTEND_INDEX)
    return JSONResponse({
        "name": "苏醒图库 API",
        "hint": "前端尚未构建。请在 frontend/ 执行 pnpm build。",
    })


@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    if full_path.startswith("api/") or full_path.startswith("ws/"):
        return JSONResponse({"error": "not found"}, status_code=404)
    # 静态资源（frontend/public/*）优先于 SPA fallback
    pub = (PUBLIC_DIR / full_path).resolve()
    try:
        if pub.is_file() and pub.is_relative_to(PUBLIC_DIR.resolve()):
            return FileResponse(pub, headers={"Cache-Control": "public, max-age=86400"})
    except OSError:
        pass
    if _FRONTEND_INDEX and _FRONTEND_INDEX.exists():
        return FileResponse(_FRONTEND_INDEX)
    return JSONResponse({"error": "frontend not built"}, status_code=404)
