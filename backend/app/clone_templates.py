"""一键同款：同款工作流模板的存储与槽位检测。

一条模板 = 一份 ComfyUI API 格式工作流 + 一组槽位绑定。用户随时会换一份 JSON 进来，
所以这里的重点不是"存了什么"，而是"怎么从任意工作流里认出可注入的位置"：

  prompt       —— inputs 下 key 是 prompt / text / positive_prompt 的字符串字面量，
                  外加 PrimitiveString(Multiline) 这种键叫 value 的字符串原语节点
                  （H3 视频工作流就是这么放提示词的）。PrimitiveFloat/PrimitiveInt
                  的 value 是数值控件，绝不认成提示词。
                  孤立节点也算：仓库样例里 540 是孤立的 CR Prompt Text、582 才真正
                  生效，只写 582 会让用户在 ComfyUI 里看到两处不一致的文本。
                  key 里带 negative 的一律不认，避免把正向提示词灌进负向。
  image/audio/video —— 三类参考位，一台加载器一个格子：LoadImage* 收图片、
                  LoadAudio* 收音频、VHS_LoadVideo* 收视频。同一组里空着的格子
                  由 autogrow 自动续出来（Qwen 那种显式 names、H3 这种 prefix+max
                  都要认），用户不必回 ComfyUI 手摆节点就能多喂参考素材。
  select/number —— 从 object_info 里挑 aspect_ratio、megapixels 这类字面量控件，
                  最多两个进弹窗；时长（PrimitiveFloat 且标题带「时长/duration」）
                  单独再多给一颗；其余作为候选，由设置页决定要不要绑。

模板还带 media_kind（image/video），按输出节点判定：出片的是 VHS_VideoCombine /
SaveVideo 这类节点就是视频工作流。「当前」按族各算各的，图片卡和视频卡各有各的默认。
"""
from __future__ import annotations

import copy
import json
import re
from typing import Any

from . import workflow_edit
from .comfyui_client import random_seed, widget_spec
from .db import get_pool

SCHEMA = """
CREATE TABLE IF NOT EXISTS clone_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    workflow TEXT NOT NULL,
    slots TEXT NOT NULL DEFAULT '[]',
    default_prompt TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 0,
    media_kind TEXT NOT NULL DEFAULT 'image',
    bundled_key TEXT,
    bundled_sha TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clone_template_name ON clone_templates(name);
"""


def initialize(conn) -> None:
    conn.executescript(SCHEMA)
    # 旧库补列：CREATE TABLE IF NOT EXISTS 不会给已经存在的表加列，加不带默认值的列
    # 又会让老库直接打不开，所以补一个 'image' 默认——旧库里躺着的本来就全是图片工作流。
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(clone_templates)").fetchall()}
    if "media_kind" not in cols:
        conn.execute(
            "ALTER TABLE clone_templates ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'image'"
        )
    # 内置模板的两列：bundled_key 认「这是安装包带来的哪一条」，bundled_sha 是
    # 安装包那版工作流的指纹——只有正文还等于它，才说明用户没动过，才敢随版本刷新。
    if "bundled_key" not in cols:
        conn.execute("ALTER TABLE clone_templates ADD COLUMN bundled_key TEXT")
    if "bundled_sha" not in cols:
        conn.execute("ALTER TABLE clone_templates ADD COLUMN bundled_sha TEXT NOT NULL DEFAULT ''")


class DuplicateNameError(ValueError):
    """模板重名。路由翻成 409：前端要区分「改个名字再试」和「参数写错了」。"""


PROMPT_INPUT_KEYS = {"prompt", "text", "positive_prompt"}
# 弹窗里那个主文本框的槽位标签，前后端共用这一个词（前端 lib/clone.ts 同名常量）。
PRIMARY_PROMPT_LABEL = "完整提示词"
# 认得出用途的第二段文字：键名 → 中文名。音色克隆必须同时有「要说的话」与「参考音频里
# 说的原话」，原话既不叫 prompt 也不叫 text，光靠 PROMPT_INPUT_KEYS 认不出来；就算认出来，
# 塞进同一个输入框更糟——用户一改台词就把原话冲掉，克隆出来的音色就不像了。
SECONDARY_PROMPT_KEYS = {"ref_text": "参考音频的文本", "instruct": "音色描述"}
# 留空时要拿台词去顶的那类文字位：只有「参考音频里的原话」是这个语义。
# 音色描述与语气留空＝不写指令，绝不跟着台词走（见 build_workflow）。
MIRROR_SCRIPT_KEYS = {"ref_text"}
# 有些工作流把提示词塞在字符串原语节点里，键叫 value。只能按类名认：
# PrimitiveFloat / PrimitiveInt 的键也叫 value，那是数值控件，认成提示词就把时长冲掉了。
STRING_PRIMITIVE_CLASSES = {"primitivestringmultiline", "primitivestring"}
STRING_PRIMITIVE_KEY = "value"
SEED_INPUT_KEYS = {"seed", "noise_seed"}
# 出声音的工作流没有比例和分辨率，弹窗里要改的是「说什么语种、用哪个音色」：
# language / speaker 一起进自动名单，否则用户自己导入 VoiceDesign 时会缺一颗语种下拉。
# 顺序就是优先级——图片/视频工作流先占满两个名额（比例 + 分辨率），语言抢不走。
AUTO_CONTROL_KEYS = ("aspect_ratio", "megapixels", "language", "speaker")
MAX_AUTO_CONTROLS = 2
DURATION_CLASSES = {"primitivefloat", "primitiveint"}
DURATION_KEY = "value"
DURATION_TITLE_HINTS = ("时长", "duration")
DURATION_PRESETS = [5, 8, 10, 12, 15]
# H3 训练区间约 124–362 帧 @24fps，也就是 5–15 秒；给五个档，允许手动填别的。
KINDS = {"prompt", "image", "audio", "video", "select", "number"}
REFERENCE_KINDS = ("image", "audio", "video")
REFERENCE_INPUT_KEYS = {"image": "image", "audio": "audio", "video": "video"}
REFERENCE_LABEL_STEMS = {"image": "图片", "audio": "音频", "video": "视频"}
REFERENCE_TYPE_FOR_KIND = {"image": "IMAGE", "audio": "AUDIO", "video": "IMAGE"}
# H3 在上下文里给参考拼的标签，带空格（comfy/text_encoders/minimax.py:175 是 "<Picture %d>: "）。
# 提示词里回指参考就写这个，弹窗 @ 引用要插入的也是它。
TAG_TEMPLATES = {"image": "<Picture {n}>", "audio": "<Audio {n}>", "video": "<Video {n}>"}
MODE_LABELS = workflow_edit.MODE_LABELS
VIDEO_MODE_LABELS = {"text": "文生视频", "single": "图生视频", "multi": "多参考视频"}
MEDIA_KINDS = ("image", "video", "audio")
# 出片节点决定这份工作流是图片还是视频：认产出端比认模型端准
# （H3 之外的视频工作流也一样是「最后有个出视频的节点」）。
VIDEO_OUTPUT_HINTS = (
    "videocombine", "savevideo", "decodeandsavevideo", "createvideo",
    "combinevideo", "videowriter", "savegif", "write to video",
)
VIDEO_MODEL_HINTS = ("referencetovideo", "imagetovideo", "texttovideo", "frametovideo")
# 音频工作流（Qwen3-TTS 那一类）最后落在 SaveAudio*/PreviewAudio 上。
# 判定顺序很重要：先看视频再看音频——带音轨的视频工作流里往往也有音频节点。
AUDIO_OUTPUT_HINTS = ("saveaudio", "previewaudio", "audiocombine", "createaudio", "audiocache")
AUDIO_MODE_LABELS = {"text": "文本配音", "single": "参考音色克隆", "multi": "多参考音频"}
CONTROL_LABELS = {
    "aspect_ratio": "比例",
    "language": "语言",
    "speaker": "音色",
    "megapixels": "分辨率",
    "value": "数值",
    "width": "宽度",
    "height": "高度",
    "steps": "步数",
    "denoise": "重绘幅度",
    "cfg": "CFG",
    "sampler_name": "采样器",
    "scheduler": "调度器",
}


