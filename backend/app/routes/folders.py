"""/api/folders 路由。"""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, HTTPException

from .. import repository
from ..models import FolderCreate, FolderUpdate, FolderReorder

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
    if repository.is_system_folder(folder_id) and "parent_id" in payload.model_fields_set:
        raise HTTPException(400, "来源文件夹不可改变层级；可修改显示名称和排序")
    try:
        parent_id = payload.parent_id if "parent_id" in payload.model_fields_set else ...
        return repository.folder_update(
            folder_id,
            name=payload.name,
            order=payload.order,
            parent_id=parent_id,
        )
    except sqlite3.IntegrityError as e:
        raise HTTPException(400, "同级文件夹已存在此名称") from e
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


@router.post("/{folder_id}/reorder")
def reorder_folder(folder_id: int, payload: FolderReorder):
    try:
        repository.folder_reorder(folder_id, payload.target_id, payload.position)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True}


@router.delete("/{folder_id}")
def delete_folder(folder_id: int):
    if repository.is_system_folder(folder_id):
        raise HTTPException(400, "系统文件夹不可删除")
    repository.folder_delete(folder_id)
    return {"ok": True}


@router.post("/{folder_id}/reveal")
def reveal_folder(folder_id: int):
    """在系统文件管理器中打开 system folder 目录（前端"在文件管理器中打开"用）。

    system folder 的 path 字段存的就是绝对路径，直接 explorer.exe / xdg-open / open 打开。
    user folder 无 on-disk 实体，没有此需求。
    """
    import platform
    import subprocess
    from pathlib import Path

    conn = repository.get_pool()  # uses the imported get_pool from ..db
    row = conn.execute(
        "SELECT path, is_system FROM folders WHERE id = ?", (folder_id,)
    ).fetchone()
    if not row or not row["is_system"] or not row["path"]:
        raise HTTPException(404, "system folder 不存在或缺少 path")
    p = Path(row["path"])
    if not p.exists():
        raise HTTPException(404, f"路径不存在: {p}")
    system = platform.system()
    try:
        if system == "Windows":
            subprocess.Popen(["explorer", str(p)])
        elif system == "Darwin":
            subprocess.Popen(["open", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p)])
    except OSError as e:
        raise HTTPException(500, f"打开目录失败: {e}") from e
    return {"ok": True, "path": str(p), "platform": system}
