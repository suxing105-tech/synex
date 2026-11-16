#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""子集化「寒蝉德黑体 ChillDINGothic」，产出随包分发的三个 woff2 字重。

用法（正常情况由 frontend/scripts/fetch-fonts.ps1 调用，不用手打）：

    backend\\.venv\\Scripts\\python.exe frontend\\scripts\\subset_fonts.py ^
        --src vendor\\fonts\\extracted --out frontend\\src\\assets\\fonts ^
        --face Regular=ChillDINGothic_Regular.ttf:400 ^
        --face Medium=ChillDINGothic_Medium.ttf:500 ^
        --face SemiBold=ChillDINGothic_SemiBold.ttf:600

为什么要自己子集化：上游发布包是整族全字库（多字重 × 多格式），原样进安装包不现实；
但只切「界面用字」又不够——本程序要渲染用户自己的文件名、提示词和文本库正文，
缺字的那几个字会掉回微软雅黑，同一行里出现两种字形，比整段掉字还难看。

所以字符集分三层，每层各挡一种缺字：
1. 拉丁与标点整段收（不按字挑）——英文、数字、全角标点、箭头、几何符号；
2. GB2312 两级常用汉字 6763 字——挡住绝大多数用户中文（文件名、提示词、正文）；
3. 前端源码里出现过的每一个非 ASCII 字符——挡住「界面自己掉字」，连注释一起扫，
   多收几百个字的代价是几十 KB，比线上漏一个字好收拾得多。

