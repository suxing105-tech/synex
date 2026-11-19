"""pre-commit 守卫钩子的守卫。

钩子把 AGENTS.md §3.1 那套尺度测试提到提交之前，代价是一次提交多等几秒。它本身是
.git/hooks 下一个不入库的 sh 文件，最容易坏在三个地方，这条测试逐个钉住：

1. 行尾与 BOM。Git for Windows 用它自带的 sh 跑钩子，CRLF 或 BOM 会直接变成
   "bad interpreter"；Windows 上随手一存就会中招，而且中招之后是「不守卫」而不是报错。
2. 守卫清单和真实测试文件分叉。钩子按名字过滤跑 8 份尺度测试，哪天重命名其中一份，
   钩子会安静地少跑一份——所以这里拿磁盘上的真文件名去对钩子里的名字。
3. 装机状态漂移。钩子不入库，换机器、重装、手改都不会有人知道，所以本机装了就必须
   和仓库里的源逐字节一致，不一致就提醒重装。
"""
from __future__ import annotations

import subprocess

import pytest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

HOOK_SOURCE = REPO / "frontend/scripts/git-hooks/pre-commit"
INSTALLER = REPO / "frontend/scripts/install-git-hooks.ps1"
TEST_DIR = REPO / "frontend/src/__tests__"

# 钩子里点名要跑的尺度守卫。改名字要两头一起改，这条会替你记住。
GUARDS = [
    "type-scale",
    "font-vocabulary",
    "font-bundle",
    "spacing-scale",
    "radius-scale",
    "design-tokens",
    "icon-unification",
    "target-size-contrast",
]


def _hook_text() -> str:
    return HOOK_SOURCE.read_text(encoding="utf-8")


def test_hook_source_is_plain_sh():
    raw = HOOK_SOURCE.read_bytes()
    assert raw.startswith(b"#!/bin/sh\n"), "钩子第一行必须是 #!/bin/sh，Git 靠它找解释器"
    assert b"\r" not in raw, "钩子源里有 CRLF，sh 会报错——存成 LF"
    assert not raw.startswith(b"\xef\xbb\xbf"), "钩子源带 BOM，sh 会当成内容读"
    assert raw.isascii(), "钩子源只写 ASCII：它在 sh 里跑，中文注释会撞控制台编码"


def test_hook_lists_every_scale_guard_and_they_exist():
    text = _hook_text()
    for name in GUARDS:
        assert name in text, f"钩子不再跑 {name} 了：要么补回去，要么在这里删掉并说明理由"
        hits = sorted(p.name for p in TEST_DIR.glob(f"{name}.test.ts"))
        assert hits, f"{name} 在 frontend/src/__tests__ 里已经没有对应文件了"
    # 反过来也钉：新加一份尺度守卫而忘了进钩子，同样是漏闸
    on_disk = {p.name[: -len(".test.ts")] for p in TEST_DIR.glob("*.test.ts")}
    forgotten = sorted(
        (on_disk & {p.name[: -len(".test.ts")] for p in TEST_DIR.glob("*-scale.test.ts")}) - set(GUARDS)
    )
    assert not forgotten, f"有 *-scale.test.ts 没进钩子清单：{forgotten}"


def test_hook_also_runs_the_font_charset_guard():
    # 缺字那条在 pytest 那边，不在 vitest 里；钩子漏了它就等于唯一那条「记得重跑
    # fetch-fonts.ps1」的规则又回到靠人记性
    assert "tests/test_font_bundle.py" in _hook_text()


def test_installer_copies_bytes_and_refuses_to_clobber():
    text = INSTALLER.read_text(encoding="utf-8-sig")
    assert "git-hooks" in text, "安装脚本不再从仓库里的钩子源拷了"
    assert "[switch]$Force" in text, "已存在的钩子必须默认不覆盖"
    assert "[switch]$Check" in text, "装没装要能查，不然没人知道自己有没有这道闸"
    # Set-Content / Out-File 会按 PowerShell 默认编码改写内容，钩子就废了
    assert "WriteAllBytes" in text, "钩子要按字节拷，Set-Content 会改编码"
    for bad in ("Set-Content", "Out-File"):
        assert bad not in text, f"安装脚本不许用 {bad} 写钩子"


def test_installed_hook_matches_the_tracked_source():
    proc = subprocess.run(
        ["git", "-C", str(REPO), "rev-parse", "--git-path", "hooks"],
        capture_output=True, text=True,
        encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        pytest.skip("拿不到 git hooks 目录")
    hooks = proc.stdout.strip()
    target = Path(hooks) if Path(hooks).is_absolute() else REPO / hooks
    installed = target / "pre-commit"
    if not installed.is_file():
        # 新克隆就是这状态。不算失败，但交付说明里要提醒跑一次安装脚本
        pytest.skip("本机还没装 pre-commit 钩子：跑 frontend/scripts/install-git-hooks.ps1")
    assert installed.read_bytes() == HOOK_SOURCE.read_bytes(), (
        "已装的 pre-commit 钩子和仓库里的源不一致："
        "重跑 frontend/scripts/install-git-hooks.ps1（要覆盖加 -Force）"
    )

