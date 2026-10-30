# -*- coding: utf-8 -*-
"""roll1 vs roll2 对照 + 两张各自的 48px 圆形预览。"""
import glob
import os
from PIL import Image, ImageDraw, ImageFilter

ORDER = ["Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee"]
LABELS = {"Vivian": "Vivian", "Serena": "Serena", "Uncle_Fu": "Uncle Fu", "Dylan": "Dylan", "Eric": "Eric",
          "Ryan": "Ryan", "Aiden": "Aiden", "Ono_Anna": "Ono Anna", "Sohee": "Sohee"}


def src(name, tag):
    return sorted(glob.glob(os.path.join("candidates", "%s_%s_%s_*.png" % (name, name, tag))))[-1]


def crop(im, size):
    im = im.convert("RGB")
    s = min(im.size)
    left = (im.width - s) // 2
    top = min(max(0, int(im.height * 0.055)), im.height - s)
    return im.crop((left, top, left + s, top + s)).resize((size, size), Image.LANCZOS)


def circ(im, size, bg=(30, 30, 34)):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    out = Image.new("RGB", (size, size), bg)
    out.paste(im.resize((size, size), Image.LANCZOS), (0, 0), mask)
    return out


cell, pad, cols, gap = 200, 30, 3, 8
rows = 3
sheet = Image.new("RGB", (cols * (cell * 2 + gap) + 40, rows * (cell + pad) + 20), (28, 28, 32))
d = ImageDraw.Draw(sheet)
for i, name in enumerate(ORDER):
    x0 = 14 + (i % cols) * (cell * 2 + gap + 20)
    y0 = 10 + (i // cols) * (cell + pad)
    d.text((x0 + 2, y0 + cell + 6), "%s  ①roll1  ②roll2" % LABELS[name], fill=(240, 240, 240))
    for k, tag in enumerate(["roll1", "roll2"]):
        sheet.paste(crop(Image.open(src(name, tag)), cell), (x0 + k * (cell + gap), y0))
sheet.save("compare_roll12.png")

# 48px 圆：上排 roll1、下排 roll2
w = len(ORDER) * 66 + 20
strip = Image.new("RGB", (w, 2 * 66 + 40), (26, 26, 30))
d2 = ImageDraw.Draw(strip)
d2.text((8, 4), "48px: top=roll1  bottom=roll2", fill=(205, 205, 205))
for i, name in enumerate(ORDER):
    x = 14 + i * 66
    d2.text((x, 18), LABELS[name][:7], fill=(175, 175, 175))
    strip.paste(circ(crop(Image.open(src(name, "roll1")), 144), 48), (x, 30))
    strip.paste(circ(crop(Image.open(src(name, "roll2")), 144), 48), (x, 96))
strip.save("compare_48px_roll12.png")
print("ok")
