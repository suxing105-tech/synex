"""缩略图生成测试。"""
from __future__ import annotations

from pathlib import Path

from app.thumbnails import generate

from .conftest import make_png


def test_generate_thumb_webp(tmp_path: Path):
    p = make_png(tmp_path / "src.png", width=64, height=48)
    out = generate(p, image_id=1, size=32)
    assert out is not None
    assert out.exists()
    assert out.suffix == ".webp"
    # 解码确认是合法图片
    from PIL import Image

    with Image.open(out) as im:
        assert im.size[0] <= 32
        assert im.size[1] <= 32


def test_generate_thumb_handles_missing(tmp_path: Path):
    out = generate(tmp_path / "nope.png", image_id=2)
    assert out is None
