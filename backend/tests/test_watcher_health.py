# -*- coding: utf-8 -*-
"""监听健康闸：watchdog 的 emitter 掉了要有人发现、有人重建。

2026-11-24 查「106 张图不进库」时顺带挖出的第三个洞：watchdog 6.0.0 的
``winapi.read_directory_changes`` 把任何不是 ERROR_OPERATION_ABORTED 的 OSError 都判成
「被监听目录已删除」——**包括 64KB 事件缓冲溢出的 ERROR_NOTIFY_ENUM_DIR**。判据本身是坏的
（GetFinalPathNameByHandleW(VOLUME_NAME_NT) 返回 \\Device\\HarddiskVolumeN\\...，
和 D:\\... 永不相等），于是目录完好时也合成一条假的 ``DirDeletedEvent(root)`` 并停掉
emitter：那条来源目录整个会话再也收不到事件，界面上不留一点痕迹。

根因在第三方库里，这里钉住的是我们能修的两半：**假的删除不许当真**、**掉了要重建**。
"""
import shutil

from pathlib import Path
from types import SimpleNamespace

import pytest

from app.indexer import Indexer, _Handler
from .conftest import make_png


@pytest.fixture
def indexer(init_db):
    idx = Indexer()
    yield idx
    idx.shutdown()


# ---------- 假观察器：只用真 watchdog 公开的那几样 ----------


class FakeWatch:
    def __init__(self, path):
        self.path = str(path)
        self.is_recursive = True


class FakeEmitter:
    def __init__(self, watch, alive=True):
        self.watch = watch
        self._alive = alive

    def is_alive(self):
        return self._alive


class FakeObserver:
    """够用的那几样：``emitters`` / ``is_alive()`` / ``schedule()`` / ``unschedule()``。

    刻意不模仿 watchdog 的内部结构（``_emitter_for_watch`` 之类）：健康探测只允许走公开面，
    假对象跟着公开面写，就不会把私有字段当成契约钉住。
    """

    def __init__(self):
        self.emitters = set()
        self.scheduled = []
        self.unscheduled = []

    def is_alive(self):
        return True

    def schedule(self, handler, path, recursive=False):
        watch = FakeWatch(path)
        self.emitters.add(FakeEmitter(watch))
        self.scheduled.append((str(path), bool(recursive)))
        return watch

    def unschedule(self, watch):
        self.unscheduled.append(str(watch.path))
        self.emitters = {e for e in self.emitters if e.watch is not watch}


def wire(indexer, *roots, alive=True):
    """把这几个目录接成「正在监听」，返回那台假观察器。"""
    observer = FakeObserver()
    for root in roots:
        observer.emitters.add(FakeEmitter(FakeWatch(root), alive=alive))
    indexer._observer = observer
    indexer._watched_dirs = {str(r) for r in roots}
    return observer


# ---------- ① 掉了要发现、要重建 ----------


def test_a_dead_emitter_is_detected_and_replaced(indexer, tmp_path):
    """emitter 线程死了而 Observer 毫无察觉：探测要认出来，并换一条新的。"""
    root = tmp_path / "output"
    root.mkdir()
    observer = wire(indexer, root, alive=False)

    assert indexer.watcher_health()["dead"] == [str(root)]
    assert indexer.repair_watcher() == [str(root)]
    # 旧的死 emitter 必须先摘掉：watchdog 在同一个 watch 还在册时不会另起一条
    assert observer.unscheduled == [str(root)]
    assert observer.scheduled == [(str(root), True)]
    assert indexer.watcher_health()["dead"] == []
    assert indexer.repair_watcher() == []
    assert indexer._watcher_repairs == 1


def test_a_healthy_watcher_is_left_completely_alone(indexer, tmp_path):
    """没掉就别动：正常时每 2 秒一次的探测不许拆重建、也不发事件。"""
    root = tmp_path / "output"
    root.mkdir()
    observer = wire(indexer, root)
    events: list[dict] = []
    indexer.emit_event_sync = events.append  # type: ignore[assignment]

    assert indexer.repair_watcher() == []
    assert (observer.scheduled, observer.unscheduled, events) == ([], [], [])
    assert indexer._watcher_repairs == 0


def test_only_the_dead_root_is_rescheduled(indexer, tmp_path):
    """两条来源目录只有一条掉了，另一条不许跟着重挂（重挂等于丢掉它已排队的缓冲）。"""
    ok = tmp_path / "ok"
    bad = tmp_path / "bad"
    ok.mkdir()
    bad.mkdir()
    observer = FakeObserver()
    observer.emitters.add(FakeEmitter(FakeWatch(ok), alive=True))
    observer.emitters.add(FakeEmitter(FakeWatch(bad), alive=False))
    indexer._observer = observer
    indexer._watched_dirs = {str(ok), str(bad)}

    assert indexer.repair_watcher() == [str(bad)]
    assert observer.unscheduled == [str(bad)]
    assert observer.scheduled == [(str(bad), True)]


