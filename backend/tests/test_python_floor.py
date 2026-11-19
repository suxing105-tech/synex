"""声明的 Python 下限必须真的能跑。

pyproject 写着 requires-python >=3.11，README 和 AGENTS 也按 3.11 教人建环境，可门禁永远只在
开发机那一个解释器上跑（本机 .venv 是 3.14）。于是「代码里用了新版本才有的语法」这件事测不出来：
3.11 的用户是装完、启动、后端起不来之后才发现。

这一轮就踩到了：repository.py 给图片 URL 拼 cache-bust 的那行，在 f-string 里复用了外层的
双引号（PEP 701，Python 3.12 才有）。在 3.11 上这一行是 SyntaxError，repository 整个模块
import 不进来，后端直接瘫——而它在 3.14 的门禁里全绿。

所以这里拿 ruff（dev 依赖里就有，不用新增依赖）按声明的下限把后端源码解析一遍：只取语法错误，
不碰风格，一次几十毫秒。要抬下限，改 FLOOR + pyproject + ruff target 三处，这条会替你记住。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
FLOOR = (3, 11)


def _target() -> str:
    return f"py{FLOOR[0]}{FLOOR[1]}"


def test_declared_floor_is_stated_in_one_voice():
    """pyproject 的 requires-python 和 ruff 的 target-version 必须是同一个下限。

    两个数分开写就会分开漂：一个说支持 3.11，另一个按 3.13 解析，测出来谁都说服不了谁。
    """
    text = (BACKEND / "pyproject.toml").read_text(encoding="utf-8")
    assert f'requires-python = ">={FLOOR[0]}.{FLOOR[1]}"' in text, (
        f"pyproject 的 requires-python 不是 {FLOOR[0]}.{FLOOR[1]}，"
        "抬下限要连着改本文件的 FLOOR 和 README 的环境步骤"
    )
    assert f'target-version = "{_target()}"' in text, (
        f"ruff target-version 不是 {_target()}，它解析用的下限和声明的不一致"
    )


def test_backend_sources_parse_on_declared_floor():
    """全部后端源码必须能在声明的下限上解析通过。

    只筛 invalid-syntax：这是「装了就起不来」那一类，风格问题不在这里管。
    """
    proc = subprocess.run(
        [sys.executable, "-m", "ruff", "check", "--target-version", _target(),
         "--output-format", "json", "app"],
        cwd=str(BACKEND),
        capture_output=True,
        check=False,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode not in (0, 1):
        pytest.skip(f"ruff 没跑起来（exit={proc.returncode}）：{proc.stderr[-200:]}")
    try:
        findings = json.loads(proc.stdout or "[]")
    except json.JSONDecodeError:
        pytest.skip(f"ruff 输出不是 JSON：{proc.stdout[:200]}")
    bad = [
        f'{item.get("filename")}:{item.get("location", {}).get("row")}: '
        f'{item.get("message")}'
        for item in findings
        if item.get("code") == "invalid-syntax"
    ]
    assert not bad, (
        f"这些文件在 Python {FLOOR[0]}.{FLOOR[1]} 上是语法错误，声明支持它就是假的：\n"
        + "\n".join(bad)
    )
