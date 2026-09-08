"""Sidecar entry - run uvicorn and print READY line to stdout.

Tauri Rust process spawns this exe and listens for the READY line.
"""
from __future__ import annotations

import json
import os
import sys
import traceback


def _emit_ready(port: int) -> None:
    sys.stdout.write(f"READY {json.dumps({'port': port})}\n")
    sys.stdout.flush()


def main() -> int:
    port = int(os.environ.get("SUXING_PORT", "8765"))
    host = os.environ.get("SUXING_HOST", "127.0.0.1")

    try:
        import uvicorn
        from app.main import app
    except Exception as exc:
        sys.stderr.write(f"[sidecar] import failed: {exc}\n")
        traceback.print_exc()
        return 2

    config = uvicorn.Config(
        app=app,
        host=host,
        port=port,
        log_level=os.environ.get("SUXING_LOG_LEVEL", "info"),
        access_log=False,
        loop="asyncio",
    )
    server = uvicorn.Server(config)

    import asyncio
    install_done = asyncio.Event()

    original_startup = server.startup

    async def _hooked_startup(sockets=None):
        await original_startup(sockets=sockets)
        install_done.set()

    server.startup = _hooked_startup  # type: ignore[assignment]

    async def _run() -> None:
        serve_task = asyncio.create_task(server.serve())
        await install_done.wait()
        _emit_ready(port)
        await serve_task

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        return 0
    except SystemExit as e:
        return int(e.code) if e.code is not None else 0
    except Exception as exc:
        sys.stderr.write(f"[sidecar] serve failed: {exc}\n")
        traceback.print_exc()
        return 3

    return 0


if __name__ == "__main__":
    sys.exit(main())
