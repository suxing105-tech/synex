"""提示词优化技能：把「按某套写法把人已写好的提示词改一遍」做成可编辑、可导入的技能。

为什么不复用反推那条 instruction：反推是「看图写话」，优化是「改写人已写下的话」，
两件事的要求正好相反——一个要凭空补全画面，一个要求不许增删原意。塞进同一条指令
只会两头都做不好，所以另起一张技能表；用哪个模型不在这里另配，继续吃反推的默认模型
（reverse_prompt_settings.default_model_id），设置页只有一处「默认模型」要维护。
"""
from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path, PurePosixPath

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from . import db, reverse_prompts, skill_packages
from .config import skills_dir

KINDS = ("image", "video")
KIND_WORDS = {"image": "图片", "video": "视频"}
LANGUAGES = ("auto", "zh", "en")

MAX_NAME = 60
MAX_NOTE = 200
MAX_INSTRUCTION = 300000
# 2026-11-16 苏醒：技能原文要完整加载，不许悄悄切一刀。这个上限只管「大到不像一条技能」，
# 不管「模型一次读得完」——真长到模型装不下，那一次优化会当场报错，
# 比在编辑器里少半篇原文好查得多。
# 一次导入最多几个来源：整摞技能拖进来的上限，超了就是选错了。
MAX_IMPORT_SOURCES = 20
# 撞名时的三种处理。默认先问——替换会覆盖人写过的东西。
CONFLICT_MODES = ("ask", "replace", "new")
MAX_MARKDOWN_BYTES = 2_000_000
# 浏览器上传压缩包的字节上限。真正进门的闸在 skill_packages 那四条总量限制上，
# 这一条只是别让一个几百 MB 的文件先进内存。
MAX_ARCHIVE_BYTES = 64_000_000
MARKDOWN_SUFFIXES = frozenset({".md", ".markdown", ".txt"})
OTHER_ARCHIVE_HINT = "压缩包只支持 .zip：先把它解压出来，再挑里面的 SKILL.md 或技能包文件夹"
SOURCE_HINT = "只认 .md/.markdown/.txt 和 .zip，或者一整个技能包文件夹"
# 一次优化最多带几张参考图。再多既慢又贵，而提示词里的引用编号本来就到不了十几。
MAX_REF_IMAGES = 16
# 参考图 data URL 的总长度上限（base64 字符数，约等于 9MB 原图）。超了就按顺序少带后面的几张：
# 服务商报 413 只会回一句含糊的「拒绝了图片大小」，用户看不出是图太多。
MAX_REF_PAYLOAD = 12_000_000

SCHEMA = """
CREATE TABLE IF NOT EXISTS prompt_skills (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
 kinds TEXT NOT NULL DEFAULT 'image,video', instruction TEXT NOT NULL,
 language TEXT NOT NULL DEFAULT 'auto', with_refs INTEGER NOT NULL DEFAULT 1,
 builtin_key TEXT, sort INTEGER NOT NULL DEFAULT 0,
 source TEXT NOT NULL DEFAULT 'manual', package_dir TEXT, package_meta TEXT, package_refs TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS prompt_skill_settings (
 id INTEGER PRIMARY KEY CHECK(id=1),
 default_image_skill INTEGER REFERENCES prompt_skills(id) ON DELETE SET NULL,
 default_video_skill INTEGER REFERENCES prompt_skills(id) ON DELETE SET NULL
);
"""

DEFAULT_IMAGE_INSTRUCTION = """你是资深 AI 生图提示词工程师。把你收到的提示词改写成一段更容易出好图的生图提示词。
1. 原意是底线：主体、动作、场景、风格指向一律不改，不新增原文没有的角色、道具、品牌、名人。
2. 按这个顺序写成一整段连贯的自然语言：图片用途与整体风格 → 构图、景别与机位 → 主体的动作、材质与神情 → 场景的前景中景后景 → 光线与影调 → 色调 → 情绪氛围。原文已经写明的细节保留原话，缺的按画面常理补齐，不要为凑字数把同一件事说两遍。
3. 只写画面里看得见的内容。「高质量」「大师作品」「细节丰富」这类没有指向的词不要加。
4. 删掉对出图没用的写法：猜测的参数（Seed、采样器、步数、模型名）、否定式要求（「不要出现……」）、以及写给人看的说明和客套。"""

DEFAULT_VIDEO_INSTRUCTION = """你是资深 AI 视频生成提示词工程师。把你收到的提示词改写成视频模型更好执行的提示词。
1. 原意是底线：主体、场景、风格与已有的镜头安排一律不改，不新增原文没有的角色、道具、品牌、名人。
2. 视频模型吃的是运动与时间：主体做什么动作、动作的方向和幅度、镜头怎么动（推、拉、摇、移、跟、固定）、景别是否变化、光线和氛围随时间怎么变，都要写明白；静止的画面描述只留必要的部分。
3. 原文按镜头分段的，保持分段和先后顺序，一段一个镜头；原文没分段的不要替他切。
4. 台词、字幕、旁白这类要出声的内容原样保留，不改写、不翻译。
5. 删掉对生成没用的写法：猜测的参数、否定式要求、以及写给人看的说明和客套。"""

BUILTINS: tuple[dict, ...] = (
    {
        "builtin_key": "image_default",
        "name": "图片提示词增强",
        "note": "补齐构图、光影、材质，不改原意",
        "kinds": ("image",),
        "instruction": DEFAULT_IMAGE_INSTRUCTION,
    },
    {
        "builtin_key": "video_default",
        "name": "视频提示词增强",
        "note": "写清动作与镜头运动，保留原有分段",
        "kinds": ("video",),
        "instruction": DEFAULT_VIDEO_INSTRUCTION,
    },
)

