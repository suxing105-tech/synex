"""本机 ComfyUI 集成：探测运行状态 + 临时 workflow 文件落地。

设计目标：
- **零额外依赖**：用标准库 ``urllib.request`` 探测，不引入 requests。
- **不执行 workflow**：仅提供「写到本地文件 + 让用户拖入」的最小实现。
  ComfyUI 没有官方「加载但不执行」的 HTTP API；后续若要真一键，
  需要在 ComfyUI 端装扩展 / 写 litegraph.js loader，超出本仓库范围。
- **探测宽松**：依次尝试 ``/system_stats`` 与 ``/`` 任一 200 即视为在跑。
  连接拒绝 / 超时 → False（ComfyUI 没启动是正常状态，不抛错）。
"""
from __future__ import annotations

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


def comfyui_temp_dir() -> Path:
    p = data_dir() / "comfyui_temp"
    p.mkdir(parents=True, exist_ok=True)
    return p


def write_workflow_temp(image_id: int, workflow_json: str) -> Path | None:
    """把 workflow JSON 写到 ``data/comfyui_temp/<image_id>.json``。

    同名文件直接覆盖；返回落盘后的 Path。workflow_json 为空或 None 时返回 None。
    """
    if not workflow_json or not workflow_json.strip():
        return None
    target = comfyui_temp_dir() / f"{image_id}.json"
    target.write_text(workflow_json, encoding="utf-8")
    return target