def slot_key(slot: dict) -> str:
    return f"{slot.get('node')}.{slot.get('input')}"

# ---------- 多图参考（ComfyUI 的 autogrow 输入组） ----------

GROW_SEP = "::"
GROW_MAX = 15          # 一次最多扩几格（真正生效的限制）
TEMPLATE_NAMES_CAP = 64  # 工作流自报的格名上限，只是防疯值
GROW_TYPE_PREFIX = "COMFY_AUTOGROW"
_GROUPS: dict[str, list[dict]] = {}  # detect_slots 期间的临时表，避免每个节点重解析一次 object_info


def grow_key(slot: dict, name: str) -> str:
    """扩出来的参考位用「543.image::image_2」这种键，和真槽位一眼分得开。"""
    return f"{slot_key(slot)}{GROW_SEP}{name}"


def split_reference_key(key: str) -> tuple[str, str | None]:
    base, sep, name = str(key).partition(GROW_SEP)
    return base, (name if sep else None)


def _cell(slot: dict, kind: str, ordinal: int, key: str, name: str) -> dict:
    stem = REFERENCE_LABEL_STEMS.get(kind, kind)
    return {
        "key": key,
        "kind": kind,
        "ordinal": ordinal,
        "label": f"{stem}{ordinal}",
        "name": name,
        "slot_label": str(slot.get("label") or slot_key(slot)),
    }


def reference_cells(slots: list[dict], soundtracks: int = 0) -> list[dict]:
    """参考格子的画面顺序与编号：图片 → 音频 → 视频，每族先排真槽位，再排 autogrow 扩位。

    弹窗按这里的顺序编号「图片1…N」，后端按同一个顺序校验「同一族要连着填」，
    两边必须一模一样，否则用户看到的音频3 和实际接到节点上的输入对不上。
    扩位按「目标节点+图组+格名」去重：两台加载器往往长进同一个组，不去重就会数出
    双倍格子，还会在同一格里互相覆盖。
    每格带上 H3 原生标签（tag），弹窗里 @ 引用要插的就是它。
    """
    cells: list[dict] = []
    for kind in REFERENCE_KINDS:
        family = [s for s in slots if s.get("kind") == kind]
        ordinal = 0
        for slot in family:
            ordinal += 1
            cells.append(_cell(slot, kind, ordinal, slot_key(slot), ""))
        claimed: set[str] = set()
        for slot in family:
            grow = slot.get("grow") or {}
            for name in grow_names(slot):
                target = f"{grow.get('node')}.{grow.get('group')}::{name}"
                if target in claimed:
                    continue
                claimed.add(target)
                ordinal += 1
                cells.append(_cell(slot, kind, ordinal, grow_key(slot, name), name))
    return attach_tags(cells, soundtracks)


def attach_tags(cells: list[dict], soundtracks: int = 0) -> list[dict]:
    """给每一格补上它在 H3 上下文里的标签：<Picture i> / <Video k> / <Audio j>。

    序号是「每类各自 1 起」，但 H3 把参考摆进上下文时按 图片 → 视频 → 独立音频 排，
    而参考视频自带的音轨会在这个视频之前先占一个 <Audio j> 号
    （comfy_extras/nodes_minimax_h3.py 里音轨先 append({"type": "audio"})
    再 append({"type": "video"})）。所以独立音频要从「已连线音轨数」之后接着数，
    否则用户插进来的 <Audio 1> 指的是参考视频的音轨，指错人。
    """
    offset = max(0, int(soundtracks or 0))
    for cell in cells:
        ordinal = int(cell.get("ordinal") or 1)
        kind = cell.get("kind")
        if kind == "audio":
            ordinal += offset
        cell["tag"] = TAG_TEMPLATES.get(str(kind), "").format(n=ordinal)
    return cells


SOUNDTRACK_INPUT = re.compile(r"^ref_video_audio(?:_\d+)?$")


def wired_reference_soundtracks(nodes: dict, slots: list[dict]) -> int:
    """工作流里已经连好的「参考视频音轨」有几路。

    这些音轨是用户自己在 ComfyUI 里接的（app 不碰 ref_video_audios），它们不占参考格，
    但在 H3 的呈现顺序里各占一个 <Audio j> 号，所以算标签序号时必须把它们先扣掉。
    从音频加载器连过去的那些已经算成参考格了，不能重复计数。
    """
    audio_nodes = {str(s.get("node")) for s in slots if s.get("kind") == "audio"}
    count = 0
    for node in (nodes or {}).values():
        for key, value in node_inputs(node).items():
            stem = str(key).rpartition(".")[2] or str(key)
            if not SOUNDTRACK_INPUT.match(stem) or not workflow_edit._is_link(value):
                continue
            if str(value[0]) in audio_nodes:
                continue
            count += 1
    return count


def reference_cell_keys(slots: list[dict]) -> list[str]:
    return [cell["key"] for cell in reference_cells(slots)]


def reference_cell_labels(slots: list[dict]) -> dict[str, str]:
    """{参考位键: 「图片2」} —— 报错文案要说人话，不能把 188.image 甩给用户。"""
    return {cell["key"]: str(cell["label"]) for cell in reference_cells(slots)}


def reference_cells_with_tags(template: dict) -> list[dict]:
    """给前端用的参考格清单：带 kind / label / tag，顺序与后端校验一致。"""
    return reference_cells(
        template.get("slots") or [],
        wired_reference_soundtracks(template.get("nodes") or {}, template.get("slots") or []),
    )


def reference_slot_keys(slots: list[dict]) -> tuple[list[str], set[str]]:
    """(必填参考位, 全部可提交的参考位)。

    必填恒为空：生成方式就是参考图的数量（0 张文生图 / 1 张单图编辑 / 2 张以上多图编辑），
    所以没有「这张工作流非要几张参考图」这回事。一张都不填能不能跑，看的是
    参考链摘不摘得掉——那由 `modes_of` 在 plan_request 里把关。
    """
    keys = reference_cell_keys(slots)
    return [], set(keys)


def reference_slots(slots: list[dict]) -> list[dict]:
    return [s for s in slots if s.get("kind") in REFERENCE_KINDS]


def unused_reference_nodes(slots: list[dict], references: dict | None) -> list[str]:
    """没拿到参考素材的加载器节点。留着它们等于偷偷用工作流里那份旧素材。

    三类加载器一视同仁：没喂图的 LoadImage 会偷偷用旧图，没喂音频的 LoadAudio
    会偷偷用工作流里那段旧声音，没喂视频的 VHS_LoadVideo 也一样。
    """
    used = {str((s or {}).get("node")) for s in
            (slot_for_reference_key(slots, key) for key in (references or {})) if s}
    return [str(s.get("node")) for s in reference_slots(slots)
            if str(s.get("node")) not in used]


def slot_for_reference_key(slots: list[dict], key: str) -> dict | None:
    base, _grow = split_reference_key(str(key))
    for slot in slots:
        if slot.get("kind") in REFERENCE_KINDS and slot_key(slot) == base:
            return slot
    return None


def mode_from_count(count: int) -> str:
    """生成方式不是用户选的，是参考图数量决定的。"""
    if count <= 0:
        return "text"
    return "single" if count == 1 else "multi"


def grow_names(slot: dict) -> list[str]:
    grow = slot.get("grow")
    if not isinstance(grow, dict):
        return []
    names = grow.get("names")
    return [n for n in names if isinstance(n, str)] if isinstance(names, list) else []