# 引用标记是这个弹窗的硬通货：@图片N 与 <Picture N> 都指「第 N 格参考」。模型一旦把它们
# 改写或吃掉，参考就悄悄不生效了，而出来的图照样像那么回事——最难查的就是这种。
MARK_RULE = (
    "3. 原文里的引用标记——@图片1、@视频1、@音频1、图1、@Image 1、@Video 1、"
    "<Picture 1>、<Video 1>、<Audio 2> 这一类编号记号——必须原样保留："
    "编号不改、不删、不新增，也不换成另一种写法。"
)
LANGUAGE_RULES = {
    "auto": "4. 输出语言跟随原文：原文以中文为主就出中文，以英文为主就出英文。",
    "zh": "4. 输出中文。",
    "en": "4. Output in English.",
}
OUTPUT_RULE = (
    "\n\n输出要求（四条都要满足）：\n"
    "1. 只返回优化后的提示词正文，从第一个字到最后一个字都是提示词本身。\n"
    "2. 不要解释、不要复述这些要求、不要说「好的」，不要加引号、代码块、标题、编号前缀或任何前后缀。\n"
    + MARK_RULE
    + "\n{language}"
)
REF_NOTE = (
    "参考素材按编号依次附在下面（图 N 就是提示词里的第 N 格参考，@图片N 与 <Picture N> 指的是它）。"
    "看图只为了核对画面里到底有什么，别照着图另写一份画面描述。\n\n"
)


def initialize(conn):
    conn.executescript(SCHEMA)
    # 技能包那四列是后加的：新库建表时就有，老库得补。老行补完全是 'manual'——
    # 「这条不是包来源」这件事不能猜，猜错就是把普通技能当成包删了。
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(prompt_skills)").fetchall()}
    if "source" not in columns:
        conn.execute("ALTER TABLE prompt_skills ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
    if "package_dir" not in columns:
        conn.execute("ALTER TABLE prompt_skills ADD COLUMN package_dir TEXT")
    if "package_meta" not in columns:
        conn.execute("ALTER TABLE prompt_skills ADD COLUMN package_meta TEXT")
    if "package_refs" not in columns:
        conn.execute("ALTER TABLE prompt_skills ADD COLUMN package_refs TEXT")
    conn.execute("INSERT OR IGNORE INTO prompt_skill_settings(id) VALUES(1)")
    # 按 builtin_key 补齐：老库升级、以及内置技能被改坏之外没有别的路径能造出内置技能。
    # 已经在的一律不动——用户改过的写法比我们的默认值值钱。
    for index, seed in enumerate(BUILTINS):
        if conn.execute("SELECT id FROM prompt_skills WHERE builtin_key=?", (seed["builtin_key"],)).fetchone():
            continue
        conn.execute(
            "INSERT INTO prompt_skills(name,note,kinds,instruction,language,with_refs,builtin_key,sort)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (seed["name"], seed["note"], ",".join(seed["kinds"]), seed["instruction"], "auto", 1,
             seed["builtin_key"], (index + 1) * 10),
        )


def builtin_seed(builtin_key):
    return next((seed for seed in BUILTINS if seed["builtin_key"] == builtin_key), None)


def kinds_of(value) -> list[str]:
    """库里的 csv 读成列表：认不出的值丢掉，全认不出就当图片族（至少界面上还有得选）。"""
    picked = [kind for kind in KINDS if kind in [part.strip() for part in str(value or "").split(",")]]
    return picked or ["image"]


def normalize_kinds(values) -> str:
    if isinstance(values, str):
        values = [part.strip() for part in values.split(",")]
    picked = [kind for kind in KINDS if kind in list(values or [])]
    if not picked:
        raise HTTPException(422, "技能至少要适用图片或视频其中一族")
    return ",".join(picked)


def public(row):
    return {
        "id": row["id"], "name": row["name"], "note": row["note"], "kinds": kinds_of(row["kinds"]),
        "instruction": row["instruction"], "language": row["language"], "with_refs": bool(row["with_refs"]),
        "builtin_key": row["builtin_key"], "sort": row["sort"], "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "source": row["source"], "package_dir": row["package_dir"],
        "package": json.loads(row["package_meta"]) if row["package_meta"] else None,
    }


def list_skills():
    rows = db.get_pool().main().execute("SELECT * FROM prompt_skills ORDER BY sort, id").fetchall()
    return [public(row) for row in rows]


