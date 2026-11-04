"""「再次创作」这个名字守着的两件事：界面上别回退成旧名，随包工作流的历史名别被删。

旧名「一键同款」是对结果的承诺，而它做的是「拿当初那套配方再抽一次」，所以改名。
但随包 JSON 的 legacy_labels 里那个旧名是**认领老库里那条记录**用的，删了会让
已装机的库多出一条重复工作流——那和文案不是一回事。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from app import clone_jobs

OLD = "一键同款"
NEW = "再次创作"
APP_DIR = Path(clone_jobs.__file__).parent

# 旧名仍允许出现的地方：注释里指图库那个真实文件夹的名字（历史数据，不能改）
ALLOWED = re.compile("文件夹")


def _py_sources():
    for path in sorted(APP_DIR.rglob("*.py")):
        yield path, path.read_text(encoding="utf-8")


def test_界面文案里不再有旧名字():
    hits = [
        f"{path.name}:{i + 1} {line.strip()}"
        for path, text in _py_sources()
        for i, line in enumerate(text.splitlines())
        if OLD in line and not ALLOWED.search(line)
    ]
    assert hits == []


def test_生成忙时那句说的是新名字():
    src = Path(clone_jobs.__file__).read_text(encoding="utf-8")
    assert "已经有一条" + NEW + "正在生成，等这一批出来再点。" in src
    assert OLD + "正在生成" not in src


@pytest.mark.parametrize("key", ["qwen3-tts-voice-clone", "qwen3-tts-custom-voice", "qwen3-tts-voice-design"])
def test_随包工作流的历史名字仍然在(key):
    """老库里那条记录认的还是旧名，删掉就等于给用户多装一条重复的。"""
    item = json.loads((APP_DIR / "bundled_workflows" / f"{key}.json").read_text(encoding="utf-8"))
    assert item["label"].startswith("闪寻")
    assert OLD not in item["label"]            # 当前显示的名不能再带旧承诺
    if key == "qwen3-tts-voice-clone":
        assert "闪寻音频-" + OLD in item["legacy_labels"]
