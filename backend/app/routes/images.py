"""/api/images 路由：feed / detail / 删除 / 标签 / 收藏。"""
from __future__ import annotations

import os
from fastapi import APIRouter, HTTPException, Query, Request

from .. import repository
from ..db import get_pool
from ..models import ImageDetail


router = APIRouter(prefix="/api/images", tags=["images"])


@router.get("")
def list_images(
    folder_id: int | None = None,
    view: str | None = None,
    q: str | None = None,
    tag: str | None = None,
    model: str | None = None,
    limit: int = Query(default=500, ge=1, le=2000),
    offset: int = Query(default=0, ge=0),
):
    items, total = repository.feed(
        folder_id=folder_id,
        view=view,
        q=q,
        tag=tag,
        model=model,
        limit=limit,
        offset=offset,
    )
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/{image_id}")
def get_image(image_id: int) -> ImageDetail:
    row = repository.image_detail(image_id)
    if not row:
        raise HTTPException(404, "图片不存在")
    return row


@router.get("/{image_id}/file")
def get_original(image_id: int, request: Request, max: int | None = Query(default=None, ge=64, le=4096)):
    """返回原图字节流（Lightbox / Feed 预览用）。

    参数：
    - max: 可选，缩放后最长边（像素）。None/缺省 = 原图。
      例如 max=1024 把图缩到最长边 1024 像素再返回（WebP 编码，落盘缓存到 previews/）。
      feed 用 ?max=1024 拿 ~200KB 预览代替 2-5MB 原图。

    缓存策略：
    - 原图 / 预览一旦落盘基本不变，按 mtime 给 1 年 Cache-Control + ETag/Last-Modified
    - 浏览器再请求时直接 304 不传 body，省流量
    - 文件被覆盖后 mtime 变 → URL ?v= 变 + ETag 变 → 浏览器重新拉
    - 预览缓存命中（同 max_size + 缓存 mtime >= 源 mtime）→ 直接返回，不解码原图
    """
    import email.utils
    from pathlib import Path
    from fastapi.responses import FileResponse, Response
    from ..db import get_pool

    row = get_pool().main().execute(
        "SELECT path, filename, mtime FROM images WHERE id = ?", (image_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "图片不存在")
    p = Path(row["path"])
    if not p.exists():
        raise HTTPException(404, "原文件不存在")
    mtime = float(row["mtime"] or 0.0)
    stat = p.stat()

    # 决定要服务的物理文件：原图 or 预览缓存
    if max is not None:
        from ..thumbnails import generate_preview
        preview_path = generate_preview(p, image_id, max)
        if preview_path is None:
            raise HTTPException(500, "预览生成失败")
        preview_stat = preview_path.stat()
        serve_path = preview_path
        fname_stem = Path(row["filename"]).stem
        serve_filename = f"{fname_stem}_max{max}.webp"
        etag = f'"{int(mtime)}-{stat.st_size}-max{max}-{preview_stat.st_size}"'
        last_modified_dt = email.utils.formatdate(preview_stat.st_mtime, usegmt=True)
    else:
        serve_path = p
        serve_filename = row["filename"]
        etag = f'"{int(mtime)}-{stat.st_size}"'
        last_modified_dt = email.utils.formatdate(mtime, usegmt=True)

    # 304 Not Modified: client 带 If-None-Match 或 If-Modified-Since 来就回 304
    if_none_match = request.headers.get("if-none-match")
    if_modified_since = request.headers.get("if-modified-since")
    if if_none_match == etag or (
        if_modified_since and if_modified_since == last_modified_dt
    ):
        return Response(
            status_code=304,
            headers={
                "ETag": etag,
                "Last-Modified": last_modified_dt,
                "Cache-Control": "public, max-age=31536000, immutable",
            },
        )

    return FileResponse(
        serve_path,
        filename=serve_filename,
        headers={
            "ETag": etag,
            "Last-Modified": last_modified_dt,
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


@router.delete("/{image_id}")
def delete_image(image_id: int, remove_file: bool = True):
    """从数据库删除图片，同时清理磁盘文件 + 缩略图缓存 + 预览缓存。

    - remove_file=True（默认，对应右键菜单"删除图片"）：
        删 DB 行、删原 PNG、删 thumb_path、删 previews/{id}_max*.webp 全部
    - remove_file=False：
        仅删 DB 行 + 清 previews/{id}_max*.webp（保留原文件）

    404 → 图片不存在
    500 → 删除原文件时遇到 OSError
    """
    if not remove_file:
        conn = get_pool().main()
        row = conn.execute("SELECT id FROM images WHERE id = ?", (image_id,)).fetchone()
        if not row:
            raise HTTPException(404, "图片不存在")
        cleaned = 0
        from ..config import previews_dir
        pd = previews_dir()
        if pd.exists():
            for f in pd.glob(f"{image_id}_max*.webp"):
                try:
                    f.unlink()
                    cleaned += 1
                except OSError:
                    pass
        conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
        return {"ok": True, "id": image_id, "removed_file": False, "cleaned_previews": cleaned}

    try:
        result = repository.delete_image_files(image_id)
    except repository.RenameError as e:
        if str(e) == "not_found":
            raise HTTPException(404, "图片不存在")
        raise HTTPException(500, str(e))
    except OSError as e:
        raise HTTPException(500, f"删除文件失败: {e}")
    return {"ok": True, **result}


@router.post("/{image_id}/favorite")
def toggle_favorite(image_id: int, favorite: bool = True):
    repository.set_favorite(image_id, favorite)
    return {"id": image_id, "favorite": favorite}


@router.post("/{image_id}/tags")
def update_tags(image_id: int, payload: dict):
    tags = payload.get("tags", []) or []
    if not repository.image_detail(image_id):
        raise HTTPException(404, "图片不存在")
    cleaned = repository.set_tags(image_id, tags)
    return {"id": image_id, "tags": cleaned}


@router.post("/{image_id}/folder")
def update_folder(image_id: int, payload: dict):
    folder_id = payload.get("folder_id")
    if not repository.image_detail(image_id):
        raise HTTPException(404, "图片不存在")
    if folder_id is not None:
        # 校验文件夹存在
        conn = get_pool().main()
        exists = conn.execute("SELECT id FROM folders WHERE id = ?", (folder_id,)).fetchone()
        if not exists:
            raise HTTPException(404, "文件夹不存在")
    repository.assign_folder(image_id, folder_id)
    return {"id": image_id, "folder_id": folder_id}


@router.patch("/{image_id}/filename")
def rename_image(image_id: int, payload: dict):
    """重命名图片文件 + 更新索引。

    body: { "filename": "<新文件名>" }
    成功 → 200 + 更新后的 ImageSummary
    404 → 图片不存在或原文件已被移走
    400 → 文件名非法
    409 → 同目录已有同名文件
    """
    new_filename = payload.get("filename") if isinstance(payload, dict) else None
    try:
        updated = repository.rename_image(image_id, new_filename or "")
    except repository.RenameError as e:
        msg = str(e)
        if msg == "not_found":
            raise HTTPException(404, "图片不存在")
        if msg == "目标文件已存在":
            raise HTTPException(409, msg)
        raise HTTPException(400, msg)
    return updated


@router.post("/{image_id}/reveal")
def reveal_image(image_id: int):
    """在操作系统默认文件管理器里打开图片所在位置。

    多策略兜底（按顺序尝试）：
    - Windows: explorer /select,path → explorer.exe 父目录 → os.startfile 父目录
    - macOS:   open -R path → open 父目录
    - 其它:    xdg-open 父目录

    即便所有策略失败（headless 容器无 GUI），只要 path 存在就返回 200，
    前端通过 method 字段知道是否真启动了 Shell，避免无意义的 500。
    """
    import logging
    import platform
    import subprocess
    from pathlib import Path

    path_str = repository.image_reveal_path(image_id)
    if not path_str:
        raise HTTPException(404, "图片或文件不存在")
    p = Path(path_str)
    parent = p.parent
    system = platform.system().lower()
    log = logging.getLogger(__name__)

    chosen = ""

    def try_exec(name, fn):
        nonlocal chosen
        if chosen:
            return True
        try:
            fn()
            chosen = name
            return True
        except (OSError, FileNotFoundError, ValueError) as e:
            log.debug("reveal fallback %s failed: %s", name, e)
            return False

    if system == "windows":
        try_exec("explorer-select", lambda: subprocess.Popen(
            ["explorer.exe", f"/select,{p}"], close_fds=True,
        ))
        if not chosen:
            try_exec("explorer-dir", lambda: subprocess.Popen(
                ["explorer.exe", str(parent)], close_fds=True,
            ))
        if not chosen and hasattr(os, "startfile"):
            try_exec("startfile-dir", lambda: os.startfile(str(parent)))
    elif system == "darwin":
        try_exec("open-R", lambda: subprocess.Popen(["open", "-R", str(p)]))
        if not chosen:
            try_exec("open-dir", lambda: subprocess.Popen(["open", str(parent)]))
    else:
        try_exec("xdg-open-dir", lambda: subprocess.Popen(["xdg-open", str(parent)]))

    return {
        "ok": True,
        "id": image_id,
        "path": str(p),
        "method": chosen or "noop",
        "platform": system,
    }


