# -*- coding: utf-8 -*-
import glob
import io
import json
import os

TAGS = {"Vivian": "roll1", "Serena": "roll2", "Uncle_Fu": "roll2", "Dylan": "roll2", "Eric": "roll3",
        "Ryan": "roll2", "Aiden": "roll2", "Ono_Anna": "roll2", "Sohee": "roll2"}
picks = {}
for name, tag in TAGS.items():
    hits = sorted(glob.glob(os.path.join("candidates", "%s_%s_%s_*.png" % (name, name, tag))))
    assert hits, name
    picks[name] = hits[-1]
io.open("picks.json", "w", encoding="utf-8").write(json.dumps(picks, ensure_ascii=False, indent=2))
print(json.dumps(picks, ensure_ascii=False, indent=2))
