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

from . import media_tools
from .config import previews_dir

log = logging.getLogger(__name__)

# 解码 Pillow 的 "too large" 警告
Image.MAX_IMAGE_PIXELS = None

_LOCK = threading.Lock()

# 海报帧是「一张静态图」，编码质量必须按静态图定，不能按视频流那一套给个位数。
# 0.2.32 之前这里传的是 ``-q:v 4``：libwebp 把这个值当 0-100 的质量档，于是所有海报
# 一直在用 4/100 编码 —— 用户反馈的「缩略图比播放时糊」就是它。同一帧（1024 宽）对
# 无损参考帧实测亮度 PSNR：q4 34.6dB / q85 42.6dB / q90 43.4dB（294 号视频），
# q90 比 q4 大 5 倍体积、代价 0.1s 编码时间，本地读取不构成代价。
# 缩放顺手改成 lanczos，与 Pillow 图片预览的 LANCZOS 同一套重采样。
POSTER_QUALITY = "90"
POSTER_SCALE_FLAGS = "lanczos"


def poster_webp_args() -> list[str]:
    """海报帧与自定义封面共用的 WebP 编码参数（一处定口径，别再各写一份）。"""
    return ["-q:v", POSTER_QUALITY, "-compression_level", "6"]


def poster_scale_filter(max_size: int) -> str:
    """只缩不放：源比 max_size 窄时保持原尺寸，避免 upscale 变糊。"""
    return f"scale='min({max_size},iw)':-2:flags={POSTER_SCALE_FLAGS}"


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


def generate_audio_waveform(
    audio_path: Path, audio_id: int, width: int = 840, height: int = 360
) -> Path | None:
    """用 ffmpeg 生成音频波形图（showwavespic），缓存到 ``previews/``。

    只在波形第一次进入视口时按需生成，不参与扫描；失败返回 ``None``，
    Feed 卡片回退成音符图形。缓存键用 id + 尺寸 + 源文件 mtime/大小
    （音频动辄几十 MB，不整份哈希）。不会抛异常。
    """
    import os
    import tempfile

    try:
        stat = audio_path.stat()
    except OSError:
        return None
    out_path = (
        previews_dir()
        / f"{audio_id}_wave_{width}x{height}_{int(stat.st_mtime)}_{stat.st_size}.png"
    )
    if out_path.exists():
        return out_path

    # 波形只画中间约 55% 高的一条，再补透明边到请求尺寸：卡片是 21:9（840x360），
    # 直接 showwavespic 会让波形铺满整张卡糊成一块红，上下留白才像缩略图。
    wave_height = max(32, round(height * 0.55))
    pad_y = (height - wave_height) // 2

    temp_path = None
    try:
        # 后缀必须是 .png：ffmpeg 按扩展名挑封装器，.tmp 会直接报未知格式
        with tempfile.NamedTemporaryFile(
            dir=previews_dir(), suffix="_wave.png", delete=False
        ) as temp:
            temp_path = Path(temp.name)
        proc = subprocess.run(
            [
                *media_tools.ffmpeg_cmd(),
                "-y",
                "-i", str(audio_path),
                "-filter_complex",
                f"showwavespic=s={width}x{wave_height}:colors=#f24e4e,"
                f"pad={width}:{height}:0:{pad_y}:color=0x00000000",
                "-frames:v", "1",
                "-pix_fmt", "rgba",
                str(temp_path),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
        )
        if proc.returncode != 0 or not temp_path.exists() or temp_path.stat().st_size == 0:
            log.warning("波形生成失败：%s", audio_path)
            return None
        with _LOCK:
            if not out_path.exists():
                os.replace(temp_path, out_path)
        return out_path
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("波形生成异常：%s (%s)", audio_path, exc)
        return None
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def generate_video_thumbnail(video_path: Path, video_id: int, max_size: int = 1024) -> Path | None:
    """用 ffmpeg 截取视频封面帧，按「质量档 + 源文件内容摘要」缓存到 ``previews/``。

    输出为 WebP（与图片预览一致），失败返回 ``None``。不会抛异常。
    优先取 ~1s 的帧；若视频过短导致取不到帧，则回退到首帧（``-ss 0``）。

    缓存名里带 ``q{POSTER_QUALITY}``：换质量升级时老海报自然失效重做，
    不然同一个源摘要会永远命中那张 4/100 质量的旧文件。
    """
    import hashlib
    import os
    import tempfile

    try:
        # 流式哈希：视频动辄几百 MB，read_bytes() 会一次性把它读进内存。
        with video_path.open("rb") as source_file:
            source_digest = hashlib.file_digest(source_file, "sha256").hexdigest()
    except OSError:
        return None
    out_path = previews_dir() / f"{video_id}_poster_q{POSTER_QUALITY}_{source_digest}.webp"
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
                *media_tools.ffmpeg_cmd(),
                "-y",
                "-ss", seek,
                "-i", str(video_path),
                "-frames:v", "1",
                "-vf", poster_scale_filter(max_size),
                *poster_webp_args(),
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
            *media_tools.ffmpeg_cmd(),
            "-y",
            "-ss", f"{seek:.3f}",
            "-i", str(video_path),
            "-frames:v", "1",
            "-vf", poster_scale_filter(max_size),
            *poster_webp_args(),
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
