"""随包字体的来源与授权守卫。

界面字体是寒蝉德黑体（ChillDINGothic）的子集化改名版，产物是三只 woff2。这条测试管的是
「前端那套 font-bundle.test.ts 看不见」的另一半：产物能不能在一台新电脑上重新生成，
以及授权链条有没有断。

- 生成脚本要靠 fonttools + brotli，它们必须在 dev extras 里写明，否则换台机器跑
  fetch-fonts.ps1 只会得到一句 ModuleNotFoundError，没人知道该装什么。
- 上游 zip 的 sha256 同时写在 fetch-fonts.ps1（下载后校验）和 fonts-manifest.json
  （记录来源）。两个数分叉，说明有人改了 pin 没重跑脚本，或者改了产物没改 pin。
- OFL 1.1 要求授权原文跟着字体走。文件不在，安装包就少一份法定随附文本。
"""
from __future__ import annotations

import importlib.util
import json
import re
import tomllib
from pathlib import Path

from fontTools.ttLib import TTFont

REPO = Path(__file__).resolve().parents[2]

MANIFEST = REPO / "frontend/src/assets/fonts/fonts-manifest.json"
FETCH_SCRIPT = REPO / "frontend/scripts/fetch-fonts.ps1"
SUBSET_SCRIPT = REPO / "frontend/scripts/subset_fonts.py"


def _manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def test_font_pipeline_deps_are_declared():
    dev = tomllib.loads(
        (REPO / "backend/pyproject.toml").read_text(encoding="utf-8")
    )["project"]["optional-dependencies"]["dev"]
    joined = " ".join(dev).lower()
    assert "fonttools" in joined, "子集化要靠 fonttools，得写进 backend 的 dev extras"
    assert "brotli" in joined, "fontTools 写 woff2 需要 brotli，缺了会静默落回 CFF"


def test_font_scripts_exist_and_are_wired_together():
    assert FETCH_SCRIPT.is_file()
    assert SUBSET_SCRIPT.is_file()
    ps1 = FETCH_SCRIPT.read_text(encoding="utf-8")
    assert "subset_fonts.py" in ps1


def test_upstream_pin_agrees_between_script_and_manifest():
    # 两个地方各存一份上游 hash，这是「可复现」这件事唯一的锚点，不许分叉
    ps1 = FETCH_SCRIPT.read_text(encoding="utf-8")
    hit = re.search(r"\$ArchiveSha\s*=\s*'([0-9a-f]{64})'", ps1)
    assert hit, "fetch-fonts.ps1 里找不到上游 zip 的 sha256 pin"
    assert hit.group(1) == _manifest()["upstream"]["archiveSha256"], (
        "上游 zip 的 sha256 在 fetch-fonts.ps1 与 fonts-manifest.json 里不一致："
        "改 pin 必须重跑 fetch-fonts.ps1 重新生成产物"
    )


def test_ofl_license_text_ships_in_the_installer():
    manifest = _manifest()
    license_path = REPO / manifest["licenseFile"]
    assert license_path.is_file(), f"缺授权原文：{manifest['licenseFile']}"
    text = license_path.read_text(encoding="utf-8")
    assert "SIL OPEN FONT LICENSE Version 1.1" in text
    # 子集必须改名（OFL 的 Reserved Font Name），授权文件里要把这件事交代清楚
    assert "Reserved Font Name" in text
    bundle = json.loads(
        (REPO / "frontend/src-tauri/tauri.conf.json").read_text(encoding="utf-8")
    )["bundle"]["resources"]
    assert manifest["licenseFile"].replace("frontend/src-tauri/", "") in bundle


def test_generated_faces_are_real_woff2():
    # fontTools 只在 font.flavor 被设成 woff2 时才真的压成 woff2；
    # 只设 Options().flavor 会得到一只名字骗人的 CFF/OTF，这个坑踩过一次。
    for face in _manifest()["files"]:
        head = (MANIFEST.parent / face["file"]).read_bytes()[:4]
        assert head == b"wOF2", f"{face['file']} 不是 woff2，重跑 frontend/scripts/fetch-fonts.ps1"

# ---------------------------------------------------------------------------
# 界面点名的字，字面里到底有没有（2026-11-16 补的闸）
#
# 前面几条守的是「产物可复现、授权链条没断」。这一条守整套字体规范里唯一还靠人记性的
# 那一步：改了中文文案或新加符号，却忘了重跑 fetch-fonts.ps1。子集是「拉丁与标点整段
# + GB2312 常用汉字 + 源码扫到的字」，常用中文不会掉，掉的是 GB2312 之外的生僻字和
# 符号——掉下去就换 Microsoft YaHei 画，同一行里两种宽度两种脸，用户只当界面没对齐，
# 不会有人当 bug 报。所以这条必须自动化，不能靠「记得重跑」。
#
# 口径直接复用生成脚本 subset_fonts.py 的同一套函数：请求集由它算，字面有没有去读真
# woff2 的 cmap，中间不隔任何生成物——所以「manifest 说全了而字体其实缺」骗不过去。
# 注意 build_charset() 里的两个源码路径是相对的（fetch-fonts.ps1 在仓库根跑），而 pytest
# 的工作目录是 backend/，所以这里一律自己传绝对路径，否则源码那组会静默扫成空。
# ---------------------------------------------------------------------------

