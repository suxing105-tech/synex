"""README 里写死的用例数必须对得上门禁实跑 —— 门禁的最后一步。

为什么值得做成闸：README 那三行是给人看的「这个项目有多少测试」。它滞后过一次就一直
在滞后，连续两轮都靠人在收尾时想起来重锚，而「想起来」不是机制。本轮加了 9 条后端用例，
README 还停在上一轮的 1270，第三次手工重锚的账记在这儿。有了这道闸，加完用例忘了改
README 会在门禁里直接红，并且点名第几行、从几改到几。

数字来源是门禁刚跑完的那三份日志，不是再跑一遍测试——跑一遍要三分钟，而这一步要的是
「刚才那一次」的结果。所以它在 verify-all.ps1 里排在四套之后。

用法：python frontend/scripts/check-readme-counts.py [--logs outputs/verify-latest]
     对得上退 0；对不上退 1（逐条打印怎么改）；日志缺了或 README 措辞变了退 2。
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
README = REPO / "README.md"

# 每条声明 = (行首锚点, 取数正则)。锚点+同一行取数，不做全文第一次命中：三行都写着
# passed，全文命中只会全都落在第一行上，那样「有闸」比「没闸」更误导人。
CLAIM_KEYS = {
    "后端 passed": ("后端：", r"(\d+) passed \+ \d+ skipped"),
    "后端 skipped": ("后端：", r"\d+ passed \+ (\d+) skipped"),
    "vitest passed": ("前端：", r"`(\d+) passed`"),
    "vitest files": ("前端：", r"（(\d+) 个测试文件）"),
    "cargo passed": ("Rust：", r"`(\d+) passed`"),
    "cargo ignored": ("Rust：", r"另 (\d+) 条"),
}


def read_log(path: Path) -> str:
    """门禁用 *> 重定向，PowerShell 5.1 写出来是 UTF-16LE；按 UTF-8 读会得到一串乱码。"""
    raw = path.read_bytes()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16", errors="replace")
    return raw.decode("utf-8", errors="replace")


def actual_from_logs(logs_dir: Path) -> dict:
    """从门禁日志取实跑数字。取不到就抛：宁可退 2 让人去修，也不要比出一堆假不一致。"""
    backend = logs_dir / "backend-tests.log"
    if not backend.exists():
        raise FileNotFoundError(str(backend))
    tail = [ln for ln in read_log(backend).splitlines() if " passed" in ln]
    if not tail:
        raise ValueError("backend-tests.log 里没有 pytest 的汇总行")
    summary = tail[-1]
    pm = re.search(r"(\d+) passed", summary)
    if not pm:
        raise ValueError("pytest 汇总行读不出 passed 条数：" + summary)
    actual: dict[str, int] = {"后端 passed": int(pm.group(1))}
    sk = re.search(r"(\d+) skipped", summary)
    actual["后端 skipped"] = int(sk.group(1)) if sk else 0

    front = logs_dir / "frontend-tests.log"
    if not front.exists():
        raise FileNotFoundError(str(front))
    ftext = read_log(front)
    vt = re.search(r"Tests\s+(\d+) passed", ftext)
    vf = re.search(r"Test Files\s+(\d+) passed", ftext)
    if not vt or not vf:
        raise ValueError("vitest 汇总缺 Tests / Test Files 行")
    actual["vitest passed"] = int(vt.group(1))
    actual["vitest files"] = int(vf.group(1))

    rust = logs_dir / "rust-tests.log"
    if not rust.exists():
        raise FileNotFoundError(str(rust))
    passed = ignored = 0
    for line in read_log(rust).splitlines():
        if "test result:" not in line:
            continue
        rp = re.search(r"(\d+) passed", line)
        ri = re.search(r"(\d+) ignored", line)
        passed += int(rp.group(1)) if rp else 0
        ignored += int(ri.group(1)) if ri else 0
    if not passed:
        raise ValueError("rust-tests.log 里一条 test result 都没有")
    actual["cargo passed"] = passed
    actual["cargo ignored"] = ignored
    return actual


def claims_from_readme(text: str) -> dict:
    """返回「声明 -> (数值, 行号)」。读不出来就抛，措辞改了要同步这里。"""
    lines = text.splitlines()
    out: dict[str, tuple[int, int]] = {}
    for key, (head, pattern) in CLAIM_KEYS.items():
        hit = None
        for idx, line in enumerate(lines):
            if head not in line:
                continue
            found = re.search(pattern, line)
            if found:
                hit = (int(found.group(1)), idx + 1)
                break
        if hit is None:
            raise ValueError(key + " 读不出来：README 那一行的措辞变了，同步这份脚本或改回口径")
        out[key] = hit
    return out


def diff(claims: dict, actual: dict) -> list[str]:
    """对不上的每条出一行「第几行、从几改到几」，让人不用再去数。"""
    problems: list[str] = []
    for key, (value, line_no) in sorted(claims.items(), key=lambda kv: kv[1][1]):
        if key not in actual:
            problems.append(key + " 没有实跑数字，核对不了")
        elif actual[key] != value:
            problems.append(
                "README 第 " + str(line_no) + " 行 " + key + " 写 " + str(value)
                + "，门禁实跑 " + str(actual[key]) + "：改 README 那一行")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="核对 README 用例数与门禁实跑是否一致")
    parser.add_argument("--logs", default=str(REPO / "outputs" / "verify-latest"))
    parser.add_argument("--readme", default=str(README))
    args = parser.parse_args(argv)
    readme = Path(args.readme)
    if not readme.exists():
        print("找不到 README：" + str(readme))
        return 2
    try:
        claims = claims_from_readme(readme.read_text(encoding="utf-8"))
        actual = actual_from_logs(Path(args.logs))
    except (ValueError, FileNotFoundError) as exc:
        print("核对不了，先修脚本或补日志：" + str(exc))
        return 2
    problems = diff(claims, actual)
    if problems:
        print("README 的用例数和门禁实跑不一致：")
        for line in problems:
            print("  - " + line)
        return 1
    print("README 用例数与门禁实跑一致：" + "、".join(
        key + "=" + str(actual[key]) for key in sorted(actual)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
