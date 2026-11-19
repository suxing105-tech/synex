"""后端 lint 欠债的闸门：只拦新增，不替历史还债。

为什么不是「ruff 全绿」：现在 ruff check app 上挂着几百条意见（I001 73、RUF015 55、
F401 43…），一把 --fix 就是几万行与本轮无关的改动，混进任何一轮都毁掉按轮回滚
（AGENTS.md §3 最小必要修改）。债可以先不还，但不许继续涨：每类规则各钉一个上限，超了就红。

F821（未定义名字）的上限是 0，这条不是凑数：test_media_tools 里两处 Path 注解从来没
import 过，全靠 from __future__ import annotations 把注解推迟成字符串才没在运行时炸，
而 ruff 以前不在门禁里，所以它一直没人看见。0 上限就是下一回有人这么写时当场红的那声。

上限怎么降：顺手修掉几条，就把下面 BASELINE 里的数字改小。比基线少同样会红，这是故意的，
别把已经还掉的债继续记成没还（同 font-bundle 那张自愈登记表的口径）。
"""
from __future__ import annotations

import collections
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]

# 规则 → 允许的最大条数（2026-11-19 在 backend 下量到的现状）。只挑「写错就是 bug」这几类，
# 并且显式 --select：不跟 ruff 的默认规则集走，那套每版都在变，跟着它钉基线等于每升级红一次。
BASELINE = {
    "F821": 0,   # 未定义名字：注解里写一个没 import 的东西就是这么来的
    "F401": 43,  # 没用的 import
    "F811": 5,   # 同名重复定义，后一条把前一条悄悄盖掉
    "F841": 17,  # 赋了值却没用的局部变量
    "B023": 4,   # 闭包引用循环变量：循环跑完才读到最后一个值
}


@pytest.fixture(scope="module")
def lint_hits():
    """跑一次 ruff：返回「规则 → 条数」和 ruff 报的原始条目。"""
    if importlib.util.find_spec("ruff") is None:
        pytest.fail("没装 ruff，欠债闸跑不了：pip install -e .\"[dev]\"（ruff 在 dev extras 里）")
    done = subprocess.run(
        [sys.executable, "-m", "ruff", "check",
         "--select", ",".join(sorted(BASELINE)), "--output-format", "json", "app", "tests"],
        cwd=str(BACKEND), capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=300,
    )
    # ruff 有意见时退 1，那是它的正常输出；退到 2 以上是它自己崩了
    assert done.returncode <= 1, "ruff 跑挂了：" + done.stderr[-400:]
    rows = json.loads(done.stdout or "[]")
    counts = dict(collections.Counter(row["code"] for row in rows))
    return counts, rows


def test_lint_debt_does_not_grow(lint_hits):
    counts, rows = lint_hits
    over = sorted(code for code in BASELINE if counts.get(code, 0) > BASELINE[code])
    if not over:
        return
    lines = ["{} 现在 {} 条，基线 {} 条".format(code, counts.get(code, 0), BASELINE[code])
             for code in over]
    lines += ["{} {}:{} {}".format(
                  row["code"], Path(row["filename"]).name, row["location"]["row"], row["message"])
              for row in rows if row["code"] in over]
    pytest.fail("新增 lint 欠债——修掉它，别把基线抬上去：" + "; ".join(lines[:40]))


def test_baseline_is_not_stale(lint_hits):
    counts, _ = lint_hits
    stale = {code: counts.get(code, 0) for code in BASELINE if counts.get(code, 0) < BASELINE[code]}
    if stale:
        pytest.fail("这几类比基线少，把 BASELINE 改成实际数字："
                    + ", ".join("{}→{}".format(code, stale[code]) for code in sorted(stale)))
