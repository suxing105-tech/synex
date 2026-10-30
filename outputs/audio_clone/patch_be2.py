# -*- coding: utf-8 -*-
"""后端：让工作流里的第二段文字（音色克隆的 ref_text）能单独填、单独命名。"""
import io, os

def patch(path, pairs):
    s = io.open(path, encoding="utf-8").read()
    before = s
    for old, new in pairs:
        assert s.count(old) == 1, (path, s.count(old), old[:70])
        s = s.replace(old, new)
    assert s != before
    tmp = path + ".tmp"
    io.open(tmp, "w", encoding="utf-8", newline="\n").write(s)
    os.replace(tmp, path)
    print("patched", path)

T = r"backend\app\clone_templates.py"
patch(T, [
    # 1) 常量：主提示词的名字 + 认得出用途的第二段文字
    ('''PROMPT_INPUT_KEYS = {"prompt", "text", "positive_prompt"}
# 一台节点上挂着第二段文字时该叫什么。音色克隆必须同时有「要说的话」与「参考音频里
# 说的原话」，两者塞进同一个输入框会把原话冲掉——克隆出来的音色就不像了。
SECONDARY_PROMPT_LABELS = {"ref_text": "参考音频的文本"}''',
     '''PROMPT_INPUT_KEYS = {"prompt", "text", "positive_prompt"}
# 弹窗里那个主文本框的槽位标签，前后端共用这一个词（前端 lib/clone.ts 同名常量）。
PRIMARY_PROMPT_LABEL = "\u5b8c\u6574\u63d0\u793a\u8bcd"
# 认得出用途的第二段文字：键名 → 中文名。音色克隆必须同时有「要说的话」与「参考音频里
# 说的原话」，原话既不叫 prompt 也不叫 text，光靠 PROMPT_INPUT_KEYS 认不出来；就算认出来，
# 塞进同一个输入框更糟——用户一改台词就把原话冲掉，克隆出来的音色就不像了。
SECONDARY_PROMPT_KEYS = {"ref_text": "\u53c2\u8003\u97f3\u9891\u7684\u6587\u672c"}'''),

    # 2) 检测：第二段文字按键名命名，谁先出现不影响谁是主提示词
    ('''            by_key = lowered in PROMPT_INPUT_KEYS
            by_class = (class_type in STRING_PRIMITIVE_CLASSES
                        and lowered == STRING_PRIMITIVE_KEY)
            if not (by_key or by_class):
                continue
            if not isinstance(value, str) or not value.strip():
                continue
            slot: dict[str, Any] = {"kind": "prompt", "node": nid, "input": key,
                                    "label": "完整提示词", "value": value}
            if nid in prompt_nodes:
                # 同一台节点上的第二段文字不是「另一个提示词」，是另一个用途：
                # 认得出名字，弹窗才配得上一句人话；认不出就退回输入键名，至少不撒谎。
                slot["label"] = (SECONDARY_PROMPT_LABELS.get(key) or key)[:40]
            prompt_nodes.add(nid)
            slots.append(slot)''',
     '''            by_key = lowered in PROMPT_INPUT_KEYS
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
                          "label": label, "value": value})'''),

    # 3) 工作流内置提示词：先认主框那条，别把参考音频的原话当默认台词
    ('''    used = referenced_node_ids(nodes)
    ordered = sorted(_prompt_slots(slots), key=lambda s: 0 if str(s.get("node")) in used else 1)''',
     '''    used = referenced_node_ids(nodes)
    # 主框那条优先：音色克隆那类工作流一台节点上有两段文字，谁排前面看的是 JSON 里的
    # 键序，照顺序取会把「参考音频里的原话」当成默认台词填进主框。
    primaries = [s for s in _prompt_slots(slots) if str(s.get("label") or "") == PRIMARY_PROMPT_LABEL]
    ordered = sorted(primaries or _prompt_slots(slots),
                     key=lambda s: 0 if str(s.get("node")) in used else 1)'''),
])

