"""Physical folders owned by this gallery; legacy classifications materialize on use."""
from pathlib import Path
import re

from . import repository
from .config import data_dir, inbox_dir
from .db import get_pool, transaction


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
    try:
        result = repository.folder_create(name, parent_id)
        normalized = repository._normalize_path(path.resolve())
        get_pool().main().execute('UPDATE folders SET path=? WHERE id=?', (normalized, result['id']))
        return {**result, 'path': normalized}
    except Exception:
        # Only remove the empty directory created by this operation.
        path.rmdir()
        raise


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
        return repository.folder_update(folder_id, name=name)
    except Exception:
        new.rename(old)
        with transaction() as conn:
            for table in ('folders', 'images'):
                conn.execute(f'UPDATE {table} SET path=? || substr(path, ?) WHERE path=? OR substr(path,1,?)=?',
                             (old_text, len(new_text) + 1, new_text, len(new_text) + 1, new_text + '/'))
        raise
