# -*- coding: utf-8 -*-
"""真机核对：ComfyUI 收到的那条 Qwen3VoiceClone，台词与原话是不是两段不同的话。"""
import json, urllib.request

with urllib.request.urlopen("http://127.0.0.1:8188/history?max_items=6", timeout=30) as r:
    history = json.loads(r.read().decode("utf-8"))
found = 0
for pid, item in history.items():
    nodes = next((x for x in (item.get("prompt") or []) if isinstance(x, dict)), {})
    for nid, node in nodes.items():
        if node.get("class_type") != "Qwen3VoiceClone":
            continue
        inputs = node.get("inputs", {})
        print(pid[:8], nid, "text     =", inputs.get("text"))
        print("        ", " " * 8, "ref_text =", inputs.get("ref_text"))
        print("        ", " " * 8, "language =", inputs.get("language"), "| ref_audio =", inputs.get("ref_audio"))
        found += 1
print("Qwen3VoiceClone runs in history:", found)