改名不是可选步骤：SIL OFL 1.1 的 Reserved Font Name 条款不允许子集沿用原名，
上游有没有声明都照改，内部字族叫 SeekX Sans。授权原文另外随包分发，不靠名字里的署名。
"""
from __future__ import annotations

import argparse
import unicodedata
import hashlib
import json
import sys
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

# 拉丁与标点：按 Unicode 区段整段收。挑字节省不了多少，漏一个标点却很难查。
RANGES: list[tuple[int, int]] = [
    (0x0020, 0x007E),  # ASCII
    (0x00A0, 0x00FF),  # Latin-1（含 × ÷ ° ±）
    (0x0100, 0x017F),  # Latin Extended-A
    (0x2000, 0x206F),  # 通用标点：引号、破折号、省略号
    (0x20A0, 0x20BF),  # 货币
    (0x2150, 0x218F),  # 数字形式
    (0x2190, 0x21FF),  # 箭头
    (0x2200, 0x22FF),  # 数学：≤ ≥ ≈
    (0x2460, 0x24FF),  # 带圈数字
    (0x25A0, 0x25FF),  # 几何图形：▶ ● ■
    (0x2600, 0x27BF),  # 杂项符号
    (0x2E80, 0x2EFF),  # CJK 部首补充
    (0x2F00, 0x2FDF),  # 康熙部首
    (0x3000, 0x303F),  # CJK 标点与符号
    (0x3040, 0x30FF),  # 假名
    (0x3105, 0x312F),  # 注音
    (0x31C0, 0x31EF),  # 笔画
    (0x3200, 0x33FF),  # 带圈 CJK、兼容符号
    (0xFE10, 0xFE19),  # 竖排标点
    (0xFE30, 0xFE4F),  # CJK 兼容形式
    (0xFE50, 0xFE6F),  # 小写变体形式
    (0xFF01, 0xFF60),  # 全角形式
    (0xFFE0, 0xFFE6),  # 全角货币
]


# 非图文码位不进子集：零宽、双向标记、BOM 这些是格式控制符，字体本来就不该有。
# 混进请求集只会让「上游缺字」的报表常年长响，真缺了字反而看不见。
_SKIP_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp", "Zs"})


def is_graphic(cp: int) -> bool:
    if cp == 0x00AD:  # soft hyphen：不渲染，靠连字规则处理
        return False
    if cp in (0x0020, 0x3000):  # 半角空格与全角空格要收
        return True
    try:
        return unicodedata.category(chr(cp)) not in _SKIP_CATEGORIES
    except ValueError:  # 代理区
        return False


def range_codepoints() -> set[int]:
    out: set[int] = set()
    for lo, hi in RANGES:
        out.update(cp for cp in range(lo, hi + 1) if is_graphic(cp))
    return out


def gb2312_hanzi() -> set[int]:
    """GB2312 两级常用汉字（一级 0xB0–0xD7 共 3755，二级 0xD8–0xF7 共 3008）。

    为什么不把「通用规范汉字表」前两级 8105 字抄成清单：抄进仓库就是二十多 KB 的死数据，
    错一位查不出来。GB2312 能用两个字节区间精确框定，编解码 Python 自带，可自证。
    代价是没进 GB2312 的人名用字（堃、翀一类）会掉回系统字体，这是本方案明说的取舍。
    """
    out: set[int] = set()
    for hi in range(0xB0, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                ch = bytes((hi, lo)).decode("gbk")
            except UnicodeDecodeError:
                continue
            cp = ord(ch)
            if 0x4E00 <= cp <= 0x9FFF:
                out.add(cp)
    return out


def source_codepoints(roots: list[Path]) -> set[int]:
    """扫源码里出现过的每个非 ASCII 字符，保证界面自己不缺字。"""
    out: set[int] = set()
    skip_dirs = {"node_modules", "dist", "build", "target", "__pycache__", ".svelte-kit"}
    for root in roots:
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in {".svelte", ".ts", ".js", ".css", ".html", ".py", ".json"}:
                continue
            if skip_dirs & set(path.parts):
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for ch in text:
                cp = ord(ch)
                if cp > 0x7F and is_graphic(cp):
                    out.add(cp)
    return out


def build_charset() -> tuple[set[int], dict[str, int]]:
    parts = {
        "latin+punct": range_codepoints(),
        "gb2312": gb2312_hanzi(),
        "source": source_codepoints(
            [Path("frontend/src"), Path("backend/app")]
        ),
    }
    codes: set[int] = set()
    for group in parts.values():
        codes |= group
    return codes, {k: len(v) for k, v in parts.items()}


def font_chars(font: TTFont) -> set[int]:
    out: set[int] = set()
    for table in font["cmap"].tables:
        out.update(table.cmap.keys())
    return out


def rename(font: TTFont, family: str, subfamily: str, weight: int) -> None:
    """改内部字族名。OFL 的 Reserved Font Name 条款要求改名，这里连 postscript 一起改干净。"""
    unique = f"{family}-{subfamily}"
    postscript = f"{family}{subfamily}".replace(" ", "")
    names = {
        1: family,                       # FontFamily
        2: subfamily,                    # FontSubfamily
        3: unique,                       # UniqueSubfamilyID
        4: f"{family} {subfamily}",      # FullFullName
        6: postscript,                   # PostScriptName
        16: family,                      # TypographicFamily
        17: subfamily,                   # TypographicSubfamily
    }
    record = font["name"]
    for name_id, value in names.items():
        record.setName(value, name_id, 3, 1, 0x0409)   # Windows / BMP
        record.setName(value, name_id, 1, 0, 0)        # Macintosh
    os2 = font["OS/2"]
    os2.usWeightClass = weight
    # fsSelection 的 REGULAR/BOLD 位要跟 CSS 口径一致，不然合成粗体会找错面
    os2.fsSelection = (os2.fsSelection & ~0x60) | (0x20 if weight >= 700 else 0x40)
    # head.macStyle 的 bold 位必须跟 OS/2.fsSelection 一致，否则 fontTools 直接警告「两位不匹配」。
    # 上游 Bold 自己就是矛盾的（usWeightClass 700，但 fsSelection 和 macStyle 都没标 bold），
    # 我们既然按 weight 重写了 fsSelection，就得连 macStyle 一起补平，别把警告留给下一轮。
    head = font["head"]
    head.macStyle = (head.macStyle & ~1) | (1 if weight >= 700 else 0)


def subset_one(src: Path, out: Path, codes: set[int], family: str, subfamily: str, weight: int) -> None:
    font = TTFont(str(src), fontNumber=0, lazy=False)
    opts = Options()
    opts.flavor = "woff2"
    # layout_features 全留：页脚那几处 font-variant-numeric: tabular-nums 靠 tnum 生效，
    # CJK 的地区字形也要 GSUB locl，砍特性省不了多少却会悄悄改字形。
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    opts.hinting = True
    opts.desubroutinize = True
    opts.drop_tables = list(opts.drop_tables) + ["DSIG"]
    subsetter = Subsetter(options=opts)
    subsetter.populate(unicodes=sorted(codes))
    subsetter.subset(font)
    rename(font, family, subfamily, weight)
    # flavor 不是 Subsetter 的活，是 save 时的编码选择：只设 Options().flavor 会得到一只
    # 普通 CFF/OTF，浏览器照样能加载，但 app.css 里那句 format("woff2") 就成了谎话，
    # 而且体积白胖一倍。必须在这里落到 font 上（font-bundle.test.ts 会验 wOF2 签名）。
    font.flavor = "woff2"
    out.parent.mkdir(parents=True, exist_ok=True)
    font.save(str(out))


def font_copyrights(font: TTFont) -> list[str]:
    """取字体自带的版权声明（nameID 0）。OFL 要求版权声明跟着字体走，这里不自己编。"""
    seen: list[str] = []
    for rec in font["name"].names:
        if rec.nameID != 0:
            continue
        value = str(rec).strip()
        if value and value not in seen:
            seen.append(value)
    return seen


def compose_license(template: Path, dest: Path, copyrights: list[str], note: str) -> None:
    """用官方 OFL 1.1 原文 + 本字体自己的版权声明，拼出随包分发的授权文件。

    OFL 1.1 只允许把抬头里的日期/版权人/字族名换成实际值，正文一个字不许改，
    所以这里的做法是：丢掉官方模板里的占位抬头，换成字体 name 表里的真实版权声明，
    再接上从「This Font Software is licensed under…」起的原文。
    """
    text = template.read_text(encoding="utf-8")
    marker = "This Font Software is licensed under the SIL Open Font License, Version 1.1."
    at = text.index(marker)
    body = text[at:]
    header = "\n".join(copyrights) + "\n\n" + note.strip() + "\n\n"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(header + body, encoding="utf-8")


def font_family_names(font: TTFont) -> list[str]:
    """字体自报的字族名（含中文名）。上游名字怎么拼不该由我们抄，抄了就会抄错。"""
    seen: list[str] = []
    for rec in font["name"].names:
        if rec.nameID not in (1, 16):
            continue
        value = str(rec).strip()
        if value and value not in seen:
            seen.append(value)
    return seen


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--src", required=True, help="上游字体原件所在目录")
    ap.add_argument("--out", required=True, help="woff2 输出目录（前端 assets）")
    ap.add_argument(
        "--face",
        action="append",
        required=True,
        metavar="STEM=FILE:WEIGHT",
        help="一个字重一条，如 Regular=ChillDINGothic_Regular.ttf:400",
    )
    ap.add_argument("--family", default="SeekX Sans", help="改名后的内部字族名")
    ap.add_argument("--upstream", default="", help="上游名字，写进 manifest")
    ap.add_argument("--version", default="", help="上游版本号，写进 manifest")
    ap.add_argument("--url", default="", help="上游下载地址，写进 manifest")
    ap.add_argument("--archive-sha256", default="", help="上游 zip 的 sha256")
    ap.add_argument("--license", default="vendor/fonts/OFL-1.1.txt", help="官方 OFL 1.1 原文模板")
    ap.add_argument("--license-name", default="OFL-SeekX-Sans.txt")
    ap.add_argument("--budget-kb", type=int, default=12288, help="三档合计体积上限（KB），超了硬失败")
    args = ap.parse_args()

    src_dir = Path(args.src)
    out_dir = Path(args.out)
    codes, groups = build_charset()
    print(f"==> 字符集 {len(codes)} 码位（{', '.join(f'{k} {v}' for k, v in groups.items())}）")

    # 上游缺哪些码位是字族层面的事实，报一次就够，别按字重重复三遍。
    probe = TTFont(str(src_dir / args.face[0].split("=", 1)[1].rsplit(":", 1)[0]), fontNumber=0, lazy=True)
    missing = sorted(codes - font_chars(probe))
    if missing:
        print(
            f"    ! 上游字族缺 {len(missing)} 个码位，这些字符会掉给栈里的下一个字体"
            f"（多为全角字母数字、生僻符号与排版空格）："
            f" {''.join(chr(c) for c in missing[:60])}",
            file=sys.stderr,
        )

    faces = []
    for spec in args.face:
        stem, _, rest = spec.partition("=")
        filename, _, weight = rest.rpartition(":")
        faces.append((stem.strip(), filename.strip(), int(weight)))

    files = []
    for stem, filename, weight in faces:
        src = src_dir / filename
        if not src.is_file():
            print(f"ERROR 找不到上游原件：{src}", file=sys.stderr)
            return 2
        out = out_dir / f"seekx-sans-{stem.lower()}.woff2"
        print(f"==> {stem} ({weight}) ← {filename}")
        subset_one(src, out, codes, args.family, stem, weight)
        size = out.stat().st_size
        print(f"    {out.as_posix()}  {size / 1024:.0f} KB")
        files.append(
            {
                "file": out.name,
                "subfamily": stem,
                "weight": weight,
                "bytes": size,
                "sha256": sha256(out),
            }
        )

    total = sum(f["bytes"] for f in files)
    print(f"==> 合计 {total / 1024 / 1024:.2f} MB（预算 {args.budget_kb / 1024:.0f} MB）")

    lic_template = Path(args.license)
    if not lic_template.is_file():
        print(
            "ERROR OFL 模板不存在：" + str(lic_template),
            file=sys.stderr,
        )
        return 2
    first = probe
    note = (
        "本程序随包分发的字体是上述字体的子集化改名版，内部字族名 " + args.family + "："
        "只保留界面与常用中文所需码位，并去掉未用到的字重。\n"
        "上游：" + args.upstream + " " + args.version + "（" + args.url + "）。"
        "改名依据 OFL 1.1 的 Reserved Font Name 条款——子集不得沿用原字族名。"
    )
    dest = Path("frontend/src-tauri/resources") / args.license_name
    compose_license(lic_template, dest, font_copyrights(first), note)
    print("==> 授权文件 → " + dest.as_posix() + "（" + str(dest.stat().st_size) + " 字节）")

    manifest = {
        "family": args.family,
        "upstream": {
            "name": args.upstream,
            "familyNames": font_family_names(first),
            "version": args.version,
            "url": args.url,
            "archiveSha256": args.archive_sha256,
        },
        "renamedBecause": "SIL OFL 1.1 Reserved Font Name：子集不得沿用原字族名",
        "codepoints": len(codes),
        "charsetGroups": groups,
        "totalBytes": total,
        "licenseFile": "frontend/src-tauri/resources/" + args.license_name,
        "files": files,
    }
    (out_dir / "fonts-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"==> {out_dir.as_posix()}/fonts-manifest.json")

    if total > args.budget_kb * 1024:
        print("ERROR 子集体积超出预算，收紧字符集或减字重", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())