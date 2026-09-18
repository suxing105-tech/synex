from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app import folder_storage, repository
from app.file_transfer import move_files
from app.indexer import Indexer
from app.main import app
from .conftest import make_png


@pytest.fixture
def indexer(init_db, monkeypatch):
    indexer = Indexer()
    monkeypatch.setattr('app.file_transfer.get_indexer', lambda: indexer)
    monkeypatch.setattr('app.indexer.get_indexer', lambda: indexer)
    yield indexer
    indexer.shutdown()


def test_create_real_nested_folder_inline_api_and_reveal(indexer, tmp_path):
    client = TestClient(app)
    parent = client.post('/api/folders', json={'name': '视频分镜'}).json()
    child = client.post('/api/folders', json={'name': '片段', 'parent_id': parent['id']}).json()
    assert Path(parent['path']) == tmp_path / 'folders' / '视频分镜'
    assert Path(child['path']).is_dir()
    with patch('subprocess.Popen') as launch:
        assert client.post(f"/api/folders/{child['id']}/reveal").status_code == 200
        launch.assert_called_once()
    assert client.post('/api/folders', json={'name': '视频分镜'}).status_code == 400
    for name in ['../outside', 'bad/name', 'CON', 'x:', '..']:
        assert client.post('/api/folders', json={'name': name}).status_code == 400


def test_move_preserves_metadata_handles_collisions_and_same_directory(indexer, tmp_path):
    folder = folder_storage.create_folder('destination', None)
    destination = Path(folder['path'])
    source = make_png(tmp_path / 'a.png')
    original = source.read_bytes()
    existing = make_png(destination / 'a.png', width=16)
    existing_bytes = existing.read_bytes()
    image_id = indexer._process_path_sync(source)['id']
    repository.set_favorite(image_id, True)
    repository.set_tags(image_id, ['保留'])
    result = move_files([str(source)], folder['id'])
    assert not result['skipped']
    saved = result['saved'][0]
    assert saved['id'] == image_id
    assert Path(saved['path']).name == 'a_1.png'
    assert Path(saved['path']).read_bytes() == original
    assert not source.exists()
    assert existing.read_bytes() == existing_bytes
    assert repository.image_detail(image_id)['favorite']
    assert repository.image_detail(image_id)['tags'] == ['保留']
    assert repository.feed(folder_id=folder['id'])[1] == 1
    again = move_files([saved['path']], folder['id'])
    assert again['saved'][0]['id'] == image_id
    assert sorted(p.name for p in destination.iterdir()) == ['a.png', 'a_1.png']


def test_missing_images_removed_without_watchdog_event(indexer, tmp_path):
    folder = folder_storage.create_folder('视频分镜', None)
    source = make_png(Path(folder['path']) / 'gone.png')
    image_id = indexer._process_path_sync(source)['id']
    repository.assign_folder(image_id, folder['id'])
    source.unlink()
    with patch.object(indexer, 'emit_event_sync') as emit:
        assert indexer.reconcile_missing() == [image_id]
        assert emit.call_args.args[0]['type'] == 'image_removed'
    assert repository.feed(folder_id=folder['id']) == ([], 0)
    assert repository.folder_tree()[0]['recursive_count'] == 0
    assert indexer.reconcile_missing() == []


def test_permission_error_does_not_remove_index(indexer, tmp_path):
    source = make_png(tmp_path / 'keep.png')
    image_id = indexer._process_path_sync(source)['id']
    with patch.object(Path, 'stat', side_effect=PermissionError):
        assert indexer.reconcile_missing() == []
    assert repository.image_detail(image_id)


def test_rename_real_parent_keeps_child_image_paths(indexer, tmp_path):
    parent = folder_storage.create_folder('before', None)
    child = folder_storage.create_folder('child', parent['id'])
    image = make_png(Path(child['path']) / 'a.png')
    image_id = indexer._process_path_sync(image)['id']
    folder_storage.rename_folder(parent['id'], 'after')
    assert not image.exists()
    assert Path(repository.image_detail(image_id)['path']).is_file()
    assert Path(repository.folder_tree()[0]['children'][0]['path']).is_dir()
    assert not indexer.reconcile_missing()


def test_move_failure_keeps_original_and_memberships(indexer, tmp_path):
    old = folder_storage.create_folder('old', None)
    target = folder_storage.create_folder('target', None)
    source = make_png(Path(old['path']) / 'a.png')
    image_id = indexer._process_path_sync(source)['id']
    repository.assign_folder(image_id, old['id'])
    unlink = Path.unlink
    def fail_original(path, *args, **kwargs):
        if path == source:
            raise PermissionError('locked')
        return unlink(path, *args, **kwargs)
    with patch.object(Path, 'unlink', fail_original):
        result = move_files([str(source)], target['id'])
    assert result['skipped']
    assert source.is_file()
    assert list(Path(target['path']).iterdir()) == []
    assert repository.feed(folder_id=old['id'])[1] == 1
    assert repository.feed(folder_id=target['id'])[1] == 0


def test_move_to_source_folder_and_legacy_classification(indexer, tmp_path):
    source_dir = tmp_path / 'watched' / 'source'
    source_dir.mkdir(parents=True)
    fid = repository.ensure_system_folder_chain(source_dir / 'x.png', tmp_path / 'watched')
    first = make_png(tmp_path / 'first.png')
    result = TestClient(app).post('/api/images/move-files', json={'paths': [str(first)], 'folder_id': fid})
    assert result.status_code == 200
    assert (source_dir / 'first.png').is_file() and not first.exists()
    legacy = repository.folder_create('old virtual', None)
    second = make_png(tmp_path / 'second.png')
    assert move_files([str(second)], legacy['id'])['saved']
    assert repository.feed(folder_id=legacy['id'])[1] == 1


def test_browser_upload_saves_to_selected_disk_folder(indexer, tmp_path, monkeypatch):
    monkeypatch.setattr('app.routes.images.get_indexer', lambda: indexer)
    folder = folder_storage.create_folder('upload', None)
    image = make_png(tmp_path / 'source.png')
    response = TestClient(app).post('/api/images/import', data={'folder_id': folder['id']},
        files={'files': ('a.png', image.read_bytes(), 'image/png')})
    assert response.status_code == 200
    assert Path(response.json()['saved'][0]['path']).parent == Path(folder['path'])
