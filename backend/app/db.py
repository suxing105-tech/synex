"""SQLite 连接管理 + schema 初始化。

要点：
- WAL 模式 + ``synchronous=NORMAL``，平衡写入吞吐与崩溃安全。
- FTS5 虚拟表 ``images_fts`` 是 **外部内容表**（``content='images'``）：正文只存在
  ``images`` 里，索引由 ``images`` 上的触发器维护，所以随时能从 ``images`` 重建。
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

import logging
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .config import db_path

logger = logging.getLogger(__name__)


SCHEMA = r"""
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    mtime REAL NOT NULL,
    kind TEXT NOT NULL DEFAULT 'image',
    width INTEGER,
    height INTEGER,
    format TEXT,
    duration_seconds REAL,
    video_codec TEXT,
    audio_codec TEXT,
    fps REAL,
    cover_path TEXT,
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
    content='images',
    content_rowid='id',
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
            from .texts import initialize as initialize_texts
            initialize_texts(self._main)
            from .reverse_prompts import initialize as initialize_reverse_prompts
            initialize_reverse_prompts(self._main)
            from .video_prompts import initialize as initialize_video_prompts
            initialize_video_prompts(self._main)
            migrate_system_folders(self._main)
            migrate_media_kind(self._main)
            # 搜索索引必须在任何线程写 images 之前修好：老库的 contentless 索引是坏过的
            # （见 migrate_fts），而触发器也依赖 images_fts 存在。
            try:
                migrate_fts(self._main)
                ensure_fts_triggers(self._main)
            except sqlite3.Error as exc:
                logger.warning("搜索索引维护失败，搜索将退回模糊匹配：%s", exc)
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


# ---------- 搜索索引（FTS5）维护 ----------
#
# 索引是 ``images`` 的派生数据，一律由 ``images`` 上的触发器维护。
# 外部内容表自己不存正文，FTS5 的 'delete' 命令必须拿到**被删行的旧值**才能把
# 倒排表改对。以前这里手写 fts_sync()：调用方先 DELETE 再同步、旧值还一律写成
# 空串，倒排表被越改越乱，最后 MATCH 直接抛 "database disk image is malformed"
# —— 表现为搜索框输入没反应（/api/images?q= 返回 500）。
# 换成触发器后不存在顺序问题，也不可能写错旧值；索引坏了还能从 images 重建。

FTS_CREATE = (
    "CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5("
    "positive_prompt, negative_prompt, filename, model, "
    "content='images', content_rowid='id', "
    "tokenize='unicode61 remove_diacritics 1')"
)

FTS_TRIGGERS = r"""
CREATE TRIGGER IF NOT EXISTS images_fts_ai AFTER INSERT ON images BEGIN
  INSERT INTO images_fts(rowid, positive_prompt, negative_prompt, filename, model)
  VALUES (new.id, new.positive_prompt, new.negative_prompt, new.filename, COALESCE(new.model, ''));
END;
CREATE TRIGGER IF NOT EXISTS images_fts_ad AFTER DELETE ON images BEGIN
  INSERT INTO images_fts(images_fts, rowid, positive_prompt, negative_prompt, filename, model)
  VALUES ('delete', old.id, old.positive_prompt, old.negative_prompt, old.filename,
          COALESCE(old.model, ''));
END;
CREATE TRIGGER IF NOT EXISTS images_fts_au AFTER UPDATE ON images BEGIN
  INSERT INTO images_fts(images_fts, rowid, positive_prompt, negative_prompt, filename, model)
  VALUES ('delete', old.id, old.positive_prompt, old.negative_prompt, old.filename,
          COALESCE(old.model, ''));
  INSERT INTO images_fts(rowid, positive_prompt, negative_prompt, filename, model)
  VALUES (new.id, new.positive_prompt, new.negative_prompt, new.filename, COALESCE(new.model, ''));
END;
"""


def _fts_ddl(conn: sqlite3.Connection) -> str | None:
    """返回 images_fts 的建表语句；表不存在时返回 None。"""
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'images_fts'"
    ).fetchone()
    if row is None:
        return None
    return row["sql"] or ""


def _fts_populate(conn: sqlite3.Connection) -> None:
    conn.execute(
        "INSERT INTO images_fts(rowid, positive_prompt, negative_prompt, filename, model) "
        "SELECT id, positive_prompt, negative_prompt, filename, COALESCE(model, '') FROM images"
    )


def fts_is_healthy(conn: sqlite3.Connection) -> bool:
    """跑一条一定搜不到的查询：索引结构坏了会在这里抛 malformed。"""
    try:
        conn.execute(
            "SELECT rowid FROM images_fts WHERE images_fts MATCH ? LIMIT 1",
            ('"suxing_fts_health_probe"*',),
        ).fetchall()
        return True
    except sqlite3.Error as exc:
        logger.warning("搜索索引探测失败，准备重建：%s", exc)
        return False


def ensure_fts_triggers(conn: sqlite3.Connection) -> None:
    conn.executescript(FTS_TRIGGERS)


def migrate_fts(conn: sqlite3.Connection) -> str:
    """把遗留的 contentless 索引换成外部内容索引，并顺手治好已经坏掉的索引。

    返回本次做的事：created / migrated / rebuilt / recreated / ok。
    历史库用 ``content=''`` + 手写同步，索引里既有指向已删图片的残留，也有被
    写坏的倒排表；这种索引不可信，直接删表按 images 重建，用户图片数据不受影响。
    """
    ddl = _fts_ddl(conn)
    if ddl is None:
        conn.execute(FTS_CREATE)
        return "created"
    if "content=''" in ddl:
        conn.execute("DROP TABLE images_fts")
        conn.execute(FTS_CREATE)
        _fts_populate(conn)
        logger.warning("搜索索引已从 contentless 迁移为外部内容表并按 images 重建")
        return "migrated"
    if fts_is_healthy(conn):
        return "ok"
    try:
        conn.execute("INSERT INTO images_fts(images_fts) VALUES('rebuild')")
        logger.warning("搜索索引已按 images 重建")
        return "rebuilt"
    except sqlite3.Error as exc:
        logger.warning("搜索索引 rebuild 失败，改为删表重建：%s", exc)
        conn.execute("DROP TABLE images_fts")
        conn.execute(FTS_CREATE)
        _fts_populate(conn)
        return "recreated"


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


def migrate_media_kind(conn: sqlite3.Connection) -> None:
    """幂等迁移：为旧库的 images 表补齐 ``kind`` 及视频元数据列。

    新库（SCHEMA 已含这些列）→ no-op；旧库 → ALTER TABLE 逐列补上。
    ``kind`` 默认 'image'，保证迁移后存量图片不被误判为视频。
    """
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(images)").fetchall()}
    added = {
        "kind": "TEXT NOT NULL DEFAULT 'image'",
        "duration_seconds": "REAL",
        "video_codec": "TEXT",
        "audio_codec": "TEXT",
        "fps": "REAL",
        "cover_path": "TEXT",
    }
    for name, ddl in added.items():
        if name not in cols:
            conn.execute(f"ALTER TABLE images ADD COLUMN {name} {ddl}")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_images_kind ON images(kind)")

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
        # 注意是 excluded.value：光写 excluded 是表名，SQLite 会报 no such column
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, str(value)),
    )
