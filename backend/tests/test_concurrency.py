"""并发回归：多线程同时读 main() 不应触发 ``InterfaceError``。"""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.db import get_pool, init_pool


def test_main_returns_thread_local_connection(tmp_data_dir):
    """main() 在同一线程内复用、跨线程必须隔离。"""
    pool = init_pool()
    a = pool.main()
    b = pool.main()
    assert a is b  # 同一线程复用

    other = {}

    def worker():
        other["conn"] = pool.main()

    t = threading.Thread(target=worker)
    t.start()
    t.join()
    assert other["conn"] is not a  # 另一线程独立


def test_concurrent_reads_do_not_raise(tmp_data_dir):
    """多线程同时 SELECT 必须全部成功，不再有 bad parameter or other API misuse。"""
    init_pool()
    pool = get_pool()

    # 先喂点数据，避免空表干扰
    pool.main().executescript(
        "INSERT INTO images(path, filename, size_bytes, mtime) "
        "VALUES ('/x/a.png','a.png',1,1.0),('/x/b.png','b.png',2,2.0)"
    )

    errors: list[BaseException] = []

    def query():
        try:
            rows = pool.main().execute(
                "SELECT id, filename FROM images ORDER BY id"
            ).fetchall()
            assert len(rows) == 2
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    with ThreadPoolExecutor(max_workers=16) as ex:
        for _ in range(64):
            ex.submit(query)

    assert errors == [], f"并发读触发异常: {errors}"
