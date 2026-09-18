"""Move dropped images without overwriting files or losing gallery metadata."""
from pathlib import Path
import shutil

from PIL import Image

from . import repository
from .db import get_pool, transaction
from .folder_storage import target_directory
from .indexer import get_indexer
from .parser import SUPPORTED_EXTS


def move_files(paths: list[str], folder_id: int | None) -> dict:
    directory = target_directory(folder_id).resolve()
    saved, skipped = [], []
    indexer = get_indexer()
    for raw in dict.fromkeys(paths):
        source = Path(raw).resolve()
        if source.suffix.lower() not in SUPPORTED_EXTS:
            skipped.append({'filename': source.name, 'reason': 'unsupported_format'})
            continue
        try:
            with indexer._live_lock:
                with Image.open(source) as image:
                    image.verify()
                before = source.stat()
                if before.st_size > 100 * 1024 * 1024:
                    raise ValueError('超过 100MB')
                target = directory / source.name
                copied = source.parent != directory
                row = get_pool().main().execute('SELECT id FROM images WHERE path=?',
                    (repository._normalize_path(source),)).fetchone()
                memberships = list(get_pool().main().execute('SELECT folder_id FROM image_folders WHERE image_id=?', (row['id'],))) if row else []
                if copied:
                    number = 0
                    while True:
                        try:
                            output = target.open('xb')
                            break
                        except FileExistsError:
                            number += 1
                            target = directory / f'{source.stem}_{number}{source.suffix}'
                    try:
                        with output, source.open('rb') as input_file:
                            shutil.copyfileobj(input_file, output)
                        after = source.stat()
                        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                            raise ValueError('图片仍在写入，请稍后重试')
                        shutil.copystat(source, target)
                    except Exception:
                        target.unlink()
                        raise
                try:
                    if row:
                        get_pool().main().execute('UPDATE images SET path=? WHERE id=?',
                            (repository._normalize_path(target), row['id']))
                    payload = indexer._process_path_sync(target)
                    if not payload:
                        raise ValueError('无法读取图片')
                    image_id = payload['id']
                    with transaction() as conn:
                        conn.execute('DELETE FROM image_folders WHERE image_id=?', (image_id,))
                        if folder_id is not None:
                            conn.execute('INSERT INTO image_folders(image_id,folder_id) VALUES(?,?)', (image_id, folder_id))
                    if copied:
                        source.unlink()
                except Exception:
                    if copied:
                        # Restore the source index; the original file still exists on failure.
                        if row:
                            get_pool().main().execute('UPDATE images SET path=? WHERE id=?',
                                (repository._normalize_path(source), row['id']))
                            indexer._process_path_sync(source)
                            with transaction() as conn:
                                conn.execute('DELETE FROM image_folders WHERE image_id=?', (row['id'],))
                                conn.executemany('INSERT INTO image_folders(image_id,folder_id) VALUES(?,?)', [(row['id'], m['folder_id']) for m in memberships])
                        else:
                            indexer._process_path_sync(target, remove=True)
                        target.unlink()
                    raise
                indexer.emit_event_sync(payload)
                saved.append({'id': image_id, 'filename': target.name, 'path': str(target)})
        except (OSError, ValueError) as error:
            skipped.append({'filename': source.name, 'reason': str(error)})
    return {'saved': saved, 'skipped': skipped, 'folder_id': folder_id, 'inbox_dir': str(directory)}
