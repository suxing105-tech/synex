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

import json
import re
import tomllib
from pathlib import Path

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