# 上游寒蝉德黑体本来就没有这些码位。按处置口径分四类登记，类别名就是结论。
# 新字符不许往这里加：要么重跑 fetch-fonts.ps1 把它收进子集，要么别用那个字符。
_BASELINE_EMOJI = {0x23F3, 0x1F4E5}  # 空态 emoji：彩色图元本来就该交给系统 emoji 字体
_BASELINE_NOT_OUR_UI = {0x1F3A5, 0x1F165, 0x1F157, 0x1F162, 0xFE0F}  # 内置工作流 JSON 的节点标题，画在 ComfyUI 里
_BASELINE_MAC_ONLY = {0x2303, 0x2325}  # 快捷键提示的 isMac 分支，本产品只发 Windows
_BASELINE_COMMENT_ONLY = {0x2460, 0x2461, 0x2462, 0x25B8, 0x2699}  # 只出现在注释和测试文本里，不进界面
# 这四个是真缺口，也确实显示在界面上：右栏「更多操作」的文字图标 ⋯、对比视图
# 播放暂停按钮的 ⏸（同一条里和 ▶ 两种脸）、Markdown 任务列表的 ☐ ☑。
# 前两个的正解是换成 <Icon>（AGENTS.md §3.1「图标只有一个入口」），换掉之后这条
# 登记会因为源码里不再有该字符而自动失效，不需要手动删。
_BASELINE_KNOWN_DEBT = {0x22EF, 0x23F8, 0x2610, 0x2611}
_BASELINE = (_BASELINE_EMOJI | _BASELINE_NOT_OUR_UI | _BASELINE_MAC_ONLY
             | _BASELINE_COMMENT_ONLY | _BASELINE_KNOWN_DEBT)

_SOURCE_ROOTS = [REPO / "frontend" / "src", REPO / "backend" / "app"]
_SF = None
_FACES = None


def _subsetter():
    """按路径加载 frontend/scripts/subset_fonts.py，和生成产物时用的是同一份逻辑。"""
    global _SF
    if _SF is None:
        spec = importlib.util.spec_from_file_location("seekx_subset", SUBSET_SCRIPT)
        assert spec and spec.loader, f"加载不了 {SUBSET_SCRIPT}"
        _SF = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_SF)
    return _SF


def _face_cmaps() -> dict[str, set[int]]:
    """每只真字面的 cmap，一次读五只、缓存住（合计 5.9MB，别在每条用例里重来）。"""
    global _FACES
    if _FACES is None:
        sf = _subsetter()
        _FACES = {}
        for face in _manifest()["files"]:
            font = TTFont(MANIFEST.parent / face["file"], lazy=True)
            try:
                _FACES[face["file"]] = sf.font_chars(font)
            finally:
                font.close()
    return _FACES


def _fmt(cps) -> str:
    return " ".join("U+%04X%s" % (cp, chr(cp)) for cp in sorted(cps))


def test_skill_markdown_is_inside_the_scanned_set():
    """技能正文换成 .md 数据文件之后，闸必须跟着把 .md 扫进来。

    这条钉的是「闸还管不管得到那一类字」，不是某个具体的字。哪天后缀名单被收窄回
    .py 那一套，内置技能的四份资料就重新变成静默缺字区：开发期看着正常，界面上掉回雅黑。
    """
    sf = _subsetter()
    import inspect
    body = inspect.getsource(sf.source_codepoints)
    assert '".md"' in body, "技能正文是 .md，不在扫描后缀里就是给自己留静默缺字区"
    found = sf.source_codepoints(_SOURCE_ROOTS)
    # 技能正文里的字真的进了请求集合（掤：太极八法之一，不在 GB2312 里，只能靠这一路进来）
    assert ord("掤") in found


def test_shipped_faces_cover_every_character_the_source_asks_for():
    sf = _subsetter()
    requested = sf.source_codepoints(_SOURCE_ROOTS)
    assert requested, "源码一个非 ASCII 字符都没扫到，八成是路径传错了"
    for name, have in _face_cmaps().items():
        missing = requested - have
        unexpected = missing - _BASELINE
        assert not unexpected, (
            f"{name} 缺 {len(unexpected)} 个字：{_fmt(unexpected)}\n"
            "源码用了子集里没有的字符，界面会掉回 Microsoft YaHei，一行里两种脸。\n"
            "修法：跑 frontend/scripts/fetch-fonts.ps1 重新切子集（上游有字就能收进来）；\n"
            "上游确实没有的字符，换成现成的 <Icon> 或普通字符，不要往登记表里塞。"
        )
        # 登记表要能自愈：上游哪天补了字、或者那处文字被换掉了，条目就该删
        stale = (requested & _BASELINE) - missing
        assert not stale, (
            f"{name} 现在认得 {_fmt(stale)} 了，登记表还是当它缺。"
            "重跑过 fetch-fonts.ps1 或改了文案，就把对应条目从登记表里删掉。"
        )


def test_manifest_charset_size_tracks_current_source():
    # manifest 的 codepoints 是「生成那一刻请求了多少码位」。对不上说明源码里的
    # 非 ASCII 字符变了而产物没重新生成——比上面那条更早报警，而且不需要读字体。
    sf = _subsetter()
    requested = (
        sf.range_codepoints() | sf.gb2312_hanzi() | sf.source_codepoints(_SOURCE_ROOTS)
    )
    declared = _manifest()["codepoints"]
    assert len(requested) == declared, (
        f"当前源码请求 {len(requested)} 个码位，fonts-manifest.json 记的是 {declared}。"
        "非 ASCII 文案变了就必须重跑 frontend/scripts/fetch-fonts.ps1 重新生成子集与清单。"
    )

