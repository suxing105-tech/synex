from pathlib import Path
import os
from PIL import Image
from app.thumbnails import generate_preview
from app.repository import original_url_for
from .test_api import client


def test_legacy_cache_and_reused_id_cannot_replace_new_source(tmp_data_dir):
    from app.config import previews_dir
    source = tmp_data_dir / 'new.jpg'
    Image.new('RGB', (600, 900), 'green').save(source)
    legacy = previews_dir() / '171_max256.webp'
    Image.new('RGB', (900, 400), 'red').save(legacy)
    os.utime(source, (100, 100))
    result = generate_preview(source, 171, 256)
    assert result != legacy
    with Image.open(result) as preview:
        assert preview.height == 256
        assert preview.getpixel((50, 50))[1] > 100
    other = tmp_data_dir / 'other.jpg'
    Image.new('RGB', (900, 400), 'blue').save(other)
    os.utime(other, (100, 100))
    assert generate_preview(other, 171, 256) != result


def test_same_path_same_timestamp_changed_pixels_invalidate_preview(tmp_data_dir):
    source = tmp_data_dir / 'replace.png'
    Image.new('RGB', (600, 400), 'red').save(source)
    os.utime(source, (100, 100))
    before = generate_preview(source, 5, 256)
    Image.new('RGB', (600, 400), 'blue').save(source)
    os.utime(source, (100, 100))
    after = generate_preview(source, 5, 256)
    assert before != after
    with Image.open(after) as preview:
        assert preview.getpixel((50, 50))[2] > 240
    stamp = after.stat().st_mtime_ns
    assert generate_preview(source, 5, 256) == after
    assert after.stat().st_mtime_ns == stamp


def test_browser_url_separates_subsecond_updates_and_identity():
    assert original_url_for(1, 100.1) != original_url_for(1, 100.2)
    assert original_url_for(1, 100, identity='old') != original_url_for(1, 100, identity='new')


def test_modified_since_does_not_override_mismatched_etag(client):
    image = client.get('/api/images').json()['items'][0]
    url = f"/api/images/{image['id']}/file?max=256"
    first = client.get(url)
    second = client.get(url, headers={'If-None-Match': '"other-image"', 'If-Modified-Since': first.headers['last-modified']})
    assert second.status_code == 200
    assert second.content == first.content
    assert second.headers['cache-control'] == 'private, no-cache'
