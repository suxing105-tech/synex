"""再次创作：工作流模板的存储与槽位检测。

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
    # 云端 API 那三条模板带的四列。「这条配方跑在本机还是云端」是模板的属性，
    # 不是用户要新学的一个概念，所以不另开一张表；workflow 对云端没有意义，留空。
    if "engine" not in cols:
        conn.execute(
            "ALTER TABLE clone_templates ADD COLUMN engine TEXT NOT NULL DEFAULT 'comfyui'")
    if "provider" not in cols:
        conn.execute("ALTER TABLE clone_templates ADD COLUMN provider TEXT")
    if "model" not in cols:
        conn.execute("ALTER TABLE clone_templates ADD COLUMN model TEXT")
    if "params" not in cols:
        conn.execute("ALTER TABLE clone_templates ADD COLUMN params TEXT NOT NULL DEFAULT '{}'")


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
# 素材组格名前缀 -> 这一族。参考位谁排第几，看的是它接进了消费节点的第几格
# （H3 写成 ref_images.ref_image_0、ref_videos.ref_video_0…，Qwen 写成 images.image_1…），
# 不是节点号：模型眼里的 <Picture 1> / <Video 1> 就是 ref_image_0 / ref_video_0 那一格。
# 只认这几个前缀。ref_video_audio_0 这种不在名单里的，是参考视频自己的音轨，
# 不占参考格（它的计数在 wired_reference_soundtracks），认错族就会把编号排乱。
CELL_STEM_KINDS = {"image": "image", "ref_image": "image",
                   "audio": "audio", "ref_audio": "audio",
                   "video": "video", "ref_video": "video"}
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
    base = f"{slot.get('node')}.{slot.get('input')}"
    # 一颗 Lora 管理器往往挂好几颗控件（整组开关一颗、某一颗 lora 的强度一颗），
    # 它们写的都是同一个 loras 输入。只靠「节点.输入」两颗粒键会撞，
    # 撞了就是后提交的那颗悄悄覆盖前一颗——弹窗里两根都填过，工作流里只留一份。
    # 所以 lora 槽位的键要带一段身份。尾巴用 #：:: 已经被 autogrow 的参考位占了。
    single = str(slot.get("lora") or "").strip()
    if single:
        return f"{base}#{lora_short_name(single)}"
    if slot.get("lora_group"):
        return f"{base}{LORA_GROUP_SUFFIX}"
    return base


# ---------- Lora 管理器：整组开关与单颗强度 ----------
# ComfyUI-Lora-Manager 那颗 loras 输入不是普通值，是一份清单：
#   {"__value__": [{"name","strength","clipStrength","active",...}, ...]}
# 运行时读它的是 lora_loader.py：active 为假的条目直接跳过；强度取 strength，
# clipStrength 只在缺省时才回落到 strength。两件事因此各有唯一写法：
# 开不开只能写 active，而改强度必须 strength 与 clipStrength 一起写
# （只改一份，提交给模型的标签就成了「新模型强度 + 旧字轨强度」）。

LORA_GROUP_SUFFIX = "#@"                       # 整组开关那颗粒键的尾巴，见 slot_key
LORA_NAME_SEPARATORS = ("/", chr(92))          # 斜杠与反斜杠：两种导出习惯都见过


def lora_short_name(name: Any) -> str:
    """lora 名里最后那一段：MinimaxH3/H3_speed_slider_1.1 -> H3_speed_slider_1.1。"""
    flat = str(name or "")
    for sep in LORA_NAME_SEPARATORS:
        flat = flat.replace(sep, "/")
    return flat.rsplit("/", 1)[-1]


def _is_lora_manager(class_type: Any) -> bool:
    return "loramanager" in str(class_type or "").lower()


def lora_slot_entries(nodes: dict, slot: dict) -> list[dict]:
    """按槽位取那份 lora 清单本体。

    返回的是工作流里那个 list 本身，改条目就是改工作流，不需要再写回去。
    结构不对（用户自己换过节点、或认错了槽位）直接抛——这一句在导入与生成都会走到。
    """
    raw = node_inputs(nodes.get(str(slot.get("node") or ""))).get(str(slot.get("input") or ""))
    entries = raw.get("__value__") if isinstance(raw, dict) else raw
    if not isinstance(entries, list):
        raise ValueError(f"{slot_key(slot)} 读不出一份 lora 清单，请在设置里重新导入这份工作流。")
    return entries

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
        # 这一格吃不吃遮罩（"alpha" = 吃）：弹窗要靠它在格子上摆「编辑遮罩」那颗，
        # 不然用户得自己记住哪一格接了遮罩。
        "mask": str(slot.get("mask") or ""),
    }


def reference_cells(slots: list[dict], soundtracks: int = 0,
                    tag_templates: dict | None = None) -> list[dict]:
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
    return attach_tags(cells, soundtracks, tag_templates)


def attach_tags(cells: list[dict], soundtracks: int = 0,
                tag_templates: dict | None = None) -> list[dict]:
    """给每一格补上它在 H3 上下文里的标签：<Picture i> / <Video k> / <Audio j>。

    序号是「每类各自 1 起」，但 H3 把参考摆进上下文时按 图片 → 视频 → 独立音频 排，
    而参考视频自带的音轨会在这个视频之前先占一个 <Audio j> 号
    （comfy_extras/nodes_minimax_h3.py 里音轨先 append({"type": "audio"})
    再 append({"type": "video"})）。所以独立音频要从「已连线音轨数」之后接着数，
    否则用户插进来的 <Audio 1> 指的是参考视频的音轨，指错人。
    """
    templates = tag_templates or TAG_TEMPLATES
    offset = max(0, int(soundtracks or 0))
    for cell in cells:
        ordinal = int(cell.get("ordinal") or 1)
        kind = cell.get("kind")
        if kind == "audio":
            ordinal += offset
        cell["tag"] = templates.get(str(kind), "").format(n=ordinal)
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
    """给前端用的参考格清单：带 kind / label / tag，顺序与后端校验一致。

    云端模板的标签由模型声明给：Seedance 认的是 @Image 1，本机 H3 认的是 <Picture 1>。
    标签写成另一家的语法，后果是参考素材明明传上去了、模型却不认，而且不报错。
    """
    spec = cloud_spec_of(template)
    slots = template.get("slots") or []
    return reference_cells(
        slots,
        0 if spec else wired_reference_soundtracks(template.get("nodes") or {}, slots),
        spec.tag_templates() if spec else None,
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


def _wired_reference_cells(nodes: dict) -> dict[str, dict[str, tuple[int, str, int]]]:
    """{加载器节点号: {族: (消费节点序号, 组名, 格号)}} —— 一次扫完全图的参考接线。

    API 格式里连线只写在消费方（`"ref_images.ref_image_1": ["188", 0]`），所以要反过来扫。
    只认「组名.格名_数字」这种 autogrow 写法：ComfyUI 存盘时素材组一律是这个形状，
    第三方平铺的 image_01…05 没有组名可核对族，不猜（宁可不排，也别把本来对的次序改坏）。
    同一台加载器被连到多格时取最靠前的那格。
    """
    ranks = {nid: i for i, nid in enumerate(_ordered_ids(nodes))}
    out: dict[str, dict[str, tuple[int, str, int]]] = {}
    for nid, node in nodes.items():
        for key, value in node_inputs(node).items():
            if not isinstance(value, (list, tuple)) or len(value) < 2:
                continue
            group, dot, cell = str(key).rpartition(".")
            if not dot:
                continue        # 平铺的 image_02 那种没有组名，核对不了族，不认
            stem, sep, num = cell.rpartition("_")
            if not sep or not num.isdigit():
                continue
            kind = CELL_STEM_KINDS.get(stem.rstrip("s"))
            if not kind:
                continue
            hit = (ranks.get(nid, len(ranks)), group, int(num))
            bucket = out.setdefault(str(value[0]), {})
            if bucket.get(kind) is None or hit < bucket[kind]:
                bucket[kind] = hit
    return out


def sort_reference_slots(nodes: dict, slots: list[dict]) -> list[dict]:
    """参考槽位照「接进模型的第几格」重排，一族里接线说不清就整族照原样。

    为什么必须重排：导入时按节点号数参考位，而 ComfyUI 的节点号是随手分配的。
    苏醒那份 H3 工作流里 25/26/27 三台视频加载器实际接的是 ref_video_1/2/0，
    照节点号数就把 25 号报成「视频1」，用户在弹窗里 @ 的 <Video 1> 其实是 ref_video_1
    那份——编号和 @ 引用一起指错人，而且一声不响。

    「说不清」有两种：这一族里有加载器根本没接到素材组（局部编辑那张底图是走
    VAEEncode 进模型的，不该跟着参考格编号跑），或者两台挤在同一格。这两种都没有
    可靠的接线依据，就保留导入时的顺序，不硬编一个可能更错的。

    只动同一族内部的先后：文字位、控件原位不动，参考位的键（node.input）也不变，
    所以库里记的历史来源照旧认得，变的只是编号和 @ 引用与接线对不对得上。
    """
    if not nodes or not slots:
        return list(slots)
    cells = _wired_reference_cells(nodes)
    out = list(slots)
    for kind in REFERENCE_KINDS:
        at = [i for i, slot in enumerate(out) if slot.get("kind") == kind]
        if len(at) < 2:
            continue
        keyed = [cells.get(str(out[i].get("node")), {}).get(kind) for i in at]
        if any(hit is None for hit in keyed) or len(set(keyed)) != len(keyed):
            continue
        moved = [out[at[j]] for j in sorted(range(len(at)), key=lambda j: keyed[j])]
        for pos, slot in enumerate(moved):
            out[at[pos]] = slot
    return out


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


# 百万像素那颗旋钮和对齐步长那颗，官方 ResolutionSelector 用英文名（megapixels / multiple），
# 第三方也做同一件事的节点用中文名（孤海「比例与分辨率」：百万像素 / 倍数取整）。
# 取数口径只认这两组名字，认不出就缺着——猜一个只会把「这一趟出多大」报错。
MEGAPEXEL_INPUTS = ("megapixels", "百万像素")
PIXEL_MULTIPLE_INPUTS = ("multiple", "倍数取整")
# 「自定义宽高」这一档的两个像素输入。这一档里节点不看模式、也不看百万像素，
# 宽高直接取这两个输入，所以它们必须能改——改不了的「自定义宽高」是假选项。
CUSTOM_RATIO_OPTION = "自定义宽高"
RATIO_INPUT_KEYS = ("比例", "aspect_ratio")
PIXEL_WIDTH_INPUTS = ("自定宽度", "自定义宽度", "custom_width")
PIXEL_HEIGHT_INPUTS = ("自定高度", "自定义高度", "custom_height")
PIXEL_UNIT = "px"
# 节点没接上（拿不到 object_info）时的区间，照节点源码那对写：min 8 / max 10240 / step 1
PIXEL_FALLBACK_RANGE = (8, 10240)


def node_pixel_multiple(node: Any) -> float | int | None:
    """那台节点自己带的对齐步长；没有这个输入、或者值不像个数就返回 None（宁缺毋滥）。"""
    inputs = node_inputs(node)
    for key in PIXEL_MULTIPLE_INPUTS:
        multiple = inputs.get(key)
        if isinstance(multiple, bool) or not isinstance(multiple, (int, float)) or multiple <= 0:
            continue
        return int(multiple) if float(multiple).is_integer() else multiple
    return None


def attach_pixel_multiple(control: dict, node: Any) -> None:
    """百万像素那台节点上的对齐步长（ResolutionSelector 的 multiple）跟着槽位一起带走。

    弹窗靠它算「这一趟会出多大一张图」（前端 lib/clone.ts 的 targetPixelSize 是同一套公式：
    总像素 = MP × 1024²，按比例开方后各自对齐到 multiple 的最近倍数）。官方 ResolutionSelector
    把它做成 advanced 输入、默认 8，孤海「比例与分辨率」的总像素模式明写与官方同一套账、它的
    倍数取整默认 16——工作流里改成 32 就得按 32 算，写死任何常数都会把尺寸报错几十像素。
    节点没有这个输入、或者值不像个数，就不带这个键，前端按 8 兜底。

    自定义宽高那两个像素框也吃这一颗：同一个「倍数取整」既管总像素那条分支，也管这一条
    （节点源码里两条分支最后都过 _round_to_multiple），报尺寸得按同一个数对齐。
    """
    if control.get("input") not in (
            MEGAPEXEL_INPUTS + PIXEL_WIDTH_INPUTS + PIXEL_HEIGHT_INPUTS):
        return
    multiple = node_pixel_multiple(node)
    if multiple is not None:
        control["multiple"] = multiple


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


def _custom_size_controls(nodes: dict, widgets: list, controls: list[dict],
                         used: set[str]) -> list[dict]:
    """认出「自定义宽高」这一档的两个像素框，顺手把百万像素那颗标成这一档不显示。

    为什么要专门认：孤海「比例与分辨率」在比例选到自定义宽高时，宽高直接取「自定宽度／自定高度」，
    而工作流里那两位默认写着 32×1024。弹窗里没有能改它们的框，用户选「自定义宽高」就等于
    提交那对没人填过的数——2026-11-17 苏醒问的「不能真的自定义宽高吗」就是这么来的。

    认法收得紧，四条同时成立才认：一、有一台节点的「比例」是 combo 且选项里明写「自定义宽高」
    （必须问 object_info——没有这个选项就没有这一档）；二、那颗下拉本身已经是面板上的一颗控件
    （条件得挂在一颗真能选的东西上。它不在控件里就没人能把条件扳过去，两个框会常驻在所有档位，
    比不给更糟）；三、同一台节点上有宽和高两个字面量数字；四、这两个输入还没被别的槽位占走。
    缺一条就当这份工作流没这一档。区间优先用 object_info 给的，没有才退回节点源码那对。
    """
    if not widgets:
        return []
    gates: dict[str, str] = {}
    for nid, key, spec in widgets:
        if key not in RATIO_INPUT_KEYS or spec.get("kind") != "combo":
            continue
        if CUSTOM_RATIO_OPTION not in [x for x in (spec.get("options") or []) if isinstance(x, str)]:
            continue
        gates.setdefault(nid, key)
    bounds: dict[tuple[str, str], dict] = {}
    for nid, key, spec in widgets:
        bounds[(nid, key)] = spec
    for nid in _ordered_ids(nodes):
        ratio_key = gates.get(nid)
        if not ratio_key:
            continue
        if not any(one.get("node") == nid and one.get("input") == ratio_key
                   and one.get("kind") == "select" for one in controls):
            continue
        inputs = node_inputs(nodes[nid])
        found = []
        for group in (PIXEL_WIDTH_INPUTS, PIXEL_HEIGHT_INPUTS):
            hit = next((k for k in group
                        if isinstance(inputs.get(k), (int, float))
                        and not isinstance(inputs.get(k), bool)), None)
            if hit is None or f"{nid}.{hit}" in used:
                found = []
                break
            found.append(hit)
        if len(found) != 2:
            continue
        wkey, hkey = found
        out: list[dict] = []
        for label, key in (("宽度", wkey), ("高度", hkey)):
            spec = bounds.get((nid, key)) or {}
            control = control_slot(nid, key, {
                "kind": "int",
                "default": inputs[key],
                "min": spec.get("min", PIXEL_FALLBACK_RANGE[0]),
                "max": spec.get("max", PIXEL_FALLBACK_RANGE[1]),
                "step": spec.get("step") or 1,
            }, inputs[key])
            if not control:
                out = []
                break
            control["label"] = label
            control["unit"] = PIXEL_UNIT
            control["show_when"] = {"input": ratio_key, "equals": CUSTOM_RATIO_OPTION}
            attach_pixel_multiple(control, nodes[nid])
            out.append(control)
            used.add(f"{nid}.{key}")
        if not out:
            continue
        # 这一档里百万像素不参与出图：留着那颗旋钮，用户拧的是一个不会生效的数。
        for control in controls:
            if control.get("node") == nid and control.get("input") in MEGAPEXEL_INPUTS:
                control["show_when"] = {"input": ratio_key, "not_equals": CUSTOM_RATIO_OPTION}
        return out
    return []


def media_kind_of_template(template: dict | None) -> str:
    """模板属哪一族；库里旧行没这个字段时一律当图片（与历史行为一致）。"""
    kind = str((template or {}).get("media_kind") or "image")
    return kind if kind in MEDIA_KINDS else "image"


CLOUD_ENGINE = "cloud"
ENGINES = ("comfyui", CLOUD_ENGINE)


def engine_of(template: dict | None) -> str:
    """这条配方跑在哪：本机 ComfyUI 还是云端 API。库里没有这一列的老行一律算本机。"""
    return CLOUD_ENGINE if str((template or {}).get("engine") or "") == CLOUD_ENGINE else "comfyui"


def cloud_spec_of(template: dict | None):
    """云端模板对应的模型声明；不是云端模板、或那条声明已经被删掉，回 None。

    懒导入：cloud/spec.py 不反过来依赖本模块，两边谁先被 import 都不会打成环。
    """
    if engine_of(template) != CLOUD_ENGINE:
        return None
    from .cloud import spec as cloud_spec

    return cloud_spec.spec_by_key((template or {}).get("model"))


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
    spec = cloud_spec_of(template)
    if spec is not None:
        # 云端能出什么档由模型声明说，跟「参考链摘不摘得掉」无关——那边没有节点可摘。
        return [m for m in workflow_edit.MODES if m in spec.modes]
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
    会执行图里所有输出节点——点一次「再次创作」出三段音频、等三倍时间，弹窗里还冒出
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
        if _is_lora_manager(class_type):
            # Lora 管理器自带一段拼好的 <lora:...> 文字，运行时那一步直接把它丢掉、
            # 读的是 loras 清单。认成提示词框等于凭空多出一个「改了什么都没变」的框。
            continue
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
            if not isinstance(value, str):
                continue
            if not value.strip() and not by_class:
                # 空文本框一般没什么好写的（写进去也只是把空字符串再填一遍），跳过。
                # 但「字符串原语」那一类整台节点就是一段文字：它现在空着是这份工作流的
                # 默认值（局部重绘那条就是靠留空切到移除模式），跳过等于把这个模式删了。
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

    pending_refs: list[dict] = []
    for nid in _ordered_ids(nodes):
        node = nodes[nid]
        kind = reference_kind_for(node.get("class_type"))
        if not kind:
            continue
        input_key = reference_input_key(node, kind)
        if not input_key or not isinstance(node_inputs(node).get(input_key), str):
            warnings.append(f"节点 {nid} 的输入素材是上游节点连过来的，不能当参考位。")
            continue
        entry: dict[str, Any] = {"kind": kind, "node": nid, "input": input_key,
                                 "title": node_title(node, "")}
        if info:
            _GROUPS.clear(); _GROUPS.update(_autogrow_groups(info))
            grow = _grow_target(nodes, nid, REFERENCE_TYPE_FOR_KIND.get(kind, ""))
            if grow:
                entry["grow"] = grow
        pending_refs.append(entry)
    # 先按接线排好序，再数「图片1/2/3」：没写标题的加载器那个号是它唯一的名字，
    # 数错了就等于给用户一个和它那一格无关的标签（详见 sort_reference_slots）。
    counters: dict[str, int] = {kind: 0 for kind in REFERENCE_KINDS}
    for entry in sort_reference_slots(nodes, pending_refs):
        kind = str(entry["kind"])
        counters[kind] += 1
        slot: dict[str, Any] = {
            "kind": kind, "node": entry["node"], "input": entry["input"],
            "label": str(entry.get("title") or "") or f"{REFERENCE_LABEL_STEMS[kind]}{counters[kind]}",
        }
        if entry.get("grow"):
            slot["grow"] = entry["grow"]
        slots.append(slot)

    # 谁的 MASK 输出去到了下游，谁就能在弹窗里画遮罩：加载器交回的第 1 个输出
    # 本来就是这张图的透明通道，画上去等于把「只改这一块」交给工作流自己接线。
    # 没人接就不给笔刷——涂半天出片一模一样，那是骗人。
    mask_users = _mask_consumers(nodes)
    for slot in slots:
        if slot.get("kind") == "image" and str(slot.get("node")) in mask_users:
            slot["mask"] = "alpha"

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
                    attach_pixel_multiple(control, nodes[nid])
                    controls.append(control)
                    used.add(slot_key(control))
                    auto_controls += 1
        # 自定义宽高那两个框不占 MAX_AUTO_CONTROLS 那两个名额（比例＋分辨率已经用满了），
        # 和时长同一个道理：它们是「这一档必须能改」，不是「多一个参数可以选」。
        controls.extend(_custom_size_controls(nodes, widgets, controls, used))
        for nid, key, spec in widgets:
            if f"{nid}.{key}" in used:
                continue
            control = control_slot(nid, key, spec, node_inputs(nodes[nid]).get(key))
            if control:
                attach_pixel_multiple(control, nodes[nid])
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


def _mask_consumers(nodes: dict) -> set[str]:
    """把「第 1 个输出（MASK）被人接走」的节点号挑出来。

    API 格式里连线只写在消费方：`{"遮罩": ["193", 1]}`。所以扫一遍所有输入，
    凡是二元素数组且第二项是 1 的，它的源节点就是拿遮罩当遮罩用的那一个。
    不认类名：官方 LoadImage 与第三方加载器（加载图像 孤海）在这一条上一样，
    IMAGE 在前、MASK 在后，透明通道就是那张 MASK。
    """
    users: set[str] = set()
    for node in nodes.values():
        for value in node_inputs(node).values():
            if isinstance(value, (list, tuple)) and len(value) == 2 and str(value[1]) == "1":
                users.add(str(value[0]))
    return users


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


# 这些字段不是从工作流里"看"出来的，是这份模板的用法说明：能不能画遮罩、
# 提示词留空算不算一个模式、一颗旋钮管几台节点。重新检测没资格把它们抹掉。
# lora_group / lora_on / lora / option_writes / slider 这几样更不可能「看」出来：
# 它们说的是「这几颗 lora 代表什么」「这一颗要画成滑块」，是作者写下的用法。
SLOT_CONTRACT_KEYS = ("mask", "allow_empty", "empty_hint", "sync_to", "show_when",
                      "lora_group", "lora_on", "lora", "option_writes", "slider",
                      "mode_only")
# 其中这几样连「槽位本身」都检测不出来：lora 控件的值不是某个 node.input 的字面量，
# 而是那份清单里的条目，所以 object_info 里根本没有对应的旋钮。
LORA_CONTRACT_KEYS = ("lora_group", "lora_on", "lora", "option_writes", "slider")


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


def _is_link_value(value: Any) -> bool:
    """连线写法：["261", 0] 或 [261, 0]。导出两种都有，别只认一种。"""
    return (isinstance(value, list) and len(value) == 2
            and not isinstance(value[0], bool) and isinstance(value[0], (str, int))
            and not isinstance(value[1], bool) and isinstance(value[1], int))


def _clean_option_writes(item: dict, slot: dict, nodes: dict) -> dict | None:
    """换档写入：选中某一档时还要连带改哪几颗输入。

    值一般是字面量（武戏多两步采样→steps 写 12）。这里也认连线，为的是「一颗下拉
    切换一条支路」那种开关：低显存模式要说的是「417 的 model 从 403 那头接」还是
    「从 333 那头直接接」，那本来就不是一个字面量，而是走不走那两颗省显存节点。
    但只许连线换成连线：把一条连线换成数字等于悄悄改了工作流的接线结构，
    那不是换档，那是背着人改配方。
    """
    writes = item.get("option_writes")
    if not isinstance(writes, dict):
        return None
    clean: dict[str, list[dict]] = {}
    for opt, rows in writes.items():
        option = str(opt or "")
        if option not in (slot.get("options") or []) or not isinstance(rows, list):
            continue
        keep: list[dict] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            rnode, rkey = str(row.get("node") or ""), str(row.get("input") or "")
            if rnode not in nodes or rkey not in node_inputs(nodes[rnode]):
                raise ValueError(f"控件 {slot_key(slot)} 换档时要写的 {rnode}.{rkey} "
                                 "不在这份工作流里，请重新导入。")
            written = row.get("value")
            if _is_link_value(written):
                if not _is_link_value(node_inputs(nodes[rnode])[rkey]):
                    continue    # 那颗输入当前不是连线，不认「凭空接上一根线」
                keep.append({"node": rnode, "input": rkey,
                             "value": [str(written[0]), int(written[1])]})
                continue
            if isinstance(written, bool) or not isinstance(written, (str, int, float)):
                continue
            keep.append({"node": rnode, "input": rkey, "value": written})
        if keep:
            clean[option] = keep
    return clean or None


def _apply_option_writes(workflow: dict, slot: dict, value: Any) -> None:
    """按选中的那一档落写入。lora 整组开关和「只换档」开关共用这一份，别分叉成两套。"""
    for write in ((slot.get("option_writes") or {}).get(str(value)) or []):
        node_inputs(workflow.get(str(write["node"]))).update(
            {str(write["input"]): write["value"]})


def normalize_slots(raw: Any, nodes: dict) -> list[dict]:
    """槽位必须落在真实存在、且值是字面量的输入上；否则抛中文错误。"""
    out: list[dict] = []
    seen: set[str] = set()
    authored = _load_slots(raw)
    # show_when 可以指向「同模板里另一颗控件的完整键」（一台 Lora 管理器挂两颗控件那种）。
    # 条件那颗可能排在后面，所以先把作者写的控件键全数一遍，不靠先后顺序。
    control_keys = {slot_key(x) for x in authored
                    if str(x.get("kind") or "") in ("select", "number")}
    for item in authored:
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
            if item.get("slider") is True:
                # 「1 到 6 档」这种连续量点按钮像在猜，作者说要滑块就画滑块。
                # 只传意图，区间仍由 min/max 说话，前端不自己挑上下限。
                slot["slider"] = True
            # 对齐步长也得活着过一遍存库：弹窗靠它算「这一趟出多大」，丢了就退回 8，
            # 把 32 对齐的工作流报成 8 对齐的尺寸（几十像素的差）。
            # 谁说了算：节点。真跑起来用的是工作流里那个数，作者写的（内置槽位文件里那一份、
            # 换 JSON 时一起传上来的旧槽位）只是备胎，节点压根没这个输入时才轮到它——
            # 内置那几份槽位是这个键还没加的时候检测的，正文里明写 32 而槽位空着，
            # 光守作者那份会永远报 8 对齐的数。备胎照样卡区间，别把怪值存进库。
            authored = item.get("multiple")
            attach_pixel_multiple(slot, nodes[node])
            if "multiple" not in slot and (
                    not isinstance(authored, bool) and isinstance(authored, (int, float))
                    and 1 <= authored <= 1024):
                slot["multiple"] = int(authored)
        # ---- Lora 管理器那两类：整组开关 / 单颗强度 ----
        # 点名的 lora 在不在图里，必须导入这一刻就吵。留到生成时才失败，
        # 用户看到的是一句 ComfyUI 的英文报错，而根因是槽位绑了一颗不存在的 lora。
        group = item.get("lora_group")
        if kind == "select" and isinstance(group, list):
            present = [str(e.get("name") or "") for e in lora_slot_entries(nodes, slot)]
            named = [str(x or "").strip() for x in group if str(x or "").strip()]
            if not named:
                raise ValueError(f"控件 {slot_key(slot)} 没点名任何 lora，请重新导入这份工作流。")
            absent = [x for x in named if x not in present]
            if absent:
                raise ValueError(f"节点 {node} 的 lora 清单里没有 {'、'.join(absent)}，"
                                 "这和工作流里那几颗对不上，请重新导入这份工作流。")
            slot["lora_group"] = named
            on = str(item.get("lora_on") or "").strip()
            if on not in (slot.get("options") or []):
                raise ValueError(f"控件 {slot_key(slot)} 要说清哪一档是「开」，"
                                 f"目前选项是 {'、'.join(slot.get('options') or [])}。")
            slot["lora_on"] = on
            writes = _clean_option_writes(item, slot, nodes)
            if writes:
                slot["option_writes"] = writes
        if kind == "select" and not isinstance(group, list):
            # 不挂 lora 的下拉也要能换档。H3 那条「低显存模式」切的不是参数大小，
            # 是模型支路走不走那两颗省显存节点——同一份正文，显存大的走直连，
            # 显存小的绕一道，两者都不必再留第二份工作流。
            writes = _clean_option_writes(item, slot, nodes)
            if writes:
                slot["option_writes"] = writes
            if item.get("mode_only") is True:
                # mode_only：这一档的值不是任何 node.input 的取值，说的是「走哪条路」。
                # 因此它绝不往自己绑的那颗输入上落字——把「关」当成 chunks 的值写进去，
                # ComfyUI 当场报一句英文类型错，用户根本想不到是下拉惹的。
                covered = slot.get("option_writes") or {}
                missing = [o for o in (slot.get("options") or []) if o not in covered]
                if missing:
                    raise ValueError(
                        f"控件 {slot_key(slot)} 是「只换档、不填值」的开关，"
                        f"但 {'、'.join(missing)} 这一档没说要改什么，选了它等于什么都没发生。")
                slot["mode_only"] = True

        single_lora = str(item.get("lora") or "").strip()
        if kind == "number" and single_lora:
            present = [str(e.get("name") or "") for e in lora_slot_entries(nodes, slot)]
            if single_lora not in present:
                raise ValueError(f"节点 {node} 的 lora 清单里没有 {single_lora}，"
                                 "这和工作流里那几颗对不上，请重新导入这份工作流。")
            slot["lora"] = single_lora
        if kind == "image" and str(item.get("mask") or "") == "alpha":
            # 这台加载器把「这张图」和「只改哪一块」一起收进同一个文件的透明通道，
            # 弹窗里因此多一个画遮罩的入口。只认 alpha 这一种投递方式：
            # 别的写法（单独一张黑白遮罩图、单独一台 LoadImageMask）我们不接，
            # 认错了比不认更糟——遮罩会被当成图像内容喂进去。
            slot["mask"] = "alpha"
        if kind == "prompt" and item.get("allow_empty") is True:
            # 提示词留空在这类工作流里是一个正经模式（局部重绘／移除二选一），
            # 不是「用户忘了填」。空提示词的放行只认这一条标记。
            slot["allow_empty"] = True
            hint = str(item.get("empty_hint") or "").strip()
            if hint:
                slot["empty_hint"] = hint[:200]
        shown = item.get("show_when")
        if kind in ("number", "select") and isinstance(shown, dict):
            # 「只有比例选到自定义宽高时才出现」这类条件。只允许挂在同一台节点的另一个
            # 字面量文字输入上：跨节点前端算不出（那颗下拉可能压根不在弹窗里），
            # 挂到连线上更不行——它的值不是选项文字。认不出就当没这个条件，控件照常显示，
            # 绝不因为一个算不出的条件把控件藏死。
            when_key = str(shown.get("input") or "")
            equals, not_equals = shown.get("equals"), shown.get("not_equals")
            # 条件挂在哪儿：要么是同节点另一个字面量文字输入（绝大多数），
            # 要么是同模板里另一颗控件的完整键——一颗 Lora 管理器挂两颗控件时，
            # 两颗粒键只有完整键分得开，而它们的值根本不是 node.input 本身。
            same_node = bool(when_key) and when_key != key and when_key in inputs \
                and isinstance(inputs[when_key], str)
            by_full_key = (bool(when_key) and when_key != slot_key(slot)
                           and when_key in control_keys)
            if same_node or by_full_key:
                if isinstance(equals, str) and equals:
                    slot["show_when"] = {"input": when_key, "equals": equals[:120]}
                elif isinstance(not_equals, str) and not_equals:
                    slot["show_when"] = {"input": when_key, "not_equals": not_equals[:120]}
        if kind in ("number", "select"):
            # 同一个参数在图里被写了两遍（局部重绘与移除两条分支各一份）时，
            # 弹窗里仍然只该有一颗旋钮，另一份跟着一起改，见 build_workflow。
            targets: list[list[str]] = []
            for pair in (item.get("sync_to") or []):
                if not (isinstance(pair, (list, tuple)) and len(pair) == 2):
                    continue
                tnode, tkey = str(pair[0]), str(pair[1])
                if tnode == node or tnode not in nodes:
                    continue
                if tkey in node_inputs(nodes[tnode]):
                    targets.append([tnode, tkey])
            if targets:
                slot["sync_to"] = targets
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


def migrate_slot_multiples(conn) -> int:
    """给库里存着的槽位补上对齐步长（`multiple`），返回补了几条模板。

    这个键是后加的：老槽位没有它，弹窗算「这一趟会出多大」就退回默认 8，把 32 对齐的
    工作流报小几十像素——闪寻视频生成那条实际出 1440×800，缺它时报的是 1432×808。
    内置模板本来靠 clone_bundled.seed 随版本刷新槽位，可 seed 只动「用户没改过正文」的
    那几条，改过正文的那条（正是闪寻视频生成）刷不到，所以这里扫全表，照正文补一次。

    值只从工作流节点取：那是真会跑的数。节点没这个输入就不动作者原来那份，不猜。
    只动这一个键，槽位里别的内容原样写回；补完之后再启动就没有可补的，不落笔。
    """
    healed = 0
    for row in conn.execute("SELECT id, workflow, slots FROM clone_templates").fetchall():
        slots = _load_slots(row["slots"])
        targets = [s for s in slots
                   if s.get("kind") == "number" and s.get("input") in MEGAPEXEL_INPUTS]
        if not targets:
            continue
        try:
            nodes = parse_workflow(row["workflow"])
        except Exception:  # noqa: BLE001 - 正文坏了自有导入那条路吵，别在这儿拦启动
            continue
        changed = False
        for slot in targets:      # targets 里是同一批 dict，改完从 slots 整体写回
            want = node_pixel_multiple(nodes.get(str(slot.get("node") or "")))
            if want is None or slot.get("multiple") == want:
                continue
            slot["multiple"] = want
            changed = True
        if not changed:
            continue
        conn.execute("UPDATE clone_templates SET slots=? WHERE id=?",
                     (json.dumps(slots, ensure_ascii=False), int(row["id"])))
        healed += 1
    return healed


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


def _apply_lora_group(workflow: dict, slot: dict, value: Any) -> None:
    """整组开关：选到「开」那一档就点亮点名的几颗 lora，其余选项一律全灭。

    全灭不是「不动」：文戏要的就是这台节点变成直通，四颗一颗都不进模型。
    换档写入（option_writes）走的是普通 node.input，用来把「戏种」这件事
    连带到的别的参数一起改掉——比如武戏多两步采样。
    """
    _validate_control(slot, value)
    named = set(slot.get("lora_group") or [])
    live = value == slot.get("lora_on")
    for entry in lora_slot_entries(workflow, slot):
        if str(entry.get("name") or "") in named:
            entry["active"] = bool(live)
    _apply_option_writes(workflow, slot, value)


def _apply_lora_strength(workflow: dict, slot: dict, value: Any) -> None:
    """单颗 lora 的强度：strength 与 clipStrength 一起写，缺一个就是半新半旧。

    关着的那颗不写：运行时 active 为假就跳过它，留着原作者那份数，
    在 ComfyUI 里核对「这一趟到底加载了谁」反而更清楚。
    """
    _validate_control(slot, value)
    want = str(slot.get("lora") or "")
    text = f"{float(value):.2f}"
    for entry in lora_slot_entries(workflow, slot):
        if str(entry.get("name") or "") != want or not entry.get("active"):
            continue
        entry["strength"] = text
        entry["clipStrength"] = text


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
    pending = dict(controls or {})
    for key in pending:
        slot = by_key.get(key)
        if slot is None or slot.get("kind") not in ("select", "number"):
            raise ValueError(f"{key} 不是这份工作流声明的控件，请重新打开弹窗再试。")
    # 三趟，顺序固定，不吃提交顺序（JSON 的键序一变，「强度只写给活着的 lora」
    # 就退化成「写给全部」，而这种错不会报错，只是出片和屏幕上选的不一样）：
    #   ①整组开关：决定哪几颗 lora 活着，顺带做换档写入（戏种连带改采样步数）；
    #   ②单颗强度：只写给第一趟之后活着的那些；
    #   ③其余控件：照老办法直写 node.input；只有「只换档」的开关（mode_only）例外，
    #     它不落值，只按档位换自己那份写入。
    for key, value in pending.items():
        slot = by_key[key]
        if value is not None and slot.get("kind") == "select" and slot.get("lora_group"):
            _apply_lora_group(workflow, slot, value)
    for key, value in pending.items():
        slot = by_key[key]
        if value is not None and slot.get("lora") and not slot.get("lora_group"):
            _apply_lora_strength(workflow, slot, value)
    for key, value in pending.items():
        slot = by_key[key]
        if slot.get("lora_group") or slot.get("lora"):
            continue        # 前两颗自己写 lora 清单，不能往 node.input 上写「武戏」
        if value is None:
            continue
        _validate_control(slot, value)
        if slot.get("mode_only"):
            # 这颗下拉选的是「走哪条支路」，不是某个输入的取值：只按档位落那几颗写入，
            # 值本身一个字都不往 node.input 上写（见 normalize_slots 里 mode_only 那段）。
            _apply_option_writes(workflow, slot, value)
            continue
        node_inputs(workflow.get(slot["node"])).update({slot["input"]: value})
        # 这颗旋钮管的好几个人：局部重绘与移除两条分支各带一份裁剪恢复节点，
        # 只改弹窗里那一份，走另一条分支时用户拧的数就凭空消失。
        # 目标节点不在图里（用户自己删过）就跳过，不值得为它整条生成失败。
        for target in (slot.get("sync_to") or []):
            if not (isinstance(target, (list, tuple)) and len(target) == 2):
                continue
            tnode, tkey = str(target[0]), str(target[1])
            if tnode in workflow and tkey in node_inputs(workflow[tnode]):
                node_inputs(workflow[tnode]).update({tkey: value})
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
    # 参考位编号照接线，不照导入时存下的顺序（老模板那份是按节点号存的）。
    # 显示、计数、@ 引用三处都从这份 slots 出，一次排对，别各自再算一遍。
    slots = sort_reference_slots(nodes, slots)
    kind = str(data.get("media_kind") or "image")
    if kind not in MEDIA_KINDS:
        kind = "image"
    data["media_kind"] = kind
    spec = cloud_spec_of(data)
    data["engine"] = engine_of(data)
    data["is_cloud"] = data["engine"] == CLOUD_ENGINE
    data["provider"] = str(data.get("provider") or "")
    data["model"] = str(data.get("model") or "")
    try:
        data["default_controls"] = json.loads(data.get("params") or "{}")
    except ValueError:
        data["default_controls"] = {}
    if not isinstance(data["default_controls"], dict):
        data["default_controls"] = {}
    if spec is not None:
        # 设置页与弹窗要说清这是哪条模型、有没有实测过；notes 是「待实测」那句话的内容。
        data["cloud"] = {"model_label": spec.model_label, "blurb": spec.blurb,
                         "verified": spec.verified, "notes": list(spec.notes),
                         "provider_label": spec_provider_label(spec),
                         # mentions=false 时弹窗要禁掉 @ 引用：TTS 会把 <Audio 1> 念出来
                         "mentions": not spec.empty_tags,
                         "ref_limits": dict(spec.refs)}
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
    data["modes"] = [m for m in workflow_edit.MODES if m in spec.modes] \
        if spec else fallback_modes(nodes, slots)
    # 参考格清单由后端一处算准（顺序、编号、H3 标签），前端照着画。
    # 两边各算一遍的话，弹窗里那个「音频2」和实际接线的 ref_audio_1 早晚会分家。
    data["soundtracks"] = 0 if spec else wired_reference_soundtracks(nodes, slots)
    data["reference_cells"] = reference_cells(slots, data["soundtracks"],
                                              spec.tag_templates() if spec else None)
    if spec is not None:
        # 云端的参考位是声明里的上限（图 9 段 3 音 3），槽位行本身每族只有一格，
        # 数槽位会得到「1 张参考」，弹窗照这个数就会把 2-9 格藏起来。
        data["reference_count"] = len(data["reference_cells"])
        for ref_kind in REFERENCE_KINDS:
            data[f"{ref_kind}_reference_count"] = sum(
                1 for cell in data["reference_cells"] if cell.get("kind") == ref_kind)
    return data


def spec_provider_label(spec) -> str:
    from .cloud import spec as cloud_spec

    return cloud_spec.provider_for(spec)[1]


def list_templates() -> list[dict]:
    rows = _conn().execute("SELECT * FROM clone_templates ORDER BY is_active DESC, id").fetchall()
    return menu_order([public(r) for r in rows])


def menu_order(items: list[dict]) -> list[dict]:
    """「切换工作流」清单的顺序：本机那几条照旧（谁先导进来谁在前），云端那条插到同族最后一条本机之后。

    不按来源分成两段：一族被切两半，人要扫两屏才找到那条 API。
    同族一条本机都没有时，云端那条就落在清单末尾——它是这个族里唯一能用的东西。
    """
    local = [item for item in items if not item.get("is_cloud")]
    cloud = [item for item in items if item.get("is_cloud")]
    for row in cloud:
        position = len(local)
        for index, other in enumerate(local):
            if media_kind_of_template(other) == media_kind_of_template(row):
                position = index + 1
        local.insert(position, row)
    return local


def get_row(template_id: int) -> dict:
    row = _conn().execute("SELECT * FROM clone_templates WHERE id=?", (template_id,)).fetchone()
    if row is None:
        raise KeyError(f"工作流 {template_id} 不存在，可能已经被删掉了。")
    return dict(row)


def get_template(template_id: int) -> dict:
    """带节点表与解析后槽位的完整模板，生成流程用这个。"""
    row = get_row(template_id)
    raw = str(row.get("workflow") or "")
    # 云端模板没有工作流正文（那一列 NOT NULL，所以存空串）。空就当零个节点，
    # 但正文写坏了仍然要吵——那种时候报错比假装没有节点有用。
    nodes = parse_workflow(raw) if raw.strip() else {}
    row["nodes"] = nodes
    # 生成那边的「第几格要连着填」校验读的是这份 slots，弹窗显示的编号读的是
    # public() 那份。两边必须同一套顺序，否则用户照弹窗填、后端说他跳格。
    row["slots"] = sort_reference_slots(nodes, _load_slots(row.get("slots")))
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


def keep_authored_contract(old: list[dict], detected: list[dict]) -> list[dict]:
    """重新检测出来的槽位，继承老的那一份里"检测不出来的东西"。

    重新检测存在的理由是「导入那一刻 ComfyUI 没开，比例／分辨率／autogrow 没认出来」。
    它不是为了改名，更不该顺手把用户写下的约定冲掉：能不能画遮罩、提示词留空算不算
    一个模式、一颗旋钮管几台节点，还有他自己改过的格子名。同一个「节点.输入」两边都有时，
    主体用新认的那份（选项和上下限要靠 object_info 才准），这几样从老的那份搬过来。
    """
    by_key = {slot_key(x): x for x in old if isinstance(x, dict)}
    out: list[dict] = []
    for slot in detected:
        before = by_key.get(slot_key(slot))
        if before is None:
            out.append(dict(slot))
            continue
        keep = dict(slot)
        label = str(before.get("label") or "").strip()
        if label:
            keep["label"] = label[:40]
        for extra in SLOT_CONTRACT_KEYS:
            if extra in before:
                keep[extra] = before[extra]
        out.append(keep)
    # 检测认不出 lora 那两类控件（它们的值不是 node.input 的字面量，object_info 里
    # 也没有对应旋钮）。照上面的循环走，重新检测会把「戏种」「武打速度」整个抹掉，
    # 而正文里那几颗 lora 还是开着的——工作流从此固定在武戏，还不报错。
    # 所以作者点名过的 lora 控件一律补回来：键在检测结果里已经有了的不补（那份是新的），
    # 补在末尾（面板按类型分行画，顺序只影响同一行里的先后，不影响能用）。
    landed = {slot_key(x) for x in detected}
    for before in old:
        if not isinstance(before, dict) or slot_key(before) in landed:
            continue
        if any(extra in before for extra in LORA_CONTRACT_KEYS):
            out.append(dict(before))
    return out


def redetect_slots(template_id: int, info: dict | None = None) -> dict:
    """按库里存着的工作流重新检测槽位，结果整体替换旧的。

    主要是补「导入时 ComfyUI 没开 → 比例/分辨率没检测出来」这一课。代价是检测认不出的
    绑定会被冲掉，所以随包那几条在设置页根本不给这个按钮（它们的槽位是调好才进包的），
    自己导入的那条至少保住名字和手写的约定，见 keep_authored_contract。
    """
    row = get_row(template_id)
    nodes = parse_workflow(row.get("workflow") or "")
    detected = detect_slots(nodes, info)["slots"]
    slots = normalize_slots(
        keep_authored_contract(_load_slots(row.get("slots")), detected), nodes)
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
        raise DuplicateNameError(f"已经有叫「{name}」的工作流，换一个名字。")
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
            raise DuplicateNameError(f"已经有叫「{candidate}」的工作流，换一个名字。")
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