def _template_names(template: dict) -> list[str]:
    """图组有哪些格子名。ComfyUI 两代写法都要认：

      显式表    —— {"names": ["image_1", ...]}（Qwen Image 2.1 的 images）
      prefix 式 —— {"prefix": "ref_image_", "min": 0, "max": 9}（H3 的 ref_images）
                   格子名是 prefix + 下标，下标从 min 起，所以是 ref_image_0..8。

    prefix 式不给上限的话就无从知道能长几格，这种组直接不认——宁可少给参考位，
    也不要凭空造一个 ComfyUI 不认的输入名，那会被 /prompt 整条打回。
    """
    if not isinstance(template, dict):
        return []
    listed = template.get("names")
    if isinstance(listed, list):
        names = [n for n in listed if isinstance(n, str)]
        if names:
            return names[:TEMPLATE_NAMES_CAP]
    prefix = template.get("prefix")
    high = template.get("max")
    if not isinstance(prefix, str) or not prefix:
        return []
    if not isinstance(high, int) or isinstance(high, bool) or high <= 0:
        return []
    low = template.get("min")
    if not isinstance(low, int) or isinstance(low, bool):
        low = 0
    return [f"{prefix}{i}" for i in range(low, min(high, low + TEMPLATE_NAMES_CAP))]


def _template_item_type(template: dict) -> str:
    """图组每一格收什么类型（IMAGE / AUDIO）。分族要靠它：视频加载器的 IMAGE 输出
    接 ref_videos、AUDIO 输出接 ref_video_audios，不认类型就会把音轨当图片参考位。"""
    if not isinstance(template, dict):
        return ""
    flat = template.get("type")
    if isinstance(flat, str) and flat:
        return flat.upper()
    block = template.get("input")
    if not isinstance(block, dict):
        return ""
    for part in ("required", "optional"):
        items = block.get(part)
        if not isinstance(items, dict) or not items:
            continue
        spec = next(iter(items.values()), None)
        if isinstance(spec, list) and spec and isinstance(spec[0], str):
            return spec[0].upper()
    return ""


def _autogrow_groups(info: dict) -> dict[str, list[dict]]:
    """class_type -> [{input, names, type}]：哪些节点的哪个输入是会自动长格的素材组。"""
    groups: dict[str, list[dict]] = {}
    for class_type, schema in (info or {}).items():
        if not isinstance(schema, dict):
            continue
        section = schema.get("input")
        if not isinstance(section, dict):
            continue
        bucket: list[dict] = []
        for part in ("required", "optional"):
            items = section.get(part)
            if not isinstance(items, dict):
                continue
            for name, spec in items.items():
                if not (isinstance(spec, list) and spec and isinstance(spec[0], str)):
                    continue
                if not spec[0].startswith(GROW_TYPE_PREFIX):
                    continue
                template = spec[1].get("template") if len(spec) > 1 and isinstance(spec[1], dict) else None
                names = _template_names(template if isinstance(template, dict) else {})
                if names:
                    bucket.append({
                        "input": name,
                        "names": names,
                        "type": _template_item_type(template if isinstance(template, dict) else {}),
                    })
        if bucket:
            groups[str(class_type)] = bucket
    return groups


def _next_node_id(nodes: dict) -> int:
    numbers = [int(k) for k in nodes if str(k).isdigit()]
    return (max(numbers) + 1) if numbers else len(nodes) + 100


def _grow_target(nodes: dict, source_id: str, want_type: str = "") -> dict | None:
    """找这台加载器连进了哪个节点的哪个素材组，以及组里还空着哪些格。

    want_type 是这一族要喂的类型（图片/视频喂 IMAGE 组，音频喂 AUDIO 组）。
    一台 VHS_LoadVideo 往往同时往 ref_videos 和 ref_video_audios 里连，
    不卡类型就会把它的音轨当成「另一张图片参考位」，凭空多出一格。
    """
    for nid in _ordered_ids(nodes):
        inputs = node_inputs(nodes[nid])
        class_type = str(nodes[nid].get("class_type") or "")
        buckets = _GROUPS.get(class_type) or []
        for key, value in inputs.items():
            if not isinstance(value, list) or len(value) < 2 or str(value[0]) != source_id:
                continue
            group, _, name = key.partition(".")
            bucket = next((b for b in buckets if b["input"] == group), None)
            if not bucket or not name:
                continue
            if want_type and bucket.get("type") and bucket["type"] != want_type:
                continue
            used = {k.partition(".")[2] for k in inputs if k.startswith(group + ".")}
            free = [n for n in bucket["names"] if n not in used][:GROW_MAX]
            if free:
                return {"node": nid, "group": group, "names": free, "type": bucket.get("type") or ""}
    return None



# ---------- 工作流解析 ----------


def parse_workflow(raw: Any) -> dict[str, Any]:
    """吃 dict 或 JSON 文本，吐 API 格式节点表；不是 API 格式就抛中文错误。"""
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except ValueError as exc:
            raise ValueError("工作流不是合法的 JSON，检查是不是被截断或带了注释。") from exc
    else:
        data = raw
    if not isinstance(data, dict) or not data:
        raise ValueError("工作流是空的。API 格式的顶层应该是 {节点号: {class_type, inputs}}。")
    if isinstance(data.get("nodes"), list):
        raise ValueError(
            "这是 ComfyUI 界面格式的工作流。请导出 API 格式再导入："
            "按住 Alt 点「保存」，或用菜单里的 Export (API)。"
        )
    nodes = {str(k): v for k, v in data.items()}
    if not any(isinstance(v, dict) and isinstance(v.get("class_type"), str) for v in nodes.values()):
        raise ValueError("没找到任何 ComfyUI 节点，确认导出的是 API 格式的工作流 JSON。")
    return nodes


def node_title(node: Any, fallback: str) -> str:
    if isinstance(node, dict):
        meta = node.get("_meta")
        if isinstance(meta, dict):
            title = str(meta.get("title") or "").strip()
            if title:
                return title
    return fallback


def node_inputs(node: Any) -> dict[str, Any]:
    if not isinstance(node, dict):
        return {}
    raw = node.get("inputs")
    return raw if isinstance(raw, dict) else {}


def is_literal(value: Any) -> bool:
    """链接是 [节点号, 输出序号]，那种值由上游喂，不能当字面量注入。"""
    if (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[0], (int, str))
        and isinstance(value[1], int)
    ):
        return False
    return True


# ---------- 槽位检测 ----------


def _ordered_ids(nodes: dict) -> list[str]:
    def key(nid: str) -> tuple[int, int, str]:
        return (0, int(nid), "") if nid.isdigit() else (1, 0, nid)

    return sorted(nodes, key=key)


def _value_kind(value: Any) -> str:
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "text"
    if isinstance(value, list) and not is_literal(value):
        return "link"
    if isinstance(value, dict):
        return "dict"
    return "other"


def node_overview(nodes: dict) -> list[dict]:
    """给设置页做"手动绑定任意 node.input"的节点清单。"""
    out = []
    for nid in _ordered_ids(nodes):
        node = nodes[nid]
        class_type = str(node.get("class_type") or "")
        out.append({
            "node": nid,
            "class_type": class_type,
            "title": node_title(node, class_type or nid),
            "inputs": [
                {"input": k, "kind": _value_kind(v), "literal": is_literal(v)}
                for k, v in node_inputs(node).items()
            ],
        })
    return out


def referenced_node_ids(nodes: dict) -> set[str]:
    """输出被别的节点连用的节点号。

    孤立节点（谁都没连它）在 ComfyUI 里只是个可见的文本块，例如仓库样例里的
    「CR Prompt Text」：改提示词时必须一起写，否则用户在 ComfyUI 里看到两份不一样
    的文本；但要挑一条当"工作流内置提示词"展示给用户，得取真正生效的那一条。
    """
    out: set[str] = set()
    for node in nodes.values():
        for value in node_inputs(node).values():
            if (
                isinstance(value, list)
                and len(value) == 2
                and isinstance(value[0], (int, str))
                and isinstance(value[1], int)
            ):
                out.add(str(value[0]))
    return out


