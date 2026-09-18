from unittest.mock import patch
from types import SimpleNamespace

import pytest

from app.indexer import Indexer, _Handler
from .conftest import make_png


@pytest.fixture
def indexer(init_db):
    idx = Indexer()
    yield idx
    idx.shutdown()


@pytest.mark.parametrize('last_kind', ['create', 'modify', 'delete'])
def test_mixed_batch_uses_each_paths_final_state(indexer, init_db, tmp_path, last_kind):
    removed = make_png(tmp_path / 'removed.png')
    old_id = indexer._process_path_sync(removed)['id']
    removed.unlink()
    created = make_png(tmp_path / 'created.png')
    with patch('app.indexer.threading.Timer'):
        indexer.enqueue('delete', removed)
        indexer.enqueue('create', created)
        indexer._flush_pending(last_kind)
    rows = init_db.main().execute('SELECT path FROM images').fetchall()
    assert [r['path'] for r in rows] == [str(created.resolve()).replace('\\', '/')]
    assert indexer._process_path_sync(removed, remove=True) is None


def test_delete_then_recreate_same_path_is_kept(indexer, init_db, tmp_path):
    image = make_png(tmp_path / 'replaced.png')
    indexer._process_path_sync(image)
    with patch('app.indexer.threading.Timer'):
        indexer.enqueue('delete', image)
        image.unlink()
        make_png(image, width=16)
        indexer._flush_pending('delete')
    assert init_db.main().execute('SELECT width FROM images').fetchone()['width'] == 16


def test_directory_event_cleans_descendants_only(indexer, init_db, tmp_path):
    directory = tmp_path / 'group'
    sibling = tmp_path / 'group-other'
    directory.mkdir()
    sibling.mkdir()
    image = make_png(directory / 'a.png')
    keep = make_png(sibling / 'b.png')
    indexer._process_path_sync(image)
    indexer._process_path_sync(keep)
    image.unlink()
    directory.rmdir()
    with patch('app.indexer.threading.Timer'):
        _Handler(indexer).on_deleted(SimpleNamespace(is_directory=True, src_path=str(directory)))
        indexer._flush_pending('delete')
    assert [r['filename'] for r in init_db.main().execute('SELECT filename FROM images')] == ['b.png']


async def test_removal_is_broadcast(indexer, tmp_path):
    import asyncio
    image = make_png(tmp_path / 'gone.png')
    image_id = indexer._process_path_sync(image)['id']
    events = []
    indexer.on_event = events.append
    indexer._loop = asyncio.get_running_loop()
    image.unlink()
    with patch('app.indexer.threading.Timer'):
        indexer.enqueue('delete', image)
        await asyncio.to_thread(indexer._flush_pending, 'modify')
    await asyncio.sleep(0)
    assert events == [{'type': 'image_removed', 'id': image_id, 'path': str(image.resolve()).replace('\\', '/')}]
