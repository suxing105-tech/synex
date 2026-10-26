"""0.2.21 收藏列删除迁移：列消失、幂等、强制备份、失败时不硬删。"""
from __future__ import annotations

import sqlite3

import pytest

from app.db import PRE_FAVORITE_DROP_DIR, backup_before_drop_favorite, get_pool, init_pool, migrate_drop_favorite


def _columns(conn, table: str) -> set[str]:
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _make_legacy(conn) -> None:
    """把当前库改回 0.2.20 的样子：两张表都带 favorite 列 + 依赖它的索引。"""
    conn.execute("ALTER TABLE images ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0")
    conn.execute("ALTER TABLE texts ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_images_favorite ON images(favorite)")


def test_migrate_drop_favorite_drops_columns_and_backs_up(tmp_data_dir):
    init_pool()
    conn = get_pool().main()
    _make_legacy(conn)
    conn.execute(
        "INSERT INTO images(path, filename, size_bytes, mtime, favorite) VALUES('p.png', 'p.png', 1, 1, 1)"
    )
    db_file = tmp_data_dir / "db.sqlite"

    assert migrate_drop_favorite(conn, db_file) is True

    assert "favorite" not in _columns(conn, "images")
    assert "favorite" not in _columns(conn, "texts")
    assert conn.execute(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND name='idx_images_favorite'"
    ).fetchone()["c"] == 0
    # 其他数据完好
    row = conn.execute("SELECT path, filename FROM images").fetchone()
    assert (row["path"], row["filename"]) == ("p.png", "p.png")

    backup = tmp_data_dir / "backup" / PRE_FAVORITE_DROP_DIR / "db.sqlite"
    assert backup.is_file()
    with sqlite3.connect(backup) as frozen:
        cols = {r[1] for r in frozen.execute("PRAGMA table_info(images)").fetchall()}
    assert "favorite" in cols  # 备份是删除前的快照


def test_migrate_drop_favorite_is_idempotent_and_keeps_first_backup(tmp_data_dir):
    init_pool()
    conn = get_pool().main()
    _make_legacy(conn)
    db_file = tmp_data_dir / "db.sqlite"
    assert migrate_drop_favorite(conn, db_file) is True
    backup = tmp_data_dir / "backup" / PRE_FAVORITE_DROP_DIR / "db.sqlite"
    stamp = backup.stat().st_mtime_ns
    # 二次调用：没有列要删 → 不再备份，备份文件原样不动
    assert migrate_drop_favorite(conn, db_file) is False
    assert backup.stat().st_mtime_ns == stamp


def test_migrate_is_noop_on_database_without_favorite_column(tmp_data_dir):
    init_pool()
    conn = get_pool().main()
    assert "favorite" not in _columns(conn, "images")
    assert migrate_drop_favorite(conn, tmp_data_dir / "db.sqlite") is False
    assert not (tmp_data_dir / "backup" / PRE_FAVORITE_DROP_DIR).exists()


def test_migrate_skipped_when_backup_fails(tmp_data_dir, monkeypatch):
    """备份失败就放弃迁移：宁可留一个没人读的列，也不能删了没法回滚。"""
    init_pool()
    conn = get_pool().main()
    _make_legacy(conn)

    def boom(_conn, _path):
        raise sqlite3.Error("disk full")

    monkeypatch.setattr("app.db.backup_before_drop_favorite", boom)
    assert migrate_drop_favorite(conn, tmp_data_dir / "db.sqlite") is False
    assert "favorite" in _columns(conn, "images")
    assert "favorite" in _columns(conn, "texts")


class _RefuseDropColumn:
    """模拟不支持 ALTER TABLE ... DROP COLUMN 的 SQLite 构建。"""

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, *args, **kwargs):
        if "DROP COLUMN" in str(sql):
            raise sqlite3.OperationalError("test: DROP COLUMN unsupported")
        return self._conn.execute(sql, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._conn, name)


def test_migrate_survives_sqlite_without_drop_column_support(tmp_data_dir):
    """列删不掉只记 warning，启动不能因此失败；索引仍会被删掉。"""
    init_pool()
    conn = get_pool().main()
    _make_legacy(conn)
    assert migrate_drop_favorite(_RefuseDropColumn(conn), tmp_data_dir / "db.sqlite") is False
    assert "favorite" in _columns(conn, "images")


def test_backup_before_drop_favorite_does_not_overwrite(tmp_data_dir):
    init_pool()
    conn = get_pool().main()
    db_file = tmp_data_dir / "db.sqlite"
    first = backup_before_drop_favorite(conn, db_file)
    assert first is not None and first.is_file()
    stamp = first.stat().st_mtime_ns
    assert backup_before_drop_favorite(conn, db_file) is None
    assert first.stat().st_mtime_ns == stamp