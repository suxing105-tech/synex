"""一键同款的图结构改造：文生图必须能把参考图整条链摘干净。

为什么单独一个模块：clone_templates 只管「往哪儿注入」，这里管「注入之前先把图剪干净」。
ComfyUI 会校验 prompt 里的每一个节点（包括没有任何下游的空节点），所以摘掉参考图不是
删两根连线就完事——留着填不满必填输入的空壳，整条请求会被直接打回。剪枝规则只有三条，
全部读 ComfyUI 自己的 object_info，不认具体节点名：

  1) 悬空连线：输入连到已被删掉的节点 → 断开；
  2) 死节点：没有任何下游消费、又不是保存/输出类节点 → 删掉；
  3) 必填输入填不满：下游本来不强制要它（optional）→ 直接断开；
     能同名透传 → 旁路（把下游改接到它的输入源，例如提示词增强器退回原始提示词）；
     都不行 → 抛中文错误，绝不带着残图去排队。
"""
from __future__ import annotations

import copy
from typing import Any

MODES = ("text", "single", "multi")
MODE_LABELS = {"text": "文生图", "single": "单图编辑", "multi": "多图编辑"}
AUTOGROW_PREFIX = "COMFY_AUTOGROW"
# 摘掉参考图之后仍然必须留下的节点：产出图片的那几台（删了就没有交付物）。
# 视频/音频的产出节点单独列：VHS_VideoCombine 这类名字里既没有 save 也没有 preview，
# 而 object_info 读不到的时候（ComfyUI 没开）只能靠类名认——认漏了，剪枝会把
# 「出片」这一头整个当死节点删光，剩下一份只剩提示词的工作流安静地排进队列。
# 绝不写 "video" 这种宽词：VHS_LoadVideo 是参考视频的加载器，必须能被摘掉。
SINK_HINTS = ("save", "preview", "showanything", "showtext", "display", "record")
MEDIA_SINK_HINTS = ("videocombine", "combinevideo", "savevideo", "createvideo", "writevideofile",
                    "saveanimated", "savegif", "saveaudio", "audiocombine", "createaudio")
# 认「空 Latent」这条路：出图尺寸由比例/分辨率决定，而不是由参考图尺寸决定。
EMPTY_LATENT_HINTS = ("emptylatent", "latentfrom", "randnoise", "noise")


class TextModeUnsupported(ValueError):
    """这份工作流去掉参考图之后跑不起来，所以不给「文生图」这一档。"""


def _inputs(node: Any) -> dict:
    if not isinstance(node, dict):
        return {}
    inputs = node.get("inputs")
    return inputs if isinstance(inputs, dict) else {}


def _is_link(value: Any) -> bool:
    return isinstance(value, (list, tuple)) and len(value) >= 1


def _link_node(value: Any) -> str:
    return str(value[0]) if _is_link(value) else ""


def _class_of(node: Any) -> str:
    return str(node.get("class_type") or "") if isinstance(node, dict) else ""


def _consumers(nodes: dict) -> dict[str, list[tuple[str, str]]]:
    """producer node_id -> [(消费方 node_id, 它那边的输入名)]。"""
    out: dict[str, list[tuple[str, str]]] = {}
    for nid, node in nodes.items():
        for key, value in _inputs(node).items():
            src = _link_node(value) if _is_link(value) else ""
            if src:
                out.setdefault(src, []).append((str(nid), str(key)))
    return out


def _specs(info: dict, class_type: str) -> dict[str, tuple[list, bool]]:
    """class_type -> {输入名: (widget 定义, 是否必填)}。object_info 里没有这个类 → 空表。"""
    schema = (info or {}).get(class_type)
    if not isinstance(schema, dict):
        return {}
    block = schema.get("input")
    merged: dict[str, tuple[list, bool]] = {}
    if isinstance(block, dict):
        for part, required in (("required", True), ("optional", False)):
            items = block.get(part)
            if isinstance(items, dict):
                for name, spec in items.items():
                    merged[str(name)] = (spec if isinstance(spec, list) and spec else [], required)
    return merged


def _is_sink(node: Any, info: dict) -> bool:
    class_type = _class_of(node)
    schema = (info or {}).get(class_type)
    if isinstance(schema, dict) and schema.get("output_node"):
        return True
    lowered = class_type.lower()
    return any(hint in lowered for hint in SINK_HINTS + MEDIA_SINK_HINTS)


