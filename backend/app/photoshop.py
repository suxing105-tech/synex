"""Locate a local Adobe Photoshop executable without using PSD file associations."""
from __future__ import annotations

import os
from pathlib import Path


def _registry_candidates() -> list[Path]:
    if os.name != "nt":
        return []
    try:
        import winreg
    except ImportError:
        return []

    candidates: list[Path] = []
    views = [0]
    for name in ("KEY_WOW64_64KEY", "KEY_WOW64_32KEY"):
        view = getattr(winreg, name, 0)
        if view and view not in views:
            views.append(view)
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in views:
            try:
                with winreg.OpenKey(
                    hive,
                    r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Photoshop.exe",
                    0,
                    winreg.KEY_READ | view,
                ) as key:
                    value, _ = winreg.QueryValueEx(key, "")
            except OSError:
                continue
            if isinstance(value, str) and value.strip():
                candidates.append(Path(os.path.expandvars(value.strip().strip('"'))))
    return candidates


def _common_install_candidates() -> list[Path]:
    roots = {
        os.environ.get("ProgramFiles"),
        os.environ.get("ProgramFiles(x86)"),
        os.environ.get("ProgramW6432"),
    }
    candidates: list[Path] = []
    for raw_root in roots:
        if not raw_root:
            continue
        adobe = Path(raw_root) / "Adobe"
        try:
            candidates.extend(adobe.glob("Adobe Photoshop*/Photoshop.exe"))
        except OSError:
            continue
    return sorted(set(candidates), key=lambda path: str(path).casefold(), reverse=True)


def find_photoshop_executable() -> Path | None:
    """Return an installed Photoshop.exe from App Paths or standard Adobe folders."""
    candidates = [*_registry_candidates(), *_common_install_candidates()]
    for candidate in candidates:
        try:
            if candidate.is_file() and candidate.name.casefold() == "photoshop.exe":
                return candidate.resolve()
        except OSError:
            continue
    return None