def _prompt_slots(slots: list[dict]) -> list[dict]:
    return [s for s in slots if s.get("kind") == "prompt"]


def pick_default_prompt(nodes: dict, slots: list[dict]) -> str:
    """工作流内置提示词：优先取真正被下游连用的文本节点，其次取第一个非空。"""
    used = referenced_node_ids(nodes)
    # 主框那条优先：音色克隆那类工作流一台节点上有两段文字，谁排前面看的是 JSON 里的
    # 键序，照顺序取会把「参考音频里的原话」当成默认台词填进主框。
    primaries = [s for s in _prompt_slots(slots) if str(s.get("label") or "") == PRIMARY_PROMPT_LABEL]
    ordered = sorted(primaries or _prompt_slots(slots),
                     key=lambda s: 0 if str(s.get("node")) in used else 1)
    for slot in ordered:
        value = node_inputs(nodes.get(slot.get("node"), {})).get(slot.get("input"))
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _widgets(nodes: dict, info: dict) -> list[tuple[str, str, dict]]:
    """工作流里"值是字面量、object_info 说是下拉/数值"的输入清单。"""
    out = []
    for nid in _ordered_ids(nodes):
        node = nodes[nid]
        spec = info.get(str(node.get("class_type") or ""))
        if not isinstance(spec, dict):
            continue
        definition = spec.get("input") if isinstance(spec.get("input"), dict) else {}
        merged: dict[str, Any] = {}
        for group in ("required", "optional"):
            block = definition.get(group)
            if isinstance(block, dict):
                merged.update(block)
        inputs = node_inputs(node)
        for key, widget in merged.items():
            if key not in inputs or not is_literal(inputs[key]):
                continue
            parsed = widget_spec(widget)
            if parsed["kind"] == "other":
                continue
            out.append((nid, key, parsed))
    return out


def control_slot(node_id: str, key: str, spec: dict, current: Any = None) -> dict | None:
    """把 widget 定义变成一个可渲染的控件槽；认不出来返回 None。"""
    label = CONTROL_LABELS.get(key, key)
    kind = spec.get("kind")
    if kind == "combo":
        options = [x for x in (spec.get("options") or []) if isinstance(x, str)]
        if not options:
            return None
        default = spec.get("default")
        value = current if isinstance(current, str) and current in options else (
            default if isinstance(default, str) and default in options else options[0]
        )
        return {"kind": "select", "node": node_id, "input": key, "label": label,
                "options": options, "value": value}
    if kind in ("int", "float"):
        usable = isinstance(current, (int, float)) and not isinstance(current, bool)
        fallback = spec.get("default")
        return {
            "kind": "number", "node": node_id, "input": key, "label": label,
            "value": current if usable else (fallback if isinstance(fallback, (int, float)) else None),
            "min": spec.get("min"), "max": spec.get("max"),
            "step": spec.get("step") or (0.1 if kind == "float" else 1),
        }
    return None


def _duration_control(nodes: dict, used: set[str]) -> dict | None:
    """时长控件：视频工作流里「几秒」这件事必须能在弹窗里改。

    认法只有一条：PrimitiveFloat / PrimitiveInt 且节点标题带「时长/duration」，
    value 是字面量数字。不认「任何叫 value 的数字」——字符串原语也叫 value，
    别的原语节点也叫 value，认错了弹窗里就多一颗没人认识的数字框。
    不读 object_info：原语节点的上下限本来就是 0–很大，没意义；档位由预设给。
    """
    for nid in _ordered_ids(nodes):
        node = nodes[nid]
        if str(node.get("class_type") or "").lower() not in DURATION_CLASSES:
            continue
        title = node_title(node, "").lower()
        if not any(hint in title for hint in DURATION_TITLE_HINTS):
            continue
        value = node_inputs(node).get(DURATION_KEY)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        key_id = f"{nid}.{DURATION_KEY}"
        if key_id in used:
            continue
        return {
            "kind": "number", "node": nid, "input": DURATION_KEY, "label": "时长",
            "unit": "秒", "value": value, "step": 1,
            "presets": list(DURATION_PRESETS),
        }
    return None


def media_kind_of_template(template: dict | None) -> str:
    """模板属哪一族；库里旧行没这个字段时一律当图片（与历史行为一致）。"""
    kind = str((template or {}).get("media_kind") or "image")
    return kind if kind in MEDIA_KINDS else "image"


def is_video(template: dict) -> bool:
    return media_kind_of_template(template) == "video"


def is_audio(template: dict) -> bool:
    return media_kind_of_template(template) == "audio"


def mode_labels(template: dict | None) -> dict[str, str]:
    """档位名要跟着工作流出的是什么说：视频工作流里冒出一句「文生图」就是骗人。"""
    kind = media_kind_of_template(template)
    if kind == "video":
        return VIDEO_MODE_LABELS
    if kind == "audio":
        return AUDIO_MODE_LABELS
    return MODE_LABELS


def reference_noun(template: dict | None) -> str:
    """对外叙述参考素材时用哪个词：在音频工作流里说「参考图」是骗人。"""
    kind = media_kind_of_template(template)
    if kind == "video":
        return "参考素材"
    if kind == "audio":
        return "参考音频"
    return "参考图"


def check_mode(template: dict, mode: str) -> str:
    """参考素材数量决定出来的档位，这份工作流到底支持不支持；不支持就明说缺什么。"""
    if mode in modes_of(template):
        return mode
    noun = reference_noun(template)
    if mode == "text":
        raise ValueError(f"这份工作流去不掉{noun}（有节点非要有输入素材才跑得起来），"
                         f"所以至少放一个{noun}。想纯文本生成请换一份不带参考的工作流。")
    raise ValueError("这份工作流不支持「" + mode_labels(template).get(mode, mode)
                     + f"」，减少{noun}再试。")


def modes_of(template: dict) -> list[str]:
    """这份模板能用哪些生成档位（读库里现成的模板，不依赖 ComfyUI 在线）。"""
    return fallback_modes(template.get("nodes") or {}, template.get("slots") or [])


def fallback_modes(nodes: dict, slots: list[dict]) -> list[str]:
    """离线估算生成档位：object_info 拿不到时用这个。

    文生这一档剪不剪得干净，没有 object_info 只能乐观判断；真到生成时后端还会带着
    object_info 再剪一次，剪不动会明确报错，不会静默出一份带着旧素材的片子。
    """
    refs = reference_slots(slots)
    if not refs:
        return ["text"]
    modes = ["single"]
    if len(refs) > 1 or any(grow_names(s) for s in refs):
        modes.append("multi")
    try:
        drop_reference_images(nodes, [str(s.get("node")) for s in refs])
    except (workflow_edit.TextModeUnsupported, RecursionError, KeyError):
        pass
    else:
        modes.append("text")
    return [m for m in workflow_edit.MODES if m in modes]


def drop_reference_images(nodes: dict, node_ids: list[str], info: dict | None = None,
                          titles: dict[str, str] | None = None,
                          slots: list[dict] | None = None) -> dict:
    """文生图：把参考图整条链从工作流里摘掉。保护提示词槽所在的节点。"""
    protected = {str(s.get("node")) for s in (slots or []) if s.get("kind") == "prompt"}
    return workflow_edit.drop_reference_images(nodes, node_ids, info, titles, protected)


def branch_prompt_nodes(nodes: dict, slots: list[dict]) -> list[str]:
    """各自独立出片的那几台生成节点：自己带主提示词，而且输出真被下游连走。

    孤立文本节点（仓库样例里那种 CR Prompt Text）不算——它是同一段话的另一份副本，
    不是一条分支；把它数进来会给正常图片工作流乱报。
    """
    used = referenced_node_ids(nodes)
    primary = {str(s.get("node")) for s in slots
               if s.get("kind") == "prompt" and str(s.get("label") or "") == PRIMARY_PROMPT_LABEL}
    return [nid for nid in _ordered_ids(nodes) if nid in primary and nid in used]


