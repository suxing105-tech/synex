"""/api/images 路由：feed / detail / 删除 / 标签 / 收藏。"""
from __future__ import annotations

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
def delete_image(image_id: int, remove_file: bool = False):
    """从索引中删除图片。可选同步删除原文件（默认 False：仅移除索引）。"""
    conn = get_pool().main()
    row = conn.execute("SELECT id, path FROM images WHERE id = ?", (image_id,)).fetchone()
    if not row:
        raise HTTPException(404, "图片不存在")
    path = row["path"]
    from pathlib import Path

    fpath = Path(path)
    if remove_file:
        try:
            fpath.unlink(missing_ok=True)
        except OSError as e:
            raise HTTPException(500, f"删除文件失败: {e}") from e
    conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
    return {"ok": True, "id": image_id, "removed_file": remove_file}


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
    """在操作系统默认文件管理器中高亮显示该图片。

    - Windows: `explorer.exe /select,<path>`
    - macOS:   `open -R <path>`
    - Linux:   `xdg-open <dir>`（多数 FM 不支持高亮单个文件，fallback 打开目录）

    成功 → 200 {ok:true}；文件被移走 → 404；启动管理器失败 → 500。
    """
    import platform
    import subprocess
    from pathlib import Path

    path_str = repository.image_reveal_path(image_id)
    if not path_str:
        raise HTTPException(404, "图片或文件不存在")
    p = Path(path_str)
    system = platform.system().lower()
    try:
        if system == "windows":
            # explorer 必须传 win 路径
            subprocess.Popen(["explorer.exe", f"/select,{p}"])
        elif system == "darwin":
            subprocess.Popen(["open", "-R", str(p)])
        else:
            # Linux/其它：fallback 到打开目录
            subprocess.Popen(["xdg-open", str(p.parent)])
    except (OSError, FileNotFoundError) as e:
        raise HTTPException(500, f"打开文件管理器失败: {e}")
    return {"ok": True, "id": image_id, "path": str(p)}