def test_repair_tells_the_ui_what_happened(indexer, tmp_path):
    """恢复了得让人看得见：发一条 watcher_restarted，前端弹一句提示。"""
    root = tmp_path / "output"
    root.mkdir()
    wire(indexer, root, alive=False)
    events: list[dict] = []
    indexer.emit_event_sync = events.append  # type: ignore[assignment]

    assert indexer.repair_watcher() == [str(root)]
    assert [e["type"] for e in events] == ["watcher_restarted"]
    assert events[0]["dirs"] == [str(root)]


def test_a_genuinely_deleted_root_is_not_rescheduled(indexer, tmp_path):
    """目录真没了归 reconcile_missing 管；往不存在的目录 schedule 会当场抛 FileNotFoundError。"""
    gone = tmp_path / "gone"
    gone.mkdir()
    wire(indexer, gone, alive=False)
    gone.rmdir()

    assert indexer.watcher_health()["dead"] == []
    assert indexer.repair_watcher() == []


def test_probe_says_unknown_when_watchdog_shape_changes(indexer, tmp_path):
    """读不到 emitter 列表时探测作废：不能据此把每条监听都重挂一遍。"""
    root = tmp_path / "output"
    root.mkdir()
    indexer._observer = SimpleNamespace(is_alive=lambda: True)  # 没有 emitters 属性
    indexer._watched_dirs = {str(root)}

    assert indexer.watcher_health()["unknown"] is True
    assert indexer.repair_watcher() == []
    assert indexer._watcher_repairs == 0


def test_nothing_is_repaired_while_paused_or_stopped(indexer, tmp_path):
    """装更新那段（observer 已停 / 正在停）不许重建监听，否则会把刚停掉的又点起来。"""
    root = tmp_path / "output"
    root.mkdir()
    wire(indexer, root, alive=False)
    indexer._stopping = True
    assert indexer.repair_watcher() == []
    indexer._stopping = False
    indexer._observer = None
    assert indexer.repair_watcher() == []


# ---------- ② 假的「根目录被删」不许当真 ----------


def test_the_fake_root_delete_enqueues_nothing(indexer, init_db, tmp_path):
    """假删除照旧走完 handler 的后果：整条来源目录被排进删除队列 + 目录树被 prune。"""
    root = tmp_path / "output"
    batch = root / "batch"
    batch.mkdir(parents=True)
    kept = indexer._process_path_sync(make_png(batch / "kept.png"))
    assert kept and kept["type"] == "image_indexed"
    indexer._watch_roots = [root]
    indexer._watched_dirs = {str(root)}

    _Handler(indexer).on_deleted(SimpleNamespace(is_directory=True, src_path=str(root)))

    assert indexer._pending == set(), "一条虚假删除不许把整条来源目录排进删除队列"
    assert init_db.main().execute("SELECT count(*) AS n FROM images").fetchone()["n"] == 1


def test_a_real_root_delete_still_clears_its_files(indexer, init_db, tmp_path):
    """反面对照：目录真的被删了，仍旧要照原路把它的文件排进删除队列。"""
    root = tmp_path / "output"
    batch = root / "batch"
    batch.mkdir(parents=True)
    indexer._process_path_sync(make_png(batch / "gone.png"))
    indexer._watch_roots = [root]
    indexer._watched_dirs = {str(root)}
    shutil.rmtree(root)

    _Handler(indexer).on_deleted(SimpleNamespace(is_directory=True, src_path=str(root)))

    assert len(indexer._pending) == 1


def test_a_subdirectory_delete_is_never_treated_as_the_root(indexer, init_db, tmp_path):
    """只有根那一条才是假删除的可疑对象；子目录删除照常处理。"""
    root = tmp_path / "output"
    batch = root / "batch"
    batch.mkdir(parents=True)
    indexer._watched_dirs = {str(root)}
    assert indexer._is_false_root_delete(batch) is False
    assert indexer._is_false_root_delete(root) is True


# ---------- ③ 接线与第三方 API 形状 ----------


def test_the_reconcile_loop_actually_runs_the_health_probe():
    """探测得真的有人按：读源码而不是起整个应用（「忘了接线」正是这轮的原始病灶）。"""
    from app import main as main_module

    src = Path(main_module.__file__).read_text(encoding="utf-8")
    loop = src.split("async def reconcile_loop", 1)[1].split("reconcile_task = ", 1)[0]
    assert "indexer.repair_watcher" in loop


def test_the_probe_relies_only_on_watchdogs_public_surface():
    """钉住我们依赖的那几样公开面；watchdog 升级改了就红着提醒，而不是静默失去保护。"""
    import inspect

    from watchdog.observers import Observer
    from watchdog.observers.api import EventEmitter

    for name in ("emitters", "schedule", "unschedule", "is_alive"):
        assert hasattr(Observer, name), name
    assert "recursive" in inspect.signature(Observer.schedule).parameters
    assert isinstance(Observer().emitters, (set, frozenset))
    for name in ("watch", "is_alive"):
        assert hasattr(EventEmitter, name), name
