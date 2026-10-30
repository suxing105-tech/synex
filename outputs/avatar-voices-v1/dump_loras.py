# -*- coding: utf-8 -*-
import json
from PIL import Image
im = Image.open(r"F:/常用/人物/Vivian.png")
g = json.loads(im.info["prompt"])
order = ["351", "353", "354", "355"]
for nid in order:
    n = g[nid]
    print("== node", nid, n["class_type"])
    print("   text-widget:", json.dumps(n["inputs"].get("text"), ensure_ascii=False)[:400])
    loras = n["inputs"].get("loras")
    if isinstance(loras, list):
        for e in loras:
            if isinstance(e, dict):
                print("   ", "ACTIVE" if e.get("active") else "      ", e.get("name"), "str=", e.get("strength"), "clip=", e.get("clipStrength"))
    else:
        print("   loras ->", json.dumps(loras, ensure_ascii=False)[:200])
print()
print("== other inputs of 351:", {k: v for k, v in g["351"]["inputs"].items() if k not in ("loras", "__lm_autocomplete_meta_text", "text")})
