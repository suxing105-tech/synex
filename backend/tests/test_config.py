"""配置加载 / 迁移测试。"""
from __future__ import annotations

import json
from pathlib import Path

from app.config import Config


def test_default_thumb_size_is_360():
    """新装用户默认 thumb_size=360，与缩放滑块上限对齐，避免 Live 添加时落回 256。"""
    cfg = Config()
    assert cfg.thumb_size == 360


def test_load_migrates_legacy_default(tmp_path: Path):
    """旧版本用户的 config.json 仍是 thumb_size=256 → 加载时自动抬到 360。

    这样历史用户不会被老 256 卡住，slider 拉到 360 也不会糊。
    """
    p = tmp_path / "config.json"
    p.write_text(
        json.dumps(
            {
                "watch_dirs": ["D:/ComfyUI/output"],
                "thumb_size": 256,
                "thumb_quality": 80,
                "theme": "dark",
                "live_enabled": True,
                "scan_workers": 4,
            }
        ),
        encoding="utf-8",
    )
    cfg = Config.load(p)
    assert cfg.thumb_size == 360, "legacy 256 should be migrated to new default 360"
    # 其它字段保留
    assert cfg.watch_dirs == ["D:/ComfyUI/output"]
    assert cfg.thumb_quality == 80
    assert cfg.scan_workers == 4


def test_load_keeps_custom_value(tmp_path: Path):
    """用户主动改过 thumb_size（如 512）→ 不迁移，保留用户选择。"""
    p = tmp_path / "config.json"
    p.write_text(
        json.dumps(
            {
                "watch_dirs": [],
                "thumb_size": 512,
                "thumb_quality": 90,
            }
        ),
        encoding="utf-8",
    )
    cfg = Config.load(p)
    assert cfg.thumb_size == 512
    assert cfg.thumb_quality == 90


def test_load_keeps_new_default(tmp_path: Path):
    """已经升过级、配置里写的就是新默认 360 → 不动。"""
    p = tmp_path / "config.json"
    p.write_text(json.dumps({"thumb_size": 360}), encoding="utf-8")
    cfg = Config.load(p)
    assert cfg.thumb_size == 360


def test_load_missing_returns_defaults(tmp_path: Path):
    """配置文件不存在 → 走默认。"""
    cfg = Config.load(tmp_path / "nope.json")
    assert cfg.thumb_size == 360
    assert cfg.watch_dirs == []


def test_load_corrupt_returns_defaults(tmp_path: Path):
    """配置文件 JSON 损坏 → 走默认（而不是 crash）。"""
    p = tmp_path / "config.json"
    p.write_text("{not json", encoding="utf-8")
    cfg = Config.load(p)
    assert cfg.thumb_size == 360


def test_save_then_load_round_trip(tmp_path: Path):
    """保存后再加载，值不变（包括 thumb_size=400 这种非默认值）。"""
    p = tmp_path / "config.json"
    cfg = Config(thumb_size=400, thumb_quality=85)
    cfg.save(p)
    again = Config.load(p)
    assert again.thumb_size == 400
    assert again.thumb_quality == 85
