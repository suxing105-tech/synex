"""一键同款：同款工作流模板的存储与槽位检测。

一条模板 = 一份 ComfyUI API 格式工作流 + 一组槽位绑定。用户随时会换一份 JSON 进来，
所以这里的重点不是"存了什么"，而是"怎么从任意工作流里认出可注入的位置"：

  prompt       —— inputs 下 key 是 prompt / text / positive_prompt 的字符串字面量。
                  孤立节点也算：仓库样例里 540 是孤立的 CR Prompt Text、582 才真正
                  生效，只写 582 会让用户在 ComfyUI 里看到两处不一致的文本。
                  key 里带 negative 的一律不认，避免把正向提示词灌进负向。
  image        —— class_type 以 LoadImage 开头的节点，一个节点一个参考位。要更多
                  参考位就去 ComfyUI 里多接一个 LoadImage，app 不自动改图结构。
  select/number —— 从 object_info 里挑 aspect_ratio、megapixels 这类字面量控件，
                  最多两个进弹窗；其余作为候选，由设置页决定要不要绑。
"""
from __future__ import annotations

import copy
import json
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
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clone_template_name ON clone_templates(name);
"""


def initialize(conn) -> None:
    conn.executescript(SCHEMA)


class DuplicateNameError(ValueError):
    """模板重名。路由翻成 409：前端要区分「改个名字再试」和「参数写错了」。"""


PROMPT_INPUT_KEYS = {"prompt", "text", "positive_prompt"}
SEED_INPUT_KEYS = {"seed", "noise_seed"}
AUTO_CONTROL_KEYS = ("aspect_ratio", "megapixels")
MAX_AUTO_CONTROLS = 2
KINDS = {"prompt", "image", "select", "number"}
CONTROL_LABELS = {
    "aspect_ratio": "比例",
    "megapixels": "分辨率",
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
GROW_MAX = 15
GROW_TYPE_PREFIX = "COMFY_AUTOGROW"
_GROUPS: dict[str, list[dict]] = {}  # detect_slots 期间的临时表，避免每个节点重解析一次 object_info


def grow_key(slot: dict, name: str) -> str:
    """扩出来的参考位用「543.image::image_2」这种键，和真槽位一眼分得开。"""
    return f"{slot_key(slot)}{GROW_SEP}{name}"


def split_reference_key(key: str) -> tuple[str, str | None]:
    base, sep, name = str(key).partition(GROW_SEP)
    return base, (name if sep else None)


def reference_cell_keys(slots: list[dict]) -> list[str]:
    """参考格子的画面顺序：先是工作流自带的 LoadImage，再是 autogrow 续出来的空格。

    弹窗按这个顺序编号「图片1…N」，后端按同一个顺序校验「不能空一格跳着填」，
    两边必须一模一样，否则用户看到的图片3 和实际接到 node 上的输入对不上。
    """
    out: list[str] = []
    image_slots = [s for s in slots if s.get("kind") == "image"]
    for slot in image_slots:
        out.append(slot_key(slot))
    claimed: set[str] = set()
    for slot in image_slots:
        grow = slot.get("grow") or {}
        for name in grow_names(slot):
            target = f"{grow.get('node')}.{grow.get('group')}::{name}"
            if target in claimed:
                continue
            claimed.add(target)
            out.append(grow_key(slot, name))
    return out


def reference_slot_keys(slots: list[dict]) -> tuple[list[str], set[str]]:
    """(必填参考位, 全部可提交的参考位)。

    必填恒为空：生成方式就是参考图的数量（0 张文生图 / 1 张单图编辑 / 2 张以上多图编辑），
    所以没有「这张工作流非要几张参考图」这回事。一张都不填能不能跑，看的是
    参考链摘不摘得掉——那由 `modes_of` 在 plan_request 里把关。
    """
    keys = reference_cell_keys(slots)
    return [], set(keys)


def unused_reference_nodes(slots: list[dict], references: dict | None) -> list[str]:
    """没拿到参考图的 LoadImage 节点。留着它们等于偷偷用工作流里那张旧图。"""
    used = {str((s or {}).get("node")) for s in
            (slot_for_reference_key(slots, key) for key in (references or {})) if s}
    return [str(s.get("node")) for s in slots
            if s.get("kind") == "image" and str(s.get("node")) not in used]


def slot_for_reference_key(slots: list[dict], key: str) -> dict | None:
    base, _grow = split_reference_key(str(key))
    for slot in slots:
        if slot.get("kind") == "image" and slot_key(slot) == base:
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


def _autogrow_groups(info: dict) -> dict[str, list[dict]]:
    """class_type -> [{input, names}]：哪些节点的哪个输入是会自动长格的图组。"""
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
                names = template.get("names") if isinstance(template, dict) else None
                if isinstance(names, list) and names:
                    bucket.append({"input": name, "names": [n for n in names if isinstance(n, str)]})
        if bucket:
            groups[str(class_type)] = bucket
    return groups


def _next_node_id(nodes: dict) -> int:
    numbers = [int(k) for k in nodes if str(k).isdigit()]
    return (max(numbers) + 1) if numbers else len(nodes) + 100


def _grow_target(nodes: dict, source_id: str) -> dict | None:
    """找这台 LoadImage 连进了哪个节点的哪个图组，以及图组里还空着哪些格。"""
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
            used = {k.partition(".")[2] for k in inputs if k.startswith(group + ".")}
            free = [n for n in bucket["names"] if n not in used][:GROW_MAX]
            if free:
                return {"node": nid, "group": group, "names": free}
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
    ordered = sorted(_prompt_slots(slots), key=lambda s: 0 if str(s.get("node")) in used else 1)
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


def check_mode(template: dict, mode: str) -> str:
    """参考图数量决定出来的档位，这份工作流到底支持不支持；不支持就明说缺什么。"""
    if mode in modes_of(template):
        return mode
    if mode == "text":
        raise ValueError("这份工作流去不掉参考图（有节点非要有输入图才跑得起来），"
                         "所以至少放一张参考图。想文生图请换一份纯文生图的工作流。")
    raise ValueError("这份工作流不支持「" + workflow_edit.MODE_LABELS.get(mode, mode)
                     + "」，减少参考图再试。")


def modes_of(template: dict) -> list[str]:
    """这份模板能用哪些生成档位（读库里现成的模板，不依赖 ComfyUI 在线）。"""
    return fallback_modes(template.get("nodes") or {}, template.get("slots") or [])


def fallback_modes(nodes: dict, slots: list[dict]) -> list[str]:
    """离线估算生成档位：object_info 拿不到时用这个。

    文生图这一档剪不剪得干净，没有 object_info 只能乐观判断；真到生成时后端还会带着
    object_info 再剪一次，剪不动会明确报错，不会静默出一张带残图的片子。
    """
    refs = [s for s in slots if s.get("kind") == "image"]
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

    for nid in _ordered_ids(nodes):
        for key, value in node_inputs(nodes[nid]).items():
            lowered = key.lower()
            if lowered not in PROMPT_INPUT_KEYS or "negative" in lowered:
                continue
            if not isinstance(value, str) or not value.strip():
                continue
            slots.append({"kind": "prompt", "node": nid, "input": key, "label": "完整提示词"})

    index = 0
    for nid in _ordered_ids(nodes):
        node = nodes[nid]
        if not str(node.get("class_type") or "").startswith("LoadImage"):
            continue
        value = node_inputs(node).get("image")
        if not isinstance(value, str):
            warnings.append(f"节点 {nid} 的输入图片是上游节点连过来的，不能当参考位。")
            continue
        index += 1
        slot: dict[str, Any] = {"kind": "image", "node": nid, "input": "image",
                                "label": node_title(node, f"图片{index}")}
        if info:
            _GROUPS.clear(); _GROUPS.update(_autogrow_groups(info))
            grow = _grow_target(nodes, nid)
            if grow:
                slot["grow"] = grow
        slots.append(slot)

    used = {slot_key(s) for s in slots}
    controls: list[dict] = []
    candidates: list[dict] = []
    if info:
        widgets = _widgets(nodes, info)
        for want in AUTO_CONTROL_KEYS:
            for nid, key, spec in widgets:
                if key != want or len(controls) >= MAX_AUTO_CONTROLS:
                    continue
                if f"{nid}.{key}" in used:
                    continue
                control = control_slot(nid, key, spec, node_inputs(nodes[nid]).get(key))
                if control:
                    controls.append(control)
                    used.add(slot_key(control))
        for nid, key, spec in widgets:
            if f"{nid}.{key}" in used:
                continue
            control = control_slot(nid, key, spec, node_inputs(nodes[nid]).get(key))
            if control:
                candidates.append(control)
    slots.extend(controls)

    default_prompt = pick_default_prompt(nodes, slots)

    return {
        "slots": slots,
        "candidates": candidates,
        "nodes": node_overview(nodes),
        "default_prompt": default_prompt,
        "modes": workflow_edit.modes_for(
            nodes,
            [s["node"] for s in slots if s.get("kind") == "image"],
            info,
            {nid: node_title(node, nid) for nid, node in nodes.items()},
            {s["node"] for s in slots if s.get("kind") == "prompt"},
        ),
        "warnings": warnings,
    }


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
        if kind != "image" and not is_literal(inputs[key]):
            raise ValueError(f"节点 {node} 的 {key} 由上游节点连过来，不能当槽位。")
        slot: dict[str, Any] = {
            "kind": kind, "node": node, "input": key,
            "label": (str(item.get("label") or "").strip() or key)[:40],
        }
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
            for extra in ("value", "min", "max", "step"):
                if item.get(extra) is not None:
                    slot[extra] = item[extra]
        grow = item.get("grow")
        if isinstance(grow, dict):
            gnode = str(grow.get("node") or "")
            group = str(grow.get("group") or "").strip()
            names = [n for n in (grow.get("names") or []) if isinstance(n, str)][:GROW_MAX]
            if kind == "image" and gnode in nodes and group and names:
                slot["grow"] = {"node": gnode, "group": group, "names": names}
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


def _attach_grown_reference(nodes: dict, slot: dict, name: str, image_name: str) -> None:
    """多图参考：照着原来的 LoadImage 复制一台，填好图，再连进图组空着的那一格。

    为什么由图库来复制节点：Qwen Image 2.1 那种 images 输入会自动长格（image_1…image_16），
    用户不必回 ComfyUI 手摆节点就能多喂参考图。
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
        raise ValueError("这份工作流的参考图输入位已经放满了，少加几张再试。")
    clone = copy.deepcopy(source)
    node_inputs(clone).update({str(slot["input"]): image_name})
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
        for slot in slots:
            if slot.get("kind") == "prompt":
                node_inputs(workflow.get(slot["node"])).update({slot["input"]: prompt})
    for key, image_name in (references or {}).items():
        base_key, grow_name = split_reference_key(key)
        slot = by_key.get(base_key)
        if slot is None or slot.get("kind") != "image":
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
    # 没喂图的 LoadImage 一律从图里摘掉：留着它，ComfyUI 会悄悄用工作流里那张旧图，
    # 用户在弹窗里看到的参考和实际出图的参考就对不上了。一张都不喂就是文生图。
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
    data["slots"] = slots
    data["is_active"] = bool(data.get("is_active"))
    data["node_count"] = len(nodes)
    data["prompt_count"] = sum(1 for s in slots if s.get("kind") == "prompt")
    data["reference_count"] = sum(1 for s in slots if s.get("kind") == "image")
    data["control_count"] = sum(1 for s in slots if s.get("kind") in ("select", "number"))
    data["modes"] = fallback_modes(nodes, slots)
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


