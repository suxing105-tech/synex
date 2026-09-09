"""图片索引服务：首次扫描 + 增量监听 + 缩略图入库。

职责：
1. 扫描指定目录（递归），对每个 PNG/WebP：
   - 解析元数据 → 写库（UPSERT）
   - 若路径落在监听根目录下：自动挂到对应的 system folder（不覆盖用户整理）
2. 监听目录新文件 / 修改 / 删除事件，调用 ``process_*`` 接口。
3. 提供进度回调 + 异步任务事件，供前端 WebSocket 订阅。

设计取舍：
- 首次扫描用 ``concurrent.futures.ThreadPoolExecutor`` 并行解析元数据；
  DB 写入统一收口到主线程，避免写锁冲突。
- watchdog 事件放入 ``asyncio.Queue`` 串行化处理。
- system folder 是 watch dir 下文件系统子目录的镜像；由 ``repository`` 模块
  提供的 helpers 负责建/查，本文件只负责调用。已被用户移动到其它 user folder 的
  图片不会被覆盖式重挂（用 INSERT OR IGNORE + 是否已挂 system folder 判定）。
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

from .config import Config, load_config, save_config
from .db import fts_sync, get_pool, transaction
from .parser import SUPPORTED_EXTS, parse_metadata
from . import repository

log = logging.getLogger(__name__)


ProgressCallback = Callable[[dict], None]


# ---------- 索引器核心 ----------


class Indexer:
    """扫描 + 索引主类。线程安全（worker 连接从池里取）。"""

    def __init__(self, on_event: Callable[[dict], None] | None = None):
        self.on_event = on_event or (lambda e: None)
        self._cfg: Config = load_config()
        # 缓存 watch root（绝对路径），用于在 _process_path_sync 内挂 system folder。
        # 注意：这里只快照当前配置的根目录；后续 update_config 改动要重新刷新。
        self._watch_roots: list[Path] = [Path(d) for d in self._cfg.watch_dirs]
        self._executor = ThreadPoolExecutor(
            max_workers=self._cfg.scan_workers, thread_name_prefix="indexer"
        )
        self._observer: Observer | None = None
        self._watched_dirs: set[str] = set()
        self._progress_lock = threading.Lock()
        # WAL 模式下 SQLite 只允许单写者；扫描用 threadpool 跑元数据解析，
        # 但写库（UPSERT / FTS sync）必须串行化。
        self._write_lock = threading.Lock()
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
        self._live_lock = threading.RLock()
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
        if "watch_dirs" in kwargs:
            self._watch_roots = [Path(d) for d in self._cfg.watch_dirs]
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

    # ----- system folder 自动挂载 -----

    def _assign_system_folder(self, image_id: int, path: Path) -> None:
        """在 _write_lock 内将图片挂到对应 system folder（如果适用）。

        规则：
        - 只在图片路径落在任一 watch root 的子目录时挂 system folder；
        - 用 INSERT OR IGNORE + 是否已挂 system folder 判定，避免覆盖用户手动整理。
        """
        try:
            watch_root = repository.find_watch_root(path, self._watch_roots)
        except Exception as e:  # noqa: BLE001
            log.warning("find_watch_root failed for %s: %s", path, e)
            return
        if watch_root is None:
            return
        try:
            folder_id = repository.ensure_system_folder_chain(path, watch_root)
        except Exception as e:  # noqa: BLE001
            log.warning("ensure_system_folder_chain failed for %s: %s", path, e)
            return
        if folder_id is None:
            return
        conn = get_pool().main()
        # 已挂过 system folder？跳过（用户未把图移到其它 system folder 就不动它）
        already = conn.execute(
            "SELECT 1 FROM image_folders if_ "
            "JOIN folders f ON f.id = if_.folder_id "
            "WHERE if_.image_id = ? AND f.is_system = 1 LIMIT 1",
            (image_id,),
        ).fetchone()
        if already:
            return
        conn.execute(
            "INSERT OR IGNORE INTO image_folders(image_id, folder_id) VALUES(?, ?)",
            (image_id, folder_id),
        )



    def _ensure_system_folder_for_dir(self, dir_path: Path) -> None:
        """让 watch root 下新建的空目录也立刻出现在 system folder 树上。

        ``ensure_system_folder_chain`` 是为文件设计的（会丢掉最后一段当文件名），
        这里用占位 sentinel 让它把目录本身也算进链里。
        """
        dir_path = Path(dir_path).resolve()
        watch_root = repository.find_watch_root(dir_path, self._watch_roots)
        if watch_root is None:
            return
        try:
            repository.ensure_system_folder_chain(dir_path / ".__folder_sentinel__", watch_root)
        except Exception as e:  # noqa: BLE001
            log.warning("ensure_system_folder_for_dir failed: %s (%s)", dir_path, e)

    # ----- 单图处理 -----

    def emit_event_sync(self, payload: dict) -> bool:
        """从同步上下文（HTTP 路由、watchdog worker 线程）广播一条已构建好的事件 payload。

        - 与 watchdog `_flush_pending` 走同一条路径：往主 asyncio 循环的 `_emit` 上调度。
        - 没有可用的运行中循环时（例如单元测试）→ 返回 False，调用方决定是否自己 publish。
        """
        if self._loop is None or not self._loop.is_running():
            return False
        try:
            asyncio.run_coroutine_threadsafe(self._emit(payload), self._loop)
        except RuntimeError:
            return False
        return True

    def _process_path_sync(self, path: Path, *, remove: bool = False) -> dict | None:
        """同步处理单张图；返回事件 payload 或 ``None``。"""
        path_str = self._normalize(path)
        if remove:
            conn = get_pool().main()
            row = conn.execute("SELECT id FROM images WHERE path = ?", (path_str,)).fetchone()
            if row:
                image_id = row["id"]
                with self._write_lock:
                    conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
                    fts_sync(conn, image_id, "delete")
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
        with self._write_lock:
            with transaction() as c:
                row = c.execute("SELECT id FROM images WHERE path = ?", (path_str,)).fetchone()
                if row:
                    image_id = row["id"]
                    c.execute(
                        "UPDATE images SET filename=?, size_bytes=?, mtime=?, positive_prompt=?, "
                        "negative_prompt=?, parameters=?, workflow=?, seed=?, model=?, sampler=?, "
                        "steps=?, cfg=?, width=?, height=? WHERE id=?",
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
                            meta["width"],
                            meta["height"],
                            image_id,
                        ),
                    )
                else:
                    cur = c.execute(
                        "INSERT INTO images(path, filename, size_bytes, mtime, positive_prompt, "
                        "negative_prompt, parameters, workflow, seed, model, sampler, steps, cfg, width, height) "
                        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                            meta["width"],
                            meta["height"],
                        ),
                    )
                    image_id = cur.lastrowid
                fts_sync(c, image_id, "update" if row else "insert")
            # system folder 挂载（在写锁内同一线程；幂等且不阻塞）
            self._assign_system_folder(image_id, path)
        return {
            "type": "image_indexed",
            "id": image_id,
            "path": path_str,
            "filename": path.name,
            "mtime": stat.st_mtime,
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
            if self._observer.is_alive():
                raise RuntimeError("文件监听尚未停止，请稍后重试")
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

    async def pause_for_update(self) -> None:
        await self.stop_watching()
        with self._pending_lock:
            timer = self._flush_timer
            if timer:
                timer.cancel()
        # 在后台等待所有已接收的文件事件写入完成。
        await asyncio.to_thread(self._flush_pending, "modify")
        self._stopping = True

    async def resume_after_update(self) -> None:
        self._stopping = False
        await self.start_watching(asyncio.get_running_loop())

    def enqueue(self, kind: str, path: Path | str) -> None:
        if self._stopping:
            return
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
        with self._live_lock:
            if not self._stopping:
                self._flush_pending_impl(kind)

    def _flush_pending_impl(self, kind: str) -> None:
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
            # 监听目录被创建时，预先在 system folder 树上挂一个节点，
            # 让空目录也能立刻出现在左侧"来源"树里。
            try:
                self.indexer._ensure_system_folder_for_dir(Path(event.src_path))
            except Exception as e:  # noqa: BLE001
                log.warning("ensure dir failed: %s (%s)", event.src_path, e)
            return
        self.indexer.enqueue("create", event.src_path)

    def on_modified(self, event):
        if event.is_directory:
            return
        self.indexer.enqueue("modify", event.src_path)

    def on_moved(self, event):
        if event.is_directory:
            # 目录重命名：把新路径预先挂上 system folder 链（空目录也能看见）
            try:
                self.indexer._ensure_system_folder_for_dir(Path(event.dest_path))
            except Exception as e:  # noqa: BLE001
                log.warning("ensure moved dir failed: %s (%s)", event.dest_path, e)
            return
        # watchdog 的 moved 事件没有 is_directory 属性在某些版本上；
        # 用后缀判断
        if str(event.src_path).lower().endswith(tuple(SUPPORTED_EXTS)) or not Path(event.src_path).suffix:
            self.indexer.enqueue("create", event.dest_path)
            self.indexer.enqueue("delete", event.src_path)

    def on_deleted(self, event):
        if event.is_directory:
            # 目录删除属于"被文件系统同步"事件；不动 system folder 表
            # （用户如果在子目录里删了所有图，目录还会留在树上，递归计数 = 0）。
            return
        self.indexer.enqueue("delete", event.src_path)


# ---------- 单例 ----------


_INDEXER: Indexer | None = None


def get_indexer() -> Indexer:
    global _INDEXER
    if _INDEXER is None:
        _INDEXER = Indexer()
    return _INDEXER
