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
        # 第一遍按默认 size（256）入库
        idx._process_path_sync(p)
        from app.thumbnails import thumbs_dir
        thumb = thumbs_dir() / "1.webp"
        assert thumb.exists()
        with Image.open(thumb) as im:
            assert max(im.size) == 256, f"first time: expected 256, got {im.size}"

        # 第二遍按 size=384 重生成
        result = idx.rebuild_thumbnails(size=384, fire_event=False)
        assert result["indexed"] >= 1
        assert result["size"] == 384
        with Image.open(thumb) as im:
            assert max(im.size) == 384, f"after rebuild: expected 384, got {im.size}"
        # 缩略图 URL 仍是同 ID（thumb 文件名 = image_id.webp）
        assert thumb_url_path(1) == "/thumbs/1.webp"
