"""ffmpeg / ffprobe 定位：安装包自带的优先，PATH 只当兜底。

为什么单独一个模块（0.2.22 修的 BUG）：视频海报帧和音频波形靠 ffmpeg，视频/音频
元数据 + 写进视频容器里的 ComfyUI 工作流靠 ffprobe。以前 7 处调用一律直接写命令名
``"ffmpeg"`` / ``"ffprobe"``，等于默认"用户机器装了 ffmpeg 并且在 PATH 里"。开发机
成立（winget 装的就 in 用户 PATH），别人的机器不成立，症状正好是反馈里那句
「视频的缩略图和提示词都出不来，但视频能正常播放」——播放是直接把文件流给 WebView，
全程不碰 ffmpeg，所以看起来只坏了一半。

查找顺序（先命中先用，命中结果缓存）：

1. ``SUXING_FFMPEG_DIR`` 指向的目录 —— 排查问题或临时换版本用；
2. 当前可执行文件所在目录 —— 安装包把 ffmpeg.exe / ffprobe.exe 和 sidecar 放一起；
3. ``sys._MEIPASS`` —— 万一以后改成 PyInstaller 内嵌；
4. ``<data_dir>/tools`` —— 已装机的用户不用重装，扔两个 exe 进去就能恢复；
5. 仓库 ``vendor/media-tools`` —— 让开发机和安装包跑同一个 ffmpeg 版本；
6. PATH —— 最后兜底，老的开发习惯不被打断。

对外只暴露 :func:`cmd`（命令前缀）和 :func:`status`（诊断）。找不到时 ``cmd``
原样返回命令名，让 ``subprocess`` 抛 ``FileNotFoundError``，各调用点原有的
"失败降级"分支（返回 None / 空字段 / 404）行为不变。
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path

log = logging.getLogger(__name__)

TOOLS = ("ffmpeg", "ffprobe")
_VERSION_RE = re.compile(r"version\s+(\S+)")

_LOCK = threading.Lock()
_RESOLVED: dict[str, tuple[Path | None, str | None]] = {}
_VERSIONS: dict[str, str | None] = {}


def reset_cache() -> None:
    """清掉解析与版本缓存。测试改环境变量 / 造目录后必须调一次。"""
    with _LOCK:
        _RESOLVED.clear()
        _VERSIONS.clear()


def _exe_names(name: str) -> tuple[str, ...]:
    if os.name == "nt":
        return (f"{name}.exe", name)
    return (name,)


def _candidate_dirs() -> list[tuple[str, Path]]:
    """按优先级返回 (来源标签, 目录)。"""
    dirs: list[tuple[str, Path]] = []
    override = os.environ.get("SUXING_FFMPEG_DIR", "").strip()
    if override:
        dirs.append(("env", Path(override)))
    # 冻结后的 sidecar：sys.executable 就是 python-backend.exe，安装包把工具放在同级
    dirs.append(("exe-dir", Path(sys.executable).parent))
    meipass = getattr(sys, "_MEIPASS", None)
    if isinstance(meipass, str) and meipass:
        dirs.append(("bundle", Path(meipass)))
    try:
        from .config import DEFAULT_DATA_DIR

        dirs.append(("data-tools", DEFAULT_DATA_DIR / "tools"))
    except Exception:  # noqa: BLE001 - 配置不可用不该拖垮工具定位
        pass
    repo_root = os.environ.get("SUXING_REPO_ROOT", "").strip()
    root = Path(repo_root) if repo_root else Path(__file__).resolve().parents[2]
    dirs.append(("vendor", root / "vendor" / "media-tools"))
    return dirs


def _resolve(name: str) -> tuple[Path | None, str | None]:
    for label, base in _candidate_dirs():
        try:
            if not base.is_dir():
                continue
        except OSError:
            continue
        for exe in _exe_names(name):
            candidate = base / exe
            try:
                if candidate.is_file():
                    return candidate, label
            except OSError:
                continue
    found = shutil.which(name)
    if found:
        return Path(found), "path"
    return None, None


def tool_path(name: str) -> Path | None:
    path, _ = _tool(name)
    return path


def tool_source(name: str) -> str | None:
    _, source = _tool(name)
    return source


def _tool(name: str) -> tuple[Path | None, str | None]:
    with _LOCK:
        cached = _RESOLVED.get(name)
    if cached is not None:
        return cached
    result = _resolve(name)
    with _LOCK:
        _RESOLVED[name] = result
    return result


def cmd(name: str) -> list[str]:
    """返回命令前缀。找不到就原样返回命令名，保持原有失败降级路径不变。"""
    path, _ = _tool(name)
    return [str(path)] if path is not None else [name]


def ffmpeg_cmd() -> list[str]:
    return cmd("ffmpeg")


def ffprobe_cmd() -> list[str]:
    return cmd("ffprobe")


def ffmpeg_path() -> Path | None:
    return tool_path("ffmpeg")


def ffprobe_path() -> Path | None:
    return tool_path("ffprobe")


def available() -> bool:
    return all(tool_path(name) is not None for name in TOOLS)


def missing_tools() -> list[str]:
    return [name for name in TOOLS if tool_path(name) is None]


def _probe_version(name: str) -> str | None:
    path = tool_path(name)
    if path is None:
        return None
    try:
        proc = subprocess.run(
            [str(path), "-version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("%s 版本探测失败：%s", name, exc)
        return None
    first = (proc.stdout or "").splitlines()
    for line in first:
        matched = _VERSION_RE.search(line)
        if matched:
            return matched.group(1)
    return None


def warm() -> dict[str, str | None]:
    """探一次版本号并缓存。启动后台调一次，健康检查只读缓存，不再开子进程。"""
    with _LOCK:
        pending = [name for name in TOOLS if name not in _VERSIONS]
    for name in pending:
        version = _probe_version(name)
        with _LOCK:
            _VERSIONS[name] = version
    return status()["versions"]


def status() -> dict[str, object]:
    """给 /api/health 用的诊断信息（纯路径判断 + 已缓存版本，不开子进程）。"""
    tools: dict[str, object] = {}
    versions: dict[str, str | None] = {}
    for name in TOOLS:
        path, source = _tool(name)
        with _LOCK:
            version = _VERSIONS.get(name)
        tools[name] = {
            "path": str(path) if path is not None else None,
            "source": source,
            "version": version,
        }
        versions[name] = version
    return {
        "available": all(item["path"] for item in tools.values()),
        "tools": tools,
        "versions": versions,
        "missing": [name for name in TOOLS if not tools[name]["path"]],
    }


def log_status() -> None:
    """启动时播报一次工具来源；缺工具时给 warning，日志里能直接看出为什么没缩略图。"""
    info = status()
    tools = info["tools"]
    try:
        from .config import DEFAULT_DATA_DIR

        hint = DEFAULT_DATA_DIR / "tools"
    except Exception:  # noqa: BLE001 - 提示路径拿不到就用占位符
        hint = "<data_dir>/tools"
    if info["available"]:
        log.info(
            "媒体工具就绪：ffmpeg %s (%s) / ffprobe %s (%s)",
            tools["ffmpeg"]["version"] or "版本未知",
            tools["ffmpeg"]["source"],
            tools["ffprobe"]["version"] or "版本未知",
            tools["ffprobe"]["source"],
        )
    else:
        log.warning(
            "缺少媒体工具：%s —— 视频海报、音频波形、视频提示词读取都会失败。"
            "请把 ffmpeg.exe / ffprobe.exe 放进 %s，或重装自带 ffmpeg 的安装包。",
            "、".join(info["missing"]),
            hint,
        )
