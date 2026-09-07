"""PNG / WebP 元数据解析。

设计目标：

1. **零额外依赖**：PNG 的 ``tEXt`` chunk 格式简单（key\\0value，Latin-1），
   手写解析即可。WebP 用 RIFF 容器 + ``EXIF`` / ``XMP`` 子块。
2. **ComfyUI 友好**：ComfyUI 写图时会把 prompt / workflow JSON 放进 PNG 的
   ``tEXt`` chunk（key 分别为 ``prompt`` 和 ``workflow``），并按最近版本附加
   ``parameters``（与 A1111/webui 兼容的扁平字符串）。
3. **健壮性**：解析失败一律返回 ``(空字符串, 空字符串, 空 dict)``，由调用方决定
   是否跳过；不抛异常到上层循环。

后续可被 PIL 的 ``Image.info`` 替换，但手写版无 PIL 依赖，便于打包。
"""
from __future__ import annotations

import json
import re
import struct
from collections import defaultdict as _dd
from pathlib import Path
from typing import Any

# ComfyUI 在保存 PNG 时把 ``class_type == "CLIPTextEncode"`` 的节点视为 prompt：
#   - 连到 ``KSampler`` 正向 ``positive`` 的 → 正向 prompt
#   - 连到 ``KSampler`` 反向 ``negative`` 的 → 反向 prompt
#
# 此外 A1111/webui 兼容格式：``parameters`` chunk 的文本协议：
#   Positive prompt\\nNegative prompt: ...\\nSteps: 20, Sampler: ..., ...
# 我们在 PNG 解析阶段也尝试它。

# ---------- PNG tEXt / iTXt 解析 ----------


def _read_png_chunks(path: Path) -> dict[str, bytes]:
    """读取 PNG 文件中所有文本类 chunk（tEXt / iTXt / zTXt）的原始值。

    返回 ``{key: bytes_or_text}``。出现重复 key 时后者覆盖前者。
    """
    out: dict[str, bytes] = {}
    with path.open("rb") as f:
        sig = f.read(8)
        if sig != b"\x89PNG\r\n\x1a\n":
            return out
        while True:
            header = f.read(8)
            if len(header) < 8:
                break
            length = struct.unpack(">I", header[:4])[0]
            ctype = header[4:8].decode("ascii", errors="replace")
            data = f.read(length)
            f.read(4)  # CRC
            if ctype == "tEXt":
                # keyword \\0 text (Latin-1)
                if b"\x00" in data:
                    k, _, v = data.partition(b"\x00")
                    out[k.decode("latin-1", errors="replace")] = v
            elif ctype == "iTXt":
                # keyword\\0 compression_flag(1) compression_method(1) lang\\0 trans\\0 text
                if b"\x00" in data:
                    k, rest = data.split(b"\x00", 1)
                    # 跳过 2 字节 flag/method
                    rest = rest[2:]
                    # lang\\0 translated\\0
                    lang, _, body = rest.partition(b"\x00")
                    _, _, txt = body.partition(b"\x00")
                    out[k.decode("utf-8", errors="replace")] = txt
            elif ctype == "zTXt":
                if b"\x00" in data:
                    k, _, rest = data.partition(b"\x00")
                    # compression_method (1 byte) + compressed text
                    if rest:
                        method = rest[0]
                        compressed = rest[1:]
                        if method == 0:
                            try:
                                import zlib

                                out[k.decode("latin-1", errors="replace")] = zlib.decompress(compressed)
                            except Exception:
                                pass
            # 早停：到 ``IEND`` 之后没有文本 chunk
            if ctype == "IEND":
                break
    return out


