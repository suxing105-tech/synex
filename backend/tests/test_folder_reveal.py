from unittest.mock import patch

from fastapi.testclient import TestClient
from app.main import app
from app import repository


def test_reveal_opens_real_source_path_after_alias_rename(init_db, tmp_path):
    root = tmp_path / 'watch'
    directory = root / 'source with spaces'
    directory.mkdir(parents=True)
    fid = repository.ensure_system_folder_chain(directory / 'x.png', root)
    repository.folder_update(fid, name='显示名字')
    with patch('subprocess.Popen') as launch, patch('platform.system', return_value='Windows'):
        response = TestClient(app).post(f'/api/folders/{fid}/reveal')
    assert response.status_code == 200
    launch.assert_called_once_with(['explorer', str(directory)])


def test_reveal_missing_or_virtual_folder_does_not_launch(init_db, tmp_path):
    virtual = repository.folder_create('分类', None)['id']
    missing = repository.ensure_system_folder_chain(tmp_path / 'missing' / 'x.png', tmp_path)
    with patch('subprocess.Popen') as launch:
        for fid in (virtual, missing, 99999):
            assert TestClient(app).post(f'/api/folders/{fid}/reveal').status_code == 404
    launch.assert_not_called()
