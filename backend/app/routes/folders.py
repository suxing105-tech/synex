"""/api/folders 路由。"""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import repository
from .. import folder_storage
from ..models import FolderCreate, FolderUpdate, FolderReorder

router = APIRouter(prefix="/api/folders", tags=["folders"])


class DirectoryDrop(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=100)


@router.post('/import-directories')
def import_directories(payload: DirectoryDrop):
    from ..folder_import import copy_directories
    return copy_directories(payload.paths)


@router.get("")
def list_folders():
    from pathlib import Path
    from .. import texts
    tree = repository.folder_tree()
    paths = [Path(r['path']) for r in texts.conn().execute('SELECT path FROM texts WHERE missing=0')]
    def enrich(nodes):
        for node in nodes:
            directory = Path(node['path']).resolve() if node.get('path') else None
            node['text_count'] = sum(p.is_relative_to(directory) for p in paths) if directory else 0
            enrich(node['children'])
    enrich(tree)
    return tree


@router.post("")
def create_folder(payload: FolderCreate):
    try:
        return folder_storage.create_folder(payload.name, payload.parent_id)
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e)) from e


@router.patch("/{folder_id}")
def update_folder(folder_id: int, payload: FolderUpdate):
    if repository.is_system_folder(folder_id) and "parent_id" in payload.model_fields_set:
        raise HTTPException(400, "来源文件夹不可改变层级；可修改显示名称和排序")
    try:
        if payload.name is not None and payload.order is None and "parent_id" not in payload.model_fields_set:
            from ..indexer import get_indexer
            with get_indexer()._live_lock:
                return folder_storage.rename_folder(folder_id, payload.name)
        parent_id = payload.parent_id if "parent_id" in payload.model_fields_set else ...
        return repository.folder_update(
            folder_id,
            name=payload.name,
            order=payload.order,
            parent_id=parent_id,
        )
    except sqlite3.IntegrityError as e:
        raise HTTPException(400, "同级文件夹已存在此名称") from e
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e)) from e


@router.post("/{folder_id}/move")
def move_folder(folder_id: int, direction: str):
    if direction not in ("up", "down"):
        raise HTTPException(400, "direction 必须为 up 或 down")
    repository.folder_move_order(folder_id, direction)
    return {"ok": True}


@router.post("/{folder_id}/reorder")
def reorder_folder(folder_id: int, payload: FolderReorder):
    try:
        from ..indexer import get_indexer
        with get_indexer()._live_lock:
            folder_storage.relocate_folder(folder_id, payload.target_id, payload.position)
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True}


@router.delete("/{folder_id}")
def delete_folder(folder_id: int):
    """删除文件夹。

    - 用户文件夹：仅删除图库归属，磁盘图片保留；
    - 来源目录（system）：目录是磁盘目录的镜像，需连同磁盘目录一并删除，否则索引器会因
      磁盘仍存在而重建。此操作由前端二次确认后调用，属于显式的破坏性操作。
    """
    if repository.is_system_folder(folder_id):
        from .. import texts
        if texts.listing(folder_id=folder_id, limit=1)['total']:
            raise HTTPException(400, '此目录包含已关联文本。请先在全部文本中将原文件移入回收站，避免永久删除正文。')
        import shutil
        from pathlib import Path
        conn = repository.get_pool().main()
        row = conn.execute("SELECT path FROM folders WHERE id = ?", (folder_id,)).fetchone()
        if row and row["path"]:
            p = Path(row["path"])
            if p.is_dir():
                try:
                    shutil.rmtree(p)
                except OSError as e:
                    raise HTTPException(400, f"删除磁盘目录失败：{e}") from e
        repository.folder_delete(folder_id)
        return {"ok": True, "removed_disk": True}
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

    conn = repository.get_pool().main()
    row = conn.execute(
        "SELECT path, is_system FROM folders WHERE id = ?", (folder_id,)
    ).fetchone()
    if not row or not row["path"]:
        raise HTTPException(404, "system folder 不存在或缺少 path")
    p = Path(row["path"])
    if not p.is_dir():
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
