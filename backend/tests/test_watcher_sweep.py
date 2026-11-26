# -*- coding: utf-8 -*-
"""监听这条路上实测出来的两个洞，钉在这里防复发。

2026-11-24：一次自更新重启之后，ComfyUI 输出目录里 106 张图 20 分钟没进库。
查下来是两件事叠在一起——① 防抖只有下限，持续事件流下永不落地；
② 全项目只有「库里有、盘上没了 → 删行」这一半，丢掉的新文件没人补扫。
下面两组用例分别钉住这两条，不是在测「功能存在」。
"""
import os
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.indexer import (
    FLUSH_MAX_WAIT_SECONDS,
    SWEEP_SETTLE_SECONDS,
    Indexer,
    _Handler,
    _is_supported_path,
)
from .conftest import make_png


@pytest.fixture
def indexer(init_db):
    idx = Indexer()
    yield idx
    idx.shutdown()


def watch_root(indexer, root: Path) -> Path:
    """把这个临时目录当成一条来源目录（生产里它来自 config.watch_dirs）。"""
    indexer._watch_roots = [root]
    return root


def settle(path: Path) -> Path:
    """把 mtime 推到「写稳」之后：补扫故意不收刚在写的文件。"""
    stamp = int((time.time() - SWEEP_SETTLE_SECONDS - 1.0) * 1e9)
    os.utime(path, ns=(stamp, stamp))
    return path


def row_count(db) -> int:
    return db.main().execute("SELECT count(*) AS n FROM images").fetchone()["n"]


def patch_timer():
    from unittest.mock import patch

    return patch("app.indexer.threading.Timer")


# ---------- ① 防抖：持续来事件也必须按时落地 ----------


def test_flush_lands_even_while_events_keep_coming(indexer, init_db, tmp_path):
    """每 20ms 一条事件的持续流里，新图不许一直不入库。

    旧写法是每个事件都把那颗 300ms 定时器往后重拨一次，于是事件不断 = 永不落地
    （实测 12 秒 0 行）。现在到期时刻锁死在「最早那条事件 + 上限」。
    """
    churn = tmp_path / "comfyui_partial.tmp"
    churn.write_bytes(b"x")
    make_png(tmp_path / "fresh.png")
    started = time.monotonic()
    stop = threading.Event()

    def churner():
        while not stop.is_set():
            indexer.enqueue("modify", churn)
            time.sleep(0.02)

    thread = threading.Thread(target=churner, daemon=True)
    thread.start()
    try:
        time.sleep(0.1)
        indexer.enqueue("create", tmp_path / "fresh.png")
        deadline = time.monotonic() + FLUSH_MAX_WAIT_SECONDS + 3.0
        while time.monotonic() < deadline and row_count(init_db) == 0:
            time.sleep(0.02)
        elapsed = time.monotonic() - started
    finally:
        stop.set()
        thread.join(timeout=2)

    rows = init_db.main().execute("SELECT filename FROM images").fetchall()
    assert [r["filename"] for r in rows] == ["fresh.png"]
    assert elapsed < FLUSH_MAX_WAIT_SECONDS + 3.0, elapsed


def test_quiet_events_still_merge_inside_the_debounce_window(indexer, init_db, tmp_path):
    """上限不许顺手把防抖改成轮询：安静时一批两条仍旧一次落地，队列与锚点清空。"""
    first = make_png(tmp_path / "one.png")
    second = make_png(tmp_path / "two.png")
    with patch_timer():
        indexer.enqueue("create", first)
        indexer.enqueue("create", second)
        assert len(indexer._pending) == 2
        indexer._flush_pending("create")
    assert sorted(r["filename"] for r in init_db.main().execute("SELECT filename FROM images")) == [
        "one.png",
        "two.png",
    ]
    assert indexer._pending == set()
    assert indexer._pending_oldest is None


# ---------- ② handler 先按后缀过滤 ----------


def test_non_media_events_never_enter_the_queue(indexer, tmp_path):
    """监听树里的 .tmp / 日志不该排队：每个事件都要在这条线程上付一次 resolve()。"""
    handler = _Handler(indexer)
    junk = tmp_path / "partial.tmp"
    junk.write_bytes(b"x")
    handler.on_created(SimpleNamespace(is_directory=False, src_path=str(junk)))
    handler.on_modified(SimpleNamespace(is_directory=False, src_path=str(junk)))
    assert indexer._pending == set()

    image = make_png(tmp_path / "real.png")
    handler.on_modified(SimpleNamespace(is_directory=False, src_path=str(image)))
    assert len(indexer._pending) == 1
    assert _is_supported_path("a/b/c.webp") and not _is_supported_path("a/b/partial.tmp")


def test_directory_created_still_mounts_system_folder(indexer, init_db, tmp_path):
    """后缀过滤不许把目录事件一起滤掉：空目录也要立刻出现在「来源」树上。"""
    watch_root(indexer, tmp_path)
    sub = tmp_path / "新一批"
    sub.mkdir()
    _Handler(indexer).on_created(SimpleNamespace(is_directory=True, src_path=str(sub)))
    assert indexer._pending == set()
    names = [r["name"] for r in init_db.main().execute("SELECT name FROM folders WHERE is_system = 1")]
    assert "新一批" in names


# ---------- ③ 补扫：只收不删 ----------


