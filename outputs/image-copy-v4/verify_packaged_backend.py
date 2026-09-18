"""验证打包后的后台；所有测试数据留在本交付目录，不访问用户图库。"""
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import uuid
from urllib.request import Request, urlopen

from PIL import Image

HERE = Path(__file__).resolve().parent
case = HERE / ('smoke-' + uuid.uuid4().hex[:8])
case.mkdir()
watch = case / 'watch'
(watch / 'A').mkdir(parents=True)
(watch / 'B').mkdir()
Image.new('RGB', (32, 24), '#cc4444').save(watch / 'A' / 'removed.png')
Image.new('RGB', (24, 32), '#44cc44').save(watch / 'B' / 'keep.png')
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
env = dict(os.environ, SUXING_DATA_DIR=str(case / 'data'), SUXING_PORT=str(port), SUXING_PARENT_PID=str(os.getpid()))

def api(path, body=None, method=None):
    request = Request(f'http://127.0.0.1:{port}/api{path}',
                      data=None if body is None else json.dumps(body).encode(),
                      headers={'Content-Type': 'application/json'}, method=method)
    with urlopen(request, timeout=5) as response:
        return json.load(response)

def wait_for(check, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                return result
        except (OSError, ValueError):
            pass
        time.sleep(.2)
    raise AssertionError('Timed out waiting for packaged backend')

def filenames():
    return {item['filename'] for item in api('/images')['items']}

with (case / 'stdout.log').open('w', encoding='utf-8') as out, (case / 'stderr.log').open('w', encoding='utf-8') as err:
    proc = subprocess.Popen([str(HERE / 'sidecar' / 'python-backend.exe')], env=env,
                            stdout=out, stderr=err, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        wait_for(lambda: api('/health'))
        api('/directories/import', {'path': str(watch)})
        wait_for(lambda: filenames() == {'removed.png', 'keep.png'})
        tree = api('/folders')
        a = next(n for n in tree if n['name'] == 'A')
        b = next(n for n in tree if n['name'] == 'B')
        assert api(f"/folders/{a['id']}", {'name': '测试显示名称'}, 'PATCH')['name'] == '测试显示名称'
        api(f"/folders/{b['id']}/reorder", {'target_id': a['id'], 'position': 'before'})
        tree = api('/folders')
        assert [n['id'] for n in tree] == [b['id'], a['id']]
        assert tree[1]['path'] == a['path']
        # 混合删除与新增事件：不能漏删，也不能误删新图片。
        (watch / 'A' / 'removed.png').unlink()
        Image.new('RGB', (32, 32), '#4444cc').save(watch / 'B' / 'new.png')
        wait_for(lambda: filenames() == {'keep.png', 'new.png'})
        # 整目录删除的后代索引清理。
        (watch / 'B' / 'keep.png').unlink()
        (watch / 'B' / 'new.png').unlink()
        (watch / 'B').rmdir()
        wait_for(lambda: filenames() == set())
        assert api('/stats')['total_images'] == 0
        physical = api('/folders', {'name': '比例与复制验证'})
        import hashlib
        import io
        checks = []
        for name, size, orientation in [('横图.jpg',(1600,900),1), ('竖图.JPEG',(600,1200),1), ('旋转.jpg',(1200,600),6), ('宽图.png',(1800,600),1)]:
            incoming = case / name
            exif = Image.Exif()
            exif[274] = orientation
            Image.new('RGB', size, '#6677cc').save(incoming, exif=exif)
            original = incoming.read_bytes()
            copied = api('/images/copy-files', {'paths': [str(incoming)], 'folder_id': physical['id']})
            assert len(copied['saved']) == 1 and incoming.exists()
            stored = Path(copied['saved'][0]['path'])
            image_id = copied['saved'][0]['id']
            assert stored.read_bytes() == original == incoming.read_bytes()
            detail = api(f'/images/{image_id}')
            expected = size[::-1] if orientation == 6 else size
            assert (detail['width'], detail['height']) == expected
            with urlopen(f'http://127.0.0.1:{port}/api/images/{image_id}/file') as response:
                assert response.read() == original
            with urlopen(f'http://127.0.0.1:{port}/api/images/{image_id}/file?max=256') as response:
                with Image.open(io.BytesIO(response.read())) as preview:
                    assert abs(preview.width/preview.height - expected[0]/expected[1]) < .02
            checks.append({'name': name, 'size': expected, 'sha256': hashlib.sha256(original).hexdigest()})
        assert api(f"/images?folder_id={physical['id']}")['total'] == 4
        print(json.dumps({'passed': True, 'checks': checks, 'case': str(case)}, ensure_ascii=False))
    finally:
        proc.terminate()
        proc.wait(timeout=10)
