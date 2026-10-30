# -*- coding: utf-8 -*-
"""Build the audio one-click-clone bundle resource from the user's Qwen3-TTS export.

Trim: keep only the VoiceClone branch (41 loader / 44 LoadAudio / 45 clone / 46 save).
The source graph has three output branches (2x PreviewAudio + SaveAudioAdvanced); ComfyUI
runs every output node, so an untrimmed graph would render three clips per click.
"""
import asyncio, copy, io, json, sys

sys.path.insert(0, "backend")
from app.comfyui_client import ComfyUIClient
from app.clone_templates import detect_slots, normalize_slots

SRC = r"outputs/bundled/audio_wf_source.json"
OUT_BUNDLE = r"backend/app/bundled_workflows/qwen3-tts-voice-clone.json"
OUT_USER = r"F:/\u5e38\u7528/\u95ea\u5bfb\u97f3\u9891-\u4e00\u952e\u540c\u6b3e.json".encode().decode("unicode_escape")
KEEP = ("41", "44", "45", "46")
PLACEHOLDER = "\u4f60\u597d\uff0c\u6211\u662f\u4e00\u6761\u58f0\u97f3\u6837\u672c\u3002"
PREFIX = "audio/\u95ea\u5bfb\u97f3\u9891\u514b\u9686"


def trimmed():
    src = json.load(io.open(SRC, encoding="utf-8"))
    graph = {k: copy.deepcopy(src[k]) for k in KEEP}
    clone = graph["45"]["inputs"]
    clone["text"] = PLACEHOLDER
    clone["ref_text"] = PLACEHOLDER
    clone["language"] = "Auto"
    clone["seed"] = 42
    graph["46"]["inputs"]["filename_prefix"] = PREFIX
    graph["45"]["_meta"]["title"] = "Qwen3-TTS \u58f0\u97f3\u514b\u9686"
    return graph


async def main():
    graph = trimmed()
    classes = sorted({v["class_type"] for v in graph.values()})
    async with ComfyUIClient("http://127.0.0.1:8188", timeout=30.0) as client:
        info = await client.object_info(classes)
    detected = detect_slots(graph, info)
    print("AUTO_SLOTS:", json.dumps(detected["slots"], ensure_ascii=False))
    print("MEDIA_KIND:", detected["media_kind"])
    print("CANDIDATES:", json.dumps([(c["node"], c["input"], c["kind"], c.get("options")) for c in detected["candidates"]], ensure_ascii=False)[:900])
    print("MODES:", json.dumps(detected["modes"], ensure_ascii=False)[:300])
    print("CELLS:", json.dumps(detected["reference_cells"], ensure_ascii=False)[:400])
    print("WARNINGS:", json.dumps(detected["warnings"], ensure_ascii=False))

    language = next((c for c in detected["candidates"]
                     if c["node"] == "45" and c["input"] == "language"), None)
    # ref_text 现在由 detect_slots 自己认（SECONDARY_PROMPT_KEYS），不再手工补一条：
    # 手工那条没有 value，弹窗预填不了，用户一改台词就把参考音频的原话冲掉。
    slots = list(detected["slots"])
    if language:
        language = dict(language)
        language["label"] = "\u8bed\u8a00"
        slots.append(language)
    order = {"prompt": 0, "image": 1, "audio": 2, "video": 3, "select": 4, "number": 5}
    slots.sort(key=lambda s: (order.get(str(s.get("kind")), 9), str(s.get("node")), str(s.get("input"))))
    slots = normalize_slots(slots, graph)
    print("FINAL_SLOTS:", json.dumps(slots, ensure_ascii=False))

    payload = {
        "key": "qwen3-tts-voice-clone",
        "label": "\u95ea\u5bfb\u97f3\u9891\u514b\u9686",
        "legacy_labels": ["\u95ea\u5bfb\u97f3\u9891", "\u95ea\u5bfb\u97f3\u9891-\u4e00\u952e\u540c\u6b3e"],
        "media_kind": "audio",
        "notes": ("Qwen3-TTS \u58f0\u97f3\u514b\u9686\uff1a\u53c2\u8003\u97f3\u9891\u51b3\u5b9a\u97f3\u8272\uff0c\u63d0\u793a\u8bcd\u51b3\u5b9a\u5ff5\u4ec0\u4e48\u3002"
                  "\u539f\u5de5\u4f5c\u6d41\u91cc\u7684\u53e6\u4e24\u6761\u5206\u652f\uff08VoiceDesign / CustomVoice\uff09\u5df2\u5254\u9664\u2014\u2014"
                  "ComfyUI \u4f1a\u6267\u884c\u56fe\u91cc\u6240\u6709\u8f93\u51fa\u8282\u70b9\uff0c\u7559\u7740\u70b9\u4e00\u6b21\u4f1a\u8fde\u51fa\u4e09\u6761\u3002"
                  "ref_text\uff08\u53c2\u8003\u97f3\u9891\u91cc\u8bf4\u7684\u539f\u8bdd\uff09\u5728\u5f39\u7a97\u91cc\u5355\u72ec\u4e00\u683c\uff1a\u5b83\u51b3\u5b9a\u514b\u9686\u5f97\u50cf\u4e0d\u50cf\uff0c"
                  "\u548c\u53f0\u8bcd\u6df7\u7528\u4f1a\u660e\u663e\u8dd1\u504f\u3002"),
        "source": "F:/\u5e38\u7528/\u95ea\u5bfb\u97f3\u9891.json\uff08\u4ec5\u4fdd\u7559 VoiceClone \u5206\u652f\uff09",
        "slots": slots,
        "workflow": graph,
    }
    io.open(OUT_BUNDLE, "w", encoding="utf-8").write(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    io.open(OUT_USER, "w", encoding="utf-8").write(json.dumps(graph, ensure_ascii=False, indent=2) + "\n")
    print("WROTE:", OUT_BUNDLE)
    print("WROTE:", OUT_USER)


asyncio.run(main())
