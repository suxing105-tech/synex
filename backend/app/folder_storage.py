"""Physical folders owned by this gallery; legacy classifications materialize on use."""
import errno
import logging
import os
from pathlib import Path
import re
import shutil

from . import repository
from .config import data_dir, inbox_dir
from .db import get_pool, transaction
from .texts import serialized

log = logging.getLogger(__name__)


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


@serialized
def sync_user_folders(indexer=None) -> int:
    """Mirror physical directories under data/folders into the user-folder tree."""
    storage = (data_dir() / 'folders').resolve()
    storage.mkdir(parents=True, exist_ok=True)
    conn = get_pool().main()
    discovered: list[Path] = []
    for current, children, _files in os.walk(storage, followlinks=False):
        base = Path(current)
        safe_children = []
        for name in sorted(children, key=str.casefold):
            child = base / name
            if child.is_symlink() or (hasattr(child, 'is_junction') and child.is_junction()):
                continue
            safe_children.append(name)
            discovered.append(child)
        children[:] = safe_children
    found = {repository._normalize_path(p.resolve()): p.resolve() for p in discovered}
    rows = conn.execute('SELECT id,parent_id,path FROM folders WHERE is_system=0 AND path IS NOT NULL').fetchall()
    existing = {repository._normalize_path(Path(r['path']).resolve()): r for r in rows}
    removed_paths = [Path(row['path']).resolve() for key, row in existing.items()
                     if key not in found and Path(row['path']).resolve().is_relative_to(storage)]
    # Remove only topmost missing branches. This treats the physical tree as canonical.
    stale_roots = [path for path in removed_paths if not any(path != other and path.is_relative_to(other) for other in removed_paths)]
    if stale_roots:
        for row in conn.execute('SELECT id,path FROM folders WHERE is_system=0 AND path IS NOT NULL').fetchall():
            path = Path(row['path']).resolve()
            if any(path == root or path.is_relative_to(root) for root in stale_roots):
                conn.execute('DELETE FROM folders WHERE id=?', (row['id'],))
        for row in conn.execute('SELECT id,path FROM images').fetchall():
            path = Path(row['path']).resolve()
            if any(path.is_relative_to(root) for root in stale_roots):
                if indexer:
                    event = indexer._process_path_sync(path, remove=True)
                    if event:
                        indexer.emit_event_sync(event)
                else:
                    conn.execute('DELETE FROM images WHERE id=?', (row['id'],))
        from . import texts
        for row in texts.conn().execute('SELECT id,path FROM texts WHERE missing=0').fetchall():
            path = Path(row['path']).resolve()
            if any(path.is_relative_to(root) for root in stale_roots):
                texts.conn().execute('UPDATE texts SET missing=1 WHERE id=?', (row['id'],))
                texts.conn().execute('DELETE FROM texts_fts WHERE rowid=?', (row['id'],))
    added = 0
    for path in discovered:
        full = path.resolve()
        normalized = repository._normalize_path(full)
        if normalized in existing:
            continue
        parent_path = full.parent
        parent_row = conn.execute('SELECT id FROM folders WHERE is_system=0 AND path=?',
                                  (repository._normalize_path(parent_path),)).fetchone()
        parent_id = parent_row['id'] if parent_row else None
        conn.execute('INSERT OR IGNORE INTO folders(parent_id,name,"order",is_system,path) VALUES(?,?,0,0,?)',
                     (parent_id, full.name, normalized))
        added += 1
    return added


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
    if not row or not row['path']:
        return repository.folder_update(folder_id, name=name)
    name = valid_name(name)
    old = Path(row['path']).resolve()
    new = old.with_name(name)
    if old == new:
        return repository.folder_update(folder_id, name=name)
    if new.exists():
        raise ValueError('同级文件夹已存在此名称')
    new = new.resolve()
    old.rename(new)

    def remap_index_paths(source: Path, destination: Path) -> None:
        conn = get_pool().main()
        for table in ('folders', 'images'):
            rows = conn.execute(f'SELECT id,path FROM {table} WHERE path IS NOT NULL').fetchall()
            for item in rows:
                path = Path(item['path']).resolve()
                if path == source or path.is_relative_to(source):
                    mapped = destination / path.relative_to(source)
                    conn.execute(f'UPDATE {table} SET path=? WHERE id=?',
                                 (repository._normalize_path(mapped), item['id']))

    try:
        with transaction():
            remap_index_paths(old, new)
        result = repository.folder_update(folder_id, name=name)
    except Exception:
        new.rename(old)
        with transaction():
            remap_index_paths(new, old)
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


