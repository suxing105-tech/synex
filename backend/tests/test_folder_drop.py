from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.indexer import Indexer
from app import folder_import, repository
from .conftest import make_png


@pytest.fixture
def copier(init_db, monkeypatch):
    indexer = Indexer()
    monkeypatch.setattr(folder_import, 'get_indexer', lambda: indexer)
    yield indexer
    indexer.shutdown()


def test_drop_copies_complete_tree_and_indexes_images(copier, tmp_path):
    source = tmp_path.parent / (tmp_path.name + '-external')
    (source / 'nested' / 'empty').mkdir(parents=True)
    make_png(source / 'nested' / 'image.png')
    (source / 'notes.txt').write_bytes(b'keep all files')
    response = TestClient(app).post('/api/folders/import-directories', json={'paths': [str(source), str(source / 'nested')]})
    assert response.status_code == 200
    result = response.json()
    assert not result['failed'] and not result['warnings']
    assert len(result['copied']) == 1
    target = Path(result['copied'][0]['path'])
    assert target.parent == tmp_path / 'folders'
    # Copy semantics: the original directory stays untouched.
    assert source.is_dir()
    assert (source / 'nested' / 'image.png').is_file()
    assert (target / 'nested' / 'empty').is_dir()
    assert (target / 'notes.txt').read_bytes() == b'keep all files'
    tree = repository.folder_tree()
    assert tree[0]['children'][0]['children'][0]['name'] == 'empty'
    assert repository.feed(folder_id=tree[0]['children'][0]['id'])[1] == 1


def test_collision_and_copy_failure_keep_originals(copier, tmp_path):
    source = tmp_path.parent / (tmp_path.name + '-external')
    source.mkdir()
    (source / 'file.txt').write_text('original')
    target = tmp_path / 'folders' / source.name
    target.mkdir(parents=True)
    (target / 'keep.txt').write_text('existing')
    with patch.object(folder_import.shutil, 'copytree', side_effect=PermissionError('locked')):
        assert folder_import.copy_directories([str(source)])['failed']
    assert (source / 'file.txt').read_text() == 'original'
    result = folder_import.copy_directories([str(source)])
    assert not result['failed']
    assert result['copied'][0]['name'] == source.name + '_1'
    assert (target / 'keep.txt').read_text() == 'existing'
    assert (source / 'file.txt').read_text() == 'original'


def test_database_failure_rolls_directory_back(copier, tmp_path):
    source = tmp_path.parent / (tmp_path.name + '-external')
    source.mkdir()
    (source / 'file.txt').write_text('original')
    with patch.object(folder_import, 'transaction', side_effect=RuntimeError('database unavailable')):
        result = folder_import.copy_directories([str(source)])
    assert result['failed']
    assert (source / 'file.txt').read_text() == 'original'
    assert not (tmp_path / 'folders' / source.name).exists()


def test_reject_managed_watch_and_plain_file(copier, tmp_path):
    plain = tmp_path.parent / (tmp_path.name + '.txt')
    plain.write_text('keep')
    assert folder_import.copy_directories([str(plain)])['failed']
    assert folder_import.copy_directories([str(tmp_path)])['failed']
    source = tmp_path.parent / (tmp_path.name + '-watched')
    source.mkdir()
    copier._watch_roots = [source]
    assert folder_import.copy_directories([str(source)])['failed']
    assert source.is_dir()


def test_copy_preserves_all_bytes_and_keeps_source(copier, tmp_path):
    source = tmp_path.parent / (tmp_path.name + '-external')
    (source / 'empty').mkdir(parents=True)
    payload = bytes(range(256)) * 100
    (source / 'data.bin').write_bytes(payload)
    result = folder_import.copy_directories([str(source)])
    assert not result['failed']
    target = Path(result['copied'][0]['path'])
    assert (target / 'data.bin').read_bytes() == payload
    assert (target / 'empty').is_dir()
    # Source is preserved after a copy.
    assert source.is_dir()
    assert (source / 'data.bin').read_bytes() == payload