def _group_floor(spec: list) -> int | None:
    """autogrow 输入组至少要填几格；不是 autogrow 返回 None。"""
    if not (isinstance(spec, list) and spec and isinstance(spec[0], str)):
        return None
    if not spec[0].startswith(AUTOGROW_PREFIX):
        return None
    extra = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
    template = extra.get("template") if isinstance(extra.get("template"), dict) else {}
    floor = template.get("min")
    return floor if isinstance(floor, int) and not isinstance(floor, bool) else 0


def _group_names(spec: list) -> list[str]:
    extra = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
    template = extra.get("template") if isinstance(extra.get("template"), dict) else {}
    names = template.get("names")
    return [n for n in names if isinstance(n, str)] if isinstance(names, list) else []


def _missing_required(nodes: dict, nid: str, info: dict) -> list[str]:
    """这个节点现在缺哪些必填输入。object_info 里没有这个类 → 一律当不缺，别瞎报错。"""
    inputs = _inputs(nodes.get(nid))
    specs = _specs(info, _class_of(nodes.get(nid)))
    if not specs:
        return []
    missing: list[str] = []
    for key, (spec, required) in specs.items():
        floor = _group_floor(spec)
        if floor is not None:
            filled = sum(1 for k in inputs if k == key or k.startswith(key + "."))
            if filled < floor:
                missing.append(key)
        elif required and key not in inputs:
            missing.append(key)
    return missing


def _passthrough_source(nodes: dict, nid: str, want_keys: list[str]) -> Any:
    """被旁路的节点里挑一个能替它交给下游的输入源：先按下游的输入名同名找，再退到唯一连线。"""
    inputs = _inputs(nodes[nid])
    for want in want_keys:
        if _is_link(inputs.get(want)):
            return inputs[want]
    links = [v for v in inputs.values() if _is_link(v)]
    if len(links) == 1:
        return links[0]
    for key in ("prompt", "text", "positive_prompt", "anything", "image", "samples", "latent"):
        if _is_link(inputs.get(key)):
            return inputs[key]
    return None


def _rewire(nodes: dict, from_id: str, source: Any) -> None:
    for node in nodes.values():
        inputs = _inputs(node)
        for key, value in inputs.items():
            if _is_link(value) and _link_node(value) == from_id:
                inputs[key] = source


def _detach_dangling(nodes: dict) -> bool:
    changed = False
    for node in nodes.values():
        inputs = _inputs(node)
        for key in [k for k, v in inputs.items() if _is_link(v) and _link_node(v) not in nodes]:
            del inputs[key]
            changed = True
    return changed


def _drop_dead(nodes: dict, info: dict, protected: set[str]) -> bool:
    consumers = _consumers(nodes)
    doomed = [nid for nid, node in nodes.items()
              if nid not in consumers and nid not in protected and not _is_sink(node, info)]
    for nid in doomed:
        del nodes[nid]
    return bool(doomed)


def _optional_for_consumers(nodes: dict, info: dict, downstream: list[tuple[str, str]]) -> bool:
    return all(not _specs(info, _class_of(nodes.get(cid))).get(key, ([], True))[1] for cid, key in downstream)


def _resolve_starved(nodes: dict, info: dict, protected: set[str], titles: dict[str, str]) -> bool:
    """把填不满必填输入的节点旁路掉或断开；一次只动一个，剩下的交给下一轮。"""
    consumers = _consumers(nodes)
    for nid in list(nodes):
        missing = _missing_required(nodes, nid, info)
        if not missing:
            continue
        downstream = consumers.get(nid, [])
        if downstream and _optional_for_consumers(nodes, info, downstream):
            # 下游本来就把它当可选项：断掉产出，让下游少一份输入继续跑。
            for cid, key in downstream:
                _inputs(nodes[cid]).pop(key, None)
            del nodes[nid]
            return True
        source = _passthrough_source(nodes, nid, [key for _cid, key in downstream])
        if downstream and source is not None:
            _rewire(nodes, nid, source)
            del nodes[nid]
            return True
        if not downstream:
            del nodes[nid]
            return True
        if nid in protected:
            continue
        raise TextModeUnsupported(
            f"这份工作流的「{titles.get(nid, nid)}」缺了{'、'.join(missing)}，"
            "去掉参考图就跑不起来，只能按参考图生成。"
        )
    return False


