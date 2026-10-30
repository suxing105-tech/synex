# -*- coding: utf-8 -*-
import json
from PIL import Image
g = json.loads(Image.open(r"F:/常用/人物/Vivian.png").info["prompt"])
for nid in ["250", "282", "290", "292", "301", "302", "303", "312", "315", "318", "325", "364", "365", "236", "242", "243"]:
    print(nid, g[nid]["class_type"], json.dumps(g[nid]["inputs"], ensure_ascii=False)[:500])
