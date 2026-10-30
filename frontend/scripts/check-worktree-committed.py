# -*- coding: utf-8 -*-
"""工作区必须已提交 —— 门禁第 0 步。

规矩写的是「每次改动完成后都必须 commit」，我还是攒了五轮：Round 25-29 叠在同一批
文件上，发布时拆不出按轮的干净 commit，等于把 commit 唯一的用途（随时回滚到某一轮）
作废。文本约束挡不住我，所以改成机器闸：verify-all.ps1 与 build-update.ps1 先跑这里。

判定口径（关键是别把产出目录变成噪音源，否则跑第三次就有人直接把这道闸删掉）：

- 已跟踪文件有任何未提交改动（含只 staged 未 commit）=> 违规。
- 未跟踪的新文件只看会进版本库的位置：backend/ frontend/ docs/ 与根目录的
  README.md AGENTS.md MEMORY.md。outputs/ 与 vendor/ 里那些一次性脚本和产物本来
  就不入库，报出来只会让人把整条告警当白噪音。

用法：python frontend/scripts/check-worktree-committed.py    干净退 0，脏退 1
"""
from __future__ import annotations

import subprocess
import sys

# 只看这些前缀下的未跟踪文件：它们才是「漏 add」的样子。
CODE_PREFIXES = ("backend/", "frontend/", "docs/")
ROOT_FILES = ("README.md", "AGENTS.md", "MEMORY.md")


def path_of(entry: str) -> str:
    """porcelain v1 的一行 -> 路径。重命名取新名字；git 的输出本来就是正斜杠。"""
    body = entry[3:] if len(entry) > 3 else ""
    if " -> " in body:
        body = body.split(" -> ", 1)[1]
    return body.strip().strip('"')


def is_output_path(path: str) -> bool:
    """任何一段叫 outputs 的目录都是产出目录（AGENTS.md 的口径），里面的东西不入库。"""
    return "outputs" in path.split("/")[:-1]


def find_offenders(entries: list[str]) -> list[str]:
    """把 git status --porcelain 的行分成「属于某一轮、必须先 commit」的东西。"""
    offenders: list[str] = []
    for entry in entries:
        if not entry.strip():
            continue
        status = entry[:2]
        path = path_of(entry)
        if not path:
            continue
        if is_output_path(path):
            continue
        if status == "??":
            if path.startswith(CODE_PREFIXES) or path in ROOT_FILES:
                offenders.append(path + "  [未跟踪：该 add 的没 add]")
            continue
        offenders.append(path + "  [" + status.strip() + " 未提交]")
    return offenders


def status_entries(cwd: str | None = None) -> list[str]:
    """core.quotepath=off 让中文路径原样出来；-uall 才把新目录里的文件逐个列出来。"""
    done = subprocess.run(
        ["git", "-c", "core.quotepath=off", "status", "--porcelain=v1", "-uall"],
        cwd=cwd, capture_output=True, text=True, encoding="utf-8", check=True,
    )
    return done.stdout.splitlines()


def main(argv: list[str] | None = None) -> int:
    try:
        entries = status_entries()
    except FileNotFoundError:
        print("找不到 git，无法判断工作区是否已提交。")
        return 2
    except subprocess.CalledProcessError as exc:
        print("git status 失败：" + (exc.stderr or "").strip())
        return 2
    offenders = find_offenders(entries)
    if not offenders:
        print("工作区已提交：没有未提交的代码改动。")
        return 0
    print("工作区还有没提交的东西。规矩是每轮做完立刻 commit，不许攒到发布前补：")
    for line in offenders:
        print("  - " + line)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
