"""/api/folders 路由。"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import repository
from ..models import FolderCreate, FolderUpdate

router = APIRouter(prefix="/api/folders", tags=["folders"])


@router.get("")
def list_folders():
    return repository.folder_tree()


@router.post("")
def create_folder(payload: FolderCreate):
    try:
        return repository.folder_create(payload.name, payload.parent_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.patch("/{folder_id}")
def update_folder(folder_id: int, payload: FolderUpdate):
    if repository.is_system_folder(folder_id):
        raise HTTPException(400, "系统文件夹不可重命名")
    try:
        parent_id = payload.parent_id if "parent_id" in payload.model_fields_set else ...
        return repository.folder_update(
            folder_id,
            name=payload.name,
            order=payload.order,
            parent_id=parent_id,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.post("/{folder_id}/move")
def move_folder(folder_id: int, direction: str):
    if direction not in ("up", "down"):
        raise HTTPException(400, "direction 必须为 up 或 down")
    if repository.is_system_folder(folder_id):
        raise HTTPException(400, "系统文件夹不可移动")
    repository.folder_move_order(folder_id, direction)
    return {"ok": True}


@router.delete("/{folder_id}")
def delete_folder(folder_id: int):
    if repository.is_system_folder(folder_id):
        raise HTTPException(400, "系统文件夹不可删除")
    repository.folder_delete(folder_id)
    return {"ok": True}