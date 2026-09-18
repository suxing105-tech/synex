from pathlib import Path
import pytest
from app import folder_storage,repository
from app.db import get_pool
from app.indexer import Indexer
from .conftest import make_png
from .test_api import client


def test_cross_level_move_keeps_physical_descendants_and_image_ids(init_db):
    a=folder_storage.create_folder('A',None);b=folder_storage.create_folder('B',None)
    child=folder_storage.create_folder('child',a['id'])
    image=Path(child['path'])/'pic.png';make_png(image)
    image_id=Indexer()._process_path_sync(image)['id']
    folder_storage.relocate_folder(a['id'],b['id'],'inside')
    new=Path(b['path'])/'A'/'child'/'pic.png'
    assert new.exists() and not image.exists()
    assert Path(repository.image_detail(image_id)['path'])==new
    folder_storage.relocate_folder(child['id'],None,'root')
    row=get_pool().main().execute('select * from folders where id=?',(child['id'],)).fetchone()
    assert row['parent_id'] is None
    assert (Path(row['path'])/'pic.png').exists()


def test_cross_level_cycle_and_collision_leave_disk_unchanged(init_db):
    a=folder_storage.create_folder('A',None);child=folder_storage.create_folder('child',a['id'])
    with pytest.raises(ValueError):folder_storage.relocate_folder(a['id'],child['id'],'inside')
    b=folder_storage.create_folder('B',None);folder_storage.create_folder('A',b['id'])
    with pytest.raises(ValueError):folder_storage.relocate_folder(a['id'],b['id'],'inside')
    assert Path(a['path']).is_dir() and Path(child['path']).is_dir()


def test_source_subfolder_can_move_up_and_down(init_db,tmp_path):
    root=tmp_path/'watch';a=root/'A';b=root/'B';a.mkdir(parents=True);b.mkdir()
    aid=repository.ensure_system_folder_chain(a/'x.png',root)
    bid=repository.ensure_system_folder_chain(b/'x.png',root)
    folder_storage.relocate_folder(aid,bid,'inside')
    assert (b/'A').is_dir() and not a.exists()
    assert repository.ensure_system_folder_chain(b/'A'/'x.png',root)==aid
    folder_storage.relocate_folder(aid,None,'root')
    assert a.is_dir()


def test_favorite_json_can_be_enabled_and_disabled(client):
    iid=client.get('/api/images').json()['items'][0]['id']
    for favorite in (True,False):
        response=client.post(f'/api/images/{iid}/favorite',json={'favorite':favorite})
        assert response.json()['favorite'] is favorite
        assert client.get(f'/api/images/{iid}').json()['favorite'] is favorite
