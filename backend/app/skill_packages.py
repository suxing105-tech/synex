"""技能包：一个目录里的 SKILL.md 加上它的附属文件。

Codex 那种技能不是一个 md 文件，而是一个目录：SKILL.md 写流程，references/ 放资料，
scripts/ 放脚本，assets/ 放图。本模块只做一件事：把这个目录读成一份「能用的技能」——
解析 frontmatter、找出正文、把文本类附属文件拼成参考块。存库在 prompt_skills.py。

两条边界钉在这儿，别改错：
- 脚本不执行。提示词优化这条链路没有工具调用循环，脚本只当参考文本发给模型。
- 二进制（图片、压缩包）只登记不发送：模型吃文字，发过去也是白花钱。
"""
from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path, PurePosixPath

from fastapi import HTTPException

# 只有这些扩展名算「文本」。别的（图片、字体、压缩包）一律只登记名字与大小。
TEXT_SUFFIXES = frozenset({
    ".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".csv", ".tsv", ".py", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".sh", ".bash", ".bat", ".ps1",
    ".html", ".css", ".xml", ".sql", ".tex", ".rst", ".env.example",
})

# 没有扩展名、但确实是文本的文件名。LICENSE / README 这类不写后缀，
# 按扩展名判断会把它们当成二进制，白白丢掉一份协议或说明。
EXTENSIONLESS_TEXT_NAMES = frozenset({
    "license", "licence", "notice", "readme", "changelog", "authors", "contributing",
    "copying", "code_of_conduct", "makefile", "dockerfile", "install", "todo",
})

# 这些目录扫的时候直接跳过：装依赖的、编译产物的、版本库——没一个对写提示词有用，
# 而且能把一次扫描拖成几分钟。
SKIP_DIR_NAMES = frozenset({
    "node_modules", "__pycache__", "dist", "build", "target", "out", "coverage",
    "site-packages", ".venv", "venv", "vendor",
})

MAX_PACKAGE_FILES = 400
MAX_PACKAGE_DEPTH = 6
MAX_PACKAGE_FILE_BYTES = 512_000
MAX_PACKAGE_TOTAL_BYTES = 8_000_000
# 参考资料往系统提示里塞的总预算。超了宁可少带几个文件，也别把模型的上下文吃干。
# 20000 是照「一份风格说明加一两份协议原文」那个量级定的。H3 视频那条内置技能自带四份
# 打斗与镜头资料（实带三万二千多字），20000 会把按路径排序排在后面的两份整份丢掉——
# 正文点名了它们却一份也没附上，正是这个文件开头明令要防的那种缺法。抬到 60000：
# 够装下它 plus 一倍余量给以后的技能，仍然只是模型上下文的一小截。
MAX_REFS_CHARS = 60_000

# 技能压缩包只认 .zip：Python 自带的 zipfile 就够了，不为一件事引第三方库。
# 其余压缩格式认得出来，是为了把「先解压再导」说清楚，
# 而不是让人对着「这里没有 SKILL.md」猜半天——他确实挑了个包。
ARCHIVE_SUFFIXES = frozenset({".zip"})
OTHER_ARCHIVE_SUFFIXES = frozenset({
    ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".jar",
})

# 压缩包里常年跟着跑的垃圾：macOS 的资源分支、Windows 的缩略图缓存。
# 它们和技能无关，偏偏经常把「这个包里到底有没有 SKILL.md」搅浑。
JUNK_NAMES = frozenset({"thumbs.db", "desktop.ini", "pif.json"})
JUNK_DIR_NAMES = frozenset({"__macosx"})

# ZIP 通用位标记的第 11 位：置了才说明条目名是 UTF-8。
ZIP_NAME_IS_UTF8 = 0x800

REFS_HEADER = (
    "\n\n技能包参考资料（这条技能附带的资料，只作风格与规范参考，不是让你照抄的模板）：\n"
)

# frontmatter 只支持最简单那几种写法：key: value、引号、内联列表。
# 为这点事引一个 yaml 依赖不值得——Codex 的 SKILL.md frontmatter 本来也只有这几行。
FRONTMATTER_BLOCK = re.compile(r"^\s*---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)", re.DOTALL)
FM_KEY = re.compile(r"^([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:[ \t]*(.*)$")
QUOTES = "'\"“”「」"


