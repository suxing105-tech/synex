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
import os
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .config import db_path

logger = logging.getLogger(__name__)

# 收藏列删除前的一次性备份目录名（唯一回滚手段，存在即不再备份）
PRE_FAVORITE_DROP_DIR = "pre-0.2.21"
# 路径写法统一 + 同文件重复行合并前的一次性备份目录名
PRE_PATH_DEDUPE_DIR = "pre-0.2.33"


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
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    indexed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_images_mtime ON images(mtime DESC);
CREATE INDEX IF NOT EXISTS idx_images_seed ON images(seed);
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_system INTEGER NOT NULL DEFAULT 0,
    path TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
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
            from .clone_templates import initialize as initialize_clone_templates
            initialize_clone_templates(self._main)
            from .clone_sources import initialize as initialize_clone_sources
            initialize_clone_sources(self._main)
            migrate_system_folders(self._main)
            migrate_media_kind(self._main)
            migrate_drop_favorite(self._main, self.path)
            # 改名接口写坏的 path：统一写法并把同一个文件的重复索引行并成一行，
            # 不然那张多出来的缩略图会一直挂在网格里。坏了只吵日志，不拦启动。
            try:
                migrate_image_path_identity(self._main, self.path)
            except sqlite3.Error as exc:
                logger.warning("图片索引路径整理没跑成，重复缩略图可能要手动清理：%s", exc)
            # 搜索索引必须在任何线程写 images 之前修好：老库的 contentless 索引是坏过的
            # （见 migrate_fts），而触发器也依赖 images_fts 存在。
            try:
                migrate_fts(self._main)
                ensure_fts_triggers(self._main)
            except sqlite3.Error as exc:
                logger.warning("搜索索引维护失败，搜索将退回模糊匹配：%s", exc)
            # 内置的「一键同款」工作流：新库装上、老库认领同名的、用户改过的不覆盖。
            # 放在这里而不是启动接口里，命令行工具打开同一个库也能拿到同一份结果。
            # 建库不该被资源文件的问题拖住，所以坏了只吵日志。
            try:
                from .clone_bundled import seed as seed_bundled_templates
                seed_bundled_templates(self._main)
            except Exception as exc:  # noqa: BLE001 - 内置模板缺失不该让图库打不开
                logger.warning("内置一键同款工作流装载失败：%s", exc)
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
    if "archived" not in cols:
        # 归档 = 图库里不再显示这个目录及其素材，磁盘上一律不动（见 routes/folders.py）。
        conn.execute("ALTER TABLE folders ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
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
    conn.execute("CREATE INDEX IF NOT EXISTS idx_folders_archived ON folders(archived)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_folders_is_system ON folders(is_system)")


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


def backup_database(conn: sqlite3.Connection, db_path: Path, dirname: str) -> Path | None:
    """动数据之前的一次性备份：备份已存在就不覆盖、也不再重复备份。

    走 sqlite3 的在线备份 API，WAL 模式下也能拿到一致快照。
    """
    target_dir = db_path.parent / "backup" / dirname
    target = target_dir / db_path.name
    if target.exists():
        return None
    target_dir.mkdir(parents=True, exist_ok=True)
    # 先写临时名再原子改名：半途失败的残文件不能让「备份已存在」的判断成立
    temp = target_dir / (target.name + ".tmp")
    try:
        dst = sqlite3.connect(temp)
        try:
            conn.backup(dst)
            dst.commit()
        finally:
            dst.close()
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)
    logger.info("改动数据库前已备份到 %s", target)
    return target


def backup_before_drop_favorite(conn: sqlite3.Connection, db_path: Path) -> Path | None:
    return backup_database(conn, db_path, PRE_FAVORITE_DROP_DIR)


def migrate_drop_favorite(conn: sqlite3.Connection, db_path: Path | None = None) -> bool:
    """幂等迁移：收藏功能整体移除后，删掉 images / texts 残留的 favorite 列。

    依赖该列的索引必须先删，否则 SQLite 拒绝 DROP COLUMN。
    真正动列前强制备份一次（唯一回滚手段）；备份失败就跳过迁移而不是硬删。
    SQLite 不支持 DROP COLUMN 时只记 warning：列残留不影响功能，不能因此启动失败。
    """
    tables = ("images", "texts")

    def columns(table: str) -> set[str]:
        return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}

    if not any("favorite" in columns(table) for table in tables):
        return False
    conn.execute("DROP INDEX IF EXISTS idx_images_favorite")
    if db_path is not None:
        try:
            backup_before_drop_favorite(conn, db_path)
        except sqlite3.Error as exc:
            logger.warning("删除收藏列前的数据库备份失败，本次跳过该迁移：%s", exc)
            return False
    dropped = False
    for table in tables:
        if "favorite" not in columns(table):
            continue
        try:
            conn.execute(f"ALTER TABLE {table} DROP COLUMN favorite")
            dropped = True
        except sqlite3.OperationalError as exc:
            logger.warning("%s.favorite 列删除失败（不影响功能）：%s", table, exc)
    conn.commit()
    return dropped


