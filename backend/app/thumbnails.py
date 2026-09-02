"""Feed 预览图生成（按需落盘到 ``data/previews/``）。

历史：本模块最初是 thumb 系统的一部分。feed 切到 `?max=1024` 原图预览后，
thumb 系统的所有调用方都已消失（materials/12），整个模块只剩下
``generate_preview()`` 这一条生路在用。

Pillow 的 LANCZOS 重采样 + WebP 编码作为通用工具，函数都集中在这里方便以后
其他用途（比如 grid 子图 / 批量导出）复用。
"""
from __future__ import annotations

import io
import logging
import threading
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from .config import previews_dir

log = logging.getLogger(__name__)

# 解码 Pillow 的 "too large" 警告
Image.MAX_IMAGE_PIXELS = None

_LOCK = threading.Lock()


def generate_preview(image_path: Path, image_id: int, max_size: int, quality: int = 85) -> Path | None:
    """为 ``image_path`` 生成最大边 ``max_size`` 的 WebP 预览，缓存到 ``previews/{id}_max{N}.webp``。

    缓存策略：
    - 缓存路径含 max_size → 不同 size 互不干扰
    - 缓存 mtime < 源文件 mtime → 重生成（源文件被覆盖时自动失效）
    - 命中缓存 → 直接返回，O(1) 不解码原图
    """
    out_path = previews_dir() / f"{image_id}_max{max_size}.webp"
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