J = r"backend\app\clone_jobs.py"
patch(J, [
    ('''def plan_request(*, template_id: int, references: list[dict],
                 controls: dict | None) -> tuple[dict, str]:''',
     '''def plan_request(*, template_id: int, references: list[dict], controls: dict | None,
                 slot_prompts: dict | None = None) -> tuple[dict, str]:'''),
    ('''    control_keys = {clone_templates.slot_key(s) for s in slots if s.get("kind") in ("select", "number")}
    for key in (controls or {}):
        if key not in control_keys:
            raise ValueError(f"{key} 不是这份工作流声明的控件，关掉弹窗重开一次试试。")
    return template, mode''',
     '''    control_keys = {clone_templates.slot_key(s) for s in slots if s.get("kind") in ("select", "number")}
    for key in (controls or {}):
        if key not in control_keys:
            raise ValueError(f"{key} 不是这份工作流声明的控件，关掉弹窗重开一次试试。")
    # 文字位同理：多一个键就是有人在往工作流里没声明的地方塞话（主提示词之外的第二段文字，
    # 比如音色克隆的原话）。让它失败，别静默丢掉用户填的那一段。
    prompt_keys = {clone_templates.slot_key(s): str(s.get("label") or "")
                   for s in slots if s.get("kind") == "prompt"}
    for key in (slot_prompts or {}):
        if key not in prompt_keys:
            raise ValueError(f"{key} 不是这份工作流的文字位，关掉弹窗重开一次试试。")
    return template, mode'''),
    ('''async def start(
    *,
    template_id: int,
    prompt: str,
    references: list[dict],
    controls: dict | None,
    source_image_id: int | None,
) -> dict:''',
     '''async def start(
    *,
    template_id: int,
    prompt: str,
    references: list[dict],
    controls: dict | None,
    source_image_id: int | None,
    slot_prompts: dict | None = None,
) -> dict:'''),
    ('''    template, mode = plan_request(
        template_id=template_id, references=references, controls=controls,
    )''',
     '''    template, mode = plan_request(
        template_id=template_id, references=references, controls=controls,
        slot_prompts=slot_prompts,
    )'''),
    ('''            "prompt": prompt,
            "references": [dict(ref) for ref in references],''',
     '''            "prompt": prompt,
            # 主框之外那些单独命名的文字位（音色克隆的参考原话）各填各的，
            # 没填的才跟着主提示词走——工作流里的原话不能被台词冲掉。
            "slot_prompts": {str(k): str(v) for k, v in (slot_prompts or {}).items()},
            "references": [dict(ref) for ref in references],'''),
    ('''            prompt=job["prompt"],
            references=references,''',
     '''            prompt=job["prompt"],
            slot_prompts=job.get("slot_prompts") or None,
            references=references,'''),
])

R = r"backend\app\routes\clone.py"
patch(R, [
    ('''class GenerateInput(BaseModel):
    template_id: int
    prompt: str = Field(min_length=1, max_length=50000)
    references: list[ReferenceInput] = Field(default_factory=list)''',
     '''class GenerateInput(BaseModel):
    template_id: int
    prompt: str = Field(min_length=1, max_length=50000)
    # 主提示词之外的文字位（键 = 「节点.输入」）。音色克隆那类工作流要两段文字：
    # 台词进 prompt，参考音频里的原话进这里，不然原话会被台词冲掉，音色就不像了。
    slot_prompts: dict[str, str] = Field(default_factory=dict)
    references: list[ReferenceInput] = Field(default_factory=list)'''),
    ('''            template_id=payload.template_id,
            prompt=payload.prompt,
            references=references,''',
     '''            template_id=payload.template_id,
            prompt=payload.prompt,
            slot_prompts=payload.slot_prompts,
            references=references,'''),
])
print("ALL OK")
