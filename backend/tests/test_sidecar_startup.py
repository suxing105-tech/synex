import asyncio
import os
import subprocess
import sys
from pathlib import Path

import pytest

from run_server import _serve


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [None, RuntimeError("bind failed"), SystemExit(1)])
async def test_ready_only_after_successful_startup(failure, capsys):
    class Server:
        started = False

        async def startup(self, sockets=None):
            if failure:
                raise failure
            self.started = True

        async def serve(self):
            await self.startup()

    if failure:
        with pytest.raises(type(failure)):
            await _serve(Server(), 8765)
        assert "READY" not in capsys.readouterr().out
    else:
        await _serve(Server(), 8765)
        import json
        from app.version import VERSION, DESKTOP_PROTOCOL
        assert json.loads(capsys.readouterr().out.removeprefix("READY ")) == {"port": 8765, "version": VERSION, "protocol": DESKTOP_PROTOCOL}


@pytest.mark.asyncio
async def test_lifespan_failure_does_not_emit_ready(capsys):
    class Server:
        started = False

        async def startup(self, sockets=None):
            pass

        async def serve(self):
            await self.startup()

    with pytest.raises(RuntimeError, match="初始化失败"):
        await asyncio.wait_for(_serve(Server(), 8765), timeout=1)
    assert "READY" not in capsys.readouterr().out


@pytest.mark.skipif(sys.platform != "win32", reason="Windows parent handle")
def test_backend_exits_when_desktop_parent_terminates():
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    env = dict(os.environ, SUXING_PARENT_PID=str(parent.pid))
    child = subprocess.Popen(
        [sys.executable, "-u", "-c", "from run_server import _watch_parent; import time; _watch_parent(); print('WATCHING', flush=True); time.sleep(60)"],
        cwd=Path(__file__).resolve().parents[1], env=env, stdout=subprocess.PIPE,
    )
    try:
        assert child.stdout.readline() == b"WATCHING\r\n"
        parent.terminate()
        parent.wait(timeout=5)
        assert child.wait(timeout=5) == 0
    finally:
        for process in (child, parent):
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
