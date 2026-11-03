"""云端模型规格：一条模型 = 一份手写声明。

为什么手写而不是拉目录：云端的参数表不在用户机器上，也没有 object_info 可查。
弹窗里的每一个下拉、每一格参考位，都必须由这份声明说清楚——让前端猜就会猜出
一个模型根本不吃的参数。

字段核实纪律（本文件唯一的硬规矩）：
- verified=True 的模型，端点与请求字段照官方文档当日抄录过；
- verified=False 表示端点或必填性还有没核实的地方，notes 逐条写明缺什么；
  这种模型在设置页挂「待实测」，不能让人以为是验过的。
- 拿不准的字段宁可不发：空数组、空字符串一律不带进请求体，让「没给」和「给错」
  在服务端的表现区分得开。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

PROVIDER = "runninghub"
PROVIDER_LABEL = "RunningHub"
BASE_URL = "https://www.runninghub.cn"

# 弹窗主输入框的标签，与 clone_templates.PRIMARY_PROMPT_LABEL 同值（测试钉住，不许分家）。
PRIMARY_PROMPT_LABEL = "完整提示词"

# 云端模板的槽位没有 ComfyUI 节点，node 段固定填这个；slot_key 得到「model.prompt」这种键。
SPEC_NODE = "model"

CAPABILITIES = ("image", "video", "audio")
FAMILY_WORDS = {"image": "图片", "video": "视频", "audio": "音频"}
CAPABILITY_WORDS = {"image": "出图", "video": "出片", "audio": "出声音"}

# 超时按能力分：一条 15 秒片子在云端是十分钟级，跟出图共用一个数会把人钉在弹窗里。
TIMEOUTS = {"image": 300.0, "audio": 300.0, "video": 1800.0}
POLL_INTERVALS = {"image": 2.0, "audio": 2.0, "video": 6.0}

# 参考素材送上去之前的上限。超了先降采样，压不下去就报错——静默压糊是最难查的。
MAX_UPLOAD_BYTES = {"image": 12 * 1024 * 1024, "audio": 20 * 1024 * 1024,
                    "video": 100 * 1024 * 1024}
MAX_IMAGE_EDGE = 2048

# 开关型控件的两个选项。画出来是下拉，发出去是真假值。
SWITCH_OPTIONS = ("开", "关")


@dataclass(frozen=True)
class Param:
    """弹窗里一颗参数控件，同时也是请求体里的一个字段。

    kind 只有 select / number 两种，因为槽位体系只认这两种控件；开关做成 select
    （选项「开」「关」），发送时翻成真假。多造一种 kind 的代价是前端每一处画控件
    的地方都要跟着改，不值。
    """

    key: str
    label: str
    kind: str = "select"
    options: tuple[str, ...] = ()
    default: Any = None
    minimum: float | None = None
    maximum: float | None = None
    step: float | None = None
    unit: str = ""
    request_field: str = ""      # 请求字段名，默认同 key
    modes: tuple[str, ...] = ()  # 空 = 所有生成档位都发；否则只在列出的档位下发
    switch: bool = False         # 选项是「开/关」，发送时翻成 bool_on/bool_off
    bool_on: Any = True
    bool_off: Any = False
    as_str: bool = False         # Seedance 官方示例里 duration 是字符串 "5"
    omit: bool = False           # 只用来选端点（档位），不进请求体
    hint: str = ""

    @property
    def wire_field(self) -> str:
        return self.request_field or self.key

    def applicable(self, mode: str) -> bool:
        return not self.modes or mode in self.modes

    def send_value(self, value: Any) -> Any:
        if self.kind == "number":
            number = float(value)
            whole = int(number) if float(number).is_integer() else number
            return str(whole) if self.as_str else whole
        if self.switch:
            return self.bool_on if value == SWITCH_OPTIONS[0] else self.bool_off
        return value

    def as_slot(self) -> dict:
        """变成弹窗吃的那种槽位——与本机工作流的槽位形状一字不差。"""
        slot: dict[str, Any] = {
            "kind": self.kind if self.kind == "number" else "select",
            "node": SPEC_NODE, "input": self.key, "label": self.label[:40]
        }
        if slot["kind"] == "select":
            options = list(self.options)
            slot["options"] = options
            slot["value"] = self.default if self.default in options else options[0]
        else:
            slot["value"] = self.default
            for key, extra in (("min", self.minimum), ("max", self.maximum),
                               ("step", self.step), ("unit", self.unit)):
                if extra is not None and extra != "":
                    slot[key] = extra
        if self.hint:
            slot["hint"] = self.hint
        return slot
    def is_available_for(self, mode: str) -> bool:
        return self.applicable(mode)

@dataclass(frozen=True)
class ModelSpec:
    """一族云端能力一条 spec：它就是弹窗里那一行「图片API」。

    一条 spec 覆盖同一件事的几种生成方式（文生 / 图生 / 多参考），靠 mode 选端点，
    而不是在「切换工作流」清单里铺三条——那一屏是让人挑今天用哪条配方，不是让人
    每次先生成一张路线图。
    """

    key: str
    capability: str                 # image | video | audio
    model_label: str                # 设置页与悬浮提示里的模型名
    blurb: str = ""                 # 一句话说这条能干什么
    modes: tuple[str, ...] = ("single", "multi")
    endpoints: dict[str, str] = field(default_factory=dict)   # mode -> 请求路径
    variants: dict[str, dict[str, str]] = field(default_factory=dict)
    variant_param: str = ""         # 用哪颗控件选 variants（例如档位 2.0 / 2.0-Fast）
    prompt_field: str = "prompt"    # 音频模型要的是 text
    empty_tags: bool = False        # 这一族能不能用「@ 引用」标签（TTS 念的是纯文本，标签会被念出来）
    refs: dict[str, int] = field(default_factory=dict)   # 族 -> 最多几份
    ref_fields: dict[str, str] = field(default_factory=dict)  # 族 -> 请求字段名
    ref_shapes: dict[str, str] = field(default_factory=dict)  # 族 -> list | single
    tags: dict[str, str] = field(default_factory=dict)   # 族 -> 提示词里的引用标签
    params: tuple[Param, ...] = ()
    extra_body: dict[str, Any] = field(default_factory=dict)
    extra_body_by_mode: dict[str, dict[str, Any]] = field(default_factory=dict)
    size_field: str = ""            # 非空 = 由「比例 + 画质」算宽高等于长边那两档
    long_edges: dict[str, int] = field(default_factory=dict)
    timeout: float = 300.0
    poll: float = 2.0
    verified: bool = True
    notes: tuple[str, ...] = ()

    # ---------- 端点 ----------

    def endpoint(self, mode: str, controls: dict | None = None) -> str:
        """按生成档位挑端点。挑不出来就明说，绝不悄悄退到另一条端点。

        悄悄退化（multi 找不到就用 single）的坏处：请求发出去了、钱扣了，
        出来的东西却不是按多参考那条模型跑的，用户完全看不出哪里不对。
        """
        path = self.endpoints.get(mode) or ""
        if not path:
            raise ValueError(f"{self.model_label} 不支持这一种生成方式，换一份参考素材或换条 API。")
        variant = self.variants.get(str((controls or {}).get(self.variant_param) or "")) \
            if self.variant_param else None
        if variant:
            path = variant.get(mode, path) or variant.get("single", path)
        return path

    # ---------- 槽位 ----------

    def slots(self) -> list[dict]:
        """给弹窗的槽位清单：提示词 + 参考位 + 参数控件。

        参考位用 grow.names 续格，这样「图片1…图片9」的编号、连着放规则、
        素材选择器全部沿用本机那套，一分新代码都不必写。
        """
        out: list[dict] = [{
            "kind": "prompt", "node": SPEC_NODE, "input": "prompt",
            "label": PRIMARY_PROMPT_LABEL
        }]
        for family in ("image", "audio", "video"):
            limit = int(self.refs.get(family) or 0)
            if limit <= 0:
                continue
            field_name = self.ref_fields.get(family, family)
            slot: dict[str, Any] = {
                "kind": family, "node": SPEC_NODE, "input": field_name,
                "label": FAMILY_WORDS[family] + "参考",
            }
            if limit > 1:
                slot["grow"] = {
                    "node": SPEC_NODE, "group": field_name,
                    "names": [f"item_{i}" for i in range(2, limit + 1)],
                    "type": {"image": "IMAGE", "audio": "AUDIO", "video": "IMAGE"}[family],
                }
            out.append(slot)
        for param in self.params:
            out.append(param.as_slot())
        return out

    def tag_templates(self) -> dict[str, str]:
        """弹窗里 @ 引用要插进去的那串标签。

        empty_tags 的族（TTS）三族一律给空串：那边的提示词会被逐字念出来，
        把本机那套 <Audio 1> 塞进台词里，配音就会真的念出「尖括号 Audio 1」。
        空串同时也是给前端的信号——那一族的 @ 引用要禁掉。
        """
        if self.empty_tags:
            return {family: "" for family in ("image", "audio", "video")}
        return dict(self.tags)

    def default_controls(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for param in self.params:
            out[param.key] = param.default
        return out
# ---------- 请求体 ----------

RATIO_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*[:：xX×]\s*(\d+(?:\.\d+)?)\s*$")


def size_from_ratio(ratio: str, long_edge: int) -> tuple[int, int]:
    """比例 + 长边 → 宽高。凑到 16 的倍数：对不齐的话模型自己会再裁一次。"""
    match = RATIO_RE.match(str(ratio or ""))
    if not match:
        return long_edge, long_edge
    wide, high = float(match.group(1)), float(match.group(2))
    if wide <= 0 or high <= 0:
        return long_edge, long_edge

    def snap(value: float) -> int:
        return max(16, int(round(value / 16.0)) * 16)

    if wide >= high:
        return long_edge, snap(long_edge * high / wide)
    return snap(long_edge * wide / high), long_edge


def build_body(spec: ModelSpec, *, mode: str, prompt: str,
               refs: list[tuple[str, str]], controls: dict | None) -> tuple[str, dict]:
    """把弹窗里填的东西拼成一次云端请求，返回 (路径, 请求体)。

    refs 是 [(族, 已上传的 URL), ...]，必须按族内编号排好——编号与顺序对不上，
    表现是「参考给了但片子不按参考走」，而且不报错，这是最难查的一种错。
    只发给值齐了的东西：空数组、空字符串一律不进请求体。
    """
    controls = dict(controls or {})
    path = spec.endpoint(mode, controls)
    body: dict[str, Any] = {spec.prompt_field: str(prompt or "")}
    singles: dict[str, str] = {}
    lists: dict[str, list[str]] = {}
    for family, url in refs:
        field_name = spec.ref_fields.get(family, family)
        if spec.ref_shapes.get(family) == "single":
            singles.setdefault(field_name, url)
            continue
        lists.setdefault(field_name, []).append(url)
    body.update(singles)
    body.update({k: v for k, v in lists.items() if v})
    for param in spec.params:
        if param.omit or not param.applicable(mode):
            continue
        if param.key not in controls or controls[param.key] in (None, ""):
            continue
        body[param.wire_field] = param.send_value(controls[param.key])
    if spec.size_field:
        # 图片模型要的是 width/height，弹窗里给的是「比例 + 画质」——后者才是人话，
        # 让人去填两个像素数等于把 API 的表单搬到用户脸上。
        quality = str(controls.get(spec.size_field) or "")
        edge = spec.long_edges.get(quality)
        if edge:
            body["width"], body["height"] = size_from_ratio(str(controls.get("ratio") or ""), int(edge))
        body.pop("ratio", None)
        body.pop(spec.size_field, None)
    body.update(spec.extra_body)
    body.update(spec.extra_body_by_mode.get(mode) or {})
    return path, body
# ---------- 首批三条 ----------

# 行名照 2026-11-03 的草图：一族一条，就叫「图片API」。同族多条模型不铺多行，
# 收成一行 + 参数里一个档位。那一屏是挑今天用哪条配方，不是让人先做品质/速度选择题。
IMAGE = ModelSpec(
    key="image", capability="image",
    model_label="即梦 Seedream v5 lite",
    blurb="多参考图融合与改图；一张参考都不放就是文生图。",
    modes=("text", "single", "multi"),
    endpoints={
        "text": "/openapi/v2/seedream-v5-lite/text-to-image",
        "single": "/openapi/v2/seedream-v5-lite/image-to-image",
        "multi": "/openapi/v2/seedream-v5-lite/image-to-image",
    },
    refs={"image": 4}, ref_fields={"image": "imageUrls"},
    # 官方示例的提示词就是「输入的图1与图2」这种自然语言，没有 @ 语法，照它写。
    tags={"image": "图{n}"},
    params=(
        Param(key="ratio", label="比例",
              options=("16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"), default="16:9"),
        Param(key="quality", label="画质", options=("1K", "2K"), default="2K"),
    ),
    extra_body={"sequentialImageGeneration": "disabled", "maxImages": 1},
    size_field="quality", long_edges={"1K": 1024, "2K": 2048},
    timeout=TIMEOUTS["image"], poll=POLL_INTERVALS["image"],
    verified=False,
    notes=(
        "图生图端点与 prompt/width/height/imageUrls 已照官方示例抄录",
        "文生图端点按同族命名推定，待实测",
        "多参考上限官方未写明，先给 4 张，实测能更多再放宽",
        "1K/2K 是这边定的两档长边，官方示例只出现过 2048",
    ),
)

VIDEO = ModelSpec(
    key="video", capability="video",
    model_label="Seedance 2.0",
    blurb="文本 + 图 9 张 + 视频 3 段 + 音频 3 段，出 4-15 秒带声片子。",
    modes=("text", "single", "multi"),
    endpoints={m: "/openapi/v2/rhart-video/sparkvideo-2.0/multimodal-video"
               for m in ("text", "single", "multi")},
    variant_param="tier",
    variants={
        "2.0-Fast": {m: "/openapi/v2/rhart-video/sparkvideo-2.0-fast/multimodal-video"
                     for m in ("text", "single", "multi")},
    },
    refs={"image": 9, "video": 3, "audio": 3},
    ref_fields={"image": "imageUrls", "video": "videoUrls", "audio": "audioUrls"},
    # 官方示例原文：「@Image 1 图中的两个人，坐在一起吃火锅，火锅场景是@Video 1」。
    # 沿用本机 <Picture 1> 的后果是参考不生效且不报错，这是全项目风险最高的一处。
    tags={"image": "@Image {n}", "video": "@Video {n}", "audio": "@Audio {n}"},
    params=(
        Param(key="tier", label="档位", options=("2.0", "2.0-Fast"), default="2.0", omit=True,
              hint="Fast 便宜快，2.0 画质最高"),
        Param(key="resolution", label="画质", options=("720p", "480p"), default="720p"),
        Param(key="duration", label="时长", kind="number", default=5, minimum=4, maximum=15,
              step=1, unit="秒", as_str=True),
        Param(key="ratio", label="比例",
              options=("adaptive", "16:9", "9:16", "1:1", "4:3", "3:4"), default="adaptive"),
        Param(key="generateAudio", label="生成声音", options=SWITCH_OPTIONS, default="开",
              switch=True),
        Param(key="returnLastFrame", label="取回尾帧", options=SWITCH_OPTIONS, default="关",
              switch=True, hint="尾帧能当下一条的首帧，短剧连镜用得上"),
        Param(key="seed", label="随机种子", kind="number", default=-1, minimum=-1,
              maximum=2147483647, step=1, hint="-1 是每次随机"),
    ),
    timeout=TIMEOUTS["video"], poll=POLL_INTERVALS["video"],
    verified=False,
    notes=(
        "端点与 prompt/resolution/duration/imageUrls/videoUrls/generateAudio/ratio/"
        "returnLastFrame/seed 已照官方示例抄录",
        "音频参考的字段名 audioUrls 未核实：官方示例只有 image/video，宣传写支持 3 段",
        "resolution 只核实到 720p，有没有 1080p 待实测——要 2K 得出片后再超分",
        "参考可否整族省略未核实，这里的做法是没给就不发该字段",
    ),
)

AUDIO = ModelSpec(
    key="audio", capability="audio",
    model_label="MiniMax 声音复刻 / speech-2.8-hd",
    blurb="放一段参考音频就是照那个音色念；不放就是选一个现成音色念。",
    modes=("text", "single"),
    endpoints={
        "text": "/openapi/v2/rhart-audio/text-to-audio/speech-2.8-hd",
        "single": "/openapi/v2/rhart-audio/text-to-audio/voice-clone",
    },
    prompt_field="text",
    refs={"audio": 1}, ref_fields={"audio": "audio"}, ref_shapes={"audio": "single"},
    tags={},
    empty_tags=True,
    params=(
        Param(key="voice_id", label="音色", options=("Wise_Woman", "Elegant_Man"),
              default="Wise_Woman", modes=("text",), hint="官方音色表 17+，先放核实过的两个"),
        Param(key="speed", label="语速", kind="number", default=1, minimum=0.5, maximum=2.0,
              step=0.1, modes=("text",)),
        Param(key="emotion", label="情绪",
              options=("neutral", "happy", "sad", "angry", "fearful", "surprised"),
              default="neutral", modes=("text",)),
        Param(key="accuracy", label="复刻贴合度", kind="number", default=0.7, minimum=0.5,
              maximum=1.2, step=0.1, modes=("single",)),
        Param(key="need_noise_reduction", label="先降噪", options=SWITCH_OPTIONS,
              default="关", switch=True, modes=("single",)),
    ),
    extra_body_by_mode={"single": {"model": "speech-02-hd"}},
    timeout=TIMEOUTS["audio"], poll=POLL_INTERVALS["audio"],
    verified=False,
    notes=(
        "两个端点与字段名已照官方示例抄录；复刻那条合成模型固定 speech-02-hd",
        "custom_voice_id 的必填性未核实（示例里有），这里不发这个字段",
        "音色枚举只核实到 Wise_Woman / Elegant_Man 两个 id，其余待补",
    ),
)

SPECS: tuple[ModelSpec, ...] = (IMAGE, VIDEO, AUDIO)
_BY_KEY = {s.key: s for s in SPECS}


def all_specs() -> list[ModelSpec]:
    return list(SPECS)


def spec_by_key(key: str | None) -> ModelSpec | None:
    return _BY_KEY.get(str(key or ""))


def spec_or_raise(key: str | None) -> ModelSpec:
    spec = spec_by_key(key)
    if spec is None:
        raise ValueError("这条云端 API 不认识，去设置里重新选一条。")
    return spec


def specs_for(capability: str) -> list[ModelSpec]:
    return [s for s in SPECS if s.capability == capability]


def template_name(spec: ModelSpec) -> str:
    """模板名 = 族名 + API，与草图里那三行一字不差。"""
    return FAMILY_WORDS.get(spec.capability, spec.capability) + "API"


def describe(spec: ModelSpec) -> dict:
    """给设置页与弹窗看的这份声明：能出什么、有哪些参数、哪一处还没实测。

    槽位直接复用 slots()——设置页与弹窗吃的是同一份，不另写一遍描述，
    否则「设置页说支持 2K、弹窗里根本没有 2K」这类分家迟早会出现。
    """
    return {
        "key": spec.key,
        "capability": spec.capability,
        "capability_word": FAMILY_WORDS.get(spec.capability, spec.capability),
        "action_word": CAPABILITY_WORDS.get(spec.capability, ""),
        "name": template_name(spec),
        "model_label": spec.model_label,
        "blurb": spec.blurb,
        "provider": PROVIDER,
        "provider_label": PROVIDER_LABEL,
        "modes": list(spec.modes),
        "ref_limits": dict(spec.refs),
        "tags": spec.tag_templates(),
        "mentions": not spec.empty_tags,
        "slots": spec.slots(),
        "controls": spec.default_controls(),
        "verified": spec.verified,
        "notes": list(spec.notes),
    }


def describe_all() -> list[dict]:
    return [describe(s) for s in SPECS]
