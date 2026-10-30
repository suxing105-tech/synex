# -*- coding: utf-8 -*-
"""Probe the Qwen3-TTS audio workflow against the local ComfyUI and (with --run) execute
the trimmed single-branch clone graph, dumping the raw history outputs."""
import asyncio, json, sys, time
sys.path.insert(0, "backend")
from app.comfyui_client import ComfyUIError, ComfyUIClient, random_seed

SRC = r"outputs/bundled/audio_wf_source.json"
KEEP = {"41", "44", "45", "46"}
BASE = "http://127.0.0.1:8188"
TEST_TEXT = "\u4f60\u597d\uff0c\u8fd9\u662f\u4e00\u6b21\u81ea\u52a8\u5316\u63a2\u6d4b\u3002"


def trimmed():
    wf = json.load(open(SRC, encoding="utf-8"))
    graph = {k: v for k, v in wf.items() if k in KEEP}
    graph["45"]["inputs"]["text"] = TEST_TEXT
    graph["45"]["inputs"]["ref_text"] = TEST_TEXT
    graph["45"]["inputs"]["seed"] = random_seed()
    graph["46"]["inputs"]["filename_prefix"] = "audio/seekx-audio-probe"
    return graph


async def main(run: bool) -> int:
    async with ComfyUIClient(BASE, timeout=120.0) as c:
        if not await c.probe():
            print("COMFY_DOWN", BASE)
            return 1
        wf = json.load(open(SRC, encoding="utf-8"))
        classes = sorted({v["class_type"] for v in wf.values()})
        info = await c.object_info(classes)
        print("CLASSES_MISSING:", [x for x in classes if x not in info])
        for cls in classes:
            spec = info.get(cls) or {}
            req = list((spec.get("input") or {}).get("required", {}).keys())
            opt = list((spec.get("input") or {}).get("optional", {}).keys())
            print(f"  {cls}: required={req} optional={opt}")
        la = ((info.get("LoadAudio") or {}).get("input") or {}).get("required", {})
        opts = la.get("audio") or []
        names = opts[0] if opts and isinstance(opts[0], list) else []
        print("LOADAUDIO_COUNT:", len(names))
        print("LOADAUDIO_HAS_SOPHIE:", any("SOPHIE" in str(n).upper() for n in names))
        if not run:
            return 0
        graph = trimmed()
        print("GRAPH_NODES:", sorted(graph, key=int))
        try:
            pid = await c.queue(graph, "seekx-audio-probe", {k: k for k in graph})
        except ComfyUIError as exc:
            print("QUEUE_ERROR:", str(exc)[:800])
            return 2
        print("PROMPT_ID:", pid)
        deadline = time.monotonic() + 900
        while time.monotonic() < deadline:
            await asyncio.sleep(3)
            hist = await c.history(pid)
            entry = (hist or {}).get(pid)
            if not entry:
                continue
            print("STATUS:", json.dumps(entry.get("status"), ensure_ascii=False)[:400])
            print("OUTPUTS_RAW:", json.dumps(entry.get("outputs"), ensure_ascii=False)[:1200])
            return 0 if (entry.get("status") or {}).get("completed") else 3
        print("TIMEOUT waiting for", pid)
        await c.interrupt()
        return 4


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main("--run" in sys.argv)))