def _clean_value(value: str):
    """去掉值两头的引号；内联列表 [a, b] 折成真列表。"""
    text = str(value or "").strip()
    if text.startswith("[") and text.endswith("]"):
        inner = text[1:-1].strip()
        if not inner:
            return []
        return [item.strip().strip(QUOTES).strip() for item in inner.split(",")]
    if len(text) >= 2 and text[0] in QUOTES and text[-1] in QUOTES:
        text = text[1:-1].strip()
    return text


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """把一份 SKILL.md 拆成「frontmatter 字段 + 正文」。

    字段解析只认顶层 key: value。value 为空说明后面跟着一块缩进内容（嵌套结构），
    这里原样留成字符串——本应用只用 name/description/license 这些平铺字段，
    剩下的原样存进包元数据，不猜它的结构。
    """
    content = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    match = FRONTMATTER_BLOCK.match(content)
    if not match:
        return {}, content.strip()
    block = match.group(1)
    body = content[match.end():].strip()
    fields: dict = {}
    key = None
    nested: list[str] = []

    def flush():
        # 缩进块收尾：没跟内容就保留原来的平铺值，跟了内容就用块盖掉。
        if key is not None and nested:
            fields[key] = "\n".join(nested).strip()

    for line in block.split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        hit = FM_KEY.match(line)
        if hit and not line[:1].isspace():
            flush()
            nested = []
            key = hit.group(1).strip().lower()
            fields[key] = _clean_value(hit.group(2))
        elif key is not None:
            nested.append(line.strip())
    flush()
    return fields, body


def read_text_bytes(blob: bytes) -> str:
    """按 utf-8 读文本，读不动再试 GBK、Big5。

    先试 utf-8-sig 而不是 utf-8：记事本存的 .txt 和不少打包工具写的 SKILL.md
    开头带 BOM，而 BOM 这个字符在 Python 的正则里不算空白，
    行首的 --- 匹配不上，整段 frontmatter 就当成正文发给模型了。
    国内手写的技能说明常是 GBK，直接 errors="replace" 会换回一堆问号。
    """
    for codec in ("utf-8-sig", "gbk", "big5"):
        try:
            return blob.decode(codec)
        except UnicodeDecodeError:
            continue
    return blob.decode("utf-8", errors="replace")


def is_text_path(rel_path: str) -> bool:
    name = PurePosixPath(str(rel_path)).name
    if PurePosixPath(name).suffix.lower() in TEXT_SUFFIXES:
        return True
    return name.lower() in EXTENSIONLESS_TEXT_NAMES


