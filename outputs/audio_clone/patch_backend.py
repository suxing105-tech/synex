# -*- coding: utf-8 -*-
"""Teach the clone engine the audio family (media_kind=audio, ComfyUI "audio" output bucket)."""
import io

def patch(path, pairs):
    text = io.open(path, encoding="utf-8").read()
    for old, new in pairs:
        assert text.count(old) == 1, (path, old[:70], text.count(old))
        text = text.replace(old, new, 1)
    io.open(path, "w", encoding="utf-8", newline="\n").write(text)
    print("patched", path, len(pairs), "edits")

T = "backend/app/clone_templates.py"
patch(T, [
    (
        'MEDIA_KINDS = ("image", "video")',
        'MEDIA_KINDS = ("image", "video", "audio")',
    ),
    (
        'VIDEO_MODEL_HINTS = ("referencetovideo", "imagetovideo", "texttovideo", "frametovideo")',
        'VIDEO_MODEL_HINTS = ("referencetovideo", "imagetovideo", "texttovideo", "frametovideo")\n'
        '# \u97f3\u9891\u5de5\u4f5c\u6d41\uff08Qwen3-TTS \u90a3\u4e00\u7c7b\uff09\u6700\u540e\u843d\u5728 SaveAudio*/PreviewAudio \u4e0a\u3002\n'
        '# \u5224\u5b9a\u987a\u5e8f\u5f88\u91cd\u8981\uff1a\u5148\u770b\u89c6\u9891\u518d\u770b\u97f3\u9891\u2014\u2014\u5e26\u97f3\u8f68\u7684\u89c6\u9891\u5de5\u4f5c\u6d41\u91cc\u5f80\u5f80\u4e5f\u6709\u97f3\u9891\u8282\u70b9\u3002\n'
        'AUDIO_OUTPUT_HINTS = ("saveaudio", "previewaudio", "audiocombine", "createaudio", "audiocache")\n'
        'AUDIO_MODE_LABELS = {"text": "\u6587\u672c\u914d\u97f3", "single": "\u53c2\u8003\u97f3\u8272\u514b\u9686", "multi": "\u591a\u53c2\u8003\u97f3\u9891"}',
    ),
    (
        'def detect_media_kind(nodes: dict) -> str:\n'
        '    """\u8fd9\u4efd\u5de5\u4f5c\u6d41\u51fa\u7684\u662f\u56fe\u8fd8\u662f\u89c6\u9891\u3002\u5148\u770b\u4ea7\u51fa\u7aef\uff0c\u518d\u515c\u5e95\u770b\u6a21\u578b\u7aef\u3002"""\n'
        '    classes = [str(node.get("class_type") or "").lower()\n'
        '               for node in (nodes or {}).values() if isinstance(node, dict)]\n'
        '    for hints in (VIDEO_OUTPUT_HINTS, VIDEO_MODEL_HINTS):\n'
        '        for hint in hints:\n'
        '            if any(hint in c for c in classes):\n'
        '                return "video"\n'
        '    return "image"',
        'def detect_media_kind(nodes: dict) -> str:\n'
        '    """\u8fd9\u4efd\u5de5\u4f5c\u6d41\u51fa\u7684\u662f\u56fe\u3001\u89c6\u9891\u8fd8\u662f\u97f3\u9891\u3002\u5148\u770b\u4ea7\u51fa\u7aef\uff0c\u518d\u515c\u5e95\u770b\u6a21\u578b\u7aef\u3002\n'
        '\n'
        '    \u89c6\u9891\u6392\u5728\u97f3\u9891\u524d\u9762\uff1aH3 \u90a3\u6837\u7684\u89c6\u9891\u5de5\u4f5c\u6d41\u540c\u65f6\u5e26 LoadAudio/\u97f3\u8f68\u5904\u7406\uff0c\n'
        '    \u5148\u5224\u97f3\u9891\u4f1a\u628a\u4e00\u6761\u51fa\u7247\u7684\u5de5\u4f5c\u6d41\u9519\u5f52\u5230\u97f3\u9891\u65cf\u3002\n'
        '    """\n'
        '    classes = [str(node.get("class_type") or "").lower()\n'
        '               for node in (nodes or {}).values() if isinstance(node, dict)]\n'
        '    for hints in (VIDEO_OUTPUT_HINTS, VIDEO_MODEL_HINTS):\n'
        '        for hint in hints:\n'
        '            if any(hint in c for c in classes):\n'
        '                return "video"\n'
        '    for hint in AUDIO_OUTPUT_HINTS:\n'
        '        if any(hint in c for c in classes):\n'
        '            return "audio"\n'
        '    return "image"',
    ),
    (
        'def is_video(template: dict) -> bool:\n'
        '    return str((template or {}).get("media_kind") or "image") == "video"',
        'def media_kind_of_template(template: dict | None) -> str:\n'
        '    """\u6a21\u677f\u5c5e\u54ea\u4e00\u65cf\uff1b\u5e93\u91cc\u65e7\u884c\u6ca1\u8fd9\u4e2a\u5b57\u6bb5\u65f6\u4e00\u5f8b\u5f53\u56fe\u7247\uff08\u4e0e\u5386\u53f2\u884c\u4e3a\u4e00\u81f4\uff09\u3002"""\n'
        '    kind = str((template or {}).get("media_kind") or "image")\n'
        '    return kind if kind in MEDIA_KINDS else "image"\n'
        '\n'
        '\n'
        'def is_video(template: dict) -> bool:\n'
        '    return media_kind_of_template(template) == "video"\n'
        '\n'
        '\n'
        'def is_audio(template: dict) -> bool:\n'
        '    return media_kind_of_template(template) == "audio"',
    ),
    (
        '    return VIDEO_MODE_LABELS if is_video(template) else MODE_LABELS',
        '    kind = media_kind_of_template(template)\n'
        '    if kind == "video":\n'
        '        return VIDEO_MODE_LABELS\n'
        '    if kind == "audio":\n'
        '        return AUDIO_MODE_LABELS\n'
        '    return MODE_LABELS',
    ),
    (
        'def reference_noun(template: dict | None) -> str:\n'
        '    if is_video(template):\n'
        '        return "\u53c2\u8003\u7d20\u6750"\n'
        '    return "\u53c2\u8003\u56fe"',
        'def reference_noun(template: dict | None) -> str:\n'
        '    """\u5bf9\u5916\u53d9\u8ff0\u53c2\u8003\u7d20\u6750\u65f6\u7528\u54ea\u4e2a\u8bcd\uff1a\u5728\u97f3\u9891\u5de5\u4f5c\u6d41\u91cc\u8bf4\u300c\u53c2\u8003\u56fe\u300d\u662f\u9a97\u4eba\u3002"""\n'
        '    kind = media_kind_of_template(template)\n'
        '    if kind == "video":\n'
        '        return "\u53c2\u8003\u7d20\u6750"\n'
        '    if kind == "audio":\n'
        '        return "\u53c2\u8003\u97f3\u9891"\n'
        '    return "\u53c2\u8003\u56fe"',
    ),
    (
        '    if str(detected.get("media_kind") or "image") != "video":\n'
        '        return []\n'
        '    slots = detected.get("slots") or []\n'
        '    return [\n'
        '        f"\u8fd9\u4efd\u5de5\u4f5c\u6d41\u6ca1\u63a5{stem}\u53c2\u8003\u4f4d\uff1a\u5728 ComfyUI \u91cc\u52a0\u4e00\u53f0 {class_name}\uff0c\u8fde\u5230 "\n'
        '        f"ref_{kind}s \u7684\u8f93\u5165\uff0c\u518d\u91cd\u65b0\u5bfc\u5165\u4e00\u6b21\u5c31\u80fd\u5728\u5f39\u7a97\u91cc\u653e{stem}\u3002"\n'
        '        for kind, (stem, class_name) in MISSING_FAMILY_HINTS.items()\n'
        '        if not any(str(s.get("kind")) == kind for s in slots)\n'
        '    ]',
        '    kind = str(detected.get("media_kind") or "image")\n'
        '    slots = detected.get("slots") or []\n'
        '    if kind == "audio":\n'
        '        # \u97f3\u9891\u540c\u6b3e\u9760\u7684\u5c31\u662f\u90a3\u6bb5\u53c2\u8003\u97f3\u8272\uff0c\u6ca1\u6709 LoadAudio \u5c31\u6ca1\u6709\u300c\u540c\u6b3e\u300d\u53ef\u8a00\u3002\n'
        '        if any(str(s.get("kind")) == "audio" for s in slots):\n'
        '            return []\n'
        '        return ["\u8fd9\u4efd\u5de5\u4f5c\u6d41\u6ca1\u63a5\u97f3\u9891\u53c2\u8003\u4f4d\uff1a\u5728 ComfyUI \u91cc\u52a0\u4e00\u53f0 LoadAudio\uff0c"\n'
        '                "\u8fde\u5230\u58f0\u97f3\u514b\u9686\u8282\u70b9\u7684\u53c2\u8003\u97f3\u9891\u8f93\u5165\uff0c\u518d\u91cd\u65b0\u5bfc\u5165\u4e00\u6b21\uff0c"\n'
        '                "\u7136\u540e\u624d\u80fd\u5728\u5f39\u7a97\u91cc\u6362\u97f3\u8272\u3002"]\n'
        '    if kind != "video":\n'
        '        return []\n'
        '    return [\n'
        '        f"\u8fd9\u4efd\u5de5\u4f5c\u6d41\u6ca1\u63a5{stem}\u53c2\u8003\u4f4d\uff1a\u5728 ComfyUI \u91cc\u52a0\u4e00\u53f0 {class_name}\uff0c\u8fde\u5230 "\n'
        '        f"ref_{kind}s \u7684\u8f93\u5165\uff0c\u518d\u91cd\u65b0\u5bfc\u5165\u4e00\u6b21\u5c31\u80fd\u5728\u5f39\u7a97\u91cc\u653e{stem}\u3002"\n'
        '        for kind, (stem, class_name) in MISSING_FAMILY_HINTS.items()\n'
        '        if not any(str(s.get("kind")) == kind for s in slots)\n'
        '    ]',
    ),
])

