"""提示词优化技能：把「按某套写法把人已写好的提示词改一遍」做成可编辑、可导入的技能。

为什么不复用反推那条 instruction：反推是「看图写话」，优化是「改写人已写下的话」，
两件事的要求正好相反——一个要凭空补全画面，一个要求不许增删原意。塞进同一条指令
只会两头都做不好，所以另起一张技能表；用哪个模型不在这里另配，继续吃反推的默认模型
（reverse_prompt_settings.default_model_id），设置页只有一处「默认模型」要维护。
"""
from __future__ import annotations

import re

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from . import db, reverse_prompts

KINDS = ("image", "video")
KIND_WORDS = {"image": "图片", "video": "视频"}
LANGUAGES = ("auto", "zh", "en")

MAX_NAME = 60
MAX_NOTE = 200
MAX_INSTRUCTION = 20000
# 导入的是给 agent 看的 SKILL.md，长的是常态。截断比拒绝有用：截了还能改，拒了就是白跑一趟。
MAX_IMPORT_CHARS = 12000
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
    """把一份 SKILL.md 读成「名字 + 正文 + 是否被截断」。

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
    truncated = len(body) > MAX_IMPORT_CHARS
    if truncated:
        body = body[:MAX_IMPORT_CHARS].rstrip() + "\n\n（技能原文过长，到这里为止。）"
    if not body:
        raise HTTPException(422, "这份文件里没有可用的正文，换一份 SKILL.md 或直接新建一条技能")
    return {"name": (name or "导入的技能")[:MAX_NAME], "instruction": body, "truncated": truncated}


def import_skill(content: str, filename: str = ""):
    """导入即落库，名字撞了就加序号：撞名时报一句「已存在」等于让人先改名再白跑一趟。"""
    parsed = parse_import(content, filename)
    base = parsed["name"]
    taken = {row["name"] for row in db.get_pool().main().execute("SELECT name FROM prompt_skills").fetchall()}
    name, suffix = base, 1
    while name in taken:
        suffix += 1
        name = base[:MAX_NAME - len(str(suffix)) - 4] + " (" + str(suffix) + ")"
    saved = save_skill({"name": name, "note": "从文件导入", "instruction": parsed["instruction"]})
    return {**saved, "truncated": parsed["truncated"]}


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
    """一条技能 = 一句写法 + 两条谁都不许违反的硬规矩（引用标记、输出形态）。

    硬规矩拼在这儿而不是写进技能正文：技能可以被用户改成一句话，
    规矩要是跟着正文一起被改没，优化就会开始吞 @图片N。
    """
    language = skill["language"] if skill["language"] in LANGUAGE_RULES else "auto"
    return skill["instruction"].strip() + "\n" + OUTPUT_RULE.replace("{language}", LANGUAGE_RULES[language])


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
