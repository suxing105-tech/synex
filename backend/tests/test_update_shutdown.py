"""Updating must exit even while the gallery keeps an idle event socket open."""
import asyncio
import os
from pathlib import Path
import socket
import subprocess
import sys

import httpx
import websockets


def test_idle_gallery_socket_does_not_block_prepared_shutdown(tmp_path):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    server = Path(__file__).resolve().parents[1] / 'run_server.py'
    env = {**os.environ, 'SUXING_DATA_DIR': str(tmp_path / 'data'), 'SUXING_PORT': str(port),
           'SUXING_CONTROL_TOKEN': 'isolated-test-control', 'SUXING_PARENT_PID': str(os.getpid())}
    with (tmp_path / 'server.log').open('w', encoding='utf-8') as log:
        packaged = os.environ.get('SUXING_TEST_BACKEND_PATH')
        command = [packaged] if packaged else [sys.executable, str(server)]
        process = subprocess.Popen(command, env=env, stdout=log, stderr=log)
        async def exercise():
            async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}', trust_env=False) as client:
                for _ in range(100):
                    try:
                        if (await client.get('/api/health')).status_code == 200:
                            break
                    except httpx.TransportError:
                        pass
                    await asyncio.sleep(.1)
                else:
                    raise AssertionError('Test server did not start')
                async with websockets.connect(f'ws://127.0.0.1:{port}/ws/events'):
                    headers = {'x-suxing-control': 'isolated-test-control'}
                    prepared = await client.post('/api/desktop/prepare-update', headers=headers, timeout=15)
                    assert prepared.status_code == 200
                    assert (Path(prepared.json()['backup']) / 'db.sqlite').is_file()
                    assert (await client.post('/api/desktop/shutdown', headers=headers)).status_code == 200
                    code = await asyncio.to_thread(process.wait, 8)
                    assert code == 0
        try:
            asyncio.run(exercise())
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