def branch_warnings(nodes: dict, slots: list[dict], media_kind: str) -> list[str]:
    """一份 JSON 里并排好几条独立分支时，导入当时就把「点一次出几份」说清。

    Qwen3-TTS 那份工作流最典型：音色克隆 / 音色描述 / 指定音色三条并排，ComfyUI
    会执行图里所有输出节点——点一次「一键同款」出三段音频、等三倍时间，弹窗里还冒出
    三个台词框，用户完全不知道为什么。app 不替用户删分支（删错就是毁工作流），
    只把话说在前面。只对音频报：图片和视频工作流里多几台文本节点是常态，报它是噪音。
    """
    if media_kind != "audio":
        return []
    branches = branch_prompt_nodes(nodes, slots)
    if len(branches) < 2:
        return []
    titles = "、".join(node_title(nodes.get(nid, {}), nid) for nid in branches[:3])
    more = f"……一共 {len(branches)} 台" if len(branches) > 3 else ""
    return [f"这份工作流里并排着 {len(branches)} 台各带台词的声音节点（{titles}{more}），"
            f"点一次生成会把它们全跑一遍、出 {len(branches)} 段音频，弹窗里也是 {len(branches)} 个台词框。"
            "想分开用，请在 ComfyUI 里删掉不用的那条分支再导出；"
            "安装包已内置拆好的参考音色 / 音色描述 / 指定音色三份，不用自己拆。"]


def detect_slots(nodes: dict, info: dict | None = None) -> dict:
    """从工作流里认槽位。

    返回：
      slots      —— 建议直接落库的槽位（prompt / image / 自动控件）
      candidates —— 其它可绑的字面量控件，给设置页手动加
      nodes      —— 节点清单，给设置页显示"这份工作流里有什么"
      warnings   —— 检测过程中值得告诉用户的事（不阻断导入）
    """
    slots: list[dict] = []
    warnings: list[str] = []
    prompt_nodes: set[str] = set()

    for nid in _ordered_ids(nodes):
        node = nodes[nid]
        class_type = str(node.get("class_type") or "").lower()
        for key, value in node_inputs(node).items():
            lowered = key.lower()
            if "negative" in lowered:
                continue
            by_key = lowered in PROMPT_INPUT_KEYS
            by_class = (class_type in STRING_PRIMITIVE_CLASSES
                        and lowered == STRING_PRIMITIVE_KEY)
            secondary = SECONDARY_PROMPT_KEYS.get(lowered, "")
            if not (by_key or by_class or secondary):
                continue
            if not isinstance(value, str) or not value.strip():
                continue
            if secondary:
                # 认得出用途的第二段文字（音色克隆的原话）：键名说了算，不看谁先出现，
                # 否则 ref_text 排在 text 前面就会把原话当成主提示词、把台词当成原话。
                label = secondary
            elif nid in prompt_nodes:
                # 同一台节点上又多出一段认不出用途的文字：按输入键名标出来，
                # 至少不谎称「完整提示词」——它跟着主框走还是自己填，用户看得见。
                label = key[:40]
            else:
                label = PRIMARY_PROMPT_LABEL
                prompt_nodes.add(nid)   # 一台节点只有一个主框
            slots.append({"kind": "prompt", "node": nid, "input": key,
                          "label": label, "value": value})

    counters: dict[str, int] = {kind: 0 for kind in REFERENCE_KINDS}
    for nid in _ordered_ids(nodes):
        node = nodes[nid]
        kind = reference_kind_for(node.get("class_type"))
        if not kind:
            continue
        input_key = reference_input_key(node, kind)
        if not input_key or not isinstance(node_inputs(node).get(input_key), str):
            warnings.append(f"节点 {nid} 的输入素材是上游节点连过来的，不能当参考位。")
            continue
        counters[kind] += 1
        slot: dict[str, Any] = {
            "kind": kind, "node": nid, "input": input_key,
            "label": node_title(node, f"{REFERENCE_LABEL_STEMS[kind]}{counters[kind]}"),
        }
        if info:
            _GROUPS.clear(); _GROUPS.update(_autogrow_groups(info))
            grow = _grow_target(nodes, nid, REFERENCE_TYPE_FOR_KIND.get(kind, ""))
            if grow:
                slot["grow"] = grow
        slots.append(slot)

    used = {slot_key(s) for s in slots}
    controls: list[dict] = []
    candidates: list[dict] = []
    # 时长先占位：它不占 MAX_AUTO_CONTROLS 那两个名额（比例+分辨率在图片工作流里
    # 已经用满，再挤进去视频就改不了秒数），但它是视频弹窗必须有的第三颗控件。
    duration = _duration_control(nodes, used)
    if duration:
        controls.append(duration)
        used.add(slot_key(duration))
    auto_controls = 0
    if info:
        widgets = _widgets(nodes, info)
        for want in AUTO_CONTROL_KEYS:
            for nid, key, spec in widgets:
                if key != want or auto_controls >= MAX_AUTO_CONTROLS:
                    continue
                if f"{nid}.{key}" in used:
                    continue
                control = control_slot(nid, key, spec, node_inputs(nodes[nid]).get(key))
                if control:
                    controls.append(control)
                    used.add(slot_key(control))
                    auto_controls += 1
        for nid, key, spec in widgets:
            if f"{nid}.{key}" in used:
                continue
            control = control_slot(nid, key, spec, node_inputs(nodes[nid]).get(key))
            if control:
                candidates.append(control)
    slots.extend(controls)

    default_prompt = pick_default_prompt(nodes, slots)
    soundtracks = wired_reference_soundtracks(nodes, slots)
    media_kind = detect_media_kind(nodes)
    warnings.extend(branch_warnings(nodes, slots, media_kind))

    return {
        "slots": slots,
        "candidates": candidates,
        "nodes": node_overview(nodes),
        "default_prompt": default_prompt,
        "media_kind": media_kind,
        "reference_cells": reference_cells(slots, soundtracks),
        "soundtracks": soundtracks,
        "modes": workflow_edit.modes_for(
            nodes,
            [s["node"] for s in reference_slots(slots)],
            info,
            {nid: node_title(node, nid) for nid, node in nodes.items()},
            {s["node"] for s in slots if s.get("kind") == "prompt"},
        ),
        "warnings": warnings,
    }


def reference_kind_for(class_type: Any) -> str:
    """这台节点是哪一类参考素材的加载器。认类名而不是认输入名：
    LoadAudio 的输入叫 audio、VHS_LoadVideo 的叫 video，但第三方包装节点往往自己加前缀。"""
    lowered = str(class_type or "").lower()
    if lowered.startswith("loadimage"):
        return "image"
    if lowered.startswith("loadaudio"):
        return "audio"
    if lowered.startswith("vhs_loadvideo"):
        return "video"
    return ""


def reference_input_key(node: Any, kind: str) -> str:
    """这台加载器要把上传后的文件名写进哪个输入。

    先按族点名（image / audio / video），点不到才退回「它唯一的字符串字面量输入」。
    退回那一步刻意要求唯一：VHS_LoadVideo 除了 video 还有个 format 也是字符串，
    随便挑一个就会把参考视频的文件名写进格式框里。
    """
    inputs = node_inputs(node)
    preferred = REFERENCE_INPUT_KEYS.get(kind, "")
    if isinstance(inputs.get(preferred), str):
        return preferred
    literals = [k for k, value in inputs.items() if isinstance(value, str)]
    return literals[0] if len(literals) == 1 else ""


MISSING_FAMILY_HINTS = {"audio": ("音频", "LoadAudio"), "video": ("视频", "VHS_LoadVideo")}
# 非要有参考音频才出声的那一类节点（Qwen3-TTS 的声音克隆就是这一类）。
# 认类名而不是认「有没有音频槽位」：音色设计与指定音色同样是音频工作流，
# 它们没有也不该有参考音频位，按「缺槽位」报警就是凭空指责用户的工作流坏了。
AUDIO_REFERENCE_CLASS_HINTS = ("voiceclone", "clonevoice", "audioclone", "voicedescribe")


