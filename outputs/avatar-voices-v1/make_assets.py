# -*- coding: utf-8 -*-
"""把选定的头像压成应用要用的 256px WebP，直接落到 frontend/public/voices/。

裁法：正方形居中、往上留一点取脸（原图头顶有留白），再缩到 256。
圆形遮罩不在图里做——UI 用 CSS border-radius，图保持方形，将来换方形头像位也不用重出图。
"""
import glob
import io
import json
import os
import sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = r"C:/Users/Administrator/Documents/ChatGPT/苏醒图库/frontend/public/voices"
ORDER = ["Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee"]
FILES = {"Vivian": "vivian", "Serena": "serena", "Uncle_Fu": "uncle-fu", "Dylan": "dylan", "Eric": "eric",
         "Ryan": "ryan", "Aiden": "aiden", "Ono_Anna": "ono-anna", "Sohee": "sohee"}
# 每个人用哪一轮的图：先读 picks.json（复核后写死），没有就退回最新的 roll
DEFAULT_TAG = os.environ.get("AVATAR_TAG", "roll1")


def source(name):
    picks = os.path.join(HERE, "picks.json")
    if os.path.exists(picks):
        table = json.load(io.open(picks, encoding="utf-8"))
        if table.get(name):
            hit = table[name]
            if not os.path.isabs(hit):
                hit = os.path.join(HERE, hit)
            if os.path.exists(hit):
                return hit
    cands = sorted(glob.glob(os.path.join(HERE, "candidates", "%s_*_%s_*.png" % (name, os.environ.get("AVATAR_TAG", DEFAULT_TAG)))))
    if not cands:
        raise SystemExit("找不到 %s 的候选图（tag=%s）" % (name, DEFAULT_TAG))
    return cands[-1]


def main():
    os.makedirs(OUT, exist_ok=True)
    tag = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("AVATAR_TAG", "roll1")
    os.environ["AVATAR_TAG"] = tag
    for name in ORDER:
        src = source(name)
        im = Image.open(src).convert("RGB")
        side = min(im.size)
        top = min(max(0, int(im.height * 0.055)), im.height - side)
        left = (im.width - side) // 2
        im = im.crop((left, top, left + side, top + side)).resize((256, 256), Image.LANCZOS)
        dst = os.path.join(OUT, FILES[name] + ".webp")
        im.save(dst, "WEBP", quality=88, method=6)
        print("%-9s %s -> %s (%d KB)" % (name, os.path.basename(src), os.path.basename(dst), os.path.getsize(dst) // 1024))


if __name__ == "__main__":
    main()
