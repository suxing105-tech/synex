"""统一素材流 /api/items：图片 / 视频 / 音频 / 文本混排。"""
from __future__ import annotations

from fastapi import APIRouter, Query

from .. import repository

router = APIRouter(prefix="/api/items", tags=["items"])


@router.get("")
def list_items(
    folder_id: int | None = None,
    q: str | None = None,
    tag: str | None = None,
    kinds: str | None = Query(default=None, description="逗号分隔：image,video,audio,text"),
    sort: str = Query(default="mtime_desc", pattern="^(mtime_desc|name_asc)$"),
    limit: int = Query(default=500, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    wanted = [k.strip() for k in (kinds or "").split(",") if k.strip()] or None
    items, total, counts = repository.unified_feed(
        folder_id=folder_id,
        q=q,
        tag=tag,
        kinds=wanted,
        sort=sort,
        limit=limit,
        offset=offset,
    )
    return {"items": items, "total": total, "counts": counts, "limit": limit, "offset": offset}
