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
import subprocess
import threading
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from .config import previews_dir

log = logging.getLogger(__name__)

# 解码 Pillow 的 "too large" 警告
Image.MAX_IMAGE_PIXELS = None

_LOCK = threading.Lock()


def generate_preview(image_path: Path, image_id: int, max_size: int, quality: int = 85) -> Path | None:
    """Cache by source bytes, never by image ID or file timestamps alone."""
    import hashlib
    import os
    import tempfile
    temp_path = None
    try:
        source = image_path.read_bytes()
        digest = hashlib.sha256(source).hexdigest()
        out_path = previews_dir() / f"{image_id}_max{max_size}_q{quality}_{digest}.webp"
        if out_path.exists():
            return out_path
        with Image.open(io.BytesIO(source)) as im:
            im = ImageOps.exif_transpose(im)
            im.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGB")
            elif im.mode == "RGBA":
                bg = Image.new("RGB", im.size, (18, 18, 20))
                bg.paste(im, mask=im.split()[3])
                im = bg
            with tempfile.NamedTemporaryFile(dir=out_path.parent, suffix=".tmp", delete=False) as temp:
                temp_path = Path(temp.name)
                im.save(temp, format="WEBP", quality=quality, method=4)
        with _LOCK:
            if not out_path.exists():
                os.replace(temp_path, out_path)
        return out_path
    except (UnidentifiedImageError, OSError) as e:
        log.warning("preview failed: %s (max=%d): %s", image_path, max_size, e)
        return None
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def generate_video_thumbnail(video_path: Path, video_id: int, max_size: int = 1024) -> Path | None:
    """用 ffmpeg 截取视频封面帧，按源文件内容摘要缓存到 ``previews/``。

    输出为 WebP（与图片预览一致），失败返回 ``None``。不会抛异常。
    优先取 ~1s 的帧；若视频过短导致取不到帧，则回退到首帧（``-ss 0``）。
    """
    import hashlib
    import os
    import tempfile

    try:
        source_digest = hashlib.sha256(video_path.read_bytes()).hexdigest()
    except OSError:
        return None
    out_path = previews_dir() / f"{video_id}_poster_{source_digest}.webp"
    if out_path.exists():
        return out_path

    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=previews_dir(), suffix=".tmp", delete=False
        ) as temp:
            temp_path = Path(temp.name)
        # 尝试的 seek 时刻：1s（封面感更好），短则回退首帧
        ok = False
        for seek in ("1", "0"):
            cmd = [
                "ffmpeg",
                "-y",
                "-ss", seek,
                "-i", str(video_path),
                "-frames:v", "1",
                "-vf", f"scale='min({max_size},iw)':-2",
                "-q:v", "4",
                "-f", "webp",
                str(temp_path),
            ]
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=60,
            )
            if proc.returncode == 0 and temp_path.exists() and temp_path.stat().st_size > 0:
                ok = True
                break
        if not ok:
            return None
        with _LOCK:
            if not out_path.exists():
                os.replace(temp_path, out_path)
        return out_path
    except (OSError, subprocess.SubprocessError):
        return None
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
