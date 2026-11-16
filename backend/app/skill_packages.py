"""技能包：一个目录里的 SKILL.md 加上它的附属文件。

Codex 那种技能不是一个 md 文件，而是一个目录：SKILL.md 写流程，references/ 放资料，
scripts/ 放脚本，assets/ 放图。本模块只做一件事：把这个目录读成一份「能用的技能」——
解析 frontmatter、找出正文、把文本类附属文件拼成参考块。存库在 prompt_skills.py。

两条边界钉在这儿，别改错：
- 脚本不执行。提示词优化这条链路没有工具调用循环，脚本只当参考文本发给模型。
- 二进制（图片、压缩包）只登记不发送：模型吃文字，发过去也是白花钱。
"""
from __future__ import annotations

import re
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
MAX_REFS_CHARS = 20_000

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
                    entry["text"] = child.read_text(encoding="utf-8", errors="replace")
                    entry["is_text"] = True
                except OSError:
                    pass
            entries.append(entry)
    return entries


def pick_skill_md(entries: list[dict]) -> tuple[dict | None, list[dict]]:
    """找出包里的 SKILL.md，并把清单重定基到它所在的目录。

    用户挑的文件夹里直接躺着 SKILL.md 是常规；也有人的包还套了一层目录。
    两种都要能认，所以：根目录优先，其次最浅的一个；命中子目录时，
    清单里那个子目录之外的文件一律不要（它们不属于这个技能包）。
    """
    candidates = [item for item in entries
                  if PurePosixPath(item["path"]).name.lower() == "skill.md"]
    if not candidates:
        return None, entries
    candidates.sort(key=lambda item: (item["path"].count("/"), item["path"]))
    chosen = candidates[0]
    base = chosen["path"].rsplit("/", 1)[0] if "/" in chosen["path"] else ""
    if not base:
        return chosen, entries
    rebased: list[dict] = []
    for item in entries:
        if item["path"] != chosen["path"] and not item["path"].startswith(base + "/"):
            continue
        copy = dict(item)
        copy["path"] = item["path"][len(base) + 1:]
        rebased.append(copy)
    return next(item for item in rebased if item["path"].lower() == "skill.md"), rebased


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