def drop_reference_images(nodes: dict, node_ids: list[str], info: dict | None = None,
                          titles: dict[str, str] | None = None,
                          protected: set[str] | None = None) -> dict:
    """把参考图（LoadImage 那几台）从图里彻底摘掉，返回可以直接排队的节点表副本。"""
    info = info or {}
    titles = titles or {}
    protected = set(protected or ())
    working = copy.deepcopy(nodes)
    doomed = {str(x) for x in node_ids}
    for nid in doomed:
        working.pop(nid, None)
    for _ in range(len(nodes) + len(doomed) + 4):
        changed = _detach_dangling(working)
        changed = _drop_dead(working, info, protected) or changed
        changed = _resolve_starved(working, info, protected, titles) or changed
        if not changed:
            break
    sinks_before = [nid for nid, node in nodes.items() if _is_sink(node, info)]
    sinks_after = [nid for nid, node in working.items() if _is_sink(node, info)]
    if sinks_before and not sinks_after:
        # 剪到连交付物都没了：这比报错糟，静默排一份不会出任何东西的工作流。
        raise TextModeUnsupported(
            "这份工作流去掉参考素材之后连出图/出片的节点都留不住，所以只支持按参考素材生成。")
    leftovers = [nid for nid, node in working.items()
                 if _missing_required(working, nid, info) and not _is_sink(node, info) and nid not in protected]
    if leftovers:
        raise TextModeUnsupported(
            "这份工作流去掉参考图之后还有节点跑不起来（"
            + "、".join(titles.get(nid, nid) for nid in leftovers[:3]) + "），所以只支持按参考图生成。"
        )
    return working


def _branch_class(nodes: dict, link: Any) -> str:
    src = _link_node(link)
    return _class_of(nodes.get(src)) if src else ""


def _looks_empty_latent(class_type: str) -> bool:
    lowered = class_type.lower()
    return any(hint in lowered for hint in EMPTY_LATENT_HINTS)


def prefer_empty_latent(nodes: dict) -> list[str]:
    """把工作流自带的「出图尺寸来源」开关翻到空 Latent 那一头。

    Qwen Image 2.1 这类工作流自带一个 Switch：一头是 EmptyLatent（跟着比例/分辨率走），
    另一头是参考图尺寸的 Latent。弹窗里既然给了比例和分辨率，就必须让开关站到空 Latent
    这边——否则那两颗控件在编辑模式下是死的，用户改了没反应，比不给控件更糟。
    认不出哪头是空 Latent 就不动，绝不瞎翻。
    """
    consumers = _consumers(nodes)
    flipped: list[str] = []
    for nid, node in nodes.items():
        inputs = _inputs(node)
        if not isinstance(inputs.get("switch"), bool):
            continue
        if "on_true" not in inputs or "on_false" not in inputs:
            continue
        keys = [key for _cid, key in consumers.get(nid, [])]
        if not any("latent" in key.lower() for key in keys):
            continue
        true_empty = _looks_empty_latent(_branch_class(nodes, inputs.get("on_true")))
        false_empty = _looks_empty_latent(_branch_class(nodes, inputs.get("on_false")))
        if true_empty == false_empty:
            continue
        if inputs["switch"] is not true_empty:
            inputs["switch"] = true_empty
            flipped.append(nid)
    return flipped


def has_grow_room(nodes: dict, info: dict | None = None) -> bool:
    """图里已经用上了某个 autogrow 图组、而且还有空位 → 多图模式有意义。"""
    for node in nodes.values():
        inputs = _inputs(node)
        for key, (spec, _required) in _specs(info or {}, _class_of(node)).items():
            if _group_floor(spec) is None:
                continue
            names = _group_names(spec)
            if not names:
                continue
            used = {k.partition(".")[2] for k in inputs if k.startswith(key + ".")}
            if used and len(names) > len(used & set(names)):
                return True
    return False


def supports_text_mode(nodes: dict, node_ids: list[str], info: dict | None = None,
                       titles: dict[str, str] | None = None,
                       protected: set[str] | None = None) -> bool:
    """导入时判断这份工作流能不能不带参考图出图：剪得干净就给「文生图」这一档。"""
    if not node_ids:
        return True
    try:
        drop_reference_images(nodes, node_ids, info, titles, protected)
    except (TextModeUnsupported, RecursionError, KeyError):
        return False
    return True


def modes_for(nodes: dict, node_ids: list[str], info: dict | None = None,
              titles: dict[str, str] | None = None,
              protected: set[str] | None = None) -> list[str]:
    """模板可用的生成档位：没有参考位就只剩文生图；有多图空位才给多图编辑。"""
    if not node_ids:
        return ["text"]
    modes = ["single"]
    if len(node_ids) > 1 or has_grow_room(nodes, info):
        modes.append("multi")
    if supports_text_mode(nodes, node_ids, info, titles, protected):
        modes.append("text")
    return [mode for mode in MODES if mode in modes]