def needs_reference_audio(nodes: Any) -> bool:
    """detected["nodes"]（设置页那份节点清单）里有没有一台要吃不来的参考音频的节点。"""
    for node in nodes or []:
        class_type = str((node or {}).get("class_type") or "").lower()
        if any(hint in class_type for hint in AUDIO_REFERENCE_CLASS_HINTS):
            return True
    return False


def family_warnings(detected: dict) -> list[str]:
    """视频工作流缺了哪一类参考位，导入当时就说清该怎么补。

    只提醒不代劳：app 不往工作流里塞加载器节点。用户的 ref_audios 该接哪台节点、
    要不要顺带音轨，只有在 ComfyUI 里看一眼才知道，凭空造节点只会把工作流弄脏。
    """
    kind = str(detected.get("media_kind") or "image")
    slots = detected.get("slots") or []
    if kind == "audio":
        # 音频同款靠的就是那段参考音色，没有 LoadAudio 就没有「同款」可言。
        if any(str(s.get("kind")) == "audio" for s in slots):
            return []
        # 但「音色描述」「指定音色人物」这两种模式压根不吃参考音频，缺 LoadAudio 不是毛病：
        # 只有工作流里确实躺着一台非要有参考音频才跑得动的克隆节点，这句提醒才成立。
        if not needs_reference_audio(detected.get("nodes") or []):
            return []
        return ["这份工作流没接音频参考位：在 ComfyUI 里加一台 LoadAudio，"
                "连到声音克隆节点的参考音频输入，再重新导入一次，"
                "然后才能在弹窗里换音色。"]
    if kind != "video":
        return []
    return [
        f"这份工作流没接{stem}参考位：在 ComfyUI 里加一台 {class_name}，连到 "
        f"ref_{kind}s 的输入，再重新导入一次就能在弹窗里放{stem}。"
        for kind, (stem, class_name) in MISSING_FAMILY_HINTS.items()
        if not any(str(s.get("kind")) == kind for s in slots)
    ]


def detect_media_kind(nodes: dict) -> str:
    """这份工作流出的是图、视频还是音频。先看产出端，再兜底看模型端。

    视频排在音频前面：H3 那样的视频工作流同时带 LoadAudio/音轨处理，
    先判音频会把一条出片的工作流错归到音频族。
    """
    classes = [str(node.get("class_type") or "").lower()
               for node in (nodes or {}).values() if isinstance(node, dict)]
    for hints in (VIDEO_OUTPUT_HINTS, VIDEO_MODEL_HINTS):
        for hint in hints:
            if any(hint in c for c in classes):
                return "video"
    for hint in AUDIO_OUTPUT_HINTS:
        if any(hint in c for c in classes):
            return "audio"
    return "image"


# ---------- 槽位校验 ----------


def _load_slots(raw: Any) -> list[dict]:
    if isinstance(raw, list):
        return [x for x in raw if isinstance(x, dict)]
    if not isinstance(raw, str) or not raw.strip():
        return []
    try:
        data = json.loads(raw)
    except ValueError:
        return []
    return [x for x in data if isinstance(x, dict)] if isinstance(data, list) else []


def normalize_slots(raw: Any, nodes: dict) -> list[dict]:
    """槽位必须落在真实存在、且值是字面量的输入上；否则抛中文错误。"""
    out: list[dict] = []
    seen: set[str] = set()
    for item in _load_slots(raw):
        kind = str(item.get("kind") or "")
        node = str(item.get("node") or "")
        key = str(item.get("input") or "")
        if kind not in KINDS:
            raise ValueError(f"未知的槽位类型：{kind or '（空）'}")
        if node not in nodes:
            raise ValueError(f"工作流里没有节点 {node}，请重新导入这份工作流。")
        inputs = node_inputs(nodes[node])
        if key not in inputs:
            raise ValueError(f"节点 {node} 没有 {key} 这个输入，请重新导入这份工作流。")
        if kind not in REFERENCE_KINDS and not is_literal(inputs[key]):
            raise ValueError(f"节点 {node} 的 {key} 由上游节点连过来，不能当槽位。")
        slot: dict[str, Any] = {
            "kind": kind, "node": node, "input": key,
            "label": (str(item.get("label") or "").strip() or key)[:40],
        }
        if kind == "prompt" and isinstance(item.get("value"), str):
            # 弹窗里那第二段文字要有初始值（工作流里现在写的是什么），否则用户面对的是
            # 一个空框，填了反而把参考音频的原话冲成空字符串——节点会当场报错。
            slot["value"] = item["value"][:50000]
        if kind == "select":
            options = [x for x in (item.get("options") or []) if isinstance(x, str)]
            if not options:
                raise ValueError(
                    f"控件 {node}.{key} 没有可用选项（导入时 ComfyUI 可能没开），"
                    "请启动 ComfyUI 后重新导入这份工作流。"
                )
            slot["options"] = options
            slot["value"] = item.get("value") if item.get("value") in options else options[0]
        elif kind == "number":
            for extra in ("value", "min", "max", "step", "unit"):
                if item.get(extra) is not None:
                    slot[extra] = item[extra]
            # 时长那种「给几个档就够了」的预设要能活着过一遍存库，不然换个工作流重开
            # 弹窗就退成纯数字框，用户又得自己敲 8。
            presets = [x for x in (item.get("presets") or [])
                       if isinstance(x, (int, float)) and not isinstance(x, bool)]
            if presets:
                slot["presets"] = presets[:12]
        grow = item.get("grow")
        if isinstance(grow, dict):
            gnode = str(grow.get("node") or "")
            group = str(grow.get("group") or "").strip()
            names = [n for n in (grow.get("names") or []) if isinstance(n, str)][:GROW_MAX]
            if kind in REFERENCE_KINDS and gnode in nodes and group and names:
                slot["grow"] = {
                    "node": gnode, "group": group, "names": names,
                    "type": str(grow.get("type") or ""),
                }
        key_id = slot_key(slot)
        if key_id in seen:
            continue
        seen.add(key_id)
        out.append(slot)
    if not any(s["kind"] == "prompt" for s in out):
        raise ValueError("这份工作流里没有可写入提示词的文本输入，去设置里手动绑一个提示词槽。")
    return out


# ---------- 生成用：把弹窗里填的东西注进工作流 ----------


def _validate_control(slot: dict, value: Any) -> None:
    label = slot.get("label") or slot_key(slot)
    if slot["kind"] == "select":
        options = slot.get("options") or []
        if value not in options:
            raise ValueError(f"{label}只能是这些值之一：{', '.join(options)}")
        return
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label}需要填数字。")
    low, high = slot.get("min"), slot.get("max")
    if low is not None and value < low:
        raise ValueError(f"{label}不能小于 {low}。")
    if high is not None and value > high:
        raise ValueError(f"{label}不能大于 {high}。")


def randomize_seeds(nodes: dict) -> int:
    """把 seed / noise_seed 换成新随机值：同款要的是"同一配方再抽一张"，不是复刻。"""
    changed = 0
    for node in nodes.values():
        inputs = node_inputs(node)
        for key, value in inputs.items():
            if key.lower() in SEED_INPUT_KEYS and isinstance(value, int) and not isinstance(value, bool):
                inputs[key] = random_seed()
                changed += 1
    return changed


