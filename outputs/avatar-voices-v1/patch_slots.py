# -*- coding: utf-8 -*-
import io
p = "gen_avatars.py"
s = io.open(p, encoding="utf-8-sig").read()
old = """    prev_m, prev_c = "1", "2"
    for idx, (name, strength) in enumerate(LORAS):
        nid = str(10 + idx)
        g[nid] = {"class_type": "LoraLoader", "inputs": {"model": [prev_m, 0], "clip": [prev_c, 1],
                  "lora_name": name, "strength_model": strength, "strength_clip": strength}}
        prev_m, prev_c = nid, nid
    g["20"]["inputs"]["clip"] = [prev_c, 1]"""
new = """    prev_m, prev_c, prev_c_slot = "1", "2", 0
    for idx, (name, strength) in enumerate(LORAS):
        nid = str(10 + idx)
        g[nid] = {"class_type": "LoraLoader", "inputs": {"model": [prev_m, 0], "clip": [prev_c, prev_c_slot],
                  "lora_name": name, "strength_model": strength, "strength_clip": strength}}
        prev_m, prev_c, prev_c_slot = nid, nid, 1
    g["20"]["inputs"]["clip"] = [prev_c, prev_c_slot]"""
assert old in s, "anchor missing"
io.open(p, "w", encoding="utf-8").write(s.replace(old, new))
print("patched")
