"""把原文件放上 Windows 剪贴板，让资源管理器等外部应用能直接粘贴。

必须是真正的文件组（CF_HDROP）才算「复制了这个文件」：写 MIME 只有碰巧认该格式的
应用读得到，粘进文件夹里什么都没有。Set-Clipboard -LiteralPath 写出的就是 CF_HDROP；
路径经环境变量传入，避免命令行引号把中文与空格路径切坏。
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path


class ClipboardUnsupported(RuntimeError):
    """当前平台做不到：只有 Windows 能写文件组剪贴板。"""


class ClipboardFailed(RuntimeError):
    """平台支持，但这一次复制没成功。"""


def copy_file_to_clipboard(path: Path | str) -> None:
    """复制单个存在的文件到系统剪贴板。

    失败统一抛 ClipboardUnsupported / ClipboardFailed，携带能直接给用户看的中文原因，
    由路由层翻成 501 / 500。
    """
    if os.name != "nt":
        raise ClipboardUnsupported("当前平台仅支持在 Windows 上复制文件到剪贴板")
    p = Path(path)
    if not p.is_file():
        raise ClipboardFailed("文件不存在，可能已被移动或删除")
    env = {**os.environ, "SUXING_COPY_PATH": str(p)}
    command = [
        "powershell", "-NoProfile", "-Command",
        "Set-Clipboard -LiteralPath $env:SUXING_COPY_PATH",
    ]
    try:
        proc = subprocess.run(
            command, env=env, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ClipboardFailed(f"复制失败：{error}") from error
    if proc.returncode != 0:
        raise ClipboardFailed(f"复制失败：{proc.stderr.strip() or '未知错误'}")
