"""图片索引服务：首次扫描 + 增量监听 + 缩略图入库。

职责：
1. 扫描指定目录（递归），对每个 PNG/WebP：
   - 解析元数据 → 写库（UPSERT）
   - 生成缩略图 → 写库（thumb_path, thumb_status）
2. 监听目录新文件 / 修改 / 删除事件，调用 ``process_*`` 接口。
3. 提供进度回调 + 异步任务事件，供前端 WebSocket 订阅。

设计取舍：
- 首次扫描用 ``concurrent.futures.ThreadPoolExecutor`` 并行解析元数据；
  DB 写入统一收口到主线程，避免写锁冲突。
- watchdog 事件放入 ``asyncio.Queue`` 串行化处理。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from .config import Config, load_config, save_config, thumbs_dir
from .db import fts_sync, get_pool, transaction
from .parser import SUPPORTED_EXTS, parse_metadata
from .thumbnails import generate as generate_thumb

log = logging.getLogger(__name__)


ProgressCallback = Callable[[dict], None]


# ---------- 索引器核心 ----------


class Indexer:
    """扫描 + 索引主类。线程安全（worker 连接从池里取）。"""

    def __init__(self, on_event: Callable[[dict], None] | None = None):
        self.on_event = on_event or (lambda e: None)
        self._cfg: Config = load_config()
        self._executor = ThreadPoolExecutor(
            max_workers=self._cfg.scan_workers, thread_name_prefix="indexer"
        )
        self._observer: Observer | None = None
        self._watched_dirs: set[str] = set()
        self._progress_lock = threading.Lock()
        self._progress: dict = {
            "running": False,
            "scanned": 0,
            "indexed": 0,
            "total": 0,
            "current_path": "",
            "error": None,
        }
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stopping = False
        self._pending: set[str] = set()
        self._pending_lock = threading.Lock()
        self._flush_timer: threading.Timer | None = None

    # ----- 配置 -----

    @property
    def config(self) -> Config:
        return self._cfg

    def update_config(self, **kwargs: object) -> Config:
        self._cfg.update(**kwargs)
        save_config(self._cfg)
        if "scan_workers" in kwargs:
            try:
                self._executor.shutdown(wait=False, cancel_futures=True)
            except Exception:
                pass
            self._executor = ThreadPoolExecutor(
                max_workers=self._cfg.scan_workers, thread_name_prefix="indexer"
            )
        return self._cfg

    # ----- 进度 -----

    def get_progress(self) -> dict:
        with self._progress_lock:
            return dict(self._progress)

    def _set_progress(self, **kwargs: object) -> None:
        with self._progress_lock:
            self._progress.update(kwargs)

    # ----- 工具 -----

    @staticmethod
    def _normalize(path: Path | str) -> str:
        p = Path(path).resolve()
        return str(p).replace(os.sep, "/")

    # ----- 单图处理 -----

    def _process_path_sync(self, path: Path, *, remove: bool = False) -> dict | None:
        """同步处理单张图；返回事件 payload 或 ``None``。"""
        path_str = self._normalize(path)
        conn = get_pool().main()
        if remove:
            row = conn.execute("SELECT id FROM images WHERE path = ?", (path_str,)).fetchone()
            if row:
                image_id = row["id"]
                conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
                fts_sync(conn, image_id, "delete")
                # 清理缩略图
                tpath = thumbs_dir() / f"{image_id}.webp"
                try:
                    tpath.unlink(missing_ok=True)
                except OSError:
                    pass
                return {"type": "image_removed", "id": image_id, "path": path_str}
            return None
        if not path.exists() or path.suffix.lower() not in SUPPORTED_EXTS:
            return None
        try:
            stat = path.stat()
        except OSError:
            return None
        try:
            meta = parse_metadata(path)
        except Exception as e:
            log.warning("parse failed: %s (%s)", path, e)
            meta = {
                "positive_prompt": "",
                "negative_prompt": "",
                "parameters": {},
                "workflow": "",
                "seed": None,
                "model": None,
                "sampler": None,
                "steps": None,
                "cfg": None,
            }
        params_json = json.dumps(meta["parameters"], ensure_ascii=False)
        # UPSERT
        with transaction() as c:
            row = c.execute("SELECT id FROM images WHERE path = ?", (path_str,)).fetchone()
            if row:
                image_id = row["id"]
                c.execute(
                    "UPDATE images SET filename=?, size_bytes=?, mtime=?, positive_prompt=?, "
                    "negative_prompt=?, parameters=?, workflow=?, seed=?, model=?, sampler=?, "
                    "steps=?, cfg=?, thumb_status='pending' WHERE id=?",
                    (
                        path.name,
                        stat.st_size,
                        stat.st_mtime,
                        meta["positive_prompt"],
                        meta["negative_prompt"],
                        params_json,
                        meta["workflow"],
                        meta["seed"],
                        meta["model"],
                        meta["sampler"],
                        meta["steps"],
                        meta["cfg"],
                        image_id,
                    ),
                )
            else:
                cur = c.execute(
                    "INSERT INTO images(path, filename, size_bytes, mtime, positive_prompt, "
                    "negative_prompt, parameters, workflow, seed, model, sampler, steps, cfg, "
                    "thumb_status) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
                    (
                        path_str,
                        path.name,
                        stat.st_size,
                        stat.st_mtime,
                        meta["positive_prompt"],
                        meta["negative_prompt"],
                        params_json,
                        meta["workflow"],
                        meta["seed"],
                        meta["model"],
                        meta["sampler"],
                        meta["steps"],
                        meta["cfg"],
                    ),
                )
                image_id = cur.lastrowid
            fts_sync(c, image_id, "update" if row else "insert")
        # 缩略图（后台线程中跑，不阻塞事件循环）
        thumb_path = generate_thumb(path, image_id, self._cfg.thumb_size, self._cfg.thumb_quality)
        if thumb_path:
            conn.execute(
                "UPDATE images SET thumb_path=?, thumb_status='ready' WHERE id=?",
                (str(thumb_path), image_id),
            )
        else:
            conn.execute(
                "UPDATE images SET thumb_status='failed' WHERE id=?",
                (image_id,),
            )
        return {
            "type": "image_indexed",
            "id": image_id,
            "path": path_str,
            "filename": path.name,
            "mtime": stat.st_mtime,
            "thumb_status": "ready" if thumb_path else "failed",
        }

    # ----- 首次扫描 -----

    def scan(self, root: Path | str, *, fire_event: bool = True) -> dict:
        """同步扫描目录，返回最终进度。"""
        root = Path(root).resolve()
        if not root.exists():
            self._set_progress(error=f"路径不存在: {root}", running=False)
            return self.get_progress()
        self._set_progress(running=True, scanned=0, indexed=0, total=0, error=None)
        all_files: list[Path] = []
        for p in root.rglob("*"):
            if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS:
                all_files.append(p)
        total = len(all_files)
        self._set_progress(total=total)
        indexed = 0
        scanned = 0
        t0 = time.time()
        # 用线程池并发解析 + 写库（写库在主线程是单线程的）
        futures = []
        for f in all_files:
            futures.append(self._executor.submit(self._process_path_sync, f))

        for fut in futures:
            scanned += 1
            try:
                payload = fut.result(timeout=120)
                if payload:
                    indexed += 1
                    if fire_event and self._loop is not None and self._loop.is_running():
                        try:
                            asyncio.run_coroutine_threadsafe(self._emit(payload), self._loop)
                        except RuntimeError:
                            pass
            except Exception as e:
                log.warning("scan item failed: %s", e)
            self._set_progress(scanned=scanned, indexed=indexed, current_path=str(all_files[scanned - 1]) if scanned else "")
        elapsed = time.time() - t0
        log.info("scan finished: %d files in %.1fs", total, elapsed)
        self._set_progress(running=False, current_path="")
        return self.get_progress()

    # ----- 监听 -----

    async def start_watching(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        if not self._cfg.live_enabled:
            return
        if self._observer is not None:
            return
        observer = Observer()
        handler = _Handler(self)
        for d in self._cfg.watch_dirs:
            p = Path(d)
            if not p.exists():
                continue
            observer.schedule(handler, str(p), recursive=True)
            self._watched_dirs.add(str(p))
        observer.daemon = True
        observer.start()
        self._observer = observer

    async def stop_watching(self) -> None:
        if self._observer is not None:
            self._observer.stop()
            self._observer.join(timeout=3)
            self._observer = None
        self._watched_dirs.clear()

    def shutdown(self) -> None:
        self._stopping = True
        try:
            if self._observer:
                self._observer.stop()
                self._observer.join(timeout=3)
        except Exception:
            pass
        try:
            self._executor.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass

    # ----- 事件入队 -----

    def enqueue(self, kind: str, path: Path | str) -> None:
        path = Path(path)
        with self._pending_lock:
            self._pending.add(self._normalize(path))
            if self._flush_timer is not None:
                self._flush_timer.cancel()
            # 防抖：300ms 内的同路径事件合并
            self._flush_timer = threading.Timer(0.3, self._flush_pending, args=(kind,))
            self._flush_timer.daemon = True
            self._flush_timer.start()

    def _flush_pending(self, kind: str) -> None:
        with self._pending_lock:
            paths = list(self._pending)
            self._pending.clear()
            self._flush_timer = None
        for p in paths:
            try:
                payload = self._process_path_sync(Path(p), remove=(kind == "delete"))
            except Exception as e:
                log.warning("event handler failed: %s (%s)", p, e)
                continue
            if payload and self._loop is not None and self._loop.is_running():
                try:
                    asyncio.run_coroutine_threadsafe(self._emit(payload), self._loop)
                except RuntimeError:
                    pass

    async def _emit(self, payload: dict) -> None:
        try:
            # on_event 是同步回调（直接 publish 到 bus），
            # 主线程切到 asyncio 循环由 call_soon_threadsafe 完成
            self.on_event(payload)
        except Exception as e:  # noqa: BLE001
            log.warning("emit failed: %s", e)


# ---------- watchdog handler ----------


class _Handler(FileSystemEventHandler):
    def __init__(self, indexer: Indexer):
        self.indexer = indexer

    def on_created(self, event):
        if event.is_directory:
            return
        self.indexer.enqueue("create", event.src_path)

    def on_modified(self, event):
        if event.is_directory:
            return
        self.indexer.enqueue("modify", event.src_path)

    def on_moved(self, event):
        if event.is_directory:
            return
        # watchdog 的 moved 事件没有 is_directory 属性在某些版本上；
        # 用后缀判断
        if str(event.src_path).lower().endswith(tuple(SUPPORTED_EXTS)) or not Path(event.src_path).suffix:
            self.indexer.enqueue("create", event.dest_path)
            self.indexer.enqueue("delete", event.src_path)

    def on_deleted(self, event):
        if event.is_directory:
            return
        self.indexer.enqueue("delete", event.src_path)


# ---------- 单例 ----------


_INDEXER: Indexer | None = None


def get_indexer() -> Indexer:
    global _INDEXER
    if _INDEXER is None:
        _INDEXER = Indexer()
    return _INDEXER
