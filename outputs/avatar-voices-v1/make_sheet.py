# -*- coding: utf-8 -*-
"""出两张复核图：新九张总览 + 新旧在 48px 圆形里的实际观感。"""
import glob
import os
from PIL import Image, ImageDraw, ImageFilter

ORDER = ["Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee"]
OLD = {n: r"F:/常用/人物/%s.png" % n.replace("_", " ") for n in ORDER}
NEW = {n: glob.glob(os.path.join("candidates", "%s_%s_roll1_*.png" % (n, n)))[0] for n in ORDER}
LABELS = {"Vivian": "Vivian", "Serena": "Serena", "Uncle_Fu": "Uncle Fu", "Dylan": "Dylan", "Eric": "Eric",
          "Ryan": "Ryan", "Aiden": "Aiden", "Ono_Anna": "Ono Anna", "Sohee": "Sohee"}


def centre_crop(im, size):
    im = im.convert("RGB")
    s = min(im.size)
    left = (im.width - s) // 2
    top = int(im.height * 0.055)          # 头顶留白，往下取脸
    top = min(max(0, top), im.height - s)
    return im.crop((left, top, left + s, top + s)).resize((size, size), Image.LANCZOS)


def circle(im, size, bg=(32, 32, 36)):
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(0.6))
    tile.paste(im.resize((size, size), Image.LANCZOS), (0, 0), mask)
    out = Image.new("RGB", (size, size), bg)
    out.paste(tile, (0, 0), tile)
    return out


# 总览
cell, pad, cols = 420, 26, 3
rows = 3
sheet = Image.new("RGB", (cols * cell, rows * (cell + pad)), (30, 30, 34))
d = ImageDraw.Draw(sheet)
for i, name in enumerate(ORDER):
    im = centre_crop(Image.open(NEW[name]), cell)
    x, y = (i % cols) * cell, (i // cols) * (cell + pad)
    sheet.paste(im, (x, y))
    d.text((x + 10, y + cell + 7), LABELS[name], fill=(245, 245, 245))
sheet.save("new_set_roll1.png")

# 新旧 48px 圆形对照：左列 = 原图，右列 = 新图（另附 25% 放大到 96px 的同一张，方便看细节）
sw, sh, gap, head = 48, 48, 18, 30
strip = Image.new("RGB", (len(ORDER) * (sw * 2 + gap + 10) + 90, 2 * sh + head + 40), (26, 26, 30))
d2 = ImageDraw.Draw(strip)
d2.text((10, 8), "48px circle   old / new", fill=(200, 200, 200))
for i, name in enumerate(ORDER):
    x = 20 + i * (sw * 2 + gap + 14)
    d2.text((x, head - 16), LABELS[name][:8], fill=(190, 190, 190))
    strip.paste(circle(centre_crop(Image.open(OLD[name]), sw * 3), sw), (x, head))
    strip.paste(circle(centre_crop(Image.open(NEW[name]), sw * 3), sw), (x + sw + gap, head + 6))
    strip.paste(circle(centre_crop(Image.open(NEW[name]), 96), 96), (x - 12, head + sh + 22))
strip.save("compare_48px.png")
print("saved new_set_roll1.png compare_48px.png")