def get_skill(skill_id: int):
    row = db.get_pool().main().execute("SELECT * FROM prompt_skills WHERE id=?", (skill_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "这条技能不存在，可能刚被删掉")
    return row


def clean_name(value):
    name = str(value or "").strip()
    if not name:
        raise HTTPException(422, "技能名字不能为空")
    if len(name) > MAX_NAME:
        raise HTTPException(422, "技能名字最长 " + str(MAX_NAME) + " 个字")
    return name


def clean_instruction(value):
    instruction = str(value or "").strip()
    if not instruction:
        raise HTTPException(422, "技能的写法不能为空")
    if len(instruction) > MAX_INSTRUCTION:
        raise HTTPException(422, "技能写法最长 " + str(MAX_INSTRUCTION) + " 字，太长的指令模型记不住")
    return instruction


def clean_language(value):
    language = str(value if value is not None else "auto").strip()
    if language not in LANGUAGES:
        raise HTTPException(422, "输出语言只能是跟随原文、中文或英文")
    return language


def save_skill(values: dict, skill_id: int | None = None):
    """建或改一条技能。只动 values 里出现过的字段——改名字不该把写法一起冲掉。"""
    conn = db.get_pool().main()
    if skill_id is not None:
        get_skill(skill_id)
    columns: dict = {}
    if "name" in values:
        columns["name"] = clean_name(values["name"])
    if "note" in values:
        columns["note"] = str(values["note"] or "").strip()[:MAX_NOTE]
    if "instruction" in values:
        columns["instruction"] = clean_instruction(values["instruction"])
    if "language" in values:
        columns["language"] = clean_language(values["language"])
    if "kinds" in values:
        columns["kinds"] = normalize_kinds(values["kinds"])
    if "with_refs" in values:
        columns["with_refs"] = 1 if values["with_refs"] else 0

    if skill_id is None:
        # 新建必须有名字和写法：缺任何一条都会立刻得到一颗点了没反应的死按钮。
        columns["name"] = clean_name(values.get("name"))
        columns["instruction"] = clean_instruction(values.get("instruction"))
        columns.setdefault("kinds", ",".join(KINDS))
        columns.setdefault("language", "auto")
        columns.setdefault("with_refs", 1)
        # source 只在建的时候定：'md' 是导入的单个文件，'package' 是技能包。
        # 改技能内容不该改来源——来源决定的是「删它的时候连带删什么」。
        if values.get("source"):
            columns["source"] = str(values["source"])
        sort = conn.execute("SELECT COALESCE(MAX(sort),0)+10 FROM prompt_skills").fetchone()[0]
        keys = list(columns)
        with db.transaction() as tx:
            record_id = tx.execute(
                "INSERT INTO prompt_skills(" + ",".join(keys) + ",sort) VALUES("
                + ",".join(["?"] * len(keys)) + ",?)",
                (*columns.values(), sort),
            ).lastrowid
    else:
        if columns:
            assignment = ",".join(key + "=?" for key in columns)
            with db.transaction() as tx:
                tx.execute(
                    "UPDATE prompt_skills SET " + assignment + ","
                    "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
                    (*columns.values(), skill_id),
                )
        record_id = skill_id
    return public(get_skill(record_id))


def delete_skill(skill_id: int):
    row = get_skill(skill_id)
    if row["builtin_key"]:
        raise HTTPException(409, "内置技能不能删除：可以改成自己的写法，或恢复默认")
    with db.transaction() as tx:
        tx.execute("DELETE FROM prompt_skills WHERE id=?", (skill_id,))
    # 包是随这条技能一起进来的，删技能就把它一起带走：留着的是没人认领的一堆文件。
    remove_package_dir(_row_get(row, "package_dir"))
    return {"deleted": skill_id}


def restore_default(skill_id: int):
    row = get_skill(skill_id)
    seed = builtin_seed(row["builtin_key"]) if row["builtin_key"] else None
    if seed is None:
        raise HTTPException(409, "只有内置技能有默认写法可恢复")
    with db.transaction() as tx:
        tx.execute(
            "UPDATE prompt_skills SET name=?,note=?,kinds=?,instruction=?,language='auto',with_refs=1,"
            "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
            (seed["name"], seed["note"], ",".join(seed["kinds"]), seed["instruction"], skill_id),
        )
    return public(get_skill(skill_id))



FRONTMATTER = re.compile(r"^\s*---\s*\r?\n.*?\r?\n---\s*(\r?\n|$)", re.DOTALL)
FIELD_NAME = re.compile(r"^name\s*:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
HEADING = re.compile(r"^\s*#{1,6}\s*(.+?)\s*$", re.MULTILINE)
# YAML 里 name: "xxx" 很常见，名字两头常带引号。这里只剥引号，不改一个字。
QUOTES = """'"“”「」"""


def parse_import(content: str, filename: str = "") -> dict:
    """把一份 SKILL.md 读成「名字 + 完整正文」：原文一个字都不切。

    开头那坨 YAML frontmatter 是给 agent 装载器看的（name/description/license），
    发给生图模型只是噪音，而且第一行就是 --- 会让模型以为自己收到了文档结构。
    """
    text = str(content or "").replace("\r\n", "\n").replace("\r", "\n")
    body = FRONTMATTER.sub("", text, count=1).strip()
    name = ""
    for pattern in (FIELD_NAME, HEADING):
        hit = pattern.search(text[:4000])
        if hit:
            name = hit.group(1).strip().strip(QUOTES).strip()
            if name:
                break
    if not name and filename:
        stem = re.sub(r"\.(md|markdown|txt)$", "", str(filename).replace("\\", "/").rsplit("/", 1)[-1],
                      flags=re.IGNORECASE).strip()
        name = stem.strip(QUOTES).strip()
    if not body:
        raise HTTPException(422, "这份文件里没有可用的正文，换一份 SKILL.md 或直接新建一条技能")
    return {"name": (name or "导入的技能")[:MAX_NAME], "instruction": body}


def fit_name(value) -> str:
    """名字长了截短，不拒收。

    名字是从 frontmatter 的标题拿的，作者写的是文档标题不是输入框，长是常态。
    拒了等于让人先改一遍自己的文件，再白跑一趟。
    """
    name = str(value or "").strip()
    if len(name) > MAX_NAME:
        name = name[:MAX_NAME].rstrip()
    return clean_name(name)


def unique_name(base: str) -> str:
    """撞名就加序号：撞名时报一句「已存在」等于让人先改名再白跑一趟。"""
    base = fit_name(base)
    taken = {row["name"] for row in db.get_pool().main().execute("SELECT name FROM prompt_skills").fetchall()}
    name, suffix = base, 1
    while name in taken:
        suffix += 1
        name = base[:MAX_NAME - len(str(suffix)) - 4] + " (" + str(suffix) + ")"
    return name


def _target_name(base: str, replace_skill_id: int | None) -> str:
    """替换就沿用原来那个名字（不加序号），新建才避让。"""
    return fit_name(base) if replace_skill_id is not None else unique_name(base)


# ---------- 导入：一个入口，四种送法 ----------
#
# 四条送法（桌面挑文件或拖路径、浏览器挑文件、浏览器传压缩包、浏览器选文件夹）
# 最后都汇到 _finish 一个口：先解析成「待导入」，再判撞名，最后才写。
# 前面几步一律不碰库，「先问一句再动手」才做得到——
# 一边写一边才发现撞名，就没有反悔的余地了。


def _md_candidate(content: str, filename: str = "", source_dir: str = "") -> dict:
    """一份 SKILL.md 文本 → 一条待导入的技能。"""
    parsed = parse_import(content, filename)
    return {
        "kind": "md",
        "label": str(filename or parsed["name"]),
        "source_dir": source_dir,
        "name": parsed["name"],
        "note": "从文件导入",
        "instruction": parsed["instruction"],
    }


def _commit_md(candidate: dict, replace_skill_id: int | None = None) -> dict:
    """一份 md 落成一条技能：只带写法，不带包。"""
    name = _target_name(candidate["name"], replace_skill_id)
    values = {"name": name, "note": candidate["note"], "instruction": candidate["instruction"]}
    if replace_skill_id is None:
        skill_id = save_skill({**values, "source": "md"})["id"]
    else:
        old = get_skill(replace_skill_id)
        save_skill(values, replace_skill_id)
        skill_id = replace_skill_id
        # 换成一份孤立的 md，上一版的包要一起带走：库里这条已经不会再读它了，
        # 留在盘上就是没人认领、也没人删得掉的一堆文件
        with db.transaction() as tx:
            tx.execute("UPDATE prompt_skills SET source='md',package_dir=NULL,package_meta=NULL,"
                       "package_refs=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
                       (skill_id,))
        remove_package_dir(_row_get(old, "package_dir"))
    return {**public(get_skill(skill_id)), "replaced": replace_skill_id is not None}


# ---------- 技能包 ----------

def _row_get(row, key: str, default=""):
    """按列名取值，缺列就返回默认值：dict 与 sqlite3.Row 两种形状都吃得下。"""
    try:
        value = row[key]
    except (KeyError, IndexError):
        return default
    return default if value is None else value


def remove_package_dir(package_dir: str | None) -> None:
    """删技能时把它落盘的包目录一起删掉。

    只删 skills/ 底下自己的那个目录：路径是库里的旧值，万一被人手改过，
    不能让它顺着删到别处去。
    """
    if not package_dir:
        return
    try:
        root = skills_dir().resolve()
        target = Path(package_dir).resolve()
    except OSError:
        return
    if target == root or root not in target.parents:
        return
    shutil.rmtree(target, ignore_errors=True)


def _package_manifest(entries: list[dict], files_meta: list[dict], skill_path: str = "") -> list[dict]:
    """清单：包里每个文件最后去了哪儿。

    三种角色分清楚，界面上才不会把「这条技能本身」说成「被预算挤掉」：
    - 写法：SKILL.md，正文就是这条技能的写法，不算参考资料；
    - 参考：文本类附属文件，能进资料块；
    - 资源：二进制（图片、字体），只登记，不发给模型。
    丢了要看得见——悄悄少给模型一份资料，是最难查的一类问题。
    """
    by_path = {item["path"]: item for item in files_meta}
    manifest: list[dict] = []
    for item in entries:
        path = item["path"]
        # 只有「这一条技能自己的」SKILL.md 算写法；包里的子技能是另一条技能，算参考资料。
        if path == skill_path:
            manifest.append({"path": path, "size": item.get("size", 0), "role": "写法",
                             "included": False, "truncated": False, "reason": "就是这条技能的写法"})
            continue
        hit = by_path.get(path)
        if hit is None:
            manifest.append({"path": path, "size": item.get("size", 0), "role": "资源",
                             "included": False, "truncated": False, "reason": "二进制文件，不发给模型"})
        else:
            manifest.append({"path": hit["path"], "size": item.get("size", 0), "role": "参考",
                             "included": bool(hit.get("included")), "truncated": bool(hit.get("truncated")),
                             "reason": hit.get("reason", ""), "order": hit.get("order", 0)})
    return manifest


def _package_candidates(root_name: str, entries: list[dict], source_dir: str) -> list[dict]:
    """一份文件清单里有几条待导入的技能。只解析，一个字都不写。

    按「SKILL.md 在第几层」分三种情形：
    - 根目录就有一份：整包就是这一条技能，里面再套的 SKILL.md 算参考资料
      （老口径，不动——别人把一个技能套在 skills/ 下是常事）；
    - 根目录没有、最浅那一层只有一份：那一条就是它，更深一层算参考资料；
    - 最浅那一层有好几份：这是一摞技能打包在一起的合集，一次全导进来，一份一条。
      挑一个 .zip 只进来一条、剩下的得在界面上一个个再导，谁都会以为包坏了。
    """
    paths = skill_packages.skill_md_paths(entries)
    if not paths:
        raise HTTPException(422, "这里没有 SKILL.md：技能包或压缩包里得放着 SKILL.md")
    shallowest = paths[0].count("/")
    roots = [path for path in paths if path.count("/") == shallowest]
    if shallowest == 0 or len(roots) == 1:
        roots = roots[:1]
    return [_package_candidate(root_name, entries, path, source_dir) for path in roots]


def _package_candidate(root_name: str, entries: list[dict], skill_md_path: str, source_dir: str) -> dict:
    """把清单里指定的那份 SKILL.md 和它自己的文件读成一条待导入的技能。"""
    skill_md, own = skill_packages.package_at(entries, skill_md_path)
    fields, body = skill_packages.parse_frontmatter(skill_md.get("text") or "")
    body = (body or "").strip()
    if not body:
        raise HTTPException(422, "SKILL.md 里没有正文，换一份或直接新建一条技能")
    # 一摞技能各自有自己的目录名；只有一条时还是用用户挑的那个文件夹/压缩包的名字
    root = PurePosixPath(skill_md_path).parent.name or root_name
    return {
        "kind": "package",
        "label": source_dir or root,
        "root_name": root,
        "source_dir": source_dir,
        "name": str(fields.get("name") or root),
        "note": str(fields.get("description") or "").strip()[:MAX_NOTE],
        "body": body,
        "fields": fields,
        "entries": own,
        "skill_path": skill_md.get("path") or "",
    }


def _write_package_dir(skill_id: int, entries: list[dict], *, replacing: bool) -> str:
    """把包里的文件原样存一份到 skills/<id>/，返回那个目录。

    替换时先写进 skills/<id>.new/，写成了才把旧的换掉：直接在原目录上写，
    写到一半失败就是「库里还有这条技能，包却只剩半截」那种查不出来的脏状态。
    二进制走 data（压缩包来的），目录来的走 abs 原路径复制。
    """
    root = skills_dir()
    target = root / (str(skill_id) + ".new" if replacing else str(skill_id))
    shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True, exist_ok=True)
    for item in entries:
        rel = skill_packages.safe_rel_path(item.get("path") or "")
        if not rel:
            continue
        dest = target / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if item.get("is_text") and item.get("text") is not None:
            dest.write_text(item["text"], encoding="utf-8")
        elif item.get("data") is not None:
            dest.write_bytes(item["data"])
        elif item.get("abs"):
            try:
                shutil.copy2(item["abs"], dest)
            except OSError:
                pass
    if not replacing:
        return str(target)
    final = root / str(skill_id)
    # 这里不 ignore_errors：旧目录被占着就该当场说话，
    # 而不是把「删不掉旧目录」糊成后面那次 rename 的一句怪错
    shutil.rmtree(final)
    try:
        target.rename(final)
    except OSError:
        shutil.rmtree(target, ignore_errors=True)
        raise
    return str(final)


def _commit_package(candidate: dict, replace_skill_id: int | None = None) -> dict:
    """一条待导入的技能包 → 库里的技能。

    替换那一路的顺序是挑过的：文件先写成功，才动库里那条。
    反过来做，落盘一失败就把人本来能用的写法改没了。
    """
    entries = candidate["entries"]
    fields = candidate["fields"]
    skill_path = candidate["skill_path"]
    body = candidate["body"]
    # 超长要在这儿就说，不能留给 save_skill 去拒：替换那一路是「新包先顶掉旧目录、再写库」，
    # 晚一步就变成旧包没了、库里还留着旧写法，两头都对不上。
    if len(body) > MAX_INSTRUCTION:
        raise HTTPException(422, "这条技能的原文有 " + str(len(body)) + " 字，超过单条技能上限 "
                                 + str(MAX_INSTRUCTION) + " 字，先把它拆成几条再导")
    # 资料优先级按正文点名判断，所以正文得是完整的：切掉后半截，
    # 「作者想让我们看什么」就被切掉一半（2026-11-16 起正文一律不切）。
    refs_block, files_meta, refs_chars = skill_packages.compose_refs_block(entries, body, skill_path)

    old = get_skill(replace_skill_id) if replace_skill_id is not None else None
    skill_id = replace_skill_id if old is not None else save_skill(
        {"name": unique_name(candidate["name"]), "note": candidate["note"],
         "instruction": body, "source": "package"})["id"]
    try:
        package_dir = _write_package_dir(skill_id, entries, replacing=old is not None)
    except OSError as exc:
        if old is None:
            with db.transaction() as tx:
                tx.execute("DELETE FROM prompt_skills WHERE id=?", (skill_id,))
        raise HTTPException(500, "技能包落盘失败：" + str(exc))
    if old is not None:
        save_skill({"name": _target_name(candidate["name"], skill_id), "note": candidate["note"],
                    "instruction": body}, skill_id)
        # 旧目录在上一步已经被 staging 顶掉了：换包时 rmtree(正主) + rename，
        # 再按老值删一次，删的就是刚写好的那一份。只有旧值指向别处（老库存过旁路）
        # 才需要另外清一次。
        stale = _row_get(old, "package_dir")
        if stale and _norm_path(stale) != _norm_path(package_dir):
            remove_package_dir(stale)

    manifest = _package_manifest(entries, files_meta, skill_path)
    meta = {
        "root": candidate["root_name"],
        "source_dir": candidate["source_dir"],
        "description": str(fields.get("description") or ""),
        "license": str(fields.get("license") or ""),
        "allowed_tools": fields.get("allowed-tools", ""),
        "version": str(fields.get("version") or ""),
        "extra_fields": {k: v for k, v in fields.items()
                         if k not in ("name", "description", "license", "allowed-tools", "version")},
        "files": manifest,
        "refs_chars": refs_chars,
        "dropped": [item["path"] for item in manifest
                    if item["role"] == "参考" and not item["included"]],
    }
    with db.transaction() as tx:
        tx.execute(
            "UPDATE prompt_skills SET package_dir=?,package_meta=?,package_refs=?,"
            "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
            (package_dir, json.dumps(meta, ensure_ascii=False), refs_block, skill_id),
        )
    return {**public(get_skill(skill_id)), "package": meta, "replaced": old is not None}


def _commit_candidate(candidate: dict, replace_skill_id: int | None = None) -> dict:
    commit = _commit_package if candidate["kind"] == "package" else _commit_md
    return commit(candidate, replace_skill_id)


# ---------- 撞名 ----------


def _norm_path(value: str) -> str:
    """路径比之前先统一大小写、斜杠和结尾分隔符：Windows 上路径不区分大小写。"""
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        text = os.path.normpath(text)
    except ValueError:
        return ""
    return os.path.normcase(text).rstrip("\\/")


def _find_conflict(name: str, source_dir: str) -> dict | None:
    """找「这条技能的上一版」。

    认两种：来源路径一模一样（重导同一个文件夹、压缩包或 SKILL.md），
    或者名字一模一样（浏览器上传没有路径可比，或者上一次那份已经挪走了）。
    只认导入过的那两类（md/package）：内置技能和用户自己手写的经常也叫同一个名，
    把它们当成「该被替换的旧版本」会直接吃掉用户写的东西。
    """
    want_dir = _norm_path(source_dir)
    want_name = str(name or "").strip()
    if not want_dir and not want_name:
        return None
    rows = db.get_pool().main().execute(
        "SELECT id,name,package_meta FROM prompt_skills WHERE source IN ('md','package')"
        " ORDER BY sort,id").fetchall()
    for row in rows:
        if want_dir and row["package_meta"]:
            try:
                meta = json.loads(row["package_meta"])
            except (TypeError, ValueError):
                meta = None
            got = _norm_path(str((meta or {}).get("source_dir") or ""))
            if got and got == want_dir:
                return {"existing_id": row["id"], "existing_name": row["name"]}
        if want_name and str(row["name"]).strip() == want_name:
            return {"existing_id": row["id"], "existing_name": row["name"]}
    return None


def _finish(candidates: list[dict], skipped: list[dict], on_conflict: str) -> dict:
    """待导入的技能 → 导入结果。这是唯一会写库的一步。

    四条送法共用一个返回形状：imported / conflicts / skipped。
    撞名又没拿到决定时整批一条都不写——只把撞名那条挂起来、其余先落库，
    用户回一句「替换」就得重导一遍，重导的那几条会变成第二份。
    """
    if on_conflict not in CONFLICT_MODES:
        raise HTTPException(422, "撞名时只能选先问、替换或另存新的")
    if not candidates:
        raise HTTPException(422, skipped[0]["reason"] if skipped else "没有读到可导入的技能")
    conflicts: list[dict] = []
    for candidate in candidates:
        hit = _find_conflict(candidate["name"], candidate.get("source_dir") or "")
        candidate["conflict"] = hit
        if hit:
            conflicts.append({"name": candidate["name"],
                              "source_dir": candidate.get("source_dir") or "",
                              "existing_id": hit["existing_id"], "existing_name": hit["existing_name"]})
    if conflicts and on_conflict == "ask":
        return {"imported": [], "conflicts": conflicts, "skipped": skipped}
    imported: list[dict] = []
    for candidate in candidates:
        replace_id = candidate["conflict"]["existing_id"] if (
            candidate.get("conflict") and on_conflict == "replace") else None
        try:
            imported.append(_commit_candidate(candidate, replace_id))
        except HTTPException as exc:
            # 一批里坏一条不该连累其余：报出来，剩下的照样进来
            if int(exc.status_code) >= 500:
                raise
            skipped.append({"path": candidate.get("label") or candidate["name"],
                            "reason": str(exc.detail)})
    return {"imported": imported, "conflicts": [], "skipped": skipped}


# ---------- 四个入口 ----------


def _is_markdown(path: Path) -> bool:
    return path.suffix.lower() in MARKDOWN_SUFFIXES


def _plan_markdown(path: Path) -> dict:
    try:
        if path.stat().st_size > MAX_MARKDOWN_BYTES:
            raise HTTPException(422, "这份文件太大了（上限 2 MB），先收一下再导：" + path.name)
        blob = path.read_bytes()
    except HTTPException:
        raise
    except OSError as exc:
        raise HTTPException(422, "这份文件读不了：" + path.name + "（" + str(exc) + "）")
    return _md_candidate(skill_packages.read_text_bytes(blob), path.name, str(path))


def _plan_skill_md(path: Path) -> list[dict]:
    """挑中的是 SKILL.md：按它所在的目录整包导。

    入口文件就是技能包的那扇门，作者放在旁边的参考资料是这条技能的一部分。
    只读进门那一句、把身后的东西全留下，界面上还看不出少了什么，
    比直接报个错更坏。目录实在没能带进东西时退回单份 md，
    至少用户自己写的那几条指令还在。
    """
    try:
        return _plan_dir(path.parent)
    except HTTPException:
        return [_plan_markdown(path)]


def _plan_dir(path: Path) -> list[dict]:
    entries = skill_packages.scan_package_dir(path)
    if not entries:
        raise HTTPException(422, "这个文件夹里没有可用的文件，换一个技能包目录：" + path.name)
    return _package_candidates(path.name, entries, str(path))


def _plan_archive(path: Path) -> list[dict]:
    entries = skill_packages.scan_package_archive(path)
    if not entries:
        raise HTTPException(422, "这个压缩包里没有一个能读的文件：" + path.name)
    return _package_candidates(path.stem or "技能包", entries, str(path))


def import_from_paths(paths: list[str], on_conflict: str = "ask") -> dict:
    """桌面版那一个入口：挑中的或拖进来的路径，可能是 md、.zip，也可能是一整个目录。

    挑中 SKILL.md 会自动升级成整包导入：它是技能包的入口文件，
    只把它当一份孤立的 md 导进来，等于把作者一起给的参考资料悄悄丢了，
    而界面上看不出少了东西。
    """
    given = [str(item or "").strip() for item in list(paths or []) if str(item or "").strip()]
    candidates: list[dict] = []
    skipped: list[dict] = []
    for text in given[:MAX_IMPORT_SOURCES]:
        path = Path(text)
        kind = skill_packages.archive_kind(text)
        try:
            if path.is_dir():
                candidates += _plan_dir(path)
            elif kind == "zip":
                candidates += _plan_archive(path)
            elif kind == "other":
                skipped.append({"path": text, "reason": OTHER_ARCHIVE_HINT + "：" + path.name})
            elif _is_markdown(path):
                # SKILL.md 是技能包的入口，挑它就等于要那整个包
                if path.name.lower() == "skill.md":
                    candidates += _plan_skill_md(path)
                else:
                    candidates.append(_plan_markdown(path))
            else:
                skipped.append({"path": text, "reason": SOURCE_HINT + "：" + path.name})
        except HTTPException as exc:
            if int(exc.status_code) >= 500:
                raise
            skipped.append({"path": text, "reason": str(exc.detail)})
    if len(given) > MAX_IMPORT_SOURCES:
        skipped.append({"path": "一次最多导 " + str(MAX_IMPORT_SOURCES) + " 个来源",
                        "reason": "多出来的没导，再挑一次"})
    return _finish(candidates, skipped, on_conflict)


def import_from_markdown(content: str, filename: str = "", on_conflict: str = "ask") -> dict:
    """浏览器版：读到的一份 md 原文。名字与正文的口径只在 parse_import 一处。"""
    return _finish([_md_candidate(content, filename)], [], on_conflict)


def import_from_archive_bytes(blob: bytes, filename: str = "", on_conflict: str = "ask") -> dict:
    """浏览器版上传的 .zip：从内存里读，不解压到盘上。"""
    if len(blob or b"") > MAX_ARCHIVE_BYTES:
        raise HTTPException(422, "这个压缩包太大了（上限 64 MB），只把要用的那条技能压进来")
    name = str(filename or "技能包.zip").replace("\\", "/").rsplit("/", 1)[-1]
    stem = re.sub(r"\.[^.]+$", "", name) or "技能包"
    entries = skill_packages.scan_package_archive(blob, label=name)
    if not entries:
        raise HTTPException(422, "这个压缩包里没有一个能读的文件：" + name)
    return _finish(_package_candidates(stem, entries, ""), [], on_conflict)


def import_from_upload_dir(root: str, files: list[dict], on_conflict: str = "ask") -> dict:
    """浏览器版选文件夹：前端读好的文本内容。二进制读不成文字，进不来。"""
    entries: list[dict] = []
    total = 0
    for item in files or []:
        rel = skill_packages.safe_rel_path(item.get("path") or "")
        if not rel:
            continue
        content = item.get("content") or ""
        size = len(content.encode("utf-8"))
        if size > skill_packages.MAX_PACKAGE_FILE_BYTES or len(entries) >= skill_packages.MAX_PACKAGE_FILES:
            continue
        total += size
        if total > skill_packages.MAX_PACKAGE_TOTAL_BYTES:
            break
        entries.append({"path": rel, "abs": "", "size": size, "text": content,
                        "is_text": True, "data": None})
    if not entries:
        raise HTTPException(422, "没有读到任何文件，换一个技能包目录")
    return _finish(_package_candidates(root or "技能包", entries, ""), [], on_conflict)


def package_detail(skill_id: int) -> dict:
    """一条技能背后的包：文件清单与元数据。"""
    row = get_skill(skill_id)
    meta = json.loads(row["package_meta"]) if row["package_meta"] else None
    return {"id": skill_id, "source": row["source"], "package_dir": row["package_dir"], "package": meta}


def settings():
    row = db.get_pool().main().execute(
        "SELECT default_image_skill,default_video_skill FROM prompt_skill_settings WHERE id=1"
    ).fetchone()
    return {"default_image_skill": row["default_image_skill"], "default_video_skill": row["default_video_skill"]}


def save_settings(*, default_image_skill, default_video_skill):
    """两族的默认各存一个。技能被删时外键自己置空，这里不用补。"""
    for kind, skill_id in (("image", default_image_skill), ("video", default_video_skill)):
        if skill_id is None:
            continue
        row = get_skill(int(skill_id))
        if kind not in kinds_of(row["kinds"]):
            raise HTTPException(422, "这条技能不适用于" + KIND_WORDS[kind] + "提示词")
    db.get_pool().main().execute(
        "INSERT INTO prompt_skill_settings(id,default_image_skill,default_video_skill) VALUES(1,?,?)"
        " ON CONFLICT(id) DO UPDATE SET default_image_skill=excluded.default_image_skill,"
        "default_video_skill=excluded.default_video_skill",
        (default_image_skill, default_video_skill),
    )
    return settings()


def system_prompt(skill) -> str:
    """一条技能 = 一句写法 +（是包的话）一叠资料 + 两条谁都不许违反的硬规矩。

    顺序有讲究：资料在正文之后（正文是主干，资料是补充），硬规矩永远垫底。
    硬规矩拼在这儿而不是写进技能正文：技能可以被用户改成一句话，
    规矩要是跟着正文一起被改没，优化就会开始吞 @图片N。
    """
    language = skill["language"] if skill["language"] in LANGUAGE_RULES else "auto"
    refs = _row_get(skill, "package_refs", "")
    return (skill["instruction"].strip() + refs + "\n"
            + OUTPUT_RULE.replace("{language}", LANGUAGE_RULES[language]))


def build_content(prompt: str, refs: list[tuple[int, str]]) -> list[dict]:
    """多模态 content：先给带编号的参考图，再给待优化的原文。

    编号用格子编号而不是「第一张、第二张」：提示词写的是 @图片3，图就得标成 图3。
    中间空格子、跳过坏图都不许把编号整体往前挪一位——挪了就指错人。
    """
    content: list[dict] = []
    if refs:
        content.append({"type": "text", "text": REF_NOTE})
        for ordinal, data_url in refs:
            content.append({"type": "text", "text": "图" + str(ordinal)})
            content.append({"type": "image_url", "image_url": {"url": data_url}})
    content.append({"type": "text", "text": "待优化的提示词："})
    content.append({"type": "text", "text": prompt})
    return content

FENCE = re.compile(r"^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```\s*$")
LABEL = re.compile(r"^(?:优化后?的?(?:提示词|prompt)|优化结果|改写后?的?提示词|提示词|prompt|optimized prompt)"
                   r"[：:]\s*$", re.IGNORECASE)
OPEN_QUOTES = """'"“「"""
CLOSE_QUOTES = """'"”」"""


def clean_output(text: str) -> str:
    """模型偶尔还是会给正文套一层代码块、引号或一行「优化后的提示词：」。

    这里只剥这一层皮，一个字都不改写：剥多了用户还能靠撤销找回来，改写多了就真找不回了。
    """
    result = str(text or "").strip()
    fenced = FENCE.match(result)
    if fenced:
        result = fenced.group(1).strip()
    while len(result) >= 2 and result[0] in OPEN_QUOTES and result[-1] in CLOSE_QUOTES:
        result = result[1:-1].strip()
    lines = result.split("\n")
    while len(lines) > 1 and LABEL.match(lines[0].strip()):
        lines = lines[1:]
    while lines and not lines[-1].strip():
        lines = lines[:-1]
    return "\n".join(lines).strip()


async def prepare_refs(refs: list[dict]) -> tuple[list[tuple[int, str]], dict | None]:
    """按格子编号备好参考图，回（要发的 (编号, data URL) 清单, 降级说明）。

    坏图（已删、损坏、其实是音频）跳过而不是整次失败：参考图在这儿是辅助信息，
    为一个没了的文件打掉用户这次优化不值当。超总长则按编号顺序少带后面的几张。
    """
    ordered = sorted(refs, key=lambda item: item["ordinal"])
    kept = ordered[:MAX_REF_IMAGES]
    dropped = [item["ordinal"] for item in ordered[MAX_REF_IMAGES:]]
    sent: list[tuple[int, str]] = []
    total = 0
    for index, item in enumerate(kept):
        try:
            path = reverse_prompts.image_path(item["image_id"])
            data_url, _ = await run_in_threadpool(reverse_prompts.prepare_image, path)
        except (HTTPException, OSError, ValueError):
            # SQLite 自己坏了不在这儿吞：那属于「整个后端都不对」，该让它响。
            dropped.append(item["ordinal"])
            continue
        # 至少带一张：2048px + JPEG q90 下单张就超标的情况基本不存在，真遇上了也宁可让
        # 服务商明说 413，而不是悄悄回一句没带图的优化。
        if sent and total + len(data_url) > MAX_REF_PAYLOAD:
            dropped.extend(other["ordinal"] for other in kept[index:])
            break
        total += len(data_url)
        sent.append((item["ordinal"], data_url))
    dropped = sorted(set(dropped))
    return sent, (None if not dropped else {"sent": len(sent), "dropped": dropped})


def resolve_model():
    """用哪具脑子：反推那套的默认模型。一处配置，反推和优化两处共用。"""
    default_model_id = reverse_prompts.settings()["default_model_id"]
    if default_model_id is None:
        raise HTTPException(422, "还没配好模型：先在设置的「反推提示词」里加一家服务商并选一个默认模型")
    config = reverse_prompts.with_model(reverse_prompts.get_config(default_model_id), None)
    return config, reverse_prompts.key_for(config)


async def optimize(*, skill, prompt: str, kind: str, refs: list[dict]) -> dict:
    """跑一次优化。这个方法一行都不写库：优化是给建议，历史留在会话里的撤销就够。"""
    if kind not in kinds_of(skill["kinds"]):
        raise HTTPException(422, "「" + skill["name"] + "」不适用于" + KIND_WORDS.get(kind, kind) + "提示词")
    if not prompt.strip():
        raise HTTPException(422, "提示词是空的，没什么可优化")
    config, key = resolve_model()
    prepared, degraded = (await prepare_refs(refs)) if (skill["with_refs"] and refs) else ([], None)
    answer = await reverse_prompts.request_model(
        config, key, build_content(prompt, prepared), system_prompt(skill), output_rule="")
    result = clean_output(answer)
    if not result:
        raise HTTPException(502, "模型只回了一层壳，没回提示词内容，请重试或换一条技能")
    return {"prompt": result, "model_name": config["name"], "model": config["model"], "degraded_refs": degraded}
