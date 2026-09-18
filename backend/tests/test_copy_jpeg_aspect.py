from pathlib import Path
from unittest.mock import patch
import hashlib

import pytest
from PIL import Image
from fastapi.testclient import TestClient

from app import folder_storage, repository
from app.file_transfer import copy_files
from app.indexer import Indexer
from app.main import app
from app.parser import parse_metadata
from app.thumbnails import generate_preview


@pytest.fixture
def indexer(init_db, monkeypatch):
    idx = Indexer()
    monkeypatch.setattr('app.file_transfer.get_indexer', lambda: idx)
    monkeypatch.setattr('app.routes.images.get_indexer', lambda: idx)
    yield idx
    idx.shutdown()


@pytest.mark.parametrize('extension,size,orientation', [
    ('.jpg', (1600, 900), 1), ('.JPEG', (600, 1200), 1),
    ('.jpg', (1200, 600), 6), ('.png', (1800, 600), 1),
    ('.webp', (600, 1800), 1),
])
def test_copy_preserves_bytes_and_full_size_with_display_aspect(indexer, tmp_path, extension, size, orientation):
    source = tmp_path / f'原图{extension}'
    exif = Image.Exif()
    exif[274] = orientation
    Image.new('RGB', size, '#9a4455').save(source, exif=exif)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    expected_size = size[::-1] if orientation in (5, 6, 7, 8) else size
    folder = folder_storage.create_folder('目标', None)
    original_id = indexer._process_path_sync(source)['id']
    original_detail = repository.image_detail(original_id)
    result = copy_files([str(source)], folder['id'])
    assert not result['skipped']
    copied = Path(result['saved'][0]['path'])
    assert source.is_file() and copied != source
    assert hashlib.sha256(copied.read_bytes()).hexdigest() == digest
    assert hashlib.sha256(source.read_bytes()).hexdigest() == digest
    assert repository.image_detail(original_id) == original_detail
    item = repository.feed(folder_id=folder['id'])[0][0]
    assert (item['width'], item['height']) == expected_size
    assert item['id'] != original_id
    preview = generate_preview(copied, item['id'], 256)
    with Image.open(preview) as image:
        assert abs(image.width / image.height - expected_size[0] / expected_size[1]) < .02
    response = TestClient(app).get(f"/api/images/{item['id']}/file")
    assert response.content == source.read_bytes()  # Export must never use ?max=1024.


def test_jpeg_upload_and_directory_scan_use_same_dimensions(indexer, tmp_path):
    source = tmp_path / 'portrait.JPG'
    Image.new('RGB', (400, 900)).save(source)
    assert indexer.scan(tmp_path)['indexed'] == 1
    response = TestClient(app).post('/api/images/import',
        files={'files': ('portrait.JPG', source.read_bytes(), 'image/jpeg')})
    assert response.status_code == 200
    item = repository.image_detail(response.json()['saved'][0]['id'])
    assert (item['width'], item['height']) == (400, 900)


def test_legacy_move_endpoint_also_preserves_source(indexer, tmp_path):
    source = tmp_path / 'keep.jpg'
    Image.new('RGB', (400, 300)).save(source)
    response = TestClient(app).post('/api/images/move-files', json={'paths': [str(source)]})
    assert response.status_code == 200
    assert response.json()['saved'] and source.exists()
