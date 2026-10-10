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


def generate_preview(
    image_path: Path,
    image_id: int,
    max_size: int | None,
    quality: int = 85,
    crop_aspect: tuple[int, int] | None = None,
) -> Path | None:
    """Cache by source bytes; PSDs are rendered from their merged composite."""
    import hashlib
    import os
    import tempfile
    temp_path = None
    try:
        with image_path.open("rb") as source_file:
            digest = hashlib.file_digest(source_file, "sha256").hexdigest()
        size_key = f"max{max_size}" if max_size is not None else "maxfull"
        if crop_aspect is not None:
            size_key += f"_crop{crop_aspect[0]}x{crop_aspect[1]}"
        out_path = previews_dir() / f"{image_id}_{size_key}_q{quality}_{digest}.webp"
        if out_path.exists():
            return out_path
        if image_path.suffix.lower() == ".psd":
            from psd_tools import PSDImage

            with image_path.open("rb") as source_file:
                psd = PSDImage.open(source_file)
                im = psd.composite()
        else:
            with Image.open(image_path) as source_image:
                im = ImageOps.exif_transpose(source_image).copy()
        try:
            if crop_aspect is not None:
                target_ratio = crop_aspect[0] / crop_aspect[1]
                source_ratio = im.width / im.height
                if source_ratio > target_ratio:
                    crop_width = max(1, round(im.height * target_ratio))
                    left = (im.width - crop_width) // 2
                    cropped = im.crop((left, 0, left + crop_width, im.height))
                    im.close()
                    im = cropped
                elif source_ratio < target_ratio:
                    crop_height = max(1, round(im.width / target_ratio))
                    top = (im.height - crop_height) // 2
                    cropped = im.crop((0, top, im.width, top + crop_height))
                    im.close()
                    im = cropped
            if max_size is not None:
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
        finally:
            im.close()
        with _LOCK:
            if not out_path.exists():
                os.replace(temp_path, out_path)
        return out_path
    except Exception as e:  # noqa: BLE001 - PSD decoders use format-specific exception types
        log.warning("preview failed: %s (max=%s): %s", image_path, max_size, e)
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
                cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
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


# ---------- 视频自定义封面（cover） ----------


def _cover_path(video_id: int) -> Path:
    """自定义封面统一存放在 previews/ 下，文件名固定，便于覆盖与缓存失效。"""
    return previews_dir() / f"{video_id}_cover.webp"


def generate_video_cover(
    video_path: Path, video_id: int, time: float, max_size: int = 1024
) -> Path | None:
    """用 ffmpeg 截取视频指定时刻作为自定义封面，缓存到 ``{video_id}_cover.webp``。

    ``time`` 为秒，小于等于 0 时取首帧。成功返回封面路径，失败返回 ``None``。
    """
    import os
    import tempfile

    out_path = _cover_path(video_id)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=previews_dir(), suffix=".tmp", delete=False
        ) as temp:
            temp_path = Path(temp.name)
        seek = max(0.0, float(time))
        cmd = [
            "ffmpeg",
            "-y",
            "-ss", f"{seek:.3f}",
            "-i", str(video_path),
            "-frames:v", "1",
            "-vf", f"scale='min({max_size},iw)':-2",
            "-q:v", "2",
            "-f", "webp",
            str(temp_path),
        ]
        proc = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
        )
        if proc.returncode != 0 or not temp_path.exists() or temp_path.stat().st_size == 0:
            return None
        with _LOCK:
            os.replace(temp_path, out_path)
        return out_path
    except (OSError, subprocess.SubprocessError):
        return None
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def save_video_cover_image(image_bytes: bytes, video_id: int, max_size: int = 1024) -> Path | None:
    """把上传的图片另存为视频自定义封面（统一转 WebP）。失败返回 ``None``。"""
    import os
    import tempfile

    out_path = _cover_path(video_id)
    temp_path = None
    try:
        with Image.open(io.BytesIO(image_bytes)) as im:
            im = ImageOps.exif_transpose(im)
            im.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGB")
            elif im.mode == "RGBA":
                bg = Image.new("RGB", im.size, (18, 18, 20))
                bg.paste(im, mask=im.split()[3])
                im = bg
            with tempfile.NamedTemporaryFile(
                dir=previews_dir(), suffix=".tmp", delete=False
            ) as temp:
                temp_path = Path(temp.name)
                im.save(temp, format="WEBP", quality=90, method=4)
        with _LOCK:
            os.replace(temp_path, out_path)
        return out_path
    except (UnidentifiedImageError, OSError, ValueError):
        return None
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def remove_video_cover(video_id: int) -> None:
    """删除自定义封面文件（数据库字段由路由层清空）。"""
    try:
        _cover_path(video_id).unlink(missing_ok=True)
    except OSError:
        pass
