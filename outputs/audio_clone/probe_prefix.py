# -*- coding: utf-8 -*-
"""Does SaveAudioAdvanced accept a non-ASCII filename_prefix? (bundled template naming)"""
import asyncio, json, sys, time
sys.path.insert(0, "backend")
from app.comfyui_client import ComfyUIClient, random_seed

SRC = r"outputs/bundled/audio_wf_source.json"
TEXT = "\u4f60\u597d\uff0c\u8fd9\u662f\u4e00\u6b21\u81ea\u52a8\u5316\u63a2\u6d4b\u3002"


async def main():
    async with ComfyUIClient("http://127.0.0.1:8188", timeout=120.0) as c:
        wf = json.load(open(SRC, encoding="utf-8"))
        g = {k: json.loads(json.dumps(v)) for k, v in wf.items() if k in {"41", "44", "45", "46"}}
        g["45"]["inputs"].update({"text": TEXT, "ref_text": TEXT, "language": "Auto", "seed": random_seed()})
        g["46"]["inputs"]["filename_prefix"] = "audio/\u95ea\u5bfb\u97f3\u9891\u514b\u9686"
        pid = await c.queue(g, "seekx-audio-probe", {k: k for k in g})
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            await asyncio.sleep(3)
            entry = (await c.history(pid)).get(pid)
            if not entry:
                continue
            st = entry.get("status") or {}
            print("completed=", st.get("completed"), "outputs=", json.dumps(entry.get("outputs"), ensure_ascii=False))
            return


asyncio.run(main())
