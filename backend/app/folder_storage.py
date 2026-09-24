"""Physical folders owned by this gallery; legacy classifications materialize on use."""
from pathlib import Path
import re

from . import repository
from .config import data_dir, inbox_dir
from .db import get_pool, transaction
from .texts import serialized


def valid_name(name: str) -> str:
    name = name.strip()
    if (not name or len(name) > 64 or name in {'.', '..'} or
            re.search(r'[<>:"/\\|?*\x00-\x1f]', name) or name.endswith(('.', ' ')) or
            name.split('.')[0].upper() in {'CON', 'PRN', 'AUX', 'NUL',
                *(f'COM{i}' for i in range(1, 10)), *(f'LPT{i}' for i in range(1, 10))}):
        raise ValueError('文件夹名称无效，请勿使用路径分隔符或系统保留名称')
    return name


def target_directory(folder_id: int | None) -> Path:
    if folder_id is None:
        return inbox_dir()
    conn = get_pool().main()
    row = conn.execute('SELECT * FROM folders WHERE id=?', (folder_id,)).fetchone()
    if not row:
        raise ValueError('文件夹不存在')
    if row['path']:
        path = Path(row['path'])
        if not path.is_dir():
            raise ValueError('目标目录不存在，请检查所在位置')
        return path
    parent = target_directory(row['parent_id']) if row['parent_id'] else data_dir() / 'folders'
    parent.mkdir(parents=True, exist_ok=True)
    path = parent / valid_name(row['name'])
    if path.exists():
        path = parent / f"{row['name']}_{folder_id}"
    path.mkdir(exist_ok=False)
    conn.execute('UPDATE folders SET path=? WHERE id=?', (repository._normalize_path(path.resolve()), folder_id))
    return path


def create_folder(name: str, parent_id: int | None) -> dict:
    name = valid_name(name)
    parent = target_directory(parent_id) if parent_id else data_dir() / 'folders'
    parent.mkdir(parents=True, exist_ok=True)
    path = parent / name
    if path.exists():
        raise ValueError('同级文件夹已存在此名称')
    path.mkdir()
    is_system = False
    if parent_id is not None:
        prow = get_pool().main().execute('SELECT is_system FROM folders WHERE id=?', (parent_id,)).fetchone()
        if prow and prow['is_system']:
            is_system = True
    try:
        result = repository.folder_create(name, parent_id, is_system=is_system)
        normalized = repository._normalize_path(path.resolve())
        get_pool().main().execute('UPDATE folders SET path=? WHERE id=?', (normalized, result['id']))
        return {**result, 'path': normalized}
    except Exception:
        # Only remove the empty directory created by this operation.
        path.rmdir()
        raise


@serialized
def rename_folder(folder_id: int, name: str) -> dict:
    row = get_pool().main().execute('SELECT * FROM folders WHERE id=?', (folder_id,)).fetchone()
    if not row or not row['path'] or row['is_system']:
        return repository.folder_update(folder_id, name=name)
    name = valid_name(name)
    old = Path(row['path'])
    new = old.with_name(name)
    if old == new:
        return repository.folder_update(folder_id, name=name)
    if new.exists():
        raise ValueError('同级文件夹已存在此名称')
    old.rename(new)
    old_text = repository._normalize_path(old)
    new_text = repository._normalize_path(new)
    try:
        with transaction() as conn:
            for table in ('folders', 'images'):
                conn.execute(f'UPDATE {table} SET path=? || substr(path, ?) WHERE path=? OR substr(path,1,?)=?',
                             (new_text, len(old_text) + 1, old_text, len(old_text) + 1, old_text + '/'))
        result = repository.folder_update(folder_id, name=name)
    except Exception:
        new.rename(old)
        with transaction() as conn:
            for table in ('folders', 'images'):
                conn.execute(f'UPDATE {table} SET path=? || substr(path, ?) WHERE path=? OR substr(path,1,?)=?',
                             (old_text, len(new_text) + 1, new_text, len(new_text) + 1, new_text + '/'))
        raise
    from .texts import remap
    remap(old, new)
    return result

@serialized
def relocate_folder(folder_id: int, target_id: int | None, position: str) -> None:
    """Move a directory and its indexed subtree together; refuse merges and cycles."""
    conn = get_pool().main()
    source = conn.execute('SELECT * FROM folders WHERE id=?', (folder_id,)).fetchone()
    target = conn.execute('SELECT * FROM folders WHERE id=?', (target_id,)).fetchone() if target_id is not None else None
    if not source or (position != 'root' and not target):
        raise ValueError('文件夹不存在')
    if position not in ('before', 'after', 'inside', 'root'):
        raise ValueError('移动位置无效')
    if target and source['is_system'] != target['is_system']:
        raise ValueError('请在来源目录或我的文件夹各自区域内移动')
    parent_id = None if position == 'root' else target['id'] if position == 'inside' else target['parent_id']
    descendants = repository.get_folder_descendants(folder_id)
    if parent_id in descendants or target_id == folder_id:
        raise ValueError('不能把文件夹移到自身或其后代')
    if conn.execute('SELECT id FROM folders WHERE parent_id IS ? AND name=? AND id<>?', (parent_id, source['name'], folder_id)).fetchone():
        raise ValueError('目标层级已有同名文件夹，不会合并或覆盖')
    old = Path(source['path']).resolve() if source['path'] else None
    new = old
    if parent_id != source['parent_id'] and old:
        if parent_id is not None:
            parent = target_directory(parent_id).resolve()
        elif source['is_system']:
            top = source
            while top['parent_id'] is not None:
                top = conn.execute('SELECT * FROM folders WHERE id=?', (top['parent_id'],)).fetchone()
            parent = Path(top['path']).resolve().parent
        else:
            parent = (data_dir() / 'folders').resolve()
        new = parent / old.name
        if new == old or new.is_relative_to(old):
            raise ValueError('目标位置无效')
        if new.exists():
            raise ValueError('目标位置已有同名目录，不会合并或覆盖')
        parent.mkdir(parents=True, exist_ok=True)
        old.rename(new)
    try:
        with transaction() as c:
            if old and new != old:
                old_text, new_text = map(repository._normalize_path, (old, new))
                for table in ('folders', 'images'):
                    c.execute(f'UPDATE {table} SET path=? || substr(path, ?) WHERE path=? OR substr(path,1,?)=?',
                              (new_text, len(old_text)+1, old_text, len(old_text)+1, old_text+'/'))
            c.execute('UPDATE folders SET parent_id=? WHERE id=?', (parent_id, folder_id))
            ids = [r['id'] for r in c.execute('SELECT id FROM folders WHERE parent_id IS ? AND is_system=? AND id<>? ORDER BY "order",name,id',
                                            (parent_id, source['is_system'], folder_id))]
            idx = ids.index(target_id) + (position == 'after') if position in ('before', 'after') else len(ids)
            ids.insert(idx, folder_id)
            c.executemany('UPDATE folders SET "order"=? WHERE id=?', enumerate(ids))
    except Exception:
        if old and new != old:
            new.rename(old)
        raise
    if old and new != old:
        from .texts import remap
        remap(old, new)