def _parse_parameters_text(text: str) -> tuple[str, str, dict[str, Any]]:
    """解析 A1111 ``parameters`` 文本格式。

    Returns: ``(positive, negative, params_dict)``
    """
    if "Steps:" not in text:
        return text.strip(), "", {}
    # 找 "Negative prompt:" 分隔
    if "Negative prompt:" in text:
        pos_part, rest = text.split("Negative prompt:", 1)
        positive = pos_part.strip()
        if "Steps:" in rest:
            neg_text, _, params_text = rest.partition("Steps:")
            negative = neg_text.strip()
            params_text = "Steps:" + params_text
        else:
            negative = rest.strip()
            params_text = ""
    else:
        positive = text.split("Steps:")[0].strip()
        negative = ""
        params_text = "Steps:" + text.split("Steps:", 1)[1]
    params: dict[str, Any] = {}
    if params_text:
        for chunk in params_text.split(","):
            chunk = chunk.strip()
            if not chunk or ":" not in chunk:
                continue
            k, _, v = chunk.partition(":")
            params[k.strip()] = v.strip()
    return positive, negative, params


def _resolve_seed(prompt_obj: dict[str, Any], sampler_info: dict[str, Any]) -> int | None:
    """Pull a numeric seed out of a sampler node's inputs.

    ComfyUI is inconsistent about the field name + whether the value is a
    literal int or a [node_id, output_index] link to a separate seed-source
    node:
      - KSampler.inputs.seed                (legacy, usually an int)
      - KSamplerAdvanced.inputs.noise_seed  (modern, often a link e.g. -> easy seed)
      - SamplerCustomAdvanced.inputs.noise_seed  (same)

    Return the int seed, or None if we could not find one.
    """
    if not isinstance(prompt_obj, dict) or not isinstance(sampler_info, dict):
        return None

    def _coerce(v: Any) -> int | None:
        if isinstance(v, bool):
            return None
        if isinstance(v, int):
            return v
        if isinstance(v, float):
            return int(v)
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return None
            try:
                return int(s)
            except ValueError:
                try:
                    return int(float(s))
                except ValueError:
                    return None
        if isinstance(v, list) and len(v) == 2 and isinstance(v[1], int):
            # ComfyUI link: walk to source node, find its seed / noise_seed int.
            try:
                next_id = str(int(v[0]))
            except (TypeError, ValueError):
                return None
            target = prompt_obj.get(next_id)
            if not isinstance(target, dict):
                return None
            ins = target.get("inputs") or {}
            for sk in ("seed", "noise_seed"):
                if sk in ins:
                    val = _coerce(ins[sk])
                    if val is not None:
                        return val
        return None

    for key in ("seed", "noise_seed"):
        if key in sampler_info:
            v = _coerce(sampler_info[key])
            if v is not None:
                return v
    return None

