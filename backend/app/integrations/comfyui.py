"""本机 ComfyUI 集成：探测运行状态 + 临时 workflow 文件落地。

设计目标：
- **零额外依赖**：用标准库 ``urllib.request`` 探测，不引入 requests。
- **不执行 workflow**：仅提供「写到本地文件 + 复用 ComfyUI 标签页」的最小实现。
  ComfyUI 没有官方「加载但不执行」的 HTTP API；后续若要真一键，
  需要在 ComfyUI 端装扩展 / 写 litegraph.js loader，超出本仓库范围。
- **探测宽松**：依次尝试 ``/system_stats`` 与 ``/`` 任一 200 即视为在跑。
  连接失败 / 超时 → False（ComfyUI 没启动是正常状态，不抛错）。
- **文件命名用图片文件名**：避免所有 workflow 都叫 ``workflow.json`` / ``<id>.json``，
  冲突自动追加 ``_1`` / ``_2`` 后缀。
"""
from __future__ import annotations

import re
import urllib.error
import urllib.request
from pathlib import Path

from ..config import data_dir


# ---------- 常量 ----------

DEFAULT_URL = "http://127.0.0.1:8188"
PROBE_PATHS = ("/system_stats", "/")
PROBE_TIMEOUT = 1.5  # 秒


# ---------- 探测 ----------


def probe(url: str = DEFAULT_URL) -> bool:
    """探测本机 ComfyUI 是否在跑。

    返回 True 表示至少一个探测路径返回了 2xx；False 表示连接失败或超时。
    任何异常一律返回 False，不抛到调用方。
    """
    base = url.rstrip("/")
    for path in PROBE_PATHS:
        try:
            req = urllib.request.Request(base + path, method="GET")
            with urllib.request.urlopen(req, timeout=PROBE_TIMEOUT) as resp:
                if 200 <= getattr(resp, "status", 200) < 300:
                    return True
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
            continue
        except Exception:
            # 任何意外错误（如 SSL 错误）也降级为未运行
            continue
    return False


# ---------- 临时文件 ----------

# Windows / POSIX 文件系统都不允许的字符（含控制字符），统一替换为下划线。
_UNSAFE_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_MAX_NAME_LEN = 100  # 限长，避免超长文件名 / 超长路径


def comfyui_temp_dir() -> Path:
    p = data_dir() / "comfyui_temp"
    p.mkdir(parents=True, exist_ok=True)
    return p


def sanitize_filename(raw: str) -> str:
    """把图片原始文件名清洗成可作 JSON 文件名的安全短名。

    - 把文件系统非法字符（含 ``/`` ``\`` ``:`` 等）替换为 ``_``
    - 去掉扩展名（统一追加 .json）
    - 限长 ``_MAX_NAME_LEN``，空字符串 / 纯符号兜底为 ``workflow``

    注意：不直接用 ``Path(raw).name`` / ``Path(raw).stem``，
    Windows 上 ``:`` 是盘符分隔符，会把前缀吞掉（``Path("a:b.png").name`` = ``"b.png"``）。
    而且 ``\`` / ``/`` 在文件名字符串里出现时也应作为非法字符处理，
    而不是当成目录分隔符。
    """
    if not raw:
        return "workflow"
    sanitized = _UNSAFE_CHARS.sub("_", raw)
    base = sanitized.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if "." in base:
        base = base.rsplit(".", 1)[0]
    stem = base.strip(" ._") or "workflow"
    return stem[:_MAX_NAME_LEN]


def _unique_path(target_dir: Path, stem: str) -> Path:
    """在 ``target_dir`` 下找一个不与现有文件冲突的 ``<stem>[_N].json`` 路径。

    优先 ``<stem>.json``，冲突则 ``<stem>_1.json``、``<stem>_2.json`` …
    """
    candidate = target_dir / f"{stem}.json"
    if not candidate.exists():
        return candidate
    counter = 1
    while counter < 10000:
        candidate = target_dir / f"{stem}_{counter}.json"
        if not candidate.exists():
            return candidate
        counter += 1
    # 兜底：永远不应该到这里；保护一下不返回会被覆盖的路径
    raise RuntimeError(f"too many collisions for stem={stem!r}")


def write_workflow_temp(image_filename: str, workflow_json: str) -> Path | None:
    """把 workflow JSON 写到 ``data/comfyui_temp/<sanitized>.json``。

    文件名取自图片原始 filename（去扩展名、清洗非法字符）。
    冲突时自动追加 ``_1`` / ``_2`` 后缀。``workflow_json`` 为空或 None 时返回 None。
    """
    if not workflow_json or not workflow_json.strip():
        return None
    stem = sanitize_filename(image_filename)
    target = _unique_path(comfyui_temp_dir(), stem)
    target.write_text(workflow_json, encoding="utf-8")
    return target