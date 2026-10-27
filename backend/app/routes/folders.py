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
    from collections import Counter
    from pathlib import Path
    from ..indexer import get_indexer
    from .. import texts
    indexer = get_indexer()
    with indexer._live_lock:
        folder_storage.sync_user_folders(indexer)
        # 老库里来源目录根上没有节点（只有摊平的一级子目录），在这里顺手自愈一次；
        # 磁盘没插盘之类的失败在函数内部逐条吞掉，不能把「读侧栏」搞成 500。
        repository.ensure_source_root_folders([*indexer.config.watch_dirs, *texts.root_paths()])
        tree = repository.folder_tree()
    # 文本计数：每篇文本给自己的各级父目录各记一次，节点查表即得「本目录及子目录内文本数」。
    # 旧实现是每个节点重扫一遍全部文本，文件一多就线性放大。
    # texts.path 存反斜杠、folders.path 存正斜杠，两边都归一后再比对。
    def key(p: Path) -> str:
        return str(p).replace("\\", "/").rstrip("/").casefold()

    text_counts: Counter[str] = Counter()
    for row in texts.conn().execute('SELECT path FROM texts WHERE missing=0'):
        directory = Path(row['path']).parent
        for ancestor in (directory, *directory.parents):
            text_counts[key(ancestor)] += 1

    def enrich(nodes):
        for node in nodes:
            counts = node['counts']
            counts['text'] = text_counts[key(Path(node['path']))] if node.get('path') else 0
            node['total'] = sum(counts.values())
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
async def update_folder(folder_id: int, payload: FolderUpdate):
    if repository.is_system_folder(folder_id) and "parent_id" in payload.model_fields_set:
        raise HTTPException(400, "来源文件夹不可改变层级；可修改显示名称和排序")
    try:
        if payload.name is not None and payload.order is None and "parent_id" not in payload.model_fields_set:
            # 改名不再动磁盘：来源目录是外部程序在写的目录（ComfyUI 的 output、素材盘），
            # 图库没有权利替它改名；我的文件夹改名仍会同步物理目录（在 rename_folder 里）。
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
    """Recycle the physical directory before removing its index entries."""
    from pathlib import Path
    from .. import texts
    from ..config import data_dir
    from ..indexer import get_indexer

    indexer = get_indexer()
    with indexer._live_lock, texts.LOCK:
        conn = repository.get_pool().main()
        row = conn.execute('SELECT path FROM folders WHERE id=?', (folder_id,)).fetchone()
        if not row:
            raise HTTPException(404, '文件夹不存在')
        if not row['path']:
            raise HTTPException(400, '此旧分类没有磁盘目录，请先打开所在文件夹确认位置')
        raw = Path(row['path'])
        try:
            directory = raw.resolve()
            if (not raw.is_absolute() or raw.is_symlink() or
                    (hasattr(raw, 'is_junction') and raw.is_junction()) or
                    directory == Path(directory.anchor) or data_dir().resolve().is_relative_to(directory) or
                    directory == (data_dir() / 'folders').resolve()):
                raise ValueError('不能删除磁盘根目录、图库数据目录或目录链接')
            try:
                directory.stat()
            except FileNotFoundError:
                raise ValueError('目录不存在，请检查磁盘连接后重试')
            if not directory.is_dir():
                raise ValueError('目标不是文件夹')
            images = [Path(r['path']) for r in conn.execute('SELECT path FROM images')
                      if Path(r['path']).resolve().is_relative_to(directory)]
            documents = [r['id'] for r in texts.conn().execute('SELECT id, path FROM texts')
                         if Path(r['path']).resolve().is_relative_to(directory)]
            texts.recycle_file(directory)
        except (ValueError, OSError) as e:
            raise HTTPException(400, f'移入回收站失败：{e}') from e
        for path in images:
            event = indexer._process_path_sync(path, remove=True)
            if event:
                indexer.emit_event_sync(event)
        for text_id in documents:
            texts.conn().execute('UPDATE texts SET missing=1 WHERE id=?', (text_id,))
            texts.conn().execute('DELETE FROM texts_fts WHERE rowid=?', (text_id,))
        repository.folder_delete(folder_id)
        return {'ok': True, 'removed_disk': True, 'recycled': True}


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
