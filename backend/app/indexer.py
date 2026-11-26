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
import copy
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
from .db import get_pool, transaction
from .parser import (
    SUPPORTED_EXTS,
    parse_audio_metadata,
    parse_metadata,
    parse_video_metadata,
    classify,
)
from . import repository

log = logging.getLogger(__name__)


ProgressCallback = Callable[[dict], None]

# 事件防抖：300ms 内的连续事件合并成一次落库，但**从最早那条事件算起最多再等 2 秒必须落一次**。
# 后半句是 2026-11-24 补的：只有下限的防抖在持续事件流下永不触发——ComfyUI 批量出图时
# created + 多次 modified 是连成线的，实测能让一批新图 12 秒一条都不入库。
FLUSH_DEBOUNCE_SECONDS = 0.3
FLUSH_MAX_WAIT_SECONDS = 2.0
# 单次补扫最多收多少个「盘上有、库里没有」的文件：让单次耗时可预期，剩下的交给下一轮。
SWEEP_MAX_FILES = 500
# 刚改过不到这个秒数的文件大概率还在写，元数据读不全；留给它自己的 modify 事件或下一轮。
SWEEP_SETTLE_SECONDS = 2.0


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
        # 监听健康闸：自动重建过多少次（进日志，也进 watcher_restarted 事件）。
        self._watcher_repairs = 0
        self._watcher_repair_lock = threading.Lock()
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
            # 补扫单独一套计数，不占 running。占了的后果不在进度条上，而在 maintenance
            # 的 prepare-update：running=true 会 409「正在导入」挡住装更新，而补扫是
            # 每分钟自己跑的后台活，不该有这个权力。
            "sweeping": False,
            "sweep_indexed": 0,
            "sweep_total": 0,
        }
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stopping = False
        self._live_lock = threading.RLock()
        self._pending: set[str] = set()
        self._pending_lock = threading.Lock()
        self._flush_timer: threading.Timer | None = None
        # 队列里最早那条事件的时刻，用来算「最多再等多久必须落地」。
        self._pending_oldest: float | None = None
        # 应用自己移动文件时，watchdog 看到的是「旧路径删除 + 新路径新建」。
        # 调用方已经在事务里把 images.path 改好了，让 watcher 再跑一遍会：
        #   1) 先处理新路径 → 插一条重复行并换 id（收藏/标签/提示词历史全丢）
        #   2) 再处理旧路径 → 把刚改好的行删掉
        # 因此对涉及的精确路径开一个短抑制窗口，只跳过这些路径的 watcher 事件。
        self._suppress: dict[str, float] = {}
        self._suppress_lock = threading.Lock()

    # ----- 配置 -----

    @property
    def config(self) -> Config:
        return self._cfg

    def update_config(self, **kwargs: object) -> Config:
        updated = copy.deepcopy(self._cfg)
        updated.update(**kwargs)
        save_config(updated)
        self._cfg = updated
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
        with self._live_lock:
            self._ensure_system_folder_for_dir_locked(dir_path)

    def _ensure_system_folder_for_dir_locked(self, dir_path: Path) -> None:
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
            with self._write_lock:
                with transaction() as conn:
                    row = conn.execute("SELECT id FROM images WHERE path = ?", (path_str,)).fetchone()
                    if not row:
                        return None
                    image_id = row["id"]
                    conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
                return {"type": "image_removed", "id": image_id, "path": path_str}
            return None
        if not path.exists() or path.suffix.lower() not in SUPPORTED_EXTS:
            return None
        try:
            stat = path.stat()
        except OSError:
            return None
        kind = classify(path)
        try:
            if kind == "video":
                meta = parse_video_metadata(path)
            elif kind == "audio":
                meta = parse_audio_metadata(path)
            else:
                meta = parse_metadata(path)
        except Exception as e:
            log.warning("parse failed: %s (%s)", path, e)
            meta = {
                "kind": kind,
                "positive_prompt": "",
                "negative_prompt": "",
                "parameters": {},
                "workflow": "",
                "seed": None,
                "model": None,
                "sampler": None,
                "steps": None,
                "cfg": None,
                "width": None,
                "height": None,
                "duration_seconds": None,
                "video_codec": None,
                "audio_codec": None,
                "fps": None,
                "format": None,
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
                        "steps=?, cfg=?, width=?, height=?, kind=?, format=?, duration_seconds=?, "
                        "video_codec=?, audio_codec=?, fps=? WHERE id=?",
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
                            kind,
                            meta.get("format"),
                            meta.get("duration_seconds"),
                            meta.get("video_codec"),
                            meta.get("audio_codec"),
                            meta.get("fps"),
                            image_id,
                        ),
                    )
                else:
                    cur = c.execute(
                        "INSERT INTO images(path, filename, size_bytes, mtime, positive_prompt, "
                        "negative_prompt, parameters, workflow, seed, model, sampler, steps, cfg, width, height, "
                        "kind, format, duration_seconds, video_codec, audio_codec, fps) "
                        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                            kind,
                            meta.get("format"),
                            meta.get("duration_seconds"),
                            meta.get("video_codec"),
                            meta.get("audio_codec"),
                            meta.get("fps"),
                        ),
                    )
                    image_id = cur.lastrowid
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
        failures = 0
        def walk_error(error):
            nonlocal failures
            failures += 1
            log.warning("scan directory unreadable: %s", error)
        for directory, _, files in os.walk(root, onerror=walk_error, followlinks=False):
            for name in files:
                p = Path(directory) / name
                if p.suffix.lower() in SUPPORTED_EXTS:
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
                failures += 1
                log.warning("scan item failed: %s", e)
            self._set_progress(scanned=scanned, indexed=indexed, current_path=str(all_files[scanned - 1]) if scanned else "")
        elapsed = time.time() - t0
        log.info("scan finished: %d files in %.1fs", total, elapsed)
        self._set_progress(running=False, current_path="", error=f"有 {failures} 个文件或子目录未能读取，请检查权限或文件内容后重试" if failures else None)
        return self.get_progress()

    # ----- 监听 -----

    async def watch_added_directory(self, target: Path) -> None:
        if not self._cfg.live_enabled:
            return
        if self._observer is None:
            await self.start_watching(asyncio.get_running_loop())
            return
        # 已被父目录递归监听覆盖时，不再增加重复监听。
        normalized = os.path.normcase(str(target.resolve()))
        for watched in self._watched_dirs:
            try:
                Path(normalized).relative_to(os.path.normcase(str(Path(watched).resolve())))
                return
            except ValueError:
                pass
        self._observer.schedule(_Handler(self), str(target), recursive=True)
        self._watched_dirs.add(str(target))

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

    # ----- 监听健康闸 -----

    def _live_watch_paths(self) -> set[str] | None:
        """现在还活着的事件发射器覆盖哪些目录（normcase 口径，和 schedule 传的串对齐）。

        只认 watchdog 的公开面：``Observer.emitters`` → ``emitter.watch.path`` +
        ``emitter.is_alive()``。返回 ``None`` 表示探测不了（这条属性链在新版本里变了），
        调用方据此**跳过**重建：读不到信息不等于全都死了，据此重挂会把监听拆了重建个没完。
        """
        observer = self._observer
        if observer is None:
            return set()
        emitters = getattr(observer, "emitters", None)
        if emitters is None:
            log.warning("watchdog 没有 emitters 属性，监听健康探测跳过")
            return None
        live: set[str] = set()
        for emitter in list(emitters):
            watch = getattr(emitter, "watch", None)
            path = getattr(watch, "path", None)
            alive = getattr(emitter, "is_alive", None)
            if path is None or not callable(alive):
                log.warning("watchdog 的 emitter 结构不认识，监听健康探测跳过")
                return None
            if alive():
                live.add(os.path.normcase(str(path)))
        return live

    def watcher_health(self) -> dict:
        """只读探测：配了、盘上还在、却已经没有活的事件发射器的来源目录。"""
        observer = self._observer
        live = self._live_watch_paths()
        dead: list[str] = []
        if live is not None:
            for directory in sorted(self._watched_dirs):
                try:
                    # 目录真被删了不归这里管（那是 reconcile_missing 那一半），而且往
                    # 一个不存在的目录上 schedule 会直接抛 FileNotFoundError。
                    if not Path(directory).is_dir():
                        continue
                except OSError:  # 路径读不动（网络盘掉线等）同样留给下一轮
                    continue
                if os.path.normcase(str(directory)) not in live:
                    dead.append(directory)
        return {
            "observer_alive": bool(observer is not None and observer.is_alive()),
            "watched": sorted(self._watched_dirs),
            "dead": dead,
            "unknown": live is None,
            "repairs": self._watcher_repairs,
        }

    def repair_watcher(self) -> list[str]:
        """把掉线的 emitter 重新挂上，返回修好的目录；没事可做返回 `[]`。

        为什么非有这一闸：watchdog 6.0.0 的 Windows emitter 会**自己退出线程**，而
        Observer 不会发现，于是那条来源目录整个会话再也收不到事件，界面上不留痕迹。
        触发它的常见原因就是下面那条假「目录被删除」。根因在第三方库里，我们能修的只有
        「掉了要有人发现并重建」；漏掉的文件反正有 ``sweep_new_files`` 兜底。
        """
        observer = self._observer
        if self._stopping or observer is None:
            return []
        health = self.watcher_health()
        if health["unknown"] or not health["dead"]:
            return []
        with self._watcher_repair_lock:
            # 锁内重判一遍：这一会儿可能已经被 stop_watching 停了（装更新走的就是那条路）。
            # 就算真抢在它后面 schedule 成功，watchdog 也只在 observer 线程还活着时才启动
            # emitter，不会留下一条没人派发事件的通道。
            if self._stopping or self._observer is not observer:
                return []
            repaired: list[str] = []
            for directory in health["dead"]:
                try:
                    self._reschedule_watch(observer, directory)
                except Exception as e:  # noqa: BLE001 - 修不好也不许拖垮巡检循环
                    log.warning("重建来源目录监听失败：%s（%s）", directory, e)
                    continue
                repaired.append(directory)
            if not repaired:
                return []
            self._watcher_repairs += len(repaired)
            log.warning(
                "来源目录的事件通道掉了（watchdog 的 emitter 自己退出了），已自动重建：%s",
                "、".join(repaired),
            )
            self.emit_event_sync({"type": "watcher_restarted", "dirs": repaired, "total": self._watcher_repairs})
        return repaired

    def _reschedule_watch(self, observer, directory: str) -> None:
        """给这条目录换一个新 emitter。

        必须先 unschedule 再 schedule：watchdog 在同一个 watch 还在册的时候不会另起
        emitter（``BaseObserver.schedule`` 里那句 `if watch not in self._emitter_for_watch`），
        直接 schedule 只会拿到那条已经死透的旧 emitter。
        """
        target = os.path.normcase(str(directory))
        for emitter in list(getattr(observer, "emitters", ()) or ()):
            watch = getattr(emitter, "watch", None)
            if watch is not None and os.path.normcase(str(watch.path)) == target:
                observer.unschedule(watch)
                break
        observer.schedule(_Handler(self), str(directory), recursive=True)

    def _is_false_root_delete(self, path: Path | str) -> bool:
        """这条「目录被删除」是不是假的：路径正是我们监听的根，而它在盘上还好好的。

        watchdog 6.0.0 的 ``winapi.read_directory_changes`` 抓到任何不是
        ERROR_OPERATION_ABORTED 的 OSError——**包括 64KB 事件缓冲溢出的
        ERROR_NOTIFY_ENUM_DIR**——都交给 ``_is_observed_path_deleted`` 判断，而它拿
        GetFinalPathNameByHandleW(VOLUME_NAME_NT) 返回的 \\Device\\HarddiskVolumeN\\...
        去等值比较 D:\\...，永不相等，于是目录完好时也照样合成一条
        ``DirDeletedEvent(root)`` 再 ``emitter.stop()``。出图洪峰正是最容易撞上的时候。
        """
        target = os.path.normcase(str(path))
        if not any(os.path.normcase(str(d)) == target for d in self._watched_dirs):
            return False
        try:
            return Path(path).is_dir()
        except OSError:
            return False

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

    def suppress_events(self, paths: "list[Path | str] | tuple[Path | str, ...]", *, seconds: float = 5.0) -> None:
        """在一段时间内忽略这些精确路径上的 watchdog 事件。

        只给应用自己发起的文件移动用：DB 已由调用方在事务里改好，
        watcher 的「删旧 + 建新」会换 id 或删掉正确的行。
        """
        until = time.monotonic() + max(0.0, seconds)
        with self._suppress_lock:
            now = time.monotonic()
            for stale in [key for key, value in self._suppress.items() if value <= now]:
                self._suppress.pop(stale, None)
            for item in paths:
                self._suppress[self._normalize(item)] = until

    def _suppressed(self, normalized: str) -> bool:
        with self._suppress_lock:
            until = self._suppress.get(normalized)
            if until is None:
                return False
            if until > time.monotonic():
                return True
            self._suppress.pop(normalized, None)
            return False

    def enqueue(self, kind: str, path: Path | str) -> None:
        if self._stopping:
            return
        path = Path(path)
        normalized = self._normalize(path)
        if self._suppressed(normalized):
            return
        with self._pending_lock:
            now = time.monotonic()
            if self._pending_oldest is None:
                self._pending_oldest = now
            self._pending.add(normalized)
            # 防抖照旧合并 300ms 内的连续事件，但到期时刻锁死在「最早那条事件 + 上限」：
            # 事件一直来只允许把等待压短，不许把它一路往后推。
            deadline = self._pending_oldest + FLUSH_MAX_WAIT_SECONDS
            delay = min(FLUSH_DEBOUNCE_SECONDS, max(0.0, deadline - now))
            if self._flush_timer is not None:
                self._flush_timer.cancel()
            self._flush_timer = threading.Timer(delay, self._flush_pending, args=(kind,))
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
            self._pending_oldest = None
        for p in paths:
            try:
                # 合并的是路径，不是事件类型；以每个路径最终状态处理，避免
                # 删除 A / 新建 B 的批次被最后一个事件统一误判。
                path = Path(p)
                try:
                    path.stat()
                    missing = False
                except FileNotFoundError:
                    missing = True
                payload = self._process_path_sync(path, remove=missing)
            except Exception as e:
                log.warning("event handler failed: %s (%s)", p, e)
                continue
            if payload and self._loop is not None and self._loop.is_running():
                try:
                    asyncio.run_coroutine_threadsafe(self._emit(payload), self._loop)
                except RuntimeError:
                    pass

    def prune_missing_system_folders(self) -> int:
        """清理磁盘上已不存在的 system folder（来源目录镜像）记录。

        在 ``reconcile_missing`` 巡检以及 watchdog 目录删除事件时调用；若有被删除的
        目录，广播 ``folders_changed`` 事件让左侧「来源目录」树刷新。
        """
        with self._live_lock:
            if self._stopping:
                return 0
            removed = repository.prune_missing_system_folders(self._watch_roots)
            if removed:
                self.emit_event_sync({"type": "folders_changed"})
            return removed

    def reconcile_missing(self) -> list[int]:
        """Recover missed deletes, including files removed while the app was closed."""
        removed = []
        with self._live_lock:
            if self._stopping:
                return removed
            rows = get_pool().main().execute('SELECT id, path FROM images').fetchall()
            for row in rows:
                path = Path(row['path'])
                try:
                    path.stat()
                except FileNotFoundError:
                    # Offline drives/network shares are not evidence of deletion.
                    anchor = Path(path.anchor)
                    if not anchor.exists():
                        continue
                    payload = self._process_path_sync(path, remove=True)
                    if payload:
                        removed.append(payload['id'])
                        self.emit_event_sync(payload)
                except OSError:
                    continue
        # 目录可能被删除（应用运行期间或上次关闭后）；一并清理消失的 system folder。
        try:
            self.prune_missing_system_folders()
        except Exception:  # noqa: BLE001
            log.warning("prune system folders failed", exc_info=True)
        return removed

    # ----- 补扫「盘上有、库里没有」的新文件 -----

    @staticmethod
    def _known_hit(known: set[str], key: str) -> bool:
        """路径键是否已在库里。Windows 上大小写不敏感（和 _enqueue_directory_removal 同一口径）。"""
        return key.lower() in known if os.name == "nt" else key in known

    def _known_path_keys(self) -> set[str]:
        """库里已有的路径键。``images.path`` 存的就是 ``_normalize`` 的产物，不用再 resolve 一遍。"""
        rows = get_pool().main().execute("SELECT path FROM images").fetchall()
        keys: set[str] = set()
        for row in rows:
            stored = row["path"]
            keys.add(stored.lower() if os.name == "nt" else stored)
            # 老库里混过反斜杠写法（改名那轮修的数据）：那种行永远比不中，会被补扫
            # 重新索引一次并落回正斜杠。认两种写法比先修数据更省事。
            alt = stored.replace("\\", "/")
            keys.add(alt.lower() if os.name == "nt" else alt)
        return keys

    def find_unindexed_files(self, *, limit: int = SWEEP_MAX_FILES) -> list[Path]:
        """来源目录里「盘上有、库里没有」的媒体文件。只找，不删。

        比对先用不 resolve 的键（绝大多数已入库的文件走这条就命中，省一次系统调用），
        比不中再按 ``_normalize`` 的口径比一次——真新文件才付那一次 resolve。
        """
        known = self._known_path_keys()
        found: list[Path] = []
        for root in self._watch_roots:
            for directory, _, files in os.walk(root, onerror=lambda e: log.warning("sweep directory unreadable: %s", e), followlinks=False):
                for name in files:
                    if os.path.splitext(name)[1].lower() not in SUPPORTED_EXTS:
                        continue
                    path = Path(directory) / name
                    if self._known_hit(known, str(path).replace(os.sep, "/")):
                        continue
                    if self._known_hit(known, self._normalize(path)):
                        continue
                    try:
                        if time.time() - path.stat().st_mtime < SWEEP_SETTLE_SECONDS:
                            continue
                    except OSError:
                        continue
                    found.append(path)
                    if len(found) >= limit:
                        return found
        return found

    def sweep_new_files(self, *, fire_event: bool = True) -> dict:
        """补扫来源目录，把漏掉的新文件收进库，返回 ``{"indexed": n}``。

        为什么非有这步：watchdog 的事件是**会丢**的——生成途中重启（pending 随进程一起没）、
        ReadDirectoryChangesW 那 64KB 缓冲在出图洪峰里溢出、机器休眠、监听线程自己挂掉。
        而 ``reconcile_missing`` 只管反方向（库里有、盘上没了 → 删行），新文件掉了永远没人管：
        2026-11-24 实测一次自更新重启就这样吞了 106 张图，之后 20 分钟无人认领。
        这里补的正是缺的那半边：**只收不删**，删除仍旧交给 reconcile_missing。
        """
        # _live_lock 只圈住「还要不要开工」这个判断和那次只读遍历：解析和写库放在锁外，
        # 否则一次 500 个文件的补扫会把 reconcile 和 watchdog 的落地一起堵在后面
        # （安装更新时 pause_for_update 也要这把锁）。
        with self._live_lock:
            if self._stopping:
                return {"indexed": 0}
            if self.get_progress()["running"]:
                # 用户手动发起的扫描正在跑，不跟它抢写锁。
                return {"indexed": 0}
            missing = self.find_unindexed_files()
        if not missing or self._stopping:
            return {"indexed": 0}
        # 补扫也得在顶部进度条上看得见：一次收 500 个要跑几十秒，只留一句
        # "sweep indexed N missed file(s)" 的话，用户看到的就是「图悄悄回来了」。
        # 用 sweeping 这一套计数而不是 running，原因写在 _progress 初始化处。
        self._set_progress(sweeping=True, sweep_total=len(missing), sweep_indexed=0)
        ids: list[int] = []
        done = 0
        futures = [self._executor.submit(self._process_path_sync, item) for item in missing]
        try:
            for fut in futures:
                try:
                    payload = fut.result(timeout=120)
                    if payload and payload.get("type") == "image_indexed":
                        ids.append(payload["id"])
                except Exception as e:  # noqa: BLE001
                    log.warning("sweep item failed: %s", e)
                finally:
                    # 计数走 finally：某条解析炸了也要往前走，否则进度条永远停在失败那条。
                    done += 1
                    self._set_progress(sweep_indexed=done)
        finally:
            # 任何一路出口都得把 sweeping 落回 False，不然进度条会一直挂着。
            self._set_progress(sweeping=False, sweep_total=0, sweep_indexed=0)
        count = len(ids)
        if count and fire_event:
            # 一条批量事件，不是每张图一条：106 张逐条发会让前端串行刷三百多次。
            self.emit_event_sync({"type": "images_indexed", "count": count, "ids": ids[:50]})
            self.emit_event_sync({"type": "folders_changed"})
        if count:
            log.info("sweep indexed %d missed file(s)", count)
        return {"indexed": count}

    async def _emit(self, payload: dict) -> None:
        try:
            # on_event 是同步回调（直接 publish 到 bus），
            # 主线程切到 asyncio 循环由 call_soon_threadsafe 完成
            self.on_event(payload)
        except Exception as e:  # noqa: BLE001
            log.warning("emit failed: %s", e)


