"""SQLite 连接管理 + schema 初始化。

要点：
- WAL 模式 + ``synchronous=NORMAL``，平衡写入吞吐与崩溃安全。
- FTS5 虚拟表 ``images_fts`` 与 ``images`` 表通过 ``rowid`` 同步。
- 删除 / 更新图片时同步维护 FTS，避免搜索悬挂。
- ``images.path`` 加唯一索引，防止同一路径重复入库。
- 所有 DDL 幂等，可在已有库上安全跑。

并发模型：
- ``main()`` 返回 **线程局部** 连接。每个调用线程（包括 watchdog / FastAPI worker
  / 索引后台任务）拿到自己的连接 + cursor，sqlite3 不允许同一连接并发执行语句，
  直接共享会触发 ``InterfaceError: bad parameter or other API misuse``。
- 所有连接指向同一个 SQLite 文件，WAL 模式天然支持多连接并发读写。
- ``transaction()`` 仍按 ``main()`` 走，所以每个线程的 BEGIN/COMMIT 是独立的。
"""
from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .config import db_path


SCHEMA = r"""
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    mtime REAL NOT NULL,
    width INTEGER,
    height INTEGER,
    format TEXT,
    positive_prompt TEXT NOT NULL DEFAULT '',
    negative_prompt TEXT NOT NULL DEFAULT '',
    parameters TEXT NOT NULL DEFAULT '{}',
    workflow TEXT NOT NULL DEFAULT '',
    seed INTEGER,
    model TEXT,
    sampler TEXT,
    steps INTEGER,
    cfg REAL,
    thumb_path TEXT,
    thumb_status TEXT NOT NULL DEFAULT 'pending',
    favorite INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    indexed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_images_mtime ON images(mtime DESC);
CREATE INDEX IF NOT EXISTS idx_images_favorite ON images(favorite) WHERE favorite = 1;
CREATE INDEX IF NOT EXISTS idx_images_seed ON images(seed);
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_system INTEGER NOT NULL DEFAULT 0,
    path TEXT,
    UNIQUE(parent_id, name)
);
-- 注意：idx_folders_path 唯一索引不在这里建，留给 migrate_system_folders
-- （旧库缺 path 列时 SCHEMA 直接建索引会失败）。
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id, "order");
CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS image_tags (
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (image_id, tag_id)
);
CREATE TABLE IF NOT EXISTS image_folders (
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    PRIMARY KEY (image_id, folder_id)
);
CREATE INDEX IF NOT EXISTS idx_image_folders_folder ON image_folders(folder_id);
CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(
    positive_prompt,
    negative_prompt,
    filename,
    model,
    content='',
    tokenize='unicode61 remove_diacritics 1'
);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class ConnectionPool:
    def __init__(self, path: Path, max_workers: int = 4):
        self.path = path
        self._lock = threading.Lock()
        self._ready_event = threading.Event()
        # 主连接仍保留一份（向后兼容 + 测试），但 main() 实际返回线程局部连接。
        self._main: sqlite3.Connection | None = None
        self._worker_pool: list[sqlite3.Connection] = []
        self._max_workers = max_workers
        self._initialized = False
        self._local = threading.local()

    def _new_conn(self) -> sqlite3.Connection:
        path_str = self.path.as_posix()
        if not path_str.startswith("\\\\?\\") and len(path_str) > 240:
            path_str = "\\\\?\\" + path_str
        conn = sqlite3.connect(
            path_str,
            uri=True,
            check_same_thread=False,
            timeout=30.0,
            isolation_level=None,
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.execute("PRAGMA temp_store = MEMORY")
        return conn

    def initialize(self) -> None:
        if self._initialized:
            return
        with self._lock:
            if self._initialized:
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._main = self._new_conn()
            # SCHEMA 先跑（建表 + 索引；老库缺 path 列时 idx_folders_path 不在这里建）。
            # migrate_system_folders 后跑：老库 ALTER 补列 + 建唯一索引；新库 no-op。
            self._main.executescript(SCHEMA)
            migrate_system_folders(self._main)
            self._initialized = True
            self._ready_event.set()

    def wait_ready(self, timeout: float = 5.0) -> None:
        """供子线程等待 initialize() 完成，再开自己的连接。"""
        self._ready_event.wait(timeout)

    def main(self) -> sqlite3.Connection:
        """返回当前线程的连接。线程内复用、跨线程隔离。"""
        self.initialize()
        conn = getattr(self._local, "conn", None)
        if conn is None:
            self.wait_ready()
            conn = self._new_conn()
            self._local.conn = conn
        return conn

    def worker(self) -> sqlite3.Connection:
        if not self._initialized:
            self.initialize()
        with self._lock:
            for conn in self._worker_pool:
                try:
                    conn.execute("SELECT 1")
                    self._worker_pool.remove(conn)
                    return conn
                except sqlite3.ProgrammingError:
                    continue
            if len(self._worker_pool) < self._max_workers:
                conn = self._new_conn()
                return conn
        return self._new_conn()

    def release_worker(self, conn: sqlite3.Connection) -> None:
        with self._lock:
            if len(self._worker_pool) < self._max_workers:
                self._worker_pool.append(conn)
            else:
                conn.close()

    def close(self) -> None:
        with self._lock:
            if self._main:
                self._main.close()
                self._main = None
            for c in self._worker_pool:
                c.close()
            self._worker_pool.clear()
            self._initialized = False
            self._ready_event.clear()
            self._local.conn = None


_POOL: ConnectionPool | None = None


def init_pool() -> ConnectionPool:
    global _POOL
    if _POOL is None:
        _POOL = ConnectionPool(db_path())
        _POOL.initialize()
    return _POOL


def get_pool() -> ConnectionPool:
    if _POOL is None:
        return init_pool()
    return _POOL


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    conn = get_pool().main()
    conn.execute("BEGIN")
    try:
        yield conn
    except Exception:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def fts_sync(conn: sqlite3.Connection, image_id: int, op: str) -> None:
    """op in {insert, delete, update}。"""
    if op == "delete":
        # contentless FTS5 必须用 special "delete-rowid" 命令
        conn.execute(
            "INSERT INTO images_fts(images_fts, rowid, positive_prompt, negative_prompt, filename, model) "
            "VALUES('delete', ?, '', '', '', '')",
            (image_id,),
        )
        return
    row = conn.execute(
        "SELECT positive_prompt, negative_prompt, filename, model FROM images WHERE id = ?",
        (image_id,),
    ).fetchone()
    if row is None:
        return
    pos = row["positive_prompt"]
    neg = row["negative_prompt"]
    filename = row["filename"]
    model = row["model"]
    if op == "insert":
        conn.execute(
            "INSERT INTO images_fts(rowid, positive_prompt, negative_prompt, filename, model) "
            "VALUES (?, ?, ?, ?, ?)",
            (image_id, pos, neg, filename, model or ""),
        )
    elif op == "update":
        conn.execute(
            "INSERT INTO images_fts(images_fts, rowid, positive_prompt, negative_prompt, filename, model) "
            "VALUES('delete', ?, '', '', '', '')",
            (image_id,),
        )
        conn.execute(
            "INSERT INTO images_fts(rowid, positive_prompt, negative_prompt, filename, model) "
            "VALUES (?, ?, ?, ?, ?)",
            (image_id, pos, neg, filename, model or ""),
        )


def migrate_system_folders(conn: sqlite3.Connection) -> None:
    """幂等迁移：补齐 folders.is_system / folders.path 字段 + 索引。

    调用前提：SCHEMA 已执行（folders 表已存在）。
    - 新库：列已存在，no-op；
    - 老库（迁移前）：ALTER TABLE 补 is_system / path，再建唯一索引 idx_folders_path。
    """
    tables = {
        r["name"]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    if "folders" not in tables:
        return
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(folders)").fetchall()}
    if "is_system" not in cols:
        conn.execute(
            "ALTER TABLE folders ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0"
        )
    if "path" not in cols:
        conn.execute("ALTER TABLE folders ADD COLUMN path TEXT")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_path "
        "ON folders(path) WHERE path IS NOT NULL"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_folders_is_system ON folders(is_system)"
    )


def get_int_meta(key: str, default: int = 0) -> int:
    row = get_pool().main().execute(
        "SELECT value FROM meta WHERE key = ?", (key,)
    ).fetchone()
    if not row:
        return default
    try:
        return int(row["value"])
    except (TypeError, ValueError):
        return default


def set_meta(key: str, value: object) -> None:
    get_pool().main().execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded",
        (key, str(value)),
    )