"""改名留下的反斜杠 path 要能自愈：统一写法，同一个文件的重复索引行并成一行。

现场（演示库 outputs/_clone_r10_data/db.sqlite）：
  id 580  D:\\AI\\...\\krea2\\科技.png   ← 改名接口写坏的那一行
  id 629  D:/AI/.../krea2/科技.png        ← watcher 之后按标准写法又插的一条
同一个文件两行 = 网格里两张一样的缩略图。
"""
from __future__ import annotations

import sqlite3

import pytest

from app.db import PRE_PATH_DEDUPE_DIR, get_pool, init_pool, migrate_image_path_identity
from app.indexer import Indexer

from .conftest import make_png


def _conn():
    return get_pool().main()


def _rows():
    return _conn().execute("SELECT id, path, filename FROM images ORDER BY id").fetchall()


def _make_twin(tmp, name="科技.png"):
    """照 v0.2.32 的样子造一个坏库：同一个文件两行，一行反斜杠、一行正斜杠。

    返回 (写坏的那行 id, watcher 补插的那行 id, 真实文件)。
    """
    f = make_png(tmp / name)
    broken = Indexer()._process_path_sync(f)["id"]
    good_path = _conn().execute("SELECT path FROM images WHERE id=?", (broken,)).fetchone()["path"]
    _conn().execute("UPDATE images SET path=? WHERE id=?", (good_path.replace("/", "\\"), broken))
    twin = _conn().execute(
        "INSERT INTO images(path, filename, size_bytes, mtime) VALUES(?,?,?,?)",
        (good_path, name, f.stat().st_size, f.stat().st_mtime),
    ).lastrowid
    return broken, twin, f


def _attach_children(image_id: int) -> None:
    """给一行挂满各种关联，合并时一条都不许丢。"""
    c = _conn()
    c.execute("INSERT OR IGNORE INTO tags(id, name) VALUES(1, '红')")
    c.execute("INSERT OR IGNORE INTO image_tags(image_id, tag_id) VALUES(?, 1)", (image_id,))
    c.execute("INSERT OR IGNORE INTO folders(id, name) VALUES(1, 'krea2')")
    c.execute("INSERT OR IGNORE INTO image_folders(image_id, folder_id) VALUES(?, 1)", (image_id,))
    c.execute(
        "INSERT INTO reverse_prompts(image_id, prompt_zh, prompt_en, status, source,"
        " model_name, model, instruction, fingerprint) VALUES(?,'中','en','done','manual','m','m','i','f')",
        (image_id,),
    )
    c.execute(
        "INSERT OR IGNORE INTO clone_sources(image_id, source_image_id) VALUES(?, NULL)", (image_id,)
    )
    c.execute(
        "INSERT INTO video_prompt_runs(video_id, range_start_ms, range_end_ms, status,"
        " frame_limit, max_unit_seconds) VALUES(?,0,1000,'planned',8,10)",
        (image_id,),
    )


def _counts(image_id: int) -> dict:
    c = _conn()
    return {
        "tags": c.execute("SELECT COUNT(*) AS n FROM image_tags WHERE image_id=?", (image_id,)).fetchone()["n"],
        "folders": c.execute("SELECT COUNT(*) AS n FROM image_folders WHERE image_id=?", (image_id,)).fetchone()["n"],
        "reverse": c.execute("SELECT COUNT(*) AS n FROM reverse_prompts WHERE image_id=?", (image_id,)).fetchone()["n"],
        "clone": c.execute("SELECT COUNT(*) AS n FROM clone_sources WHERE image_id=?", (image_id,)).fetchone()["n"],
        "runs": c.execute("SELECT COUNT(*) AS n FROM video_prompt_runs WHERE video_id=?", (image_id,)).fetchone()["n"],
    }


def test_twin_rows_merge_into_one_card(tmp_data_dir):
    """两张卡并成一张：留下标准写法那一行，关联全部跟过去，图片文件不动。"""
    init_pool()
    broken, twin, file = _make_twin(tmp_data_dir)
    _attach_children(broken)

    result = migrate_image_path_identity(_conn(), tmp_data_dir / "db.sqlite")

    assert result == {"rewritten": 0, "merged": 1}
    rows = _rows()
    assert len(rows) == 1, "同一个文件只剩一行索引"
    assert rows[0]["id"] == twin
    assert rows[0]["path"].startswith("D:/") or "\\" not in rows[0]["path"]
    assert "\\" not in rows[0]["path"], rows[0]["path"]
    assert rows[0]["filename"] == "科技.png"
    assert _counts(twin) == {"tags": 1, "folders": 1, "reverse": 1, "clone": 1, "runs": 1}
    assert file.is_file(), "整理索引不许碰磁盘上的图片"


