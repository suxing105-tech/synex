"""缩略图生成。

设计：
- 全部缩略图统一为 ``thumb_size`` 像素（默认 256，正方形外接框）。
- 文件名：``<image_id>.webp``，用 WebP 体积小、解码快。
- 失败容错：缩略图失败不影响图片入库，``thumb_status='failed'`` 即可。
- 单线程同步接口：调用方负责调度（扫描时多线程并发生成）。
"""
from __future__ import annotations

import io
import logging
import threading
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from .config import previews_dir, thumbs_dir

log = logging.getLogger(__name__)

# 解码 Pillow 的 "too large" 警告
Image.MAX_IMAGE_PIXELS = None

_LOCK = threading.Lock()


def generate(image_path: Path, image_id: int, size: int = 256, quality: int = 80) -> Path | None:
    """为 ``image_path`` 生成缩略图，返回缩略图绝对路径；失败返回 ``None``。"""
    out_path = thumbs_dir() / f"{image_id}.webp"
    try:
        with Image.open(image_path) as im:
            im = ImageOps.exif_transpose(im)
            im.thumbnail((size, size), Image.Resampling.LANCZOS)
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGB")
            elif im.mode == "RGBA":
                bg = Image.new("RGB", im.size, (18, 18, 20))
                bg.paste(im, mask=im.split()[3])
                im = bg
            buf = io.BytesIO()
            im.save(buf, format="WEBP", quality=quality, method=4)
            data = buf.getvalue()
        with _LOCK:
            out_path.write_bytes(data)
        return out_path
    except (UnidentifiedImageError, OSError) as e:
        log.warning("thumbnail failed: %s (%s)", image_path, e)
        return None


def thumb_url_path(image_id: int) -> str:
    return f"/thumbs/{image_id}.webp"


def generate_preview(image_path: Path, image_id: int, max_size: int, quality: int = 85) -> Path | None:
    """为 ``image_path`` 生成最大边 ``max_size`` 的 WebP 预览，缓存到 ``previews/{id}_max{N}.webp``。

    缓存策略：
    - 缓存路径含 max_size → 不同 size 互不干扰
    - 缓存 mtime < 源文件 mtime → 重生成（源文件被覆盖时自动失效）
    - 命中缓存 → 直接返回，O(1) 不解码原图
    """
    from .config import previews_dir as _pd
    out_path = _pd() / f"{image_id}_max{max_size}.webp"
    try:
        src_stat = image_path.stat()
    except OSError:
        return None
    if out_path.exists():
        try:
            if out_path.stat().st_mtime >= src_stat.st_mtime:
                return out_path
        except OSError:
            pass
    try:
        with Image.open(image_path) as im:
            im = ImageOps.exif_transpose(im)
            im.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGB")
            elif im.mode == "RGBA":
                bg = Image.new("RGB", im.size, (18, 18, 20))
                bg.paste(im, mask=im.split()[3])
                im = bg
            buf = io.BytesIO()
            im.save(buf, format="WEBP", quality=quality, method=4)
            data = buf.getvalue()
        with _LOCK:
            out_path.write_bytes(data)
        return out_path
    except (UnidentifiedImageError, OSError) as e:
        log.warning("preview failed: %s (max=%d): %s", image_path, max_size, e)
        return None