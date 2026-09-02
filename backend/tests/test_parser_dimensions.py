"""图片尺寸解析测试。"""
from __future__ import annotations

from pathlib import Path

from app.parser import parse_metadata

from .conftest import make_png


def test_parse_png_returns_dimensions(tmp_path: Path):
    """PNG 解析应返回 width / height。"""
    p = tmp_path / "img.png"
    make_png(p, width=1024, height=768)
    meta = parse_metadata(p)
    assert meta["width"] == 1024
    assert meta["height"] == 768


def test_parse_png_unknown_size_returns_none(tmp_path: Path):
    """非 PNG 字节应让 dimensions 退到 None，不抛异常。"""
    p = tmp_path / "img.jpg"
    p.write_bytes(b"not a real jpeg either")
    meta = parse_metadata(p)
    assert meta["width"] is None
    assert meta["height"] is None
    # 其他字段仍正常
    assert meta["filename"] == "img.jpg"
    assert meta["seed"] is None