J = "backend/app/clone_jobs.py"
patch(J, [
    (
        '# VHS_VideoCombine \u56de\u7684\u662f gifs\uff0cSaveImage \u56de\u7684\u662f images\uff0c\u4e09\u7c7b\u90fd\u8bfb\u4e00\u904d\u518d\u6309\u6587\u4ef6\u53bb\u91cd\u3002\n'
        'OUTPUT_HISTORY_KEYS = ("images", "gifs", "videos", "audios")',
        '# VHS_VideoCombine \u56de\u7684\u662f gifs\uff0cSaveImage \u56de\u7684\u662f images\uff0c\u4e09\u7c7b\u90fd\u8bfb\u4e00\u904d\u518d\u6309\u6587\u4ef6\u53bb\u91cd\u3002\n'
        '# \u5355\u6570 audio \u4e5f\u5f97\u8bfb\uff1aSaveAudioAdvanced / SaveAudio / PreviewAudio \u7684\u5386\u53f2\u91cc\u7528\u7684\u662f\n'
        '# {"audio": [...]}uff08\u771f\u673a\u5b9e\u6d4b\uff09\uff0c\u53ea\u627e audios \u7684\u8bdd\u97f3\u9891\u8dd1\u5b8c\u53ea\u4f1a\u5f97\u5230\u4e00\u53e5\u300c\u6ca1\u4ea4\u56de\u4ea7\u7269\u300d\u3002\n'
        'OUTPUT_HISTORY_KEYS = ("images", "gifs", "videos", "audios", "audio")',
    ),
    (
        '            raise ValueError("ComfyUI \u8dd1\u5b8c\u4e86\u4f46\u6ca1\u4ea4\u56de\u4ea7\u7269\uff0c\u68c0\u67e5\u8fd9\u4efd\u5de5\u4f5c\u6d41\u91cc\u6709\u6ca1\u6709\u4fdd\u5b58\u56fe\u50cf/\u89c6\u9891\u7684\u8282\u70b9\u3002")\n'
        '        counter = "\u6761" if job.get("media_kind") == "video" else "\u5f20"\n'
        '        noun = "\u4ea7\u7269" if job.get("media_kind") == "video" else "\u56fe"',
        '            raise ValueError("ComfyUI \u8dd1\u5b8c\u4e86\u4f46\u6ca1\u4ea4\u56de\u4ea7\u7269\uff0c\u68c0\u67e5\u8fd9\u4efd\u5de5\u4f5c\u6d41\u91cc\u6709\u6ca1\u6709\u4fdd\u5b58\u56fe\u50cf/\u89c6\u9891/\u97f3\u9891\u7684\u8282\u70b9\u3002")\n'
        '        kind = str(job.get("media_kind") or "")\n'
        '        counter = "\u6761" if kind in ("video", "audio") else "\u5f20"\n'
        '        noun = "\u4ea7\u7269" if kind in ("video", "audio") else "\u56fe"',
    ),
])
