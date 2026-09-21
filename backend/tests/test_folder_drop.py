from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.indexer import Indexer
from app import folder_import, repository
from .conftest import make_png


@pytest.fixture
def mover(init_db, monkeypatch):
    indexer = Indexer()
    monkeypatch.setattr(folder_import, 'get_indexer', lambda: indexer)
    yield indexer
    indexer.shutdown()


def test_drop_moves_complete_tree_and_indexes_images(mover, tmp_path):
    source = tmp_path.parent / (tmp_path.name + '-external')
    (source / 'nested' / 'empty').mkdir(parents=True)
    make_png(source / 'nested' / 'image.png')
    (source / 'notes.txt').write_bytes(b'keep all files')
    response = TestClient(app).post('/api/folders/import-directories', json={'paths': [str(source), str(source / 'nested')]})
    assert response.status_code == 200
    result = response.json()
    assert not result['failed'] and not result['warnings']
    assert len(result['moved']) == 1
    target = Path(result['moved'][0]['path'])
    assert target.parent == tmp_path / 'folders'
    assert not source.exists()
    assert (target / 'nested' / 'empty').is_dir()
    assert (target / 'notes.txt').read_bytes() == b'keep all files'
    tree = repository.folder_tree()
    assert tree[0]['children'][0]['children'][0]['name'] == 'empty'
    assert repository.feed(folder_id=tree[0]['children'][0]['id'])[1] == 1


def test_collision_and_move_failure_keep_originals(mover, tmp_path):
    source = tmp_path.parent / (tmp_path.name + '-external')
    source.mkdir()
    (source / 'file.txt').write_text('original')
    target = tmp_path / 'folders' / source.name
    target.mkdir(parents=True)
    (target / 'keep.txt').write_text('existing')
    with patch.object(folder_import.shutil, 'move', side_effect=PermissionError('locked')):
        assert folder_import.move_directories([str(source)])['failed']
    assert (source / 'file.txt').read_text() == 'original'
    result = folder_import.move_directories([str(source)])
    assert not result['failed']
    assert result['moved'][0]['name'] == source.name + '_1'
    assert (target / 'keep.txt').read_text() == 'existing'


def test_database_failure_rolls_directory_back(mover, tmp_path):
    source = tmp_path.parent / (tmp_path.name + '-external')
    source.mkdir()
    (source / 'file.txt').write_text('original')
    with patch.object(folder_import, 'transaction', side_effect=RuntimeError('database unavailable')):
        result = folder_import.move_directories([str(source)])
    assert result['failed']
    assert (source / 'file.txt').read_text() == 'original'
    assert not (tmp_path / 'folders' / source.name).exists()


def test_reject_managed_watch_and_plain_file(mover, tmp_path):
    plain = tmp_path.parent / (tmp_path.name + '.txt')
    plain.write_text('keep')
    assert folder_import.move_directories([str(plain)])['failed']
    assert folder_import.move_directories([str(tmp_path)])['failed']
    source = tmp_path.parent / (tmp_path.name + '-watched')
    source.mkdir()
    mover._watch_roots = [source]
    assert folder_import.move_directories([str(source)])['failed']
    assert source.is_dir()


def test_cross_volume_copy_then_remove_preserves_all_bytes(mover, tmp_path):
    import errno
    source = tmp_path.parent / (tmp_path.name + '-external')
    (source / 'empty').mkdir(parents=True)
    payload = bytes(range(256)) * 100
    (source / 'data.bin').write_bytes(payload)
    with patch('shutil.os.rename', side_effect=OSError(errno.EXDEV, 'different volume')):
        result = folder_import.move_directories([str(source)])
    assert not result['failed']
    target = Path(result['moved'][0]['path'])
    assert (target / 'data.bin').read_bytes() == payload
    assert (target / 'empty').is_dir()
    assert not source.exists()
