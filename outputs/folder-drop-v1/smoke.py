import os
import socket
import subprocess
import tempfile
import time
from pathlib import Path

import httpx
from PIL import Image

base = Path(__file__).resolve().parent
root = Path(tempfile.mkdtemp(prefix='smoke-', dir=base))
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
env = {**os.environ, 'SUXING_DATA_DIR': str(root / 'data'), 'SUXING_PORT': str(port), 'SUXING_PARENT_PID': str(os.getpid())}
with (root / 'server.log').open('w') as log:
    proc = subprocess.Popen([str(base / 'sidecar/python-backend.exe')], env=env, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        with httpx.Client(base_url=f'http://127.0.0.1:{port}', trust_env=False, timeout=30) as client:
            for _ in range(150):
                try:
                    if client.get('/api/health').is_success:
                        break
                except httpx.TransportError:
                    pass
                time.sleep(.1)
            else:
                raise AssertionError('Backend did not start')
            source = root / 'external' / 'album'
            (source / 'child' / 'empty').mkdir(parents=True)
            Image.new('RGB', (60, 30), 'red').save(source / 'child' / 'test.jpg')
            (source / 'notes.txt').write_text('all files retained')
            response = client.post('/api/folders/import-directories', json={'paths': [str(source)]})
            response.raise_for_status()
            result = response.json()
            assert len(result['moved']) == 1 and not result['failed'] and not result['warnings'], result
            target = Path(result['moved'][0]['path'])
            assert not source.exists()
            assert (target / 'child' / 'empty').is_dir()
            assert (target / 'notes.txt').read_text() == 'all files retained'
            tree = client.get('/api/folders').json()
            assert tree[0]['children'][0]['image_count'] == 1, tree
            print('Packaged backend: full directory move, JPG indexing, empty folder and non-image preservation PASS')
    finally:
        proc.terminate()
        proc.wait(10)