def safe_rel_path(rel_path: str) -> str | None:
    """把上传来的相对路径收拾干净：绝对路径、盘符、.. 一律不要。"""
    raw = str(rel_path or "").replace("\\", "/").strip()
    if not raw or raw.startswith("/"):
        return None
    parts = [part for part in raw.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        return None
    if ":" in parts[0]:
        return None
    return "/".join(parts)


def scan_package_dir(root: str | Path) -> list[dict]:
    """递归读一个技能目录，返回文件清单。

    每项：{"path", "abs", "size", "text", "is_text"}。只读目录内的普通文件，
    不跟符号链接（一个符号链接就能把扫描带出目录），隐藏文件与隐藏目录一律跳过。
    """
    root_path = Path(str(root)).expanduser()
    if not root_path.exists():
        raise HTTPException(422, "这个路径不存在：" + str(root_path))
    if not root_path.is_dir():
        raise HTTPException(422, "这是一个文件，不是技能包文件夹：" + str(root_path))
    entries: list[dict] = []
    total = 0
    stack: list[tuple[Path, str, int]] = [(root_path, "", 0)]
    while stack:
        current, prefix, depth = stack.pop()
        try:
            children = sorted(current.iterdir(), key=lambda item: item.name)
        except OSError:
            continue
        for child in children:
            if child.name.startswith("."):
                continue
            try:
                if child.is_symlink():
                    continue
            except OSError:
                continue
            rel = f"{prefix}/{child.name}" if prefix else child.name
            if child.is_dir():
                if depth + 1 > MAX_PACKAGE_DEPTH:
                    continue
                if child.name.lower() in SKIP_DIR_NAMES:
                    continue
                stack.append((child, rel, depth + 1))
                continue
            try:
                if not child.is_file():
                    continue
                size = child.stat().st_size
            except OSError:
                continue
            if len(entries) >= MAX_PACKAGE_FILES or total + size > MAX_PACKAGE_TOTAL_BYTES:
                continue
            total += size
            entry = {"path": rel, "abs": str(child), "size": size, "text": None, "is_text": False}
            if is_text_path(rel) and size <= MAX_PACKAGE_FILE_BYTES:
                try:
                    entry["text"] = read_text_bytes(child.read_bytes())
                    entry["is_text"] = True
                except OSError:
                    pass
            entries.append(entry)
    return entries


def _rebase(entries: list[dict], skill_md: dict) -> tuple[dict, list[dict]]:
    """把清单重定基到指定那份 SKILL.md 所在的目录。

    命中子目录时，那个子目录之外的文件一律不要——它们不属于这条技能。
    """
    base = skill_md["path"].rsplit("/", 1)[0] if "/" in skill_md["path"] else ""
    if not base:
        return skill_md, entries
    rebased: list[dict] = []
    for item in entries:
        if item["path"] != skill_md["path"] and not item["path"].startswith(base + "/"):
            continue
        copy = dict(item)
        copy["path"] = item["path"][len(base) + 1:]
        rebased.append(copy)
    return next(item for item in rebased if item["path"].lower() == "skill.md"), rebased


def skill_md_paths(entries: list[dict]) -> list[str]:
    """清单里每一份 SKILL.md 的路径，层数浅的在前，同层按路径排。"""
    hits = [item["path"] for item in entries if PurePosixPath(item["path"]).name.lower() == "skill.md"]
    return sorted(hits, key=lambda path: (path.count("/"), path))


def package_at(entries: list[dict], skill_md_path: str) -> tuple[dict, list[dict]]:
    """按点名的那份 SKILL.md 取出这一条技能自己的文件清单。

    一个压缩包里躺着好几条技能（技能合集）时，每条都得用它自己的目录重定基一遍。
    """
    wanted = str(skill_md_path or "").lower()
    chosen = next((item for item in entries if item["path"].lower() == wanted), None)
    if chosen is None:
        raise HTTPException(422, "这份技能包的文件清单不完整，重新导一次")
    return _rebase(entries, chosen)


def pick_skill_md(entries: list[dict]) -> tuple[dict | None, list[dict]]:
    """找出包里最浅的那份 SKILL.md，并把清单重定基到它所在的目录。

    用户挑的文件夹里直接躺着 SKILL.md 是常规；也有人的包还套了一层目录。
    两种都要能认，所以：根目录优先，其次最浅的一个；命中子目录时，
    清单里那个子目录之外的文件一律不要（它们不属于这个技能包）。
    一份目录里有好几条技能时这里只给最浅那一份，多条的拆法在 prompt_skills 那边。
    """
    candidates = skill_md_paths(entries)
    if not candidates:
        return None, entries
    chosen = next(item for item in entries if item["path"] == candidates[0])
    return _rebase(entries, chosen)


def compose_refs_block(entries: list[dict], body: str, skill_path: str = "") -> tuple[str, list[dict], int]:
    """把文本类附属文件拼成一段参考资料，返回（文本块, 每个文件的去处）。

    顺序：SKILL.md 正文里点名过的文件先放（作者显然是想让模型看它的），
    其余按路径排。总预算 MAX_REFS_CHARS，超了整个丢掉并记进去处——丢了要看得见，
    悄悄少给一份资料是最难查的一类问题。
    """
    body_text = str(body or "")
    # 只把「这一条技能自己的 SKILL.md」排除掉。包里的子技能（skills/xxx/SKILL.md）
    # 是另一条技能，它们是正经参考资料，不能跟着被排除。
    texts = [item for item in entries
             if item.get("is_text") and item["path"] != skill_path]

    def priority(item: dict) -> int:
        """点名越具体，排得越前。

        写全了路径（references/style.md）最 specific，只写文件名（style.md）次之，
        指了一整个目录（references/ 下的都算）再次，没提到的最后。
        目录这一种最常见：SKILL.md 里往往只说「参考资料在 references/ 里」。
        """
        path = item["path"]
        base = PurePosixPath(path).name
        if path in body_text:
            return 0
        if base in body_text:
            return 1
        parent = PurePosixPath(path).parent.as_posix()
        if parent not in (".", "") and (parent + "/") in body_text:
            return 2
        return 3

    texts.sort(key=lambda item: (priority(item), item["path"]))
    blocks: list[str] = []
    meta: list[dict] = []
    used = 0
    for item in texts:
        text = item.get("text") or ""
        entry = {"path": item["path"], "size": item.get("size", len(text)),
                 "included": False, "truncated": False, "reason": ""}
        remaining = MAX_REFS_CHARS - used
        if remaining <= 0:
            entry["reason"] = "超出参考预算"
            meta.append(entry)
            continue
        if len(text) > remaining:
            if len(text) > MAX_REFS_CHARS:
                entry["reason"] = "单个文件就超出参考预算"
                meta.append(entry)
                continue
            text = text[:remaining]
            entry["truncated"] = True
        blocks.append("\n--- " + item["path"] + " ---\n" + text)
        used += len(text)
        entry["included"] = True
        entry["chars"] = len(text)
        entry["order"] = len(blocks)
        meta.append(entry)
    for item in entries:
        if item.get("is_text") and not any(m["path"] == item["path"] for m in meta):
            meta.append({"path": item["path"], "size": item.get("size", 0),
                         "included": False, "truncated": False, "reason": "超出参考预算"})
    block = (REFS_HEADER + "".join(blocks)) if blocks else ""
    # 返回的是「正文字数」，不含标题与文件分隔线：预算管的是内容，界面报的字数也该是内容
    return block, meta, used


def refs_separator(path: str) -> str:
    """一份资料在资料块里那一条分隔线。上面那样拼、下面这样切，两边只能有这一颗。"""
    return "\n--- " + str(path) + " ---\n"


def filter_refs_block(block: str, paths: list[str], drop: set[str]) -> tuple[str, list[str]] | None:
    """从一份已经拼好的资料块里摘掉点名的几份，回（剩下的块, 真摘掉的路径）；切不动回 None。

    为什么要能摘「库里拼好的那一份」，而不是按戏种从盘上重拼一遍：资料块只在技能第一次
    进库时拼一次（_seed_builtin 只补新插的那条和清单写了、资料块还空着的半条），升级之后
    盘上的资料换了、库里那份没换。重拼会让武戏发库里那版、文戏发盘上那版，一次优化里
    两套资料，正是本文件开头明令要防的那种缺法。

    切点只认 paths 这张先后表上点名的路径（清单里的 order），不拿 "--- " 满块找：
    资料本身是 Markdown，--- 是水平线，泛着找会切在正文中间。表与块对不上（切点找不到、
    路径重名）时回 None 让调用方原样带——宁可多带几份，也不能把一份资料切一半送进模型。
    """
    if not block:
        return "", []
    if not block.startswith(REFS_HEADER):
        return None
    marks: list[tuple[int, str]] = []             # (分隔线起点, 路径)
    cursor = len(REFS_HEADER)
    for path in paths:
        sep = refs_separator(path)
        at = block.find(sep, cursor)
        if at < 0:
            return None
        marks.append((at, str(path)))
        cursor = at + len(sep)
    if not marks or len(marks) != len({item[1] for item in marks}):
        return None                               # 表是空的或者写了重名：认不出谁是谁，别切
    kept: list[str] = []
    dropped: list[str] = []
    for index, (start, path) in enumerate(marks):
        # 一段资料是「分隔线 + 正文」整块算的：留下它就得连分隔线一起留。
        # 第一版在这里只截了正文，留下那份少了自己那行标题，整块字数对不上——
        # 是 tests 里「少掉的字数必须正好等于摘掉那几份」那条算术断言抓出来的。
        stop = marks[index + 1][0] if index + 1 < len(marks) else len(block)
        if path in drop:
            dropped.append(path)
            continue
        kept.append(block[start:stop])
    if not dropped:
        return block, []
    return (REFS_HEADER + "".join(kept)) if kept else "", dropped


# ---------- 技能压缩包 ----------


def archive_kind(path: str | Path) -> str:
    """这个扩展名是 zip（能读）、别的压缩包（读不了但要说清楚），还是别的。"""
    suffix = Path(str(path)).suffix.lower()
    if suffix in ARCHIVE_SUFFIXES:
        return "zip"
    if suffix in OTHER_ARCHIVE_SUFFIXES:
        return "other"
    return ""


def zip_entry_name(info: zipfile.ZipInfo) -> str:
    """还原压缩包里的文件名。

    通用位标记没置 UTF-8 时，zipfile 已经替我们按 cp437 解过一遍。国内打包的
    中文目录名多半是 GBK 写的，于是中文名字取回来是一串谁也认不出的乱码。补救办法是把它
    按 cp437 编回原字节，再依次试 utf-8 / gbk / big5。
    这一步决定界面上的文件名能不能看，也决定子目录里的 SKILL.md 认不认得出来。
    """
    name = str(info.filename)
    if info.flag_bits & ZIP_NAME_IS_UTF8:
        return name
    try:
        raw = name.encode("cp437")
    except UnicodeEncodeError:
        return name
    for codec in ("utf-8", "gbk", "big5"):
        try:
            return raw.decode(codec)
        except UnicodeDecodeError:
            continue
    return name


def is_junk_entry(rel_path: str) -> bool:
    """压缩包里的 macOS 资源分支、缩略图缓存、依赖目录：不是技能的一部分。"""
    parts = str(rel_path).split("/")
    name = parts[-1].lower()
    if name.startswith("._") or name in JUNK_NAMES:
        return True
    return any(part.lower() in JUNK_DIR_NAMES or part.lower() in SKIP_DIR_NAMES
               for part in parts[:-1])


def scan_package_archive(source, label: str = "") -> list[dict]:
    """读一个 .zip（磁盘路径，或已经在内存里的那份），返回和 scan_package_dir 同形状的清单。

    三条和目录版不同的地方，都是为了「压缩包比目录更容易出事」：
    - 全程不落盘：只在内存里过一遍，落盘交给 prompt_skills 按 id 写进 skills/<id>/。
      解压到临时目录等于多留一份没人认领的垃圾，出事还查不到。
    - 每项多带一个 data：二进制没有文本，但原样留着才写得回去。
    - 先看 ZipInfo 报的 file_size 再决定读不读：不先看的话，
      一个几 GB 的条目就能把内存吃掉，而那本来就该是「跳过」而不是「卡死」。
    上限和目录版共用同一把尺子（文件数 / 深度 / 单文件 / 总量）。
    """
    in_memory = isinstance(source, (bytes, bytearray))
    where = label or ("" if in_memory else str(source))
    try:
        archive = zipfile.ZipFile(io.BytesIO(source) if in_memory else str(source))
    except FileNotFoundError:
        raise HTTPException(422, "这个压缩包已经不在了：" + where)
    except zipfile.BadZipFile:
        raise HTTPException(422, "这个 .zip 打不开，可能还没下完或者坏了：" + where)
    except OSError as exc:
        raise HTTPException(422, "这个压缩包读不了：" + where + "（" + str(exc) + "）")
    entries: list[dict] = []
    total = 0
    with archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            rel = safe_rel_path(zip_entry_name(info).replace("\\", "/"))
            if not rel or is_junk_entry(rel) or rel.count("/") > MAX_PACKAGE_DEPTH:
                continue
            size = int(info.file_size or 0)
            if len(entries) >= MAX_PACKAGE_FILES or total + size > MAX_PACKAGE_TOTAL_BYTES:
                continue
            try:
                blob = archive.read(info)
            except (OSError, RuntimeError, zipfile.BadZipFile):
                continue
            total += len(blob)
            entry = {"path": rel, "abs": "", "size": len(blob), "text": None,
                     "is_text": False, "data": None}
            if is_text_path(rel) and len(blob) <= MAX_PACKAGE_FILE_BYTES:
                entry["text"] = read_text_bytes(blob)
                entry["is_text"] = True
            else:
                entry["data"] = blob
            entries.append(entry)
    return entries
