"""config.py data_dir() 环境变量优先级测试。"""
from __future__ import annotations

from pathlib import Path


def _reload_with_env(monkeypatch, env_name: str, env_value):
    monkeypatch.delenv("SUXING_GALLERY_DATA_DIR", raising=False)
    monkeypatch.delenv("SUXING_DATA_DIR", raising=False)
    if env_value is not None:
        monkeypatch.setenv(env_name, env_value)
    import importlib
    import app.config as cfg
    importlib.reload(cfg)
    return cfg

def test_suxing_data_dir_env_takes_effect(monkeypatch, tmp_path):
    """Tauri sidecar 注入 SUXING_DATA_DIR 时应当被识别。"""
    target = tmp_path / "sidecar-data"
    cfg = _reload_with_env(monkeypatch, "SUXING_DATA_DIR", str(target))
    assert cfg.data_dir() == target
    assert target.exists()


def test_gallery_alias_still_works(monkeypatch, tmp_path):
    """保留 SUXING_GALLERY_DATA_DIR 向后兼容（dev 模式默认）。"""
    target = tmp_path / "legacy"
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(target))
    import importlib
    import app.config as cfg
    importlib.reload(cfg)
    assert cfg.data_dir() == target


def test_suxing_data_dir_beats_gallery_alias(monkeypatch, tmp_path):
    """SUXING_DATA_DIR 优先级高于旧 alias（sidecar 优先）。"""
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path / "old"))
    monkeypatch.setenv("SUXING_DATA_DIR", str(tmp_path / "new"))
    import importlib
    import app.config as cfg
    importlib.reload(cfg)
    assert cfg.data_dir() == tmp_path / "new"
