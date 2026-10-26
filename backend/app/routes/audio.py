"""/api/audio 路由：音频原文件（Range 分段）/ 波形图 / 系统播放器打开。"""
from __future__ import annotations

import mimetypes
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response

from ..db import get_pool
from ..thumbnails import generate_audio_waveform

router = APIRouter(prefix="/api/audio", tags=["audio"])

# 容器扩展名 → Content-Type（回退 mimetypes 猜测）
_EXT_MIME = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".opus": "audio/opus",
    ".ogg": "audio/ogg",
}


def _row(audio_id: int):
    row = get_pool().main().execute(
        "SELECT id, path, filename, mtime, size_bytes FROM images WHERE id = ? AND kind = 'audio'",
        (audio_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "音频不存在")
    return row


@router.get("/{audio_id}/file")
def get_audio_file(audio_id: int, request: Request):
    """返回音频原文件字节流，支持 Range 分段（播放条拖进度条要 206）。"""
    import email.utils

    row = _row(audio_id)
    p = Path(row["path"])
    if not p.exists():
        raise HTTPException(404, "音频文件不存在")
    stat = p.stat()
    etag = f'"{int(row["mtime"] or 0)}-{stat.st_size}"'
    last_modified = email.utils.formatdate(stat.st_mtime, usegmt=True)
    headers = {
        "ETag": etag,
        "Last-Modified": last_modified,
        "Cache-Control": "private, no-cache",
        "Accept-Ranges": "bytes",
    }
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    mime = _EXT_MIME.get(p.suffix.lower()) or mimetypes.guess_type(p.name)[0] or "audio/mpeg"

    range_header = request.headers.get("range")
    first, _, last = (range_header or "").partition("=")[2].partition("-")
    # 没有 Range 或整份请求（bytes=0-）都直接回整文件，省掉把整个音频读进内存
    if range_header and (first or last):
        try:
            start = int(first) if first else 0
            end = int(last) if last else stat.st_size - 1
        except ValueError:
            raise HTTPException(416, "Range 头格式不正确")
        start = max(0, start)
        end = min(end, stat.st_size - 1)
        if start > end:
            return Response(
                status_code=416,
                headers={**headers, "Content-Range": f"bytes */{stat.st_size}"},
            )
        with p.open("rb") as f:
            f.seek(start)
            body = f.read(end - start + 1)
        return Response(
            content=body,
            status_code=206,
            media_type=mime,
            headers={
                **headers,
                "Content-Range": f"bytes {start}-{end}/{stat.st_size}",
                "Content-Length": str(len(body)),
            },
        )
    return FileResponse(p, media_type=mime, filename=row["filename"], headers=headers)


@router.get("/{audio_id}/waveform")
def get_audio_waveform(
    audio_id: int,
    request: Request,
    w: int = Query(default=840, ge=64, le=2048),
    h: int = Query(default=360, ge=32, le=1024),
):
    """返回音频波形图（PNG，透明背景）。ffmpeg 不可用时 404，卡片自行降级。"""
    import email.utils
    import hashlib

    row = _row(audio_id)
    p = Path(row["path"])
    if not p.exists():
        raise HTTPException(404, "音频文件不存在")
    wave_path = generate_audio_waveform(p, audio_id, width=w, height=h)
    if wave_path is None:
        raise HTTPException(404, "波形生成失败")
    digest = hashlib.file_digest(wave_path.open("rb"), "sha256").hexdigest()
    etag = f'"{digest}-{w}x{h}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "private, no-cache"})
    return FileResponse(
        wave_path,
        media_type="image/png",
        headers={
            "ETag": etag,
            "Last-Modified": email.utils.formatdate(wave_path.stat().st_mtime, usegmt=True),
            "Cache-Control": "private, no-cache",
        },
    )


@router.post("/{audio_id}/open")
def open_audio_system(audio_id: int):
    """用系统默认播放器打开音频（WebView 不支持的容器走这里）。"""
    row = _row(audio_id)
    p = Path(row["path"])
    if not p.exists():
        raise HTTPException(404, "音频文件不存在")
    if not hasattr(os, "startfile"):
        raise HTTPException(501, "当前平台不支持用系统播放器打开")
    try:
        os.startfile(str(p))  # type: ignore[attr-defined]
    except OSError as e:
        raise HTTPException(500, f"打开失败：{e}")
    return {"ok": True, "id": audio_id, "path": str(p)}
