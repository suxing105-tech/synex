"""CI 工作流的守卫。

`.github/workflows/ci.yml` 是这一轮新加的，本机跑不到 Actions，所以它最容易坏在两类地方，
这里逐条钉住（都是这台机器上真取过证的坑，不是想象出来的风险）：

1. 名单漂移。rust job 要补 tauri-build 声明的随包文件，名单抄自 `tauri.conf.json`。以后加第
   四个 sidecar、或者换授权文件而忘了同步 ci.yml，CI 会停在 build script 报一句 resource path
   不存在，看日志的人根本想不到是 CI 少了一步。所以两头对着钉：tauri.conf 声明的每个都要在
   ci.yml 里出现，ci.yml 里写的每个都得在 tauri.conf 里还在。
2. 静默少跑一套。ci.yml 是手抄 verify-all 的，抄漏一套（或者手滑写成 `cargo test --offline`，
   CI 的空缓存会当场要不到 crate）都是安静地少一道闸。所以钉住四套命令都在、且不带 --offline。

另外钉三件本机验证不了、但一改就会忘的事：后端 job 的 Python 版本必须等于 pyproject 声明的
下限（本机只有更新的解释器，不钉就等于 Python 3.11 那套没人守）；rust job 必须先出
frontend/dist（`build.rs` 调 `tauri_build::build()`，没有 dist 连编译都进不去）；三个 sidecar
确实不入库（占位那一步成立的前提），而两份授权文本必须在仓库里——安装包要随包的法律文本，
不能只活在某台机器的打包目录里。
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

CI = REPO / ".github/workflows/ci.yml"
TAURI_CONF = REPO / "frontend/src-tauri/tauri.conf.json"
PYPROJECT = REPO / "backend/pyproject.toml"

# tauri-build 按 target triple 找 sidecar 的全名（本机取证见 outputs/ci-rust-probe/）
TRIPLE = "x86_64-pc-windows-msvc"


def _ci() -> str:
    text = CI.read_text(encoding="utf-8")
    assert "\r" not in text, "ci.yml 要存成 LF，和仓库里其它 YAML 一致"
    return text


def _rust_job(text: str) -> str:
    return text[text.index("  rust:"):]  # rust 是最后一份 job


def _run_cmds(text: str) -> list[str]:
    """按出现顺序返回每个 step 的命令行，注释里提到什么都不算数。"""
    return [ln.strip()[4:].strip() for ln in text.splitlines() if ln.strip().startswith("run:")]


def _declared_payloads() -> tuple[list[str], list[str]]:
    conf = json.loads(TAURI_CONF.read_text(encoding="utf-8"))
    bundle = conf["bundle"]
    bins = [Path(p).name for p in bundle.get("externalBin") or []]
    res = [Path(p).name for p in bundle.get("resources") or []]
    assert bins and res, "tauri.conf.json 的 externalBin/resources 读不到：配置口径变了要同步这份测试"
    return bins, res


def _tracked(paths: list[str]) -> list[str]:
    proc = subprocess.run(
        ["git", "ls-files", "--", *paths],
        cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace",
        check=False,  # 下面自己判 returncode：失败信息要带 git 的 stderr
    )
    assert proc.returncode == 0, f"git ls-files 失败：{proc.stderr.strip()}"
    return [line for line in proc.stdout.splitlines() if line.strip()]


def test_ci_file_exists_and_is_plain_yaml():
    text = _ci()
    assert text.startswith("name: CI\n"), "ci.yml 开头结构变了，先确认 GitHub 还认得它"
    assert "runs-on: windows-latest" in text, "只有 Windows x64 是发布口径，别在别的平台上测"
    for trigger in ("on:", "  push:", "  pull_request:", "  workflow_dispatch:"):
        assert trigger in text, f"ci.yml 少了触发器 {trigger}"


def test_ci_runs_every_local_gate_suite():
    # verify-all 里的四套（第五套「工作区已提交」是本地闸，CI 不适用）
    cmds = _run_cmds(_ci())
    for cmd in ("python -m pytest -q", "pnpm test", "pnpm exec svelte-check --threshold error", "cargo test"):
        assert cmd in cmds, f"CI 不再真跑 {cmd} 了：要撤就得连 AGENTS.md §4.3 一起改"


def test_cargo_step_does_not_use_offline_in_ci():
    # 本机门禁带 --offline 靠的是本地 crate 缓存；CI 是空缓存，照抄会当场失败
    for cmd in _run_cmds(_ci()):
        if cmd.startswith("cargo test"):
            assert "--offline" not in cmd, f"CI 里没有本地缓存，cargo 不能 --offline：{cmd}"


def test_backend_job_pins_the_declared_python_floor():
    # 正则里那个孤零零的 . 顶掉引号，免得这份测试自己陷进引号套引号
    floor = re.search(r"requires-python\s*=\s*.>=([0-9.]+)", PYPROJECT.read_text(encoding="utf-8"))
    assert floor, "pyproject 里找不到 requires-python，口径变了要同步这份测试"
    ver = floor.group(1)
    pinned = re.search("python-version:\\s*.(" + re.escape(ver) + ")", _ci())
    assert pinned, f"后端 job 不再是 Python {ver}：本机只有更新的解释器，这一处是声明下限唯一的实跑证据"


def test_rust_job_builds_frontend_before_cargo_test():
    cmds = _run_cmds(_rust_job(_ci()))
    assert "pnpm build" in cmds, "build.rs 要 frontend/dist，rust job 必须先构建前端"
    assert "cargo test" in cmds
    assert cmds.index("pnpm build") < cmds.index("cargo test"), "顺序倒了：先出 dist 再跑 cargo"


def _ci_placeholder_lists() -> tuple[list[str], list[str]]:
    """占位步骤里那两条 foreach 各自点名的文件，按结构取，不做全文子串匹配。

    全文子串匹配是个假闸：本机试过把 ffprobe 从名单里删掉，测试照绿——因为 ffprobe 这个词
    在后端 job 那步「备 ffmpeg / ffprobe（可选）」里还活着。要按 foreach 的结构取才作数。
    """
    lists = re.findall(r"foreach \(\$\w in @\(([^)]*)\)\)", _ci())
    assert len(lists) == 2, f"占位步骤的两个名单结构变了（找到 {len(lists)} 个 foreach），要同步这份测试"
    return (
        re.findall(r"[A-Za-z0-9._-]+", lists[0]),
        re.findall(r"[A-Za-z0-9._-]+", lists[1]),
    )


def test_ci_placeholder_lists_match_tauri_conf():
    # 双向：tauri.conf 新增 sidecar 而 ci.yml 没跟上，CI 停在 build script；
    # ci.yml 残留一个已经不存在的名字，名单就在说谎，下次照着它排查会被带偏。
    bins, res = _declared_payloads()
    ci_bins, ci_res = _ci_placeholder_lists()
    assert set(ci_bins) == set(bins), f"sidecar 名单分叉：ci.yml {sorted(ci_bins)} vs tauri.conf {sorted(bins)}"
    assert set(ci_res) == set(res), f"resource 名单分叉：ci.yml {sorted(ci_res)} vs tauri.conf {sorted(res)}"


def test_placeholder_step_builds_the_names_tauri_build_actually_looks_for():
    # tauri-build 找的是带 target triple 后缀的全名，名单对了但拼法错了同样是零分
    text = _ci()
    assert TRIPLE in text, "占位文件名要带 target triple 后缀"
    assert "$tauri/binaries/$n-$triple.exe" in text, "sidecar 占位名的拼法变了，对一下 tauri-build 的口径"
    assert "$tauri/resources/$r" in text, "resource 占位路径的拼法变了"
    assert "Test-Path" in text, "已入库的授权文本要被 Test-Path 跳过，别拿占位内容覆盖真 license"


def test_sidecar_binaries_are_really_untracked():
    # 占位那一步成立的前提就是这三个 exe 不入库（.gitignore: frontend/src-tauri/binaries/*.exe）
    bins, _ = _declared_payloads()
    paths = [f"frontend/src-tauri/binaries/{n}-{TRIPLE}.exe" for n in bins]
    tracked = _tracked(paths)
    assert not tracked, (
        "sidecar 已经入库，占位那一步变成多余的假动作：要么移出仓库，要么删掉那一步并在这里说明理由。实际："
        + ", ".join(tracked)
    )


def test_license_texts_ship_from_the_repository():
    # 授权文本是安装包要随包的法律文件，必须在仓库里，不能只活在打包机上。
    # 它们不在 .gitignore 里，所以全新 checkout 自带；哪天被移出去，CI 的占位步骤会静默
    # 造一个假 license 顶上——那是比 CI 变红更糟的结果，所以这里单独钉一条。
    _, res = _declared_payloads()
    paths = [f"frontend/src-tauri/resources/{n}" for n in res]
    tracked = _tracked(paths)
    assert set(tracked) == set(paths), (
        "tauri.conf.json 声明的授权文本没有全部入库，缺：" + ", ".join(sorted(set(paths) - set(tracked)))
    )

