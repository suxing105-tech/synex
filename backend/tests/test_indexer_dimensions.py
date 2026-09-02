"""indexer 写库必须把 width/height 也存进 DB，且 threadpool 写库无 \"database is locked\"。"""
from __future__ import annotations

import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app import db
from app.indexer import Indexer

sys.path.insert(0, str(Path(__file__).parent))
from conftest import make_png  # noqa: E402


def test_indexer_writes_width_and_height(tmp_data_dir):
    """单图入库应能查到 width / height。"""
    db.init_pool()
    idx = Indexer()
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "img.png"
        make_png(p, width=2048, height=1024)
        idx._process_path_sync(p)
        row = db.get_pool().main().execute(
            "SELECT width, height FROM images WHERE path = ?", (str(p).replace("\\", "/"),)
        ).fetchone()
    assert row is not None, "image row missing"
    assert row["width"] == 2048
    assert row["height"] == 1024


def test_indexer_concurrent_scan_does_not_lock(tmp_data_dir):
    """多线程并发索引不能撞 \"database is locked\"——write_lock 串行化所有写。"""
    db.init_pool()
    idx = Indexer()
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        for i in range(20):
            make_png(td / f"img_{i:02d}.png", width=512 + i, height=512)
        # 用 ThreadPoolExecutor 并发调 _process_path_sync
        files = sorted(td.glob("*.png"))
        with ThreadPoolExecutor(max_workers=8) as ex:
            list(ex.map(idx._process_path_sync, files))
        c = db.get_pool().main()
        n = c.execute("SELECT COUNT(*) AS c FROM images").fetchone()["c"]
        assert n == 20
        # 任一行都有尺寸
        none_count = c.execute(
            "SELECT COUNT(*) AS c FROM images WHERE width IS NULL OR height IS NULL"
        ).fetchone()["c"]
        assert none_count == 0, f"{none_count} rows missing width/height"