def set_active(template_id: int) -> dict:
    get_row(template_id)
    conn = _conn()
    conn.execute("UPDATE clone_templates SET is_active=0")
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


def create_template(name: str, workflow_raw: Any, slots_raw: Any = None) -> dict:
    name = (name or "").strip()
    if not name:
        raise ValueError("给这份工作流起个名字，弹窗里要靠它认模板。")
    if len(name) > 40:
        raise ValueError("名字最长 40 个字。")
    nodes = parse_workflow(workflow_raw)
    slots = normalize_slots(detect_slots(nodes)["slots"] if slots_raw is None else slots_raw, nodes)
    conn = _conn()
    if conn.execute("SELECT 1 FROM clone_templates WHERE name=?", (name,)).fetchone():
        raise DuplicateNameError(f"已经有叫「{name}」的同款工作流，换一个名字。")
    is_first = conn.execute("SELECT 1 FROM clone_templates LIMIT 1").fetchone() is None
    cur = conn.execute(
        "INSERT INTO clone_templates(name, workflow, slots, default_prompt, is_active) VALUES(?,?,?,?,?)",
        (name, json.dumps(nodes, ensure_ascii=False), json.dumps(slots, ensure_ascii=False),
         default_prompt_for(nodes, slots), 1 if is_first else 0),
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

    conn.execute(
        f"UPDATE clone_templates SET name=?, workflow=?, slots=?, default_prompt=?, updated_at={NOW_SQL} WHERE id=?",
        (name, json.dumps(nodes, ensure_ascii=False), json.dumps(slots, ensure_ascii=False),
         default_prompt_for(nodes, slots), template_id),
    )
    if patch.get("is_active") is True:
        return set_active(template_id)
    return public(conn.execute("SELECT * FROM clone_templates WHERE id=?", (template_id,)).fetchone())


def delete_template(template_id: int) -> int:
    get_row(template_id)
    conn = _conn()
    conn.execute("DELETE FROM clone_templates WHERE id=?", (template_id,))
    # 删掉的正好是当前用的 → 拿最早一条顶上，别让弹窗没有默认模板。
    if conn.execute("SELECT 1 FROM clone_templates WHERE is_active=1").fetchone() is None:
        fallback = conn.execute("SELECT id FROM clone_templates ORDER BY id LIMIT 1").fetchone()
        if fallback:
            conn.execute("UPDATE clone_templates SET is_active=1 WHERE id=?", (fallback["id"],))
    return template_id
