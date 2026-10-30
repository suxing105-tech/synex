# -*- coding: utf-8 -*-
"""把「工作区必须已提交」这道闸接进两个入口：verify-all.ps1 与 build-update.ps1。

这两个 .ps1 含中文，仓库有一条测试要求含中文的 .ps1 必须带 UTF-8 BOM，
所以只能锚点替换，不能整文件重写（重写容易丢 BOM / 换行风格）。
"""
import io

VERIFY = r"C:/Users/Administrator/Documents/ChatGPT/苏醒图库/frontend/scripts/verify-all.ps1"
BUILD = r"C:/Users/Administrator/Documents/ChatGPT/苏醒图库/frontend/scripts/build-update.ps1"

VERIFY_ANCHOR = "Suite 'backend pytest' (Join-Path $Repo 'backend') { & $Python -m pytest -q } 'backend-tests.log'"
VERIFY_GATE = """# Gate 0: the AGENTS.md rule says "commit every round, immediately". It was still
# skipped for five rounds before v0.2.31, so it is enforced in code, not prose.
$Gate = Join-Path $PSScriptRoot 'check-worktree-committed.py'
$GateLog = Join-Path $Out 'worktree-committed.log'
$GateCode = RunNative { & $Python $Gate } $GateLog
Write-Output ('{0,-18} exit={1}  {2}' -f 'worktree committed', $GateCode, (Tail $GateLog))
if ($GateCode) { $fail = $fail + 'worktree committed' }

"""

BUILD_ANCHOR = "# 发布前先锁版本号：0.2.7 曾漏改 backend/app/version.py，"
BUILD_GATE = """# 发布前先确认每一轮都已经 commit：工作区还是脏的，说明某一轮没进版本库，
# 发出去就没有「回滚到某一轮」的落点了。
$PreviousEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $Python "$PSScriptRoot/check-worktree-committed.py" *> "$OutputDir/worktree-committed.log"
$CommittedCheck = $LASTEXITCODE
$ErrorActionPreference = $PreviousEap
if ($CommittedCheck) { throw "工作区还有未提交的改动，已停止发布。查看 worktree-committed.log" }
"""


def patch(path, anchor, gate):
    t = io.open(path, encoding="utf-8", newline="").read()
    assert t.count(anchor) == 1, (path, t.count(anchor))
    nl = "\r\n" if "\r\n" in t else "\n"
    block = gate.replace("\n", nl)
    if t.lstrip("\ufeff").startswith("#"):
        pass
    t = t.replace(anchor, block + anchor)
    io.open(path, "w", encoding="utf-8", newline="").write(t)
    raw = open(path, "rb").read()
    assert raw[:3] == b"\xef\xbb\xbf", "BOM lost: " + path
    print("patched", path, "CRLF" if nl == "\r\n" else "LF")


patch(VERIFY, VERIFY_ANCHOR, VERIFY_GATE)
patch(BUILD, BUILD_ANCHOR, BUILD_GATE)