def test_sweep_picks_up_files_the_watcher_missed(indexer, init_db, tmp_path):
    """watchdog 事件丢了（重启、缓冲溢出……）之后补扫要捞回来，且只发一条批量事件。"""
    watch_root(indexer, tmp_path)
    events: list[dict] = []
    indexer.emit_event_sync = events.append  # type: ignore[assignment]
    settle(make_png(tmp_path / "missed.png"))

    assert indexer.sweep_new_files() == {"indexed": 1}
    assert [r["filename"] for r in init_db.main().execute("SELECT filename FROM images")] == ["missed.png"]
    assert [e["type"] for e in events] == ["images_indexed", "folders_changed"]
    assert events[0]["count"] == 1 and len(events[0]["ids"]) == 1

    # 第二轮没有新东西：不许每分钟把整库重解析一遍
    assert indexer.sweep_new_files() == {"indexed": 0}
    assert len(events) == 2


def test_sweep_leaves_files_that_are_still_being_written(indexer, init_db, tmp_path):
    """刚在写的文件元数据读不全，留给它自己的 modify 事件或下一轮补扫。"""
    watch_root(indexer, tmp_path)
    fresh = make_png(tmp_path / "writing.png")
    assert indexer.sweep_new_files() == {"indexed": 0}
    assert row_count(init_db) == 0
    settle(fresh)
    assert indexer.sweep_new_files() == {"indexed": 1}


def test_sweep_only_adds_and_never_removes(indexer, init_db, tmp_path):
    """删除仍旧归 reconcile_missing 管；补扫这一半不许顺手删行。"""
    watch_root(indexer, tmp_path)
    gone = settle(make_png(tmp_path / "gone.png"))
    indexer._process_path_sync(gone)
    gone.unlink()

    assert indexer.sweep_new_files() == {"indexed": 0}
    assert row_count(init_db) == 1
    indexer.reconcile_missing()
    assert row_count(init_db) == 0


def test_sweep_does_not_reindex_paths_stored_with_backslashes(indexer, init_db, tmp_path):
    """老库里反斜杠写法的行要认得，否则每分钟白白重解析一次。"""
    watch_root(indexer, tmp_path)
    image = settle(make_png(tmp_path / "legacy.png"))
    indexer._process_path_sync(image)
    forward = str(image.resolve()).replace(os.sep, "/")
    init_db.main().execute("UPDATE images SET path = ? WHERE id = (SELECT MIN(id) FROM images)", (forward.replace("/", "\\"),))
    assert indexer.find_unindexed_files() == []


def test_sweep_honours_the_per_pass_limit(indexer, init_db, tmp_path):
    watch_root(indexer, tmp_path)
    for i in range(3):
        settle(make_png(tmp_path / ("p%d.png" % i)))
    assert len(indexer.find_unindexed_files(limit=2)) == 2
    assert len(indexer.find_unindexed_files()) == 3


def test_sweep_stands_aside_while_a_scan_is_running(indexer, init_db, tmp_path):
    watch_root(indexer, tmp_path)
    settle(make_png(tmp_path / "during_scan.png"))
    indexer._set_progress(running=True)
    assert indexer.sweep_new_files() == {"indexed": 0}
    assert row_count(init_db) == 0


def test_sweep_shows_its_own_progress_without_stealing_running(indexer, init_db, tmp_path):
    """补扫一次收几百个文件要跑几十秒，顶部进度条得跟着动。

    关键是它**不占** running：running=true 会让 maintenance 的 prepare-update 回 409
    「正在导入」，而补扫是每分钟自己跑的后台活——用它挡装更新等于让图库永远装不上更新。
    """
    watch_root(indexer, tmp_path)
    for i in range(3):
        settle(make_png(tmp_path / ("q%d.png" % i)))
    seen: list[dict] = []
    original = indexer._process_path_sync

    def spy(path, *, remove=False):
        seen.append(indexer.get_progress())
        return original(path, remove=remove)

    indexer._process_path_sync = spy  # type: ignore[assignment]
    assert indexer.sweep_new_files() == {"indexed": 3}

    assert len(seen) == 3
    assert all(p["sweeping"] and p["sweep_total"] == 3 for p in seen)
    assert not any(p["running"] for p in seen), "补扫不许占 running，那会挡住装更新"
    assert [p["sweep_indexed"] for p in seen] == sorted(p["sweep_indexed"] for p in seen)
    after = indexer.get_progress()
    assert (after["sweeping"], after["sweep_total"], after["sweep_indexed"]) == (False, 0, 0)
    assert row_count(init_db) == 3


def test_sweep_clears_its_progress_when_an_item_explodes(indexer, init_db, tmp_path):
    """某条解析炸了不许把进度条永久挂在「补录中」：计数在 finally 里落回原样。"""
    watch_root(indexer, tmp_path)
    settle(make_png(tmp_path / "a.png"))
    settle(make_png(tmp_path / "b.png"))

    def boom(path, *, remove=False):
        raise RuntimeError("解析炸了")

    indexer._process_path_sync = boom  # type: ignore[assignment]
    assert indexer.sweep_new_files() == {"indexed": 0}
    after = indexer.get_progress()
    assert (after["sweeping"], after["sweep_total"], after["sweep_indexed"]) == (False, 0, 0)


def test_startup_and_reconcile_loop_are_wired_to_the_sweep():
    """补扫得真的有人调：开机一次 + 循环里每 30 轮（约 1 分钟）一次。

    这条读源码而不跑 lifespan——起整个应用太重，但「忘了接线」正是这轮的原始病灶。
    """
    from app import main as main_module

    src = Path(main_module.__file__).read_text(encoding="utf-8")
    loop = src.split("async def reconcile_loop", 1)[1].split("reconcile_task = ", 1)[0]
    assert "indexer.sweep_new_files" in loop
    assert "sweep_every = 30" in loop
    startup = src.split("await asyncio.to_thread(indexer.reconcile_missing)", 1)[1]
    assert "await asyncio.to_thread(indexer.sweep_new_files)" in startup.split("reconcile_task", 1)[0]
