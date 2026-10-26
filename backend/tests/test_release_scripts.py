# -*- coding: utf-8 -*-
"""发布脚本守卫：版本号必须一次改齐，发布资产必须齐全。

版本号曾经漏改一处就把已安装的应用判死，所以 bump-version.py 要么全部改完、
要么一个字节都不写；publish-release.py 在 plan 阶段就要发现资产缺失。
"""
from __future__ import annotations

import codecs
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPTS = REPO / "frontend" / "scripts"


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bump_version = _load("bump_version_script", "bump-version.py")
publish_release = _load("publish_release_script", "publish-release.py")

VERSION_FILES = [
    "frontend/src-tauri/tauri.conf.json",
    "frontend/src-tauri/Cargo.toml",
    "frontend/package.json",
    "backend/pyproject.toml",
    "backend/app/version.py",
    "frontend/src-tauri/Cargo.lock",
]


def _fake_tree(tmp_path: Path, version: str = "0.9.0", lock_newlines: str = "\n") -> Path:
    """A minimal checkout-shaped tree where `version` appears once per file."""
    files = {
        "frontend/src-tauri/tauri.conf.json": '{"version": "%s"}\n' % version,
        "frontend/src-tauri/Cargo.toml": '[package]\nname = "suxing-gallery"\nversion = "%s"\n' % version,
        "frontend/package.json": '{"name": "suxing-gallery-frontend", "version": "%s"}\n' % version,
        "backend/pyproject.toml": '[project]\nname = "suxing-gallery-backend"\nversion = "%s"\n' % version,
        "backend/app/version.py": 'VERSION = "%s"\nDESKTOP_PROTOCOL = 1\n' % version,
        # An unrelated package shares the version string on purpose: the lock
        # edit must be scoped to the app entry only.
        "frontend/src-tauri/Cargo.lock": (
            '[[package]]\nname = "drag"\nversion = "%s"\n\n[[package]]\n'
            'name = "suxing-gallery"\nversion = "%s"\ndependencies = [\n "drag",\n]\n' % (version, version)
        ).replace("\n", lock_newlines),
    }
    for rel, text in files.items():
        path = tmp_path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode("utf-8"))
    return tmp_path


def test_bump_updates_every_source(tmp_path: Path) -> None:
    _fake_tree(tmp_path)
    changed = bump_version.bump(tmp_path, "0.9.0", "0.9.1")
    assert sorted(changed) == sorted(VERSION_FILES)
    for rel in bump_version.SIMPLE_FILES:
        assert "0.9.0" not in (tmp_path / rel).read_text(encoding="utf-8"), rel
    assert json.loads((tmp_path / "frontend/src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["version"] == "0.9.1"
    lock = (tmp_path / "frontend/src-tauri/Cargo.lock").read_text(encoding="utf-8")
    assert 'name = "drag"\nversion = "0.9.0"' in lock, lock
    assert 'name = "suxing-gallery"\nversion = "0.9.1"' in lock, lock


def test_bump_handles_crlf_lock_file(tmp_path: Path) -> None:
    _fake_tree(tmp_path, lock_newlines="\r\n")
    bump_version.bump(tmp_path, "0.9.0", "0.9.1")
    lock = (tmp_path / "frontend/src-tauri/Cargo.lock").read_bytes().decode("utf-8")
    assert 'name = "suxing-gallery"\r\nversion = "0.9.1"' in lock
    assert 'name = "drag"\r\nversion = "0.9.0"' in lock


def test_bump_writes_nothing_when_a_source_is_stale(tmp_path: Path) -> None:
    _fake_tree(tmp_path)
    # Two copies in one file is ambiguous, so the whole bump must be refused.
    conf = tmp_path / "frontend/src-tauri/tauri.conf.json"
    conf.write_text('{"version": "0.9.0", "mirror": "0.9.0"}\n', encoding="utf-8")
    before = {rel: (tmp_path / rel).read_bytes() for rel in VERSION_FILES}
    with pytest.raises(bump_version.BumpError):
        bump_version.bump(tmp_path, "0.9.0", "0.9.1")
    for rel in VERSION_FILES:
        assert (tmp_path / rel).read_bytes() == before[rel], rel


@pytest.mark.parametrize("target", ["0.9.0", "", None])
def test_bump_refuses_noop(tmp_path: Path, target) -> None:
    _fake_tree(tmp_path)
    with pytest.raises(bump_version.BumpError):
        bump_version.bump(tmp_path, "0.9.0", target)


def test_current_version_reads_the_desktop_config(tmp_path: Path) -> None:
    _fake_tree(tmp_path, version="0.9.4")
    assert bump_version.current_version(tmp_path) == "0.9.4"


def _assets(root: Path, version: str) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    for name in publish_release.asset_names(version):
        (root / name).write_bytes(("payload:" + name).encode("utf-8"))
    return root


def test_publish_plan_reports_assets_without_network(tmp_path: Path) -> None:
    root = _assets(tmp_path / "release-0.9.1", "0.9.1")
    summary = publish_release.plan(root, "0.9.1")
    assert summary["tag"] == "v0.9.1"
    assert [a["name"] for a in summary["assets"]] == publish_release.asset_names("0.9.1")
    for asset in summary["assets"]:
        raw = (root / asset["name"]).read_bytes()
        assert asset["bytes"] == len(raw)
        assert asset["sha256"] == hashlib.sha256(raw).hexdigest()
    assert len(summary["commit"]) == 40


def test_publish_plan_requires_every_asset(tmp_path: Path) -> None:
    root = tmp_path / "release-0.9.1"
    root.mkdir()
    (root / "suxing-gallery_0.9.1_x64-setup.exe").write_bytes(b"installer")
    with pytest.raises(RuntimeError, match="Missing asset"):
        publish_release.plan(root, "0.9.1")


def test_asset_names_follow_the_version() -> None:
    assert publish_release.asset_names("0.2.21") == [
        "suxing-gallery_0.2.21_x64-setup.exe",
        "suxing-gallery_0.2.21_x64-setup.exe.sig",
        "latest.json",
    ]


def test_powershell_scripts_with_chinese_carry_a_bom() -> None:
    """Windows PowerShell 5.1 reads a BOM-less UTF-8 script as GBK, so a Chinese
    comment swallows the next quote and the whole file fails to parse
    ("Unexpected token", "The string is missing the terminator"). Any .ps1 that
    is not pure ASCII must therefore start with a UTF-8 BOM."""
    offenders = []
    for script in sorted(SCRIPTS.glob("*.ps1")):
        blob = script.read_bytes()
        if blob.startswith(codecs.BOM_UTF8):
            continue
        if any(byte > 0x7F for byte in blob):
            offenders.append(script.name)
    assert offenders == []


def test_release_scripts_exist() -> None:
    for name in ("build-update.ps1", "build-preview.ps1", "package-release.ps1",
                 "fetch-media-tools.ps1", "verify-all.ps1"):
        assert (SCRIPTS / name).is_file(), name
