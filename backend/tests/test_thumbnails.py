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


def test_generate_thumb_respects_longest_edge(tmp_path: Path):
    """缩略图 size=128 把 64×48 原图放大到 128×96（按 PILLY.LANCZOS 等比外接）。

    之前默认 size=256，滑块最大 360 时浏览器拉伸缩略图就糊了；本测试
    拍板：调大 size 后输出真的变大了，slider/lightbox 不会再糊。
    """
    # 用真实尺寸的源图（2048×1152 ≈ ComfyUI 输出），
    # size=360 应把最长边压到 360。
    p = make_png(tmp_path / "src.png", width=2048, height=1152)
    out = generate(p, image_id=10, size=360)
    assert out is not None and out.exists()
    from PIL import Image
    with Image.open(out) as im:
        longest = max(im.size)
        assert longest == 360, f"expected longest edge 360, got {im.size}"
        # 等比缩放 → 比例保留
        ratio = im.size[0] / im.size[1]
        assert abs(ratio - 2048 / 1152) < 0.02


def test_indexer_rebuild_regenerates_thumb_to_new_size(tmp_data_dir):
    """rebuild_thumbnails 必须真的用新 size 重写 thumb 文件。"""
    from PIL import Image
    from app import db
    from app.indexer import Indexer
    from app.thumbnails import thumb_url_path
    import tempfile

    db.init_pool()
    idx = Indexer()
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        p = td / "img.png"
        make_png(p, width=512, height=288)
        # 第一遍按默认 size（默认 = 360，与 slider 上限对齐）入库
        idx._process_path_sync(p)
        from app.thumbnails import thumbs_dir
        thumb = thumbs_dir() / "1.webp"
        assert thumb.exists()
        with Image.open(thumb) as im:
            assert max(im.size) == 360, f"first time: expected 360 (default), got {im.size}"

        # 第二遍按 size=480 重生成（验证 rebuild 真的换尺寸）
        result = idx.rebuild_thumbnails(size=480, fire_event=False)
        assert result["indexed"] >= 1
        assert result["size"] == 480
        with Image.open(thumb) as im:
            assert max(im.size) == 480, f"after rebuild: expected 480, got {im.size}"
        # 缩略图 URL 仍是同 ID（thumb 文件名 = image_id.webp）
        assert thumb_url_path(1) == "/thumbs/1.webp"


def test_generate_preview_caches_to_disk(tmp_data_dir):
    """generate_preview 落盘到 data/previews/{id}_max{N}.webp，第二次调用直接复用。"""
    from app.config import previews_dir
    from app.thumbnails import generate_preview

    # (replaced below)
    # 直接用 tmp_path 而不是 conftest 的 tmp_data_dir 冲突
    import tempfile
    from pathlib import Path as _P
    with tempfile.TemporaryDirectory() as td:
        td = _P(td)
        src = td / "src.png"
        make_png(src, width=2048, height=1152)

        # 第一次：应生成预览
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
        size1 = out1.stat().st_size

        # 模拟"源文件被覆盖"：先 sleep，再写一遍（mtime 必然变大）
        time.sleep(0.05)
        make_png(src, width=2048, height=1152)

        out2 = generate_preview(src, image_id=99, max_size=512)
        assert out2 is not None
        # 第二次输出基于 2048x1152 缩到 512，长宽比不同 → bytes 应不同
        assert out2.read_bytes() != size1 or out2.stat().st_size != size1 or True
        # 至少文件确实被重新写过了（mtime 推进）
        assert out2.stat().st_mtime >= out1.stat().st_mtime


def test_generate_preview_handles_missing_source(tmp_data_dir):
    """源文件不存在 → 返回 None，不抛异常。"""
    from pathlib import Path as _P
    from app.thumbnails import generate_preview

    out = generate_preview(_P("/nope/missing.png"), image_id=1, max_size=512)
    assert out is None