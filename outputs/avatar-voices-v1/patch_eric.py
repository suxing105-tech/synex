# -*- coding: utf-8 -*-
"""Eric roll3：官方是「活泼的成都男声、略带沙哑的明亮」，两轮都跑成了四十多岁的硬汉大叔，
这里把年龄、胡子和主光写死。"""
import io
import re

p = "gen_avatars.py"
s = io.open(p, encoding="utf-8-sig").read()
start = s.index('    "Eric": "')
end = s.index('",\n', start + 12) + 3
new = ('    "Eric": "一位三十岁出头的中国男性，短而硬的头发剃出利落鬓角，脸刮得干干净净、一根胡子都没有，'
       '皮肤紧致、面色红润透亮；他咧开嘴笑出声，露出一排牙齿，眼角笑纹堆起来，眉毛一挑，眼神机灵热络，'
       '像成都茶馆里最会讲段子的那一位，热闹、亲切、带点痞气，绝不冷峻；钢青色棒球夹克领子立起、里面一件浅色T恤，'
       '背景是几道干净的斜向几何光带，冷钢青环境光配明亮的暖色主光把整张脸照亮，硬朗里全是幽默感。'
       '强调色钢青 #5B7FA6。",\n')
s = s[:start] + new + s[end:]
io.open(p, "w", encoding="utf-8").write(s)
print("Eric prompt rewritten")