def _extract_comfyui_prompts(prompt_obj: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    """从 ComfyUI ``prompt`` JSON 抽取正向 / 反向 prompt + 关键参数。

    采用启发式：
    - 找到第一个 ``KSampler`` 节点 → 沿 ``inputs.positive`` / ``inputs.negative`` 链
      追溯到 ``CLIPTextEncode`` 节点，取 ``inputs.text`` 字段。
    - 关键参数直接从 KSampler 节点 ``inputs`` 取。
    """
    if not isinstance(prompt_obj, dict):
        return "", "", {}
    pos = neg = ""
    sampler_info: dict[str, Any] = {}

    # 先抓所有 KSampler 节点
    ksamplers: list[dict[str, Any]] = []
    for nid, node in prompt_obj.items():
        if isinstance(node, dict) and node.get("class_type") == "KSampler":
            ksamplers.append(node)
    if not ksamplers:
        # 新版 ComfyUI 可能用 ``KSamplerAdvanced`` / ``SamplerCustom`` 等，做最小适配
        for nid, node in prompt_obj.items():
            if isinstance(node, dict) and "Sampler" in (node.get("class_type") or ""):
                ksamplers.append(node)
    if ksamplers:
        ks = ksamplers[0]
        sampler_info = {k: v for k, v in (ks.get("inputs") or {}).items() if k != "model" and k != "positive" and k != "negative"}

        # _text_from_node: walk a node and extract its prompt text.
        # Handles:
        #  - CLIPTextEncode.inputs.text string  -> return directly.
        #  - CLIPTextEncode.inputs.text list    -> if [node_id, output_index] link, recurse;
        #                                         otherwise treat list as multi-line prompt.
        #  - ZML_* / PromptExpand dictionary nodes (text1/text2 + separator + enabled flags):
        #                                         join all enabled segments by separator.
        #  - ShowText|pysssss debug nodes: inputs.text is a link (display-only),
        #                                   inputs.text_0/text_1/... are the user-written prompt.
        #                                   Must prefer those over following the text link,
        #                                   which would lead into PromptExpand -> LLM context chain.
        def _text_from_node(node: dict[str, Any]) -> str:
            inputs = node.get("inputs") or {}
            ct = (node.get("class_type") or "").strip()

            # Conditioning-only nodes (e.g. ConditioningZeroOut) intentionally produce
            # empty / non-text conditioning. They often have a `conditioning` link pointing
            # back at the positive CLIP encode chain, which the generic fallback below
            # would otherwise follow and return the *positive* prompt as the negative.
            # Short-circuit: no text to extract here.
            if ct == "ConditioningZeroOut":
                return ""

            def _resolve_value(v: Any) -> str:
                """Resolve any value: link -> recurse; str -> as-is; list -> join; else str()."""
                if v is None:
                    return ""
                if isinstance(v, str):
                    return v
                if isinstance(v, list):
                    # ComfyUI link format: [node_id, output_index]
                    if len(v) == 2 and isinstance(v[1], int):
                        try:
                            next_id = str(int(v[0]))
                        except (TypeError, ValueError):
                            next_id = None
                        if next_id and next_id in prompt_obj:
                            nxt = prompt_obj[next_id]
                            if isinstance(nxt, dict):
                                # Honor the link: whatever the target produced (including
                                # empty string for nodes like ConditioningZeroOut).
                                # Do NOT silently fall through to the multi-line join,
                                # which would treat [node_id, output_index] as text.
                                return _text_from_node(nxt)
                        # Valid link format but target node missing/unreadable -> empty.
                        return ""
                    # Not a link format -> treat list as multi-line prompt (newer ComfyUI
                    # sometimes stores a multi-line CLIP text input as a list of strings).
                    parts = [str(x) for x in v if x not in (None, "")]
                    return "\n".join(parts)
                return str(v)

            # ShowText|pysssss debug nodes: text is a link (canvas display only),
            # text_0/text_1/... are the real user-written prompt strings. Prefer them.
            if ct.startswith("ShowText"):
                text_n_keys = sorted(
                    (k for k in inputs if k.startswith("text_") and k[5:].isdigit()),
                    key=lambda k: int(k[5:]),
                )
                if text_n_keys:
                    parts: list[str] = []
                    for k in text_n_keys:
                        v = inputs.get(k)
                        if v not in (None, ""):
                            parts.append(str(v))
                    if parts:
                        return "\n".join(parts)

            # Standard field: text
            text_val = inputs.get("text")
            if text_val is not None:
                t = _resolve_value(text_val)
                if t:
                    return t

            # ZML/PromptExpand style nodes: text1/text2/... + separator + enabled flags
            text_keys = sorted(k for k in inputs.keys()
                               if (k.startswith("\u6587\u672c") or k.startswith("text_"))
                               and not k.endswith("\u542f\u7528"))
            if text_keys:
                sep = inputs.get("\u5206\u9694\u7b26") or inputs.get("separator") or ",\n"
                parts: list[str] = []
                for tk in text_keys:
                    # Corresponding enabled flag: ZML uses enabled1/enabled2/... (same
                    # trailing number as the text key, e.g. \u6587\u672c3 -> \u542f\u75283).
                    enabled = True
                    tk_suffix = ""
                    for c in reversed(tk):
                        if c.isdigit():
                            tk_suffix = c + tk_suffix
                        else:
                            break
                    if tk_suffix:
                        ek_guess = "\u542f\u7528" + tk_suffix  # ZML convention
                        if ek_guess in inputs:
                            enabled = bool(inputs[ek_guess])
                    # Fallback: text_0_enabled/text_1_enabled/... style
                    if enabled and not tk_suffix:
                        for ek in inputs.keys():
                            if ek.endswith("_enabled") and ek.startswith("text_"):
                                enabled = bool(inputs.get(ek))
                                break
                    if not enabled:
                        continue
                    t = _resolve_value(inputs.get(tk))
                    if t:
                        parts.append(t)
                if parts:
                    return sep.join(parts)

            # Generic fallback: scan inputs for any link and follow it
            for v in inputs.values():
                if isinstance(v, list) and len(v) >= 1:
                    t = _resolve_value(v)
                    if t:
                        return t
            return ""

        def resolve_text(link: list[Any] | None) -> str:
            if not link or not isinstance(link, list) or len(link) < 1:
                return ""
            target_id = link[0]
            target = prompt_obj.get(str(target_id))
            if not isinstance(target, dict):
                return ""
            return _text_from_node(target)

        inputs = ks.get("inputs") or {}
        pos = resolve_text(inputs.get("positive"))
        neg = resolve_text(inputs.get("negative"))

    # 模型：从 checkpoint loader 节点取
    model = ""
    for nid, node in prompt_obj.items():
        if isinstance(node, dict) and "CheckpointLoader" in (node.get("class_type") or ""):
            ckpt = (node.get("inputs") or {}).get("ckpt_name")
            if ckpt:
                model = str(ckpt)
                break

    # Extract seed. ComfyUI varies the field name and may store it as a link:
    #   - KSampler.inputs.seed            (legacy, usually int)
    #   - KSamplerAdvanced.inputs.noise_seed  (modern, often a link to a seed-source node)
    #   - SamplerCustomAdvanced.inputs.noise_seed  (same)
    # When it is a link, follow it to a node like `easy seed` / `SeedGenerator` /
    # `RandomNoise` whose `seed` / `noise_seed` field is a plain int.
    seed = _resolve_seed(prompt_obj, sampler_info)

    merged: dict[str, Any] = dict(sampler_info)
    if model:
        merged["model"] = model
    if seed is not None:
        merged["seed"] = seed
    return pos.strip(), neg.strip(), merged


# ---------- LoRA 节点抽取 ----------
# ComfyUI 里"实际被执行"的 LoRA 节点；bypassed 节点在 API prompt JSON 里
# 根本不会出现，所以从 API prompt 抽 LoRA = 天然只包含"已使用"的 LoRA。
LORA_NODE_TYPES = frozenset({
    # 核心节点
    "LoraLoader",
    "LoRALoader",
    "LoraLoaderAdvanced",
    "LoRALoaderAdvanced",
    "LoraLoaderMgr",
    "LoraStackLoader",
    # rgthird-party / rgthree
    "PowerLoraLoader",
    "Power Lora Loader (rgthree)",
    "PowerLoRAStacker",
    "Power Lora Stacker (rgthree)",
    "Power Lora Loader (rgthree) - Bypass",
    # Cosmicai / efficient
    "EfficientLoraLoader",
    "Efficient Lora Loader",
    # 一些常见第三方
    "CR LoRA Stack",
    "LoraTagLoader",
    "LoRA Stacker",
})

# inputs 字段名 -> strength 优先级，匹配第一个非空值
_LORA_STRENGTH_KEYS = (
    "strength_model",
    "model_strength",
    "strength",
    "strength_clip",
    "clip_strength",
    "lora_strength",
)


def _is_lora_node(node: Any) -> bool:
    """判断一个 API prompt 节点是不是 LoRA loader。"""
    if not isinstance(node, dict):
        return False
    ct = (node.get("class_type") or "").strip()
    if ct in LORA_NODE_TYPES:
        return True
    # 启发式：inputs 里有 lora_name 字符串字段 -> 典型 LoRA 特征
    inputs = node.get("inputs") or {}
    if not isinstance(inputs, dict):
        return False
    name_v = inputs.get("lora_name")
    return isinstance(name_v, str) and bool(name_v.strip())


def _lora_strength_from_inputs(inputs: dict[str, Any]) -> float:
    """从 inputs 里抽 strength；找不到返回 1.0。"""
    if not isinstance(inputs, dict):
        return 1.0
    for k in _LORA_STRENGTH_KEYS:
        v = inputs.get(k)
        if v is None:
            continue
        if isinstance(v, bool):
            continue
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            try:
                return float(v.strip())
            except ValueError:
                continue
    return 1.0


# ComfyUI-LoraManager 插件（willmiao/ComfyUI-Lora-Manager）的 LoRA Loader 节点类型。
# 该节点的 widgets_values 结构:
#   [0] = { version, textWidgetName }    元数据对象
#   [1] = "<lora:NAME:WEIGHT> ..."      注入到 prompt 的字符串（含未勾选的 LoRA）
#   [2] = [{ name, strength, active, ... }, ...]  结构化 LoRA 列表（每个有 active 字段）
LORA_MANAGER_NODE_TYPES = frozenset({
    "Lora Loader (LoraManager)",
    "Lora Manager",
    "LoraLoader (LoraManager)",
})


# UI workflow JSON 里节点的 "mode" 字段含义（ComfyUI 约定）：
# 0 = muted (节点被禁用，bypass)，4 = bypass。其它值视为启用。
_LORA_BYPASS_MODES = frozenset({0, 4})


def _extract_active_loras_from_lora_manager(workflow_obj: Any) -> list[dict[str, Any]]:
    """从 ComfyUI-LoraManager 节点的 widgets_values 抽"实际激活"的 LoRA。

    适用 willmiao/ComfyUI-Lora-Manager 插件。

    注意：LoraManager 节点的 widgets_values[2] 里 active=false 项是用户手工取消勾选的，
    即使该节点 mode=0/4 (bypass) 也照抽，因为用户可能主动 bypass 节点但仍用 widgets 列表管理 LoRA。
    节点本身不输出 model/clip，但 active 列表仍是用户当前真正想用的 LoRA。

    返回 [{name, strength}, ...]，按 |strength| 降序。
    """
    nodes = _workflow_nodes(workflow_obj)
    merged: dict[str, float] = {}
    for node in nodes:
        ct = (node.get("type") or "").strip()
        if ct not in LORA_MANAGER_NODE_TYPES:
            continue
        wv = node.get("widgets_values")
        if not isinstance(wv, list) or len(wv) < 3:
            continue
        loras = wv[2]
        if not isinstance(loras, list):
            continue
        for item in loras:
            if not isinstance(item, dict):
                continue
            if not item.get("active"):
                continue
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            # strength 可能是字符串或数字，统一转 float
            raw_s = item.get("strength")
            try:
                strength = float(raw_s) if raw_s is not None else 1.0
            except (TypeError, ValueError):
                strength = 1.0
            prev = merged.get(name)
            if prev is None or abs(strength) > abs(prev):
                merged[name] = strength
    return sorted(
        ({"name": n, "strength": s} for n, s in merged.items()),
        key=lambda x: abs(x["strength"]),
        reverse=True,
    )


def _workflow_nodes(workflow_obj: Any) -> list[dict[str, Any]]:
    """从 UI workflow JSON 抽取 nodes 数组。"""
    if not isinstance(workflow_obj, dict):
        return []
    nodes = workflow_obj.get("nodes")
    return [n for n in nodes if isinstance(n, dict)] if isinstance(nodes, list) else []


def _extract_used_loras_from_workflow(workflow_obj: Any) -> list[dict[str, Any]]:
    """从 UI workflow JSON 抽"实际使用"的 LoRA 节点。

    判定规则：
    - 节点 type 在 LORA_NODE_TYPES 白名单 或 inputs 启发式命中 LoRA 特征
    - 节点 mode 不是 0/4 (bypass)
    - name: widgets_values[0]（LoRA 文件名）或 inputs.lora_name
    - strength: widgets_values[1] (model_strength) / widgets_values[2] (clip_strength)
      或 inputs.{strength_model, model_strength, strength}
    - 同名 LoRA 多节点：strength 取绝对值大者
    """
    nodes = _workflow_nodes(workflow_obj)
    if not nodes:
        return []
    merged: dict[str, float] = {}
    for node in nodes:
        # bypass 过滤：mode 为 0/4 视为未启用
        if node.get("mode") in _LORA_BYPASS_MODES:
            continue
        if not _is_workflow_lora_node(node):
            continue
        name = _lora_name_from_workflow_node(node)
        if not name:
            continue
        strength = _lora_strength_from_workflow_node(node)
        prev = merged.get(name)
        if prev is None or abs(strength) > abs(prev):
            merged[name] = strength
    return sorted(
        ({"name": n, "strength": s} for n, s in merged.items()),
        key=lambda x: abs(x["strength"]),
        reverse=True,
    )


def _is_workflow_lora_node(node: dict[str, Any]) -> bool:
    """判断 UI workflow 节点是不是 LoRA loader。

    白名单优先；启发式仅放行 type 含 "lora" 子串的节点，避免误判 CheckpointLoader / VAELoader 等。
    """
    ct = (node.get("type") or "").strip()
    if ct in LORA_NODE_TYPES:
        return True
    # 启发式：type 含 "lora"（不区分大小写） -> 算 LoRA 节点（兜底新插件 / 第三方节点）
    return "lora" in ct.lower()


def _lora_name_from_workflow_node(node: dict[str, Any]) -> str:
    """从 UI workflow 节点抽 LoRA 文件名（去扩展名）。"""
    # 优先 widgets_values[0]
    wv = node.get("widgets_values")
    if isinstance(wv, list) and wv:
        first = wv[0]
        if isinstance(first, str) and first.strip():
            name = first.strip()
            # 去常见扩展名（前端 matchLoras 也会去，这里保持一致）
            for ext in (".safetensors", ".ckpt", ".pt", ".pth"):
                if name.lower().endswith(ext):
                    name = name[: -len(ext)]
                    break
            return name
    # 回退 inputs.lora_name（链接型 [<n>, <out>] 跳过）
    inputs = node.get("inputs") or {}
    if isinstance(inputs, dict):
        n = inputs.get("lora_name")
        if isinstance(n, str) and n.strip():
            return n.strip()
    return ""


def _lora_strength_from_workflow_node(node: dict[str, Any]) -> float:
    """从 UI workflow 节点抽 strength。widgets_values 通常 [name, model_strength, clip_strength]；否则回退 inputs。"""
    wv = node.get("widgets_values")
    if isinstance(wv, list):
        # model_strength / clip_strength 通常相等；取第一个非空数值
        for v in wv[1:]:
            if isinstance(v, bool):
                continue
            if isinstance(v, (int, float)):
                return float(v)
            if isinstance(v, str):
                try:
                    return float(v.strip())
                except ValueError:
                    continue
    inputs = node.get("inputs") or {}
    if isinstance(inputs, dict):
        return _lora_strength_from_inputs(inputs)
    return 1.0


# ---------- WebP RIFF 解析 ----------


def _read_webp_metadata(path: Path) -> dict[str, bytes]:
    """读取 WebP 文件中 ``EXIF`` / ``XMP`` 块的原始字节。

    WebP = RIFF 容器，块结构 ``FourCC(4) + Size(4) + Payload + Pad``。
    """
    out: dict[str, bytes] = {}
    with path.open("rb") as f:
        riff = f.read(4)
        size = f.read(4)
        form = f.read(4)
        if riff != b"RIFF" or form != b"WEBP":
            return out
        _ = size  # 不用
        while True:
            chunk_id = f.read(4)
            if len(chunk_id) < 4:
                break
            sz_bytes = f.read(4)
            if len(sz_bytes) < 4:
                break
            sz = struct.unpack("<I", sz_bytes)[0]
            payload = f.read(sz)
            # RIFF 块对齐到偶数
            if sz % 2 == 1:
                f.read(1)
            cid = chunk_id.decode("ascii", errors="replace")
            if cid in ("EXIF", "XMP "):
                # payload 头部：4 字节空白（WebP 规范要求）
                if payload[:4] in (b"Exif", b"http"):
                    out[cid] = payload[4:]
                else:
                    out[cid] = payload
    return out


# ---------- 图片尺寸解析 ----------
#
# PNG IHDR / WebP VP8 / VP8L / VP8X 手写 bitwise 也能做，但 Pillow 已经在依赖里
# （缩略图要用），直接 Image.open 拿 .width/.height 更稳。


def _extract_dimensions(path):
    """返回 (width, height)，失败时 (None, None)。不抛异常。"""
    try:
        from PIL import Image
    except ImportError:
        return None, None
    try:
        with Image.open(path) as img:
            return img.width, img.height
    except Exception:
        return None, None


# ---------- 统一入口 ----------


SUPPORTED_EXTS = {".png", ".webp"}


def parse_metadata(path: Path) -> dict[str, Any]:
    """解析图片元数据。返回统一结构，缺失字段为空字符串。

    不会抛出异常。
    """
    ext = path.suffix.lower()
    result: dict[str, Any] = {
        "filename": path.name,
        "width": None,
        "height": None,
        "positive_prompt": "",
        "negative_prompt": "",
        "parameters": {},
        "workflow": "",
        "seed": None,
        "model": None,
        "sampler": None,
        "steps": None,
        "cfg": None,
    }

    # 尺寸独立于元数据 chunk（PNG IHDR / WebP VP8*），尽早解析
    w, h = _extract_dimensions(path)
    result["width"] = w
    result["height"] = h

    try:
        if ext == ".png":
            chunks = _read_png_chunks(path)
            prompt_raw = chunks.get("prompt", b"")
            workflow_raw = chunks.get("workflow", b"")
            params_raw = chunks.get("parameters", b"")

            if prompt_raw:
                try:
                    prompt_obj = json.loads(prompt_raw.decode("utf-8", errors="replace"))
                    pos, neg, params = _extract_comfyui_prompts(prompt_obj)
                    result["positive_prompt"] = pos
                    result["negative_prompt"] = neg
                    result["parameters"] = params
                except (json.JSONDecodeError, UnicodeDecodeError):
                    pass
            if workflow_raw:
                result["workflow"] = workflow_raw.decode("utf-8", errors="replace")
                # 抽"实际使用"的 LoRA，优先级：
                # 1) ComfyUI-LoraManager 节点的 active LoRA 列表（精确到 active=false 关闭项）
                # 2) UI workflow 里 mode 非 bypass 的标准 LoRA 节点（兜底）
                try:
                    wf_obj = json.loads(workflow_raw.decode("utf-8", errors="replace"))
                    _used = _extract_active_loras_from_lora_manager(wf_obj)
                    if not _used:
                        _used = _extract_used_loras_from_workflow(wf_obj)
                    if _used:
                        result["parameters"]["used_loras"] = _used
                except (json.JSONDecodeError, UnicodeDecodeError):
                    pass
            if params_raw:
                try:
                    text = params_raw.decode("utf-8", errors="replace")
                    pos, neg, params = _parse_parameters_text(text)
                    if not result["positive_prompt"]:
                        result["positive_prompt"] = pos
                    if not result["negative_prompt"]:
                        result["negative_prompt"] = neg
                    # 不覆盖 ComfyUI 已给出的参数
                    for k, v in params.items():
                        result["parameters"].setdefault(k, v)
                except UnicodeDecodeError:
                    pass

        elif ext == ".webp":
            # 优先尝试 EXIF 中的 UserComment（很多工具把 prompt 写在这里），其次 XMP
            chunks = _read_webp_metadata(path)
            exif = chunks.get("EXIF", b"")
            if exif:
                parsed = _parse_exif_usercomment(exif)
                if parsed:
                    pos, neg, params = _parse_parameters_text(parsed)
                    if pos:
                        result["positive_prompt"] = pos
                    if neg:
                        result["negative_prompt"] = neg
                    for k, v in params.items():
                        result["parameters"].setdefault(k, v)
            # WebP 也可能把 ComfyUI 的 prompt 放进 XMP（custom namespace）
            xmp = chunks.get("XMP ", b"")
            if xmp and not result["positive_prompt"]:
                result["positive_prompt"] = _scrape_xmp_prompt(xmp)
    except Exception:
        # 解析异常：返回空结构，不影响入库（无元数据也允许）
        pass

    # 把常用参数提到顶层
    params = result["parameters"]
    if isinstance(params, dict):
        if "seed" in params or "Seed" in params:
            try:
                result["seed"] = int(str(params.get("seed") or params.get("Seed")).strip())
            except ValueError:
                pass
        if "model" in params:
            result["model"] = str(params["model"])
        if "sampler_name" in params or "Sampler" in params or "sampler" in params:
            result["sampler"] = str(params.get("sampler_name") or params.get("Sampler") or params.get("sampler"))
        if "steps" in params or "Steps" in params:
            try:
                result["steps"] = int(str(params.get("steps") or params.get("Steps")))
            except ValueError:
                pass
        if "cfg" in params or "CFG scale" in params:
            try:
                result["cfg"] = float(str(params.get("cfg") or params.get("CFG scale")))
            except ValueError:
                pass
    return result


# ---------- 辅助：EXIF UserComment ----------


def _parse_exif_usercomment(exif_bytes: bytes) -> str:
    """极简 EXIF 解码，只取 ``UserComment`` 字段文本。"""
    try:
        # 跳过 ``Exif\\0\\0``
        if exif_bytes.startswith(b"Exif"):
            exif_bytes = exif_bytes[6:]
        # TIFF header
        if exif_bytes[:2] not in (b"II", b"MM"):
            return ""
        little = exif_bytes[:2] == b"II"
        endian = "<" if little else ">"

        def u16(off: int) -> int:
            return struct.unpack(endian + "H", exif_bytes[off : off + 2])[0]

        def u32(off: int) -> int:
            return struct.unpack(endian + "I", exif_bytes[off : off + 4])[0]

        if u16(2) != 0x002A:
            return ""
        ifd0_off = u32(4)
        n = u16(ifd0_off)
        for i in range(n):
            entry_off = ifd0_off + 2 + i * 12
            tag = u16(entry_off)
            if tag == 0x8769:  # ExifIFD
                exif_ifd = u32(entry_off + 8)
                m = u16(exif_ifd)
                for j in range(m):
                    eoff = exif_ifd + 2 + j * 12
                    ttag = u16(eoff)
                    if ttag == 0x9286:  # UserComment
                        # 跳过 char encoding 前 8 字节
                        val_off = u32(eoff + 8)
                        size = u32(eoff + 4)
                        raw = exif_bytes[val_off : val_off + size]
                        # 前 8 字节是 charset 标记
                        if len(raw) > 8:
                            charset = raw[:8]
                            text_bytes = raw[8:]
                            if charset.startswith(b"UNICODE"):
                                return text_bytes.decode("utf-16", errors="replace").rstrip("\x00").strip()
                            return text_bytes.decode("utf-8", errors="replace").strip()
                        return raw.decode("utf-8", errors="replace").strip()
        return ""
    except Exception:
        return ""


def _scrape_xmp_prompt(xmp_bytes: bytes) -> str:
    """从 XMP 中粗略匹配 ``dc:description`` 字段。"""
    text = xmp_bytes.decode("utf-8", errors="replace")
    m = re.search(r"<dc:description>([\s\S]*?)</dc:description>", text)
    if m:
        return m.group(1).strip()
    m = re.search(r"<Description>([\s\S]*?)</Description>", text)
    if m:
        return m.group(1).strip()
    return ""

