"""版本号一致性守卫。

0.2.7 发布时只改了 4 个文件，漏掉 backend/app/version.py，桌面端认为自己是
0.2.7、sidecar 上报 0.2.6，已安装的应用一启动就被判死，只能重装。
版本号散落在 5 处，靠人记不住，所以在这里锁死：任何一处不一致测试就红。
"""
from __future__ import annotations

import json
import tomllib
from pathlib import Path

from app.version import DESKTOP_PROTOCOL, VERSION

REPO = Path(__file__).resolve().parents[2]


def _toml(rel: str) -> dict:
    return tomllib.loads((REPO / rel).read_text(encoding="utf-8"))


def _json(rel: str) -> dict:
    return json.loads((REPO / rel).read_text(encoding="utf-8"))


def test_backend_version_matches_pyproject():
    assert _toml("backend/pyproject.toml")["project"]["version"] == VERSION


def test_desktop_shell_versions_match_sidecar():
    assert _toml("frontend/src-tauri/Cargo.toml")["package"]["version"] == VERSION
    assert _json("frontend/src-tauri/tauri.conf.json")["version"] == VERSION
    assert _json("frontend/package.json")["version"] == VERSION


def test_sidecar_protocol_matches_the_rust_startup_check():
    # frontend/src-tauri/src/sidecar.rs 的 check_ready_payload 写死了协议 1
    assert DESKTOP_PROTOCOL == 1
    source = (REPO / "frontend/src-tauri/src/sidecar.rs").read_text(encoding="utf-8")
    assert "const DESKTOP_PROTOCOL: u64 = 1;" in source