def _attach_grown_reference(nodes: dict, slot: dict, name: str, file_name: str) -> None:
    """参考位多出来的那些格：照着原来那台加载器复制一台，填好素材，连进空着的那一格。

    为什么由图库来复制节点：H3 的 ref_images 会自动长格（ref_image_0…8），
    用户不必回 ComfyUI 手摆节点就能多喂参考素材。三族共用这套做法——
    复制的是槽位自己那台节点，所以音频位长出来的是 LoadAudio，视频位是 VHS_LoadVideo。
    """
    grow = slot.get("grow") if isinstance(slot.get("grow"), dict) else {}
    source_id = str(slot["node"])
    source = nodes.get(source_id)
    target_id = str(grow.get("node") or "")
    group = str(grow.get("group") or "")
    if source is None or target_id not in nodes or not group:
        raise ValueError("这份工作流的多图参考位信息不完整，请在设置里重新导入一次。")
    # 图组的空格以「当前工作流」为准：同一个组往往被两台 LoadImage 共用，
    # 照导入时缓存的名字硬塞会互相覆盖，悄悄少一张参考图。
    live = node_inputs(nodes[target_id])
    taken = {k.partition(".")[2] for k in live if k.startswith(group + ".")}
    free = [n for n in grow_names(slot) if n not in taken]
    # 点名的格子还空着就照原样接；被别的参考位占了就顺延到下一格，
    # 免得两台 LoadImage 长进同一个图组时后一张悄悄顶掉前一张。
    requested = str(name)
    name = requested if requested in free else (free[0] if free else None)
    if name is None:
        stem = REFERENCE_LABEL_STEMS.get(str(slot.get("kind") or ""), "参考")
        raise ValueError(f"这份工作流的{stem}参考位已经放满了，少加几份再试。")
    clone = copy.deepcopy(source)
    node_inputs(clone).update({str(slot["input"]): file_name})
    meta = clone.get("_meta") if isinstance(clone.get("_meta"), dict) else {}
    meta["title"] = (f"{node_title(source, source_id)} · {name}")[:60]
    clone["_meta"] = meta
    new_id = str(_next_node_id(nodes))
    nodes[new_id] = clone
    # 连线值的类型跟着工作流原有的写法：有的导出是 ["543", 0]，有的是 [543, 0]
    target_inputs = node_inputs(nodes[target_id])
    existing = next((v for k, v in target_inputs.items()
                     if k.startswith(group + ".") and isinstance(v, list) and v), None)
    link = new_id if isinstance(existing, list) and isinstance(existing[0], str) else (
        int(new_id) if new_id.isdigit() else new_id)
    target_inputs.update({f"{group}.{name}": [link, 0]})


def build_workflow(
    nodes: dict,
    slots: list[dict],
    *,
    prompt: str | None = None,
    slot_prompts: dict[str, str] | None = None,
    references: dict[str, str] | None = None,
    controls: dict[str, Any] | None = None,
    info: dict | None = None,
    randomize_seed: bool = True,
) -> tuple[dict, dict[str, str]]:
    """注入并返回 (工作流副本, {节点号: 标题})；标题用来把 ComfyUI 报错翻成人话。"""
    workflow = copy.deepcopy(nodes)
    titles = {nid: node_title(node, nid) for nid, node in workflow.items()}
    by_key = {slot_key(s): s for s in slots}
    if prompt is not None:
        prompts = [s for s in slots if s.get("kind") == "prompt"]
        primaries = {slot_key(s) for s in prompts
                     if str(s.get("label") or "") == PRIMARY_PROMPT_LABEL} or                     {slot_key(prompts[0]) if prompts else ""}
        for slot in prompts:
            key = slot_key(slot)
            text = (slot_prompts or {}).get(key)
            if text is not None:
                value = text
            elif key in primaries:
                value = prompt
            elif str(slot.get("input") or "").lower() in MIRROR_SCRIPT_KEYS:
                # 参考原话留空＝「就说台词这句」：音色克隆那台节点要的是同一句话，
                # 留空会让它拿不到原话，克隆出来的音色当场跑偏。
                value = prompt
            else:
                # 其余单独命名的文字位（音色描述、语气风格）：留空就是没指令。
                # 拿台词去灌等于用户什么都没写、声音却按台词的内容变了。
                continue
            node_inputs(workflow.get(slot["node"])).update({slot["input"]: value})
    for key, image_name in (references or {}).items():
        base_key, grow_name = split_reference_key(key)
        slot = by_key.get(base_key)
        if slot is None or slot.get("kind") not in REFERENCE_KINDS:
            raise ValueError(f"这份工作流里没有叫 {key} 的参考位，请重新打开弹窗再试。")
        if grow_name is None:
            node_inputs(workflow.get(slot["node"])).update({slot["input"]: str(image_name)})
            continue
        if grow_name not in grow_names(slot):
            raise ValueError(f"{key} 不是这份工作流空着的参考位，请重新打开弹窗再试。")
        _attach_grown_reference(workflow, slot, grow_name, str(image_name))
    for key, value in (controls or {}).items():
        slot = by_key.get(key)
        if slot is None or slot.get("kind") not in ("select", "number"):
            raise ValueError(f"{key} 不是这份工作流声明的控件，请重新打开弹窗再试。")
        if value is None:
            continue
        _validate_control(slot, value)
        node_inputs(workflow.get(slot["node"])).update({slot["input"]: value})
    # 没喂素材的加载器一律摘掉：留着它，ComfyUI 会悄悄用工作流里那份旧图/旧声音/旧片子，
    # 用户在弹窗里看到的参考和实际出片的参考就对不上了。一份都不喂就是纯文本生成。
    unused = unused_reference_nodes(slots, references)
    if unused:
        workflow = drop_reference_images(workflow, unused, info, titles, slots)
    # 出图尺寸交给比例/分辨率：工作流自带的 Latent 开关必须站到空 Latent 那头，
    # 否则弹窗里那两颗控件是死的。
    workflow_edit.prefer_empty_latent(workflow)
    if randomize_seed:
        randomize_seeds(workflow)
    return workflow, titles


# ---------- 模板读写 ----------

NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"


def _conn():
    return get_pool().main()


def public(row: Any) -> dict:
    """给前端的模板视图：不带工作流正文，只带槽位与计数（导出走单独接口）。"""
    data = dict(row)
    workflow = data.pop("workflow", "") or ""
    slots = _load_slots(data.pop("slots", "[]"))
    try:
        nodes = parse_workflow(workflow)
    except ValueError:
        nodes = {}
    kind = str(data.get("media_kind") or "image")
    if kind not in MEDIA_KINDS:
        kind = "image"
    data["media_kind"] = kind
    # 内置与否只在设置页挂个徽标：用户删得掉，删了也不会下次启动又长回来
    data["is_builtin"] = bool(data.get("bundled_key"))
    data["bundled_key"] = str(data.get("bundled_key") or "")
    data["slots"] = slots
    data["is_active"] = bool(data.get("is_active"))
    data["node_count"] = len(nodes)
    data["prompt_count"] = sum(1 for s in slots if s.get("kind") == "prompt")
    data["reference_count"] = len(reference_slots(slots))
    for ref_kind in REFERENCE_KINDS:
        data[f"{ref_kind}_reference_count"] = sum(1 for s in slots if s.get("kind") == ref_kind)
    data["control_count"] = sum(1 for s in slots if s.get("kind") in ("select", "number"))
    data["modes"] = fallback_modes(nodes, slots)
    # 参考格清单由后端一处算准（顺序、编号、H3 标签），前端照着画。
    # 两边各算一遍的话，弹窗里那个「音频2」和实际接线的 ref_audio_1 早晚会分家。
    data["soundtracks"] = wired_reference_soundtracks(nodes, slots)
    data["reference_cells"] = reference_cells(slots, data["soundtracks"])
    return data


def list_templates() -> list[dict]:
    rows = _conn().execute("SELECT * FROM clone_templates ORDER BY is_active DESC, id").fetchall()
    return [public(r) for r in rows]


def get_row(template_id: int) -> dict:
    row = _conn().execute("SELECT * FROM clone_templates WHERE id=?", (template_id,)).fetchone()
    if row is None:
        raise KeyError(f"同款工作流 {template_id} 不存在，可能已经被删掉了。")
    return dict(row)


