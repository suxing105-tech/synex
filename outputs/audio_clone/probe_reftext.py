# -*- coding: utf-8 -*-
"""Does Qwen3VoiceClone accept an empty ref_text? (decides how the clone template fills it)"""
import asyncio, json, sys, time
sys.path.insert(0, "backend")
from app.comfyui_client import ComfyUIClient, random_seed

SRC = r"outputs/bundled/audio_wf_source.json"
KEEP = {"41", "44", "45", "46"}
TEXT = "\u4f60\u597d\uff0c\u8fd9\u662f\u4e00\u6b21\u81ea\u52a8\u5316\u63a2\u6d4b\u3002"


async def one(client, ref_text, prefix):
    wf = json.load(open(SRC, encoding="utf-8"))
    g = {k: json.loads(json.dumps(v)) for k, v in wf.items() if k in KEEP}
    g["45"]["inputs"]["text"] = TEXT
    g["45"]["inputs"]["ref_text"] = ref_text
    g["45"]["inputs"]["language"] = "Auto"
    g["45"]["inputs"]["seed"] = random_seed()
    g["46"]["inputs"]["filename_prefix"] = prefix
    pid = await client.queue(g, "seekx-audio-probe", {k: k for k in g})
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        await asyncio.sleep(3)
        entry = (await client.history(pid)).get(pid)
        if not entry:
            continue
        st = entry.get("status") or {}
        return st, entry.get("outputs")
    return {"timeout": True}, None


async def main():
    async with ComfyUIClient("http://127.0.0.1:8188", timeout=120.0) as c:
        for ref_text, prefix in (("", "audio/probe-refempty"), (TEXT, "audio/probe-reffull")):
            st, out = await one(c, ref_text, prefix)
            print("REF_TEXT_EMPTY" if ref_text == "" else "REF_TEXT_SAME",
                  "completed=", st.get("completed"), "status_str=", st.get("status_str"),
                  "outputs=", json.dumps(out, ensure_ascii=False)[:300])
            if not st.get("completed"):
                msgs = [m for m in (st.get("messages") or []) if m and m[0] == "execution_error"]
                print("  ERROR:", json.dumps(msgs, ensure_ascii=False)[:600])


asyncio.run(main())
