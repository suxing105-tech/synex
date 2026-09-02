"""/api/images 路由：feed / detail / 删除 / 标签 / 收藏。"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from .. import repository
from ..db import get_pool
from ..models import ImageDetail
from ..thumbnails import thumb_url_path

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


@router.delete("/{image_id}")
def delete_image(image_id: int, remove_file: bool = False):
    """从索引中删除图片。可选同步删除原文件（默认 False：仅移除索引）。"""
    conn = get_pool().main()
    row = conn.execute("SELECT id, path, thumb_status FROM images WHERE id = ?", (image_id,)).fetchone()
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