def get_template(template_id: int) -> dict:
    """带节点表与解析后槽位的完整模板，生成流程用这个。"""
    row = get_row(template_id)
    row["slots"] = _load_slots(row.get("slots"))
    row["nodes"] = parse_workflow(row.get("workflow") or "")
    return row


def workflow_json(template_id: int) -> str:
    return get_row(template_id).get("workflow") or ""


def default_prompt_for(nodes: dict, slots: list[dict]) -> str:
    return pick_default_prompt(nodes, slots)


def _media_kind_of(row: dict) -> str:
    kind = str((row or {}).get("media_kind") or "image")
    return kind if kind in MEDIA_KINDS else "image"


def set_active(template_id: int) -> dict:
    """把这份工作流设成它那一族的「当前」。

    只清同族的 is_active：图片卡和视频卡各有各的默认，选了视频那份不该把图片那份顶掉
    ——否则下次从图片卡点开弹窗，里面躺着一条视频工作流，比例下拉都不一样。
    """
    kind = _media_kind_of(get_row(template_id))
    conn = _conn()
    conn.execute("UPDATE clone_templates SET is_active=0 WHERE media_kind=?", (kind,))
    conn.execute("UPDATE clone_templates SET is_active=1 WHERE id=?", (template_id,))
    conn.execute(f"UPDATE clone_templates SET updated_at={NOW_SQL} WHERE id=?", (template_id,))
    return public(conn.execute("SELECT * FROM clone_templates WHERE id=?", (template_id,)).fetchone())


def redetect_slots(template_id: int, info: dict | None = None) -> dict:
    """按库里存着的工作流重新检测槽位，结果整体替换旧的。

    主要是补「导入时 ComfyUI 没开 → 比例/分辨率没检测出来」这一课。
    代价是手动改过的绑定会被冲掉，所以设置页那个按钮的 title 里要写清楚。
    """
    row = get_row(template_id)
    nodes = parse_workflow(row.get("workflow") or "")
    slots = normalize_slots(detect_slots(nodes, info)["slots"], nodes)
    conn = _conn()
    conn.execute(
        f"UPDATE clone_templates SET slots=?, default_prompt=?, updated_at={NOW_SQL} WHERE id=?",
        (json.dumps(slots, ensure_ascii=False), default_prompt_for(nodes, slots), template_id),
    )
    return public(conn.execute("SELECT * FROM clone_templates WHERE id=?", (template_id,)).fetchone())


def create_template(name: str, workflow_raw: Any, slots_raw: Any = None,
                    media_kind: str | None = None) -> dict:
    name = (name or "").strip()
    if not name:
        raise ValueError("给这份工作流起个名字，弹窗里要靠它认模板。")
    if len(name) > 40:
        raise ValueError("名字最长 40 个字。")
    nodes = parse_workflow(workflow_raw)
    slots = normalize_slots(detect_slots(nodes)["slots"] if slots_raw is None else slots_raw, nodes)
    kind = media_kind if media_kind in MEDIA_KINDS else detect_media_kind(nodes)
    conn = _conn()
    if conn.execute("SELECT 1 FROM clone_templates WHERE name=?", (name,)).fetchone():
        raise DuplicateNameError(f"已经有叫「{name}」的同款工作流，换一个名字。")
    # 这一族还没有「当前」就让新来的当默认：只导入过图片工作流的人不该在视频卡上
    # 面对一个空弹窗；但已经有默认的族不会被一次导入悄悄换掉。
    is_first = conn.execute(
        "SELECT 1 FROM clone_templates WHERE media_kind=? AND is_active=1", (kind,)
    ).fetchone() is None
    cur = conn.execute(
        "INSERT INTO clone_templates(name, workflow, slots, default_prompt, is_active, media_kind)"
        " VALUES(?,?,?,?,?,?)",
        (name, json.dumps(nodes, ensure_ascii=False), json.dumps(slots, ensure_ascii=False),
         default_prompt_for(nodes, slots), 1 if is_first else 0, kind),
    )
    return public(conn.execute("SELECT * FROM clone_templates WHERE id=?", (cur.lastrowid,)).fetchone())


def update_template(template_id: int, patch: dict) -> dict:
    """改名 / 改槽位 / 设为当前 / 就地替换工作流。

    替换工作流时若没同时给槽位，就按新工作流重新检测：换完 JSON 节点号大概率变了，
    沿用旧槽位只会让生成莫名失败。
    """
    row = get_row(template_id)
    conn = _conn()
    name = str(row["name"])
    old_kind = _media_kind_of(row)
    if patch.get("name") is not None:
        candidate = str(patch["name"]).strip()
        if not candidate:
            raise ValueError("名字不能为空。")
        if len(candidate) > 40:
            raise ValueError("名字最长 40 个字。")
        if conn.execute("SELECT 1 FROM clone_templates WHERE name=? AND id<>?", (candidate, template_id)).fetchone():
            raise DuplicateNameError(f"已经有叫「{candidate}」的同款工作流，换一个名字。")
        name = candidate

    replacing = patch.get("workflow") is not None
    nodes = parse_workflow(patch["workflow"] if replacing else row.get("workflow"))
    slots_raw = patch.get("slots")
    if slots_raw is None and replacing:
        slots_raw = detect_slots(nodes)["slots"]
    if slots_raw is None:
        slots_raw = row.get("slots")
    slots = normalize_slots(slots_raw, nodes)
    # 手动改判优先；换了一份 JSON 就重新判一次（换完可能从出图变成出片）；都没给就沿用。
    kind = patch.get("media_kind")
    if kind not in MEDIA_KINDS:
        kind = detect_media_kind(nodes) if replacing else old_kind

    conn.execute(
        f"UPDATE clone_templates SET name=?, workflow=?, slots=?, default_prompt=?, media_kind=?,"
        f" updated_at={NOW_SQL} WHERE id=?",
        (name, json.dumps(nodes, ensure_ascii=False), json.dumps(slots, ensure_ascii=False),
         default_prompt_for(nodes, slots), kind, template_id),
    )
    if kind != old_kind:
        # 改判族别后「当前」要重新算：新族里已经有默认的，这边就退下来，
        # 否则同一族躺着两条 is_active=1，弹窗默认用哪条全看查询顺序。
        if conn.execute("SELECT 1 FROM clone_templates WHERE media_kind=? AND is_active=1 AND id<>?",
                        (kind, template_id)).fetchone():
            conn.execute("UPDATE clone_templates SET is_active=0 WHERE id=?", (template_id,))
        _ensure_active_kind(conn, old_kind)
    if patch.get("is_active") is True:
        return set_active(template_id)
    return public(conn.execute("SELECT * FROM clone_templates WHERE id=?", (template_id,)).fetchone())


def _ensure_active_kind(conn, kind: str) -> None:
    """这一族没有「当前」了就拿最早一条顶上，别让弹窗对着空默认。"""
    if kind not in MEDIA_KINDS:
        return
    if conn.execute("SELECT 1 FROM clone_templates WHERE media_kind=? AND is_active=1",
                    (kind,)).fetchone():
        return
    fallback = conn.execute(
        "SELECT id FROM clone_templates WHERE media_kind=? ORDER BY id LIMIT 1", (kind,)
    ).fetchone()
    if fallback:
        conn.execute("UPDATE clone_templates SET is_active=1 WHERE id=?", (int(fallback["id"]),))


def delete_template(template_id: int) -> int:
    row = get_row(template_id)
    conn = _conn()
    kind = _media_kind_of(row)
    bundled_key = str(row.get("bundled_key") or "")
    conn.execute("DELETE FROM clone_templates WHERE id=?", (template_id,))
    if bundled_key:
        # 内置模板删掉就到此为止：记进 dismissed 名单，否则下次启动 seed 又塞回来
        from .clone_bundled import note_dismissal
        note_dismissal(conn, bundled_key)
    # 删掉的正好是当前用的 → 同族里拿最早一条顶上，别让弹窗没有默认模板。
    _ensure_active_kind(conn, kind)
    return template_id
