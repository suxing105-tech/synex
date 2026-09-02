"""预览生成测试。"""
from __future__ import annotations

from pathlib import Path

from .conftest import make_png


def test_generate_preview_caches_to_disk(tmp_data_dir):
    """generate_preview 落盘到 data/previews/{id}_max{N}.webp，第二次调用直接复用。"""
    from app.config import previews_dir
    from app.thumbnails import generate_preview

    import tempfile
    from pathlib import Path as _P
    with tempfile.TemporaryDirectory() as td:
        td = _P(td)
        src = td / "src.png"
        make_png(src, width=2048, height=1152)

        out1 = generate_preview(src, image_id=42, max_size=512)
        assert out1 is not None
        assert out1.exists()
        assert out1.parent == previews_dir()
        assert out1.name == "42_max512.webp"

        from PIL import Image
        with Image.open(out1) as im:
            assert max(im.size) == 512

        # 第二次：mtime 一致，应直接返回缓存（不重新生成 → bytes 不变）
        out2 = generate_preview(src, image_id=42, max_size=512)
        assert out2 is not None
        assert out2.read_bytes() == out1.read_bytes()


def test_generate_preview_regenerates_when_source_newer(tmp_data_dir):
    """源文件被覆盖（mtime 更新）→ 预览重新生成。"""
    import time
    from app.thumbnails import generate_preview

    import tempfile
    from pathlib import Path as _P
    with tempfile.TemporaryDirectory() as td:
        td = _P(td)
        src = td / "src.png"
        make_png(src, width=1024, height=768)
        out1 = generate_preview(src, image_id=99, max_size=512)
        assert out1 is not None

        time.sleep(0.05)
        make_png(src, width=2048, height=1152)

        out2 = generate_preview(src, image_id=99, max_size=512)
        assert out2 is not None
        # 至少文件确实被重新写过了（mtime 推进）
        assert out2.stat().st_mtime >= out1.stat().st_mtime


def test_generate_preview_handles_missing_source(tmp_data_dir):
    """源文件不存在 → 返回 None，不抛异常。"""
    from pathlib import Path as _P
    from app.thumbnails import generate_preview

    out = generate_preview(_P("/nope/missing.png"), image_id=1, max_size=512)
    assert out is None