# ---------- watchdog handler ----------


def _is_supported_path(path: str | Path) -> bool:
    """这个路径是不是我们管的媒体文件（只看后缀，和 scan 的口径一致）。"""
    return Path(path).suffix.lower() in SUPPORTED_EXTS


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
        if not _is_supported_path(event.src_path):
            return
        self.indexer.enqueue("create", event.src_path)

    def on_modified(self, event):
        if event.is_directory:
            return
        # 每个事件都要在这条派发线程上付一次 resolve()。不收后缀过滤时，监听树里的
        # .tmp / 日志 / 任何无关文件都在白白排队，还把真新图挤在同一个防抖窗口里。
        if not _is_supported_path(event.src_path):
            return
        self.indexer.enqueue("modify", event.src_path)

    def on_moved(self, event):
        if event.is_directory:
            self._enqueue_directory_removal(event.src_path)
            try:
                self.indexer.prune_missing_system_folders()
            except Exception:  # noqa: BLE001
                log.warning("prune system folders on move failed: %s", event.src_path)
            # 目录重命名：把新路径预先挂上 system folder 链（空目录也能看见）
            try:
                self.indexer._ensure_system_folder_for_dir(Path(event.dest_path))
                for path in Path(event.dest_path).rglob("*"):
                    if path.is_file() and path.suffix.lower() in SUPPORTED_EXTS:
                        self.indexer.enqueue("create", path)
            except Exception as e:  # noqa: BLE001
                log.warning("ensure moved dir failed: %s (%s)", event.dest_path, e)
            return
        # watchdog 的 moved 事件没有 is_directory 属性在某些版本上；
        # 用后缀判断
        if str(event.src_path).lower().endswith(tuple(SUPPORTED_EXTS)) or not Path(event.src_path).suffix:
            self.indexer.enqueue("create", event.dest_path)
            self.indexer.enqueue("delete", event.src_path)

    def on_deleted(self, event):
        # Windows watchdog 把 FILE_ACTION_REMOVED 一律包装成 FileDeletedEvent，
        # 因而不能仅凭 is_directory 判断是否需要清理目录后代。
        if event.is_directory and self.indexer._is_false_root_delete(event.src_path):
            # 假删除（判据见 Indexer._is_false_root_delete）。照下面走完的后果很实在：
            # 前缀匹配会把整条来源目录的文件全排进删除队列，每条又因为「盘上还在」退回
            # 重新解析（实测一次 700 个文件），顺带 prune 掉左侧那棵目录树。
            # emitter 这会儿已经停了，重建交给 repair_watcher。
            log.warning("忽略一条虚假的目录删除事件（监听事件缓冲溢出被 watchdog 误判）：%s", event.src_path)
            return
        self._enqueue_directory_removal(event.src_path)
        if event.is_directory:
            # 目录删除属于"被文件系统同步"事件。旧实现"不动 system folder 表"
            # 导致左侧「来源目录」残留已删除的镜像文件夹；现在点删除立即清理。
            try:
                self.indexer.prune_missing_system_folders()
            except Exception:  # noqa: BLE001
                log.warning("prune system folders on delete failed: %s", event.src_path)
            return
        self.indexer.enqueue("delete", event.src_path)

    def _enqueue_directory_removal(self, directory):
        # Windows 的目录删除/移出可能只有目录事件，逐个清理其图片索引。
        prefix = self.indexer._normalize(directory).rstrip("/") + "/"
        collation = " COLLATE NOCASE" if os.name == "nt" else ""
        rows = get_pool().main().execute(
            "SELECT path FROM images WHERE substr(path, 1, ?) = ?" + collation,
            (len(prefix), prefix),
        ).fetchall()
        for row in rows:
            self.indexer.enqueue("delete", row["path"])


# ---------- 单例 ----------


_INDEXER: Indexer | None = None


def get_indexer() -> Indexer:
    global _INDEXER
    if _INDEXER is None:
        _INDEXER = Indexer()
    return _INDEXER


def suppress_watcher_events(paths: "list[Path | str] | tuple[Path | str, ...]", *, seconds: float = 5.0) -> None:
    """应用自己动磁盘文件时，忽略这些路径上的 watchdog 事件。

    调用方自己把索引写好了，watcher 再跑一遍会插重复行或删掉正确的行。监听没起来
    （单测、拆分前的老流程）时本来就没有事件，这里安静地跳过。
    """
    try:
        get_indexer().suppress_events(paths, seconds=seconds)
    except Exception as exc:  # noqa: BLE001 - 抑制失败不该让改名/移动本身失败
        log.warning("watchdog 抑制窗口没开成：%s", exc)
