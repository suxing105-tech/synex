# -*- coding: utf-8 -*-
"""后端：让一份工作流里的第二段文字（音色克隆的 ref_text）能单独填。"""
import io, os

def patch(path, pairs):
    s = io.open(path, encoding="utf-8").read()
    before = s
    for old, new in pairs:
        assert s.count(old) == 1, (path, s.count(old), old[:80])
        s = s.replace(old, new)
    assert s != before
    tmp = path + ".tmp"
    io.open(tmp, "w", encoding="utf-8", newline="\n").write(s)
    os.replace(tmp, path)
    print("patched", path)


T = r"backend\app\clone_templates.py"
patch(T, [
    # 1) 第二段文字的中文标签
    ('''PROMPT_INPUT_KEYS = {"prompt", "text", "positive_prompt"}''',
     '''PROMPT_INPUT_KEYS = {"prompt", "text", "positive_prompt"}
# 一台节点上挂着第二段文字时该叫什么。音色克隆必须同时有「要说的话」与「参考音频里
# 说的原话」，两者塞进同一个输入框会把原话冲掉——克隆出来的音色就不像了。
SECONDARY_PROMPT_LABELS = {"ref_text": "参考音频的文本"}'''),

    # 2) 检测：同节点上的第二段文字单独命名，并把当前字面量带进槽位（弹窗要预填）
    ('''            if not isinstance(value, str) or not value.strip():
                continue
            slots.append({"kind": "prompt", "node": nid, "input": key, "label": "完整提示词"})''',
     '''            if not isinstance(value, str) or not value.strip():
                continue
            slot: dict[str, Any] = {"kind": "prompt", "node": nid, "input": key,
                                    "label": "完整提示词", "value": value}
            if nid in prompt_nodes:
                # 同一台节点上的第二段文字不是「另一个提示词」，是另一个用途：
                # 认得出名字，弹窗才配得上一句人话；认不出就退回输入键名，至少不撒谎。
                slot["label"] = (SECONDARY_PROMPT_LABELS.get(key) or key)[:40]
            prompt_nodes.add(nid)
            slots.append(slot)'''),
    ('''    slots: list[dict] = []
    warnings: list[str] = []

    for nid in _ordered_ids(nodes):
        node = nodes[nid]
        class_type = str(node.get("class_type") or "").lower()''',
     '''    slots: list[dict] = []
    warnings: list[str] = []
    prompt_nodes: set[str] = set()

    for nid in _ordered_ids(nodes):
        node = nodes[nid]
        class_type = str(node.get("class_type") or "").lower()'''),

    # 3) 存库时保住 prompt 槽的当前文字
    ('''        if kind == "select":
            options = [x for x in (item.get("options") or []) if isinstance(x, str)]''',
     '''        if kind == "prompt" and isinstance(item.get("value"), str):
            # 弹窗里那第二段文字要有初始值（工作流里现在写的是什么），否则用户面对的是
            # 一个空框，填了反而把参考音频的原话冲成空字符串——节点会当场报错。
            slot["value"] = item["value"][:50000]
        if kind == "select":
            options = [x for x in (item.get("options") or []) if isinstance(x, str)]'''),

    # 4) 注入：按槽位覆盖
    ('''    prompt: str | None = None,
    references: dict[str, str] | None = None,''',
     '''    prompt: str | None = None,
    slot_prompts: dict[str, str] | None = None,
    references: dict[str, str] | None = None,'''),
    ('''    if prompt is not None:
        for slot in slots:
            if slot.get("kind") == "prompt":
                node_inputs(workflow.get(slot["node"])).update({slot["input"]: prompt})''',
     '''    if prompt is not None:
        for slot in slots:
            if slot.get("kind") != "prompt":
                continue
            # 主提示词喂所有提示词位；单独命名的那些（音色克隆的 ref_text）
            # 有自己那一份，用户没填才跟着主提示词走。
            key = slot_key(slot)
            text = (slot_prompts or {}).get(key)
            node_inputs(workflow.get(slot["node"])).update({slot["input"]: text if text is not None else prompt})'''),
])

J = r"backend\app\clone_jobs.py"
patch(J, [
    ('''async def start(''',
     '''async def start('''),
])
