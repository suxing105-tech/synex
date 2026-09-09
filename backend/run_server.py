"""Sidecar entry - run uvicorn and print READY line to stdout.

Tauri Rust process spawns this exe and listens for the READY line.
"""
from __future__ import annotations

import json
import os
import sys
import traceback
import threading


def _watch_parent(parent_pid: int | None = None) -> None:
    """PyInstaller 的服务子进程随桌面父进程退出，防止遗留端口占用。"""
    parent = parent_pid or os.environ.get("SUXING_PARENT_PID")
    if not parent or sys.platform != "win32":
        return
    import ctypes
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    handle = kernel.OpenProcess(0x00100000, False, int(parent))  # SYNCHRONIZE
    if not handle:
        raise OSError(ctypes.get_last_error(), "无法监控桌面父进程")

    def wait() -> None:
        result = kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
        kernel.CloseHandle(handle)
        if result == 0:  # WAIT_OBJECT_0
            os._exit(0)

    threading.Thread(target=wait, daemon=True, name="desktop-parent-watch").start()


async def _serve(server, port: int) -> None:
    original_startup = server.startup

    async def startup(sockets=None):
        await original_startup(sockets=sockets)
        if not server.started:
            raise RuntimeError("后端初始化失败，请查看启动日志")
        _emit_ready(port)

    server.startup = startup
    # 直接等待 serve，启动失败会立即传回，不会卡在独立 Event 上。
    await server.serve()


def _emit_ready(port: int) -> None:
    sys.stdout.write(f"READY {json.dumps({'port': port})}\n")
    sys.stdout.flush()


def main() -> int:
    # PyInstaller 不保证采用 PYTHONIOENCODING；显式保证 Rust 按 UTF-8 读管道。
    for stream in (sys.stdout, sys.stderr):
        if stream is not None and hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    _watch_parent()
    if getattr(sys, "frozen", False) and os.environ.get("SUXING_PARENT_PID"):
        _watch_parent(os.getppid())  # 同时跟随 PyInstaller 启动器，处理超时 kill。
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
    try:
        asyncio.run(_serve(server, port))
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
