"""repository 路由层测试：thumb_url cache-bust。"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from app import db
from app.config import thumbs_dir
from app.repository import thumb_url_for


def test_thumb_url_includes_version_when_ready(tmp_path: Path, tmp_data_dir):
    """thumb_url_for 必须在 ready 时带 ?v={mtime} 防止浏览器缓存老图。"""
    db.init_pool()
    # 写一个真实 thumb 文件
    thumb = thumbs_dir() / "999.webp"
    thumb.write_bytes(b"fake")
    url = thumb_url_for(999, str(thumb), "ready")
    assert url is not None
    assert url.startswith("/thumbs/999.webp?v=")
    # mtime = 同一文件，应该有非零整数
    v = int(url.split("=")[1])
    expected = int(os.path.getmtime(thumb))
    assert v == expected


def test_thumb_url_none_when_not_ready(tmp_data_dir):
    """未就绪时返回 None，前端用 '无缩略图' 占位。"""
    db.init_pool()
    assert thumb_url_for(999, "data/thumbs/999.webp", "pending") is None
    assert thumb_url_for(999, "data/thumbs/999.webp", "failed") is None


def test_thumb_url_zero_when_file_missing(tmp_data_dir):
    """thumb_path 指向不存在的文件时回退 v=0（前端不应加载，但保证 URL 不 crash）。"""
    db.init_pool()
    url = thumb_url_for(123, "data/thumbs/missing.webp", "ready")
    assert url is not None
    assert url.endswith("?v=0")


def test_thumb_url_zero_when_path_empty(tmp_data_dir):
    db.init_pool()
    assert thumb_url_for(123, None, "ready") == "/thumbs/123.webp?v=0"
    assert thumb_url_for(123, "", "ready") == "/thumbs/123.webp?v=0"


def test_thumb_url_changes_when_file_rewritten(tmp_path: Path, tmp_data_dir):
    """核心场景：重建缩略图后，URL 应当变化，让浏览器别拿缓存。"""
    db.init_pool()
    thumb = thumbs_dir() / "777.webp"
    thumb.write_bytes(b"v1")
    u1 = thumb_url_for(777, str(thumb), "ready")
    # 模拟 rebuild：覆写文件
    import time; time.sleep(1.1)
    thumb.write_bytes(b"v2")
    u2 = thumb_url_for(777, str(thumb), "ready")
    assert u1 != u2, "重建后 URL 必须变化以 bust cache"
