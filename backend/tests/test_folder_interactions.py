import pytest
from fastapi.testclient import TestClient

from app import repository
from app.main import app


def test_reorder_persists_and_keeps_children(init_db):
    a, b, c = [repository.folder_create(name, None) for name in ('A', 'B', 'C')]
    child = repository.folder_create('child', c['id'])
    client = TestClient(app)
    response = client.post(f"/api/folders/{c['id']}/reorder", json={'target_id': a['id'], 'position': 'before'})
    assert response.status_code == 200
    tree = client.get('/api/folders').json()
    assert [n['id'] for n in tree] == [c['id'], a['id'], b['id']]
    assert tree[0]['children'][0]['id'] == child['id']
    repository.folder_reorder(c['id'], b['id'], 'after')
    assert [n['id'] for n in repository.folder_tree()] == [a['id'], b['id'], c['id']]


def test_source_alias_and_equal_order_reordering_preserve_paths(init_db, tmp_path):
    root = tmp_path / 'watch'
    ids = [repository.ensure_system_folder_chain(root / name / 'x.png', root) for name in ('A', 'B', 'C')]
    client = TestClient(app)
    assert client.patch(f'/api/folders/{ids[0]}', json={'name': '显示名称'}).status_code == 200
    repository.folder_reorder(ids[2], ids[0], 'before')
    tree = repository.folder_tree()
    assert [n['id'] for n in tree] == [ids[2], ids[0], ids[1]]
    assert tree[1]['name'] == '显示名称'
    assert tree[1]['path'].endswith('/A')
    assert repository.ensure_system_folder_chain(root / 'A' / 'y.png', root) == ids[0]
    assert next(n for n in repository.folder_tree() if n['id'] == ids[0])['name'] == '显示名称'
    assert client.patch(f'/api/folders/{ids[0]}', json={'parent_id': ids[1]}).status_code == 400


def test_invalid_moves_and_blank_rename_leave_tree_unchanged(init_db, tmp_path):
    a = repository.folder_create('A', None)['id']
    child = repository.folder_create('child', a)['id']
    source = repository.ensure_system_folder_chain(tmp_path / 'watch' / 'source' / 'x.png', tmp_path / 'watch')
    before = repository.folder_tree()
    for target in (child, source, 99999):
        with pytest.raises(ValueError):
            repository.folder_reorder(a, target, 'before')
    assert TestClient(app).patch(f'/api/folders/{a}', json={'name': '   '}).status_code == 400
    assert repository.folder_tree() == before