def _slashes(path: str) -> str:
    """images.path 全站唯一写法：绝对路径 + 正斜杠（索引与「移动到文件夹」都写它）。"""
    return str(path).replace("\\", "/")


def _repoint_image(conn: sqlite3.Connection, loser: int, keep: int) -> None:
    """把挂在 loser 上的关联整条搬到 keep，别让「并成一行」顺手删掉标签和反推。"""
    conn.execute(
        "INSERT OR IGNORE INTO image_tags(image_id, tag_id)"
        " SELECT ?, tag_id FROM image_tags WHERE image_id = ?",
        (keep, loser),
    )
    conn.execute("DELETE FROM image_tags WHERE image_id = ?", (loser,))
    conn.execute(
        "INSERT OR IGNORE INTO image_folders(image_id, folder_id)"
        " SELECT ?, folder_id FROM image_folders WHERE image_id = ?",
        (keep, loser),
    )
    conn.execute("DELETE FROM image_folders WHERE image_id = ?", (loser,))
    conn.execute("UPDATE reverse_prompts SET image_id = ? WHERE image_id = ?", (keep, loser))
    conn.execute("UPDATE video_prompt_runs SET video_id = ? WHERE video_id = ?", (keep, loser))
    # clone_sources.image_id 是主键：keep 自己有来源就丢 loser 那份，否则整条搬过去
    if conn.execute("SELECT 1 FROM clone_sources WHERE image_id = ?", (keep,)).fetchone():
        conn.execute("DELETE FROM clone_sources WHERE image_id = ?", (loser,))
    else:
        conn.execute("UPDATE clone_sources SET image_id = ? WHERE image_id = ?", (keep, loser))
    conn.execute(
        "UPDATE clone_sources SET source_image_id = ? WHERE source_image_id = ?", (keep, loser)
    )


def migrate_image_path_identity(conn: sqlite3.Connection, db_path: Path | None = None) -> dict:
    """幂等迁移：images.path 统一成正斜杠写法，并把同一个文件的重复索引行并成一行。

    重复行怎么来的：改名接口一度把 path 写成反斜杠形式（v0.2.32 及以前）。path 上那个
    UNIQUE 只比字符串、不比这两个字符串指的是不是同一个文件，于是同一个文件留下两行，
    网格里就是两张一模一样的缩略图。这里把老写法改回全站那一种，重复的并成一行——
    标签、所属文件夹、反推提示词、一键同款来源、视频提示词记录都跟到留下来的那一行上。

    合并只删「和另一行指向同一个文件」的索引行，图片文件本身一个都不动。
    动数据前强制备份一次（唯一回滚手段）；备份失败就跳过迁移。
    返回 {"rewritten": n, "merged": n}，两个 0 表示这个库本来就是干净的。
    """
    rows = conn.execute("SELECT id, path FROM images ORDER BY id").fetchall()
    paths = {r["id"]: r["path"] for r in rows}
    groups: dict[str, list[int]] = {}
    for r in rows:
        groups.setdefault(_slashes(r["path"]), []).append(r["id"])
    dupes = {k: v for k, v in groups.items() if len(v) > 1}
    stale = [i for i, path in paths.items() if path != _slashes(path)]
    if not dupes and not stale:
        return {"rewritten": 0, "merged": 0}
    if db_path is not None:
        try:
            backup_database(conn, db_path, PRE_PATH_DEDUPE_DIR)
        except sqlite3.Error as exc:
            logger.warning("统一图片路径前的数据库备份失败，本次跳过该迁移：%s", exc)
            return {"rewritten": 0, "merged": 0}

    merged = 0
    conn.execute("BEGIN")
    try:
        for key, ids in dupes.items():
            # 已经是标准写法的那一行留下（它的键本来就对），否则留 id 最小的
            keep = min((i for i in ids if paths[i] == key), default=min(ids))
            for loser in sorted(ids):
                if loser == keep:
                    continue
                _repoint_image(conn, loser, keep)
                conn.execute("DELETE FROM images WHERE id = ?", (loser,))
                merged += 1
        rewritten = 0
        for image_id in stale:
            if image_id not in paths or not conn.execute(
                "SELECT 1 FROM images WHERE id = ?", (image_id,)
            ).fetchone():
                continue  # 这一行刚被并进别的行了
            conn.execute(
                "UPDATE images SET path = ? WHERE id = ?", (_slashes(paths[image_id]), image_id)
            )
            rewritten += 1
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    if merged or rewritten:
        logger.info("图片索引路径已整理：改写 %d 行，合并重复 %d 行", rewritten, merged)
    return {"rewritten": rewritten, "merged": merged}


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