# ---------- 图片真实移动 ----------

def managed_roots() -> list[Path]:
    """应用自己管理的磁盘目录：用户文件夹树 + 拖拽收件箱。"""
    return [(data_dir() / 'folders').resolve(), inbox_dir().resolve()]


def _inside(path: Path, roots: list[Path]) -> bool:
    return any(path == root or path.is_relative_to(root) for root in roots)


def _unique_path(directory: Path, filename: str) -> Path:
    """目标目录内不覆盖同名文件：追加 _1 _2 …"""
    candidate = directory / filename
    if not candidate.exists():
        return candidate
    stem, suffix = candidate.stem, candidate.suffix
    for index in range(1, 1000):
        candidate = directory / f'{stem}_{index}{suffix}'
        if not candidate.exists():
            return candidate
    raise ValueError('目标文件夹内同名文件过多')


def _suppress_watcher(paths: list[Path]) -> None:
    """移动期间忽略这些路径的 watchdog 事件（索引由本模块自己改）。"""
    try:
        from .indexer import get_indexer
        get_indexer().suppress_events(paths, seconds=5.0)
    except Exception:  # noqa: BLE001 - 监听未启动时本来就没有事件
        pass


def _move_on_disk(source: Path, destination: Path) -> None:
    """把文件搬到 destination；跨卷时复制后删源，失败不留半成品。"""
    try:
        source.rename(destination)
        return
    except OSError as error:
        cross_volume = (getattr(error, 'winerror', None) == 17
                        or getattr(error, 'errno', None) == errno.EXDEV)
        if not cross_volume:
            raise
    temporary = destination.with_name(destination.name + '.moving')
    temporary.unlink(missing_ok=True)
    try:
        shutil.copy2(source, temporary)
        temporary.rename(destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    try:
        source.unlink()
    except OSError:
        # 源文件删不掉（被占用等）→ 回滚目标副本，保持「只有一个副本」语义
        destination.unlink(missing_ok=True)
        raise


def _reassign_system_folder(image_id: int, path: Path) -> None:
    """文件搬进监听目录时补挂 system folder；搬出监听目录时旧关系已清，不再挂。"""
    try:
        from .indexer import get_indexer
        roots = [Path(d) for d in get_indexer().config.watch_dirs]
        root = repository.find_watch_root(path, roots)
        if root is None:
            return
        folder_id = repository.ensure_system_folder_chain(path, root)
    except Exception:  # noqa: BLE001 - 补挂归属失败不该影响移动本身
        return
    if folder_id is None:
        return
    get_pool().main().execute(
        'INSERT OR IGNORE INTO image_folders(image_id, folder_id) VALUES(?,?)',
        (image_id, folder_id))


def _reclassify(image_id: int, folder_id: int | None) -> None:
    """只改归类、不动磁盘；保留 system folder 关系。"""
    with transaction() as c:
        c.execute('DELETE FROM image_folders WHERE image_id=? '
                  'AND folder_id IN (SELECT id FROM folders WHERE is_system=0)', (image_id,))
        if folder_id is not None:
            c.execute('INSERT OR IGNORE INTO image_folders(image_id, folder_id) VALUES(?,?)',
                      (image_id, folder_id))


def _commit_move(image_id: int, folder_id: int | None, path: Path) -> None:
    """文件已到位后写索引：路径与归属同事务更新，顺带清掉指向该路径的幽灵行。"""
    normalized = repository._normalize_path(path.resolve())
    with transaction() as c:
        phantom = c.execute('SELECT id FROM images WHERE path=? AND id<>?',
                            (normalized, image_id)).fetchone()
        if phantom:
            # 该路径上的旧文件早已被删，索引是幽灵行；现在的文件是刚搬来的这张
            c.execute('DELETE FROM images WHERE id=?', (phantom['id'],))
        stat = path.stat()
        c.execute('UPDATE images SET path=?, filename=?, mtime=? WHERE id=?',
                  (normalized, path.name, float(stat.st_mtime), image_id))
        c.execute('DELETE FROM image_folders WHERE image_id=?', (image_id,))
        if folder_id is not None:
            c.execute('INSERT OR IGNORE INTO image_folders(image_id, folder_id) VALUES(?,?)',
                      (image_id, folder_id))
    _reassign_system_folder(image_id, path)


@serialized
def move_images(image_ids: list[int], folder_id: int | None, *, move_files: bool = True) -> dict:
    """把图片/视频真实移动到目标文件夹的磁盘目录，并同步索引与归属。

    - folder_id=int（只能是 user folder）：文件搬进该夹的真实目录，归属替换为该夹；
      离开监听目录时一并清掉旧的 system folder 归属。
    - folder_id=None：解除 user folder 归属。文件只有在「应用自己管的目录」
      （data/folders、收件箱）里才会搬回收件箱；用户自己的监听目录里的文件保持原位
      —— 应用不该把文件从用户自己的目录里拽走。
    - move_files=False：只改归类（纯逻辑移动）。

    返回 {ids, folder_id, moved, kept, failed}：moved=真实搬动过的文件，
    kept=只改归类或本来就在目标目录，failed=单个文件的失败原因（不影响其余文件）。
    """
    conn = get_pool().main()
    if folder_id is not None:
        target = conn.execute('SELECT id, is_system FROM folders WHERE id=?', (folder_id,)).fetchone()
        if not target:
            raise ValueError(f'文件夹 {folder_id} 不存在')
        if target['is_system']:
            raise ValueError('不能把图片移动到系统文件夹')
    destination = target_directory(folder_id) if folder_id is not None else inbox_dir()
    destination.mkdir(parents=True, exist_ok=True)
    destination = destination.resolve()
    roots = managed_roots()
    moved: list[dict] = []
    kept: list[int] = []
    failed: list[dict] = []
    for image_id in image_ids:
        row = conn.execute('SELECT id, path, filename FROM images WHERE id=?', (image_id,)).fetchone()
        if not row:
            failed.append({'id': image_id, 'filename': '', 'error': '图片不存在'})
            continue
        filename = row['filename']
        try:
            source = Path(row['path']).resolve()
        except OSError as error:
            failed.append({'id': image_id, 'filename': filename, 'error': f'路径无法读取：{error}'})
            continue
        if not source.is_file():
            failed.append({'id': image_id, 'filename': filename, 'error': '原文件不存在，未更新位置'})
            continue
        already_there = source.parent == destination
        external = not _inside(source, roots)
        if not move_files or already_there or (folder_id is None and external):
            try:
                _reclassify(image_id, folder_id)
            except Exception as error:  # noqa: BLE001
                failed.append({'id': image_id, 'filename': filename, 'error': f'更新归类失败：{error}'})
                continue
            kept.append(image_id)
            continue
        target_path = _unique_path(destination, source.name)
        _suppress_watcher([source, target_path])
        try:
            _move_on_disk(source, target_path)
        except PermissionError:
            failed.append({'id': image_id, 'filename': filename,
                           'error': '文件被其它程序占用或没有写入权限'})
            continue
        except OSError as error:
            failed.append({'id': image_id, 'filename': filename,
                           'error': f'移动失败：{error.strerror or error}'})
            continue
        try:
            _commit_move(image_id, folder_id, target_path)
        except Exception as error:  # noqa: BLE001
            try:
                _move_on_disk(target_path, source)
            except Exception:  # noqa: BLE001
                log.error('move rollback failed: %s -> %s', target_path, source, exc_info=True)
            failed.append({'id': image_id, 'filename': filename, 'error': f'更新索引失败：{error}'})
            continue
        moved.append({'id': image_id, 'filename': target_path.name,
                      'path': repository._normalize_path(target_path),
                      'renamed': target_path.name != source.name})
    return {'ids': [item['id'] for item in moved] + kept, 'folder_id': folder_id,
            'moved': moved, 'kept': kept, 'failed': failed}


@serialized
def move_image(image_id: int, folder_id: int | None) -> dict:
    """单张图片的真实移动；任一失败抛中文 ValueError（路由据此回 400/404）。"""
    result = move_images([image_id], folder_id)
    if result['failed']:
        raise ValueError(result['failed'][0]['error'])
    return result
