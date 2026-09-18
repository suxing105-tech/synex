"""Copy dropped originals, retaining the source file and its gallery record."""
from pathlib import Path
import shutil

from PIL import Image

from . import repository
from .db import get_pool, transaction
from .folder_storage import target_directory
from .indexer import get_indexer
from .parser import SUPPORTED_EXTS


def copy_files(paths: list[str], folder_id: int | None) -> dict:
    directory = target_directory(folder_id).resolve()
    saved, skipped = [], []
    indexer = get_indexer()
    for raw in dict.fromkeys(paths):
        source = Path(raw).resolve()
        target = None
        created = False
        try:
            if source.suffix.lower() not in SUPPORTED_EXTS:
                raise ValueError('unsupported_format')
            with indexer._live_lock:
                with Image.open(source) as image:
                    image.verify()
                before = source.stat()
                if before.st_size > 100 * 1024 * 1024:
                    raise ValueError('超过 100MB')
                target = directory / source.name
                row = get_pool().main().execute('SELECT id, favorite FROM images WHERE path=?',
                    (repository._normalize_path(source),)).fetchone()
                if source.parent != directory:
                    number = 0
                    while True:
                        try:
                            output = target.open('xb')
                            created = True
                            break
                        except FileExistsError:
                            number += 1
                            target = directory / f'{source.stem}_{number}{source.suffix}'
                    with output, source.open('rb') as input_file:
                        shutil.copyfileobj(input_file, output)
                    after = source.stat()
                    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                        raise ValueError('图片仍在写入，请稍后重试')
                    shutil.copystat(source, target)
                payload = indexer._process_path_sync(target)
                if not payload:
                    raise ValueError('无法读取图片')
                image_id = payload['id']
                with transaction() as conn:
                    if folder_id is not None:
                        conn.execute('INSERT OR IGNORE INTO image_folders(image_id,folder_id) VALUES(?,?)', (image_id, folder_id))
                    if created and row:
                        conn.execute('UPDATE images SET favorite=? WHERE id=?', (row['favorite'], image_id))
                        conn.execute('INSERT OR IGNORE INTO image_tags(image_id,tag_id) SELECT ?,tag_id FROM image_tags WHERE image_id=?', (image_id, row['id']))
                indexer.emit_event_sync(payload)
                saved.append({'id': image_id, 'filename': target.name, 'path': str(target)})
        except (OSError, ValueError) as error:
            if created and target is not None:
                with indexer._live_lock:
                    indexer._process_path_sync(target, remove=True)
                    target.unlink(missing_ok=True)
            skipped.append({'filename': source.name, 'reason': str(error)})
    return {'saved': saved, 'skipped': skipped, 'folder_id': folder_id, 'inbox_dir': str(directory)}


# Compatibility for earlier clients; even the legacy endpoint now only copies.
move_files = copy_files