def test_backslash_row_without_a_twin_only_rewrites_the_path(tmp_data_dir):
    """只有一行、没有重复：就地改写法，id 和关联都不变（缩略图 URL、标签都跟着 id 走）。"""
    init_pool()
    file = make_png(tmp_data_dir / "你好.png")
    broken = Indexer()._process_path_sync(file)["id"]
    good = _conn().execute("SELECT path FROM images WHERE id=?", (broken,)).fetchone()["path"]
    _conn().execute("UPDATE images SET path=? WHERE id=?", (good.replace("/", "\\"), broken))
    _attach_children(broken)

    result = migrate_image_path_identity(_conn(), tmp_data_dir / "db.sqlite")

    assert result == {"rewritten": 1, "merged": 0}
    row = _rows()[0]
    assert row["id"] == broken, "不该换 id，别牵连缩略图 URL 和反向关联"
    assert row["path"] == good
    assert row["filename"] == "你好.png"
    assert _counts(broken) == {"tags": 1, "folders": 1, "reverse": 1, "clone": 1, "runs": 1}
    assert file.is_file()


def test_watcher_after_migration_reuses_the_row(tmp_data_dir):
    """整理完，watcher 再上报同一个文件必须认得那一行，不能再插第三张卡。"""
    init_pool()
    _broken, twin, file = _make_twin(tmp_data_dir)
    migrate_image_path_identity(_conn(), tmp_data_dir / "db.sqlite")

    payload = Indexer()._process_path_sync(file)

    assert payload["id"] == twin
    assert len(_rows()) == 1


def test_migration_is_idempotent_and_backs_up_once(tmp_data_dir):
    init_pool()
    _make_twin(tmp_data_dir)
    db_file = tmp_data_dir / "db.sqlite"
    assert migrate_image_path_identity(_conn(), db_file)["merged"] == 1
    backup = tmp_data_dir / "backup" / PRE_PATH_DEDUPE_DIR / "db.sqlite"
    assert backup.is_file()
    stamp = backup.stat().st_mtime_ns
    with sqlite3.connect(backup) as frozen:
        assert frozen.execute("SELECT COUNT(*) FROM images").fetchone()[0] == 2  # 合并前的快照
    assert migrate_image_path_identity(_conn(), db_file) == {"rewritten": 0, "merged": 0}
    assert backup.stat().st_mtime_ns == stamp


def test_clean_database_is_left_alone(tmp_data_dir):
    init_pool()
    Indexer()._process_path_sync(make_png(tmp_data_dir / "ok.png"))

    assert migrate_image_path_identity(_conn(), tmp_data_dir / "db.sqlite") == {
        "rewritten": 0,
        "merged": 0,
    }
    assert not (tmp_data_dir / "backup" / PRE_PATH_DEDUPE_DIR).exists()


def test_backup_failure_skips_the_merge(tmp_data_dir, monkeypatch):
    """备份失败就什么都不动：宁可留着两张卡，也不能合并完没法回滚。"""
    init_pool()
    _broken, twin, _file = _make_twin(tmp_data_dir)

    def boom(*_args, **_kwargs):
        raise sqlite3.Error("disk full")

    monkeypatch.setattr("app.db.backup_database", boom)
    assert migrate_image_path_identity(_conn(), tmp_data_dir / "db.sqlite") == {
        "rewritten": 0,
        "merged": 0,
    }
    assert len(_rows()) == 2


def test_running_the_pool_runs_the_migration(tmp_data_dir, monkeypatch):
    """迁移挂在启动流程里：装机用户升级后自己就好了，不需要手动清库。"""
    from app import db as db_module

    init_pool()
    _make_twin(tmp_data_dir)
    calls = []
    monkeypatch.setattr(
        db_module,
        "migrate_image_path_identity",
        lambda conn, path=None: calls.append(1) or {"rewritten": 0, "merged": 0},
    )
    pool = db_module.ConnectionPool(tmp_data_dir / "db.sqlite")
    pool.initialize()
    assert calls == [1]
