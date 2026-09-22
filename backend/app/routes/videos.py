"""/api/videos 路由：视频原文件 / 海报帧 / 系统播放器打开。"""
from __future__ import annotations

import logging
import os
import mimetypes
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response

from ..db import get_pool
from ..thumbnails import generate_video_thumbnail, generate_video_cover, save_video_cover_image

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/videos", tags=["videos"])

# 容器扩展名 → Content-Type（回退 mimetypes 猜测）
_EXT_MIME = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".wmv": "video/x-ms-wmv",
    ".flv": "video/x-flv",
}


def _row(video_id: int):
    row = get_pool().main().execute(
        "SELECT id, path, filename, mtime, size_bytes, cover_path FROM images WHERE id = ? AND kind = 'video'",
        (video_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "视频不存在")
    return row


@router.get("/{video_id}/file")
def get_video_file(video_id: int, request: Request):
    """返回视频原文件字节流，支持 Range 分段（播放器拖动进度条）。"""
    import email.utils
    row = _row(video_id)
    p = Path(row["path"])
    if not p.exists():
        raise HTTPException(404, "视频文件不存在")
    ext = p.suffix.lower()
    mime = _EXT_MIME.get(ext) or mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    stat = p.stat()
    etag = f'"{int(row["mtime"] or 0)}-{stat.st_size}"'
    last_modified_dt = email.utils.formatdate(stat.st_mtime, usegmt=True)
    if request.headers.get("if-none-match") == etag:
        return Response(
            status_code=304,
            headers={
                "ETag": etag,
                "Last-Modified": last_modified_dt,
                "Cache-Control": "private, no-cache",
            },
        )
    return FileResponse(
        p,
        media_type=mime,
        filename=row["filename"],
        content_disposition_type="inline",
        headers={
            "ETag": etag,
            "Last-Modified": last_modified_dt,
            "Cache-Control": "private, no-cache",
            "Accept-Ranges": "bytes",
        },
    )


@router.get("/{video_id}/thumb")
def get_video_thumb(video_id: int, request: Request, max: int | None = Query(default=1024, ge=64, le=4096)):
    """返回视频海报帧（WebP，按源内容摘要缓存）。"""
    import email.utils
    import hashlib
    row = _row(video_id)
    p = Path(row["path"])
    if not p.exists():
        raise HTTPException(404, "视频文件不存在")
    cover = row["cover_path"]
    if cover and Path(cover).exists():
        thumb_path = Path(cover)
    else:
        thumb_path = generate_video_thumbnail(p, video_id, max_size=max)
        if thumb_path is None:
            raise HTTPException(500, "海报生成失败")
    digest = hashlib.file_digest(thumb_path.open("rb"), "sha256").hexdigest()
    etag = f'"{digest}-max{max}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "private, no-cache"})
    return FileResponse(
        thumb_path,
        media_type="image/webp",
        headers={
            "ETag": etag,
            "Last-Modified": email.utils.formatdate(thumb_path.stat().st_mtime, usegmt=True),
            "Cache-Control": "private, no-cache",
        },
    )


@router.post("/{video_id}/open")
def open_video_system(video_id: int):
    """用系统默认播放器打开视频（无法在 App 内播放的容器走这里）。"""
    row = _row(video_id)
    p = Path(row["path"])
    if not p.exists():
        raise HTTPException(404, "视频文件不存在")
    if not hasattr(os, "startfile"):
        raise HTTPException(501, "当前平台不支持用系统播放器打开")
    try:
        os.startfile(str(p))  # type: ignore[attr-defined]
    except OSError as e:
        raise HTTPException(500, f"打开失败：{e}")
    return {"ok": True, "id": video_id, "path": str(p)}



def _set_cover(video_id: int, cover_path: str) -> None:
    get_pool().main().execute(
        "UPDATE images SET cover_path = ? WHERE id = ?", (cover_path, video_id)
    )


def _clear_cover(video_id: int) -> None:
    row = get_pool().main().execute(
        "SELECT cover_path FROM images WHERE id = ?", (video_id,)
    ).fetchone()
    old = row["cover_path"] if row else None
    if old and Path(old).exists():
        try:
            Path(old).unlink()
        except OSError:
            pass
    get_pool().main().execute(
        "UPDATE images SET cover_path = NULL WHERE id = ?", (video_id,)
    )


@router.post("/{video_id}/cover")
def set_video_cover(video_id: int, payload: dict):
    """设置视频封面：``{"time": 秒}`` 截取指定帧，``{"reset": true}`` 恢复默认。"""
    row = _row(video_id)
    p = Path(row["path"])
    if not p.exists():
        raise HTTPException(404, "视频文件不存在")
    if payload.get("reset"):
        _clear_cover(video_id)
        return {"ok": True, "id": video_id, "cover_path": None, "reset": True}
    try:
        time = float(payload.get("time", 0) or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "time 参数无效")
    cover = generate_video_cover(p, video_id, time)
    if cover is None:
        raise HTTPException(500, "封面生成失败")
    _set_cover(video_id, str(cover))
    return {"ok": True, "id": video_id, "cover_path": str(cover)}


@router.post("/{video_id}/cover/upload")
async def upload_video_cover(video_id: int, file: UploadFile = File(...)):
    """上传自定义图片作为视频封面。"""
    row = _row(video_id)
    if not Path(row["path"]).exists():
        raise HTTPException(404, "视频文件不存在")
    data = await file.read()
    if not data:
        raise HTTPException(400, "未读取到图片内容")
    cover = save_video_cover_image(data, video_id)
    if cover is None:
        raise HTTPException(500, "封面保存失败（请上传常见图片格式）")
    _set_cover(video_id, str(cover))
    return {"ok": True, "id": video_id, "cover_path": str(cover)}


@router.post("/{video_id}/copy")
def copy_video_clipboard(video_id: int):
    """把视频文件复制到系统剪贴板（可粘贴到资源管理器等）。"""
    import subprocess
    row = _row(video_id)
    p = Path(row["path"])
    if not p.exists():
        raise HTTPException(404, "视频文件不存在")
    if os.name == "nt":
        env = {**os.environ, "SUXING_COPY_PATH": str(p)}
        cmd = ["powershell", "-NoProfile", "-Command", "Set-Clipboard -LiteralPath $env:SUXING_COPY_PATH"]
        try:
            proc = subprocess.run(
                cmd, env=env, capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=30,
            )
        except (OSError, subprocess.SubprocessError) as e:
            raise HTTPException(500, f"复制失败：{e}")
        if proc.returncode != 0:
            raise HTTPException(500, f"复制失败：{proc.stderr.strip() or '未知错误'}")
        return {"ok": True, "id": video_id, "path": str(p), "method": "clipboard"}
    raise HTTPException(501, "当前平台仅支持在 Windows 上复制视频文件到剪贴板")
