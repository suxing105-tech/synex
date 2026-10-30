"""双击改名不能多出一张缩略图。

现场（演示库 outputs/_clone_r10_data/db.sqlite）：
  id 580  D:\\AI\\...\\krea2\\科技.png   ← 改名之后被写成反斜杠
  id 629  D:/AI/.../krea2/科技.png        ← watcher 之后按正斜杠又插的一条
同一个文件两行，网格上就是两张一模一样的卡。images.path 上那个 UNIQUE 拦不住，
因为它只比字符串，不比这两个字符串指的是不是同一个文件。
"""
from __future__ import annotations

from app import repository
from app.db import get_pool, init_pool
from app.indexer import Indexer, get_indexer

from .conftest import make_png


def _rows():
    return get_pool().main().execute("SELECT id, path, filename FROM images ORDER BY id").fetchall()


def test_rename_keeps_the_path_form_the_indexer_uses(tmp_data_dir):
    """改名写回的 path 必须还是索引那份写法（正斜杠 + 绝对路径）。"""
    init_pool()
    image_id = Indexer()._process_path_sync(make_png(tmp_data_dir / "before.png"))["id"]

    repository.rename_image(image_id, "after.png")

    stored = _rows()[0]["path"]
    assert "\\" not in stored, stored
    assert stored == repository._normalize_path((tmp_data_dir / "after.png").resolve())


def test_watcher_report_after_rename_reuses_the_same_row(tmp_data_dir):
    """改名之后 watcher 上报同一张图：要认得就是那一行，不许再插一条。"""
    init_pool()
    indexer = Indexer()
    image_id = indexer._process_path_sync(make_png(tmp_data_dir / "before.png"))["id"]

    repository.rename_image(image_id, "after.png")
    payload = indexer._process_path_sync(tmp_data_dir / "after.png")

    assert payload["id"] == image_id, "watcher 把改完名的图当成新文件，网格里会多一张卡"
    assert len(_rows()) == 1


def test_rename_suppresses_watcher_events_on_both_paths(tmp_data_dir):
    """改名那一下吞掉旧路径与新路径的 watchdog 事件（与「移动到文件夹」同一条规矩）。"""
    init_pool()
    indexer = get_indexer()
    image_id = indexer._process_path_sync(make_png(tmp_data_dir / "before.png"))["id"]
    before, after = tmp_data_dir / "before.png", tmp_data_dir / "after.png"

    repository.rename_image(image_id, "after.png")

    indexer.enqueue("created", after)
    indexer.enqueue("deleted", before)
    assert indexer._normalize(after) not in indexer._pending
    assert indexer._normalize(before) not in indexer._pending


def test_rename_to_the_same_name_leaves_one_row(tmp_data_dir):
    """改名成自己（补全扩展名后一模一样）：不许动磁盘、也不许多出行。"""
    init_pool()
    indexer = Indexer()
    image_id = indexer._process_path_sync(make_png(tmp_data_dir / "same.png"))["id"]

    repository.rename_image(image_id, "same.png")

    assert len(_rows()) == 1
    assert _rows()[0]["filename"] == "same.png"
    assert (tmp_data_dir / "same.png").is_file()
