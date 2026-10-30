# -*- coding: utf-8 -*-
import io
p = r"C:/Users/Administrator/Documents/ChatGPT/苏醒图库/README.md"
s = io.open(p, encoding="utf-8").read()
anchor = "- **重开「同款」不用重新打字**"
assert s.count(anchor) == 1
bullet = ("- **「指定音色」里那九个音色各有一张脸**：参数面板的音色格不再是九颗圆点，而是 Qwen3-TTS 自带那九个人物各自的头像"
          "（Vivian / Serena / Uncle Fu / Dylan / Eric / Ryan / Aiden / Ono Anna / Sohee），底部那颗胶囊也跟着带上当前选中的那张脸——"
          "不点开面板就知道现在用的是谁的声音。脸是照**模型给的音色描述**画的（明亮带棱角 / 温和亲切 / 低沉醇厚的长者 / 清亮的北京小伙 / "
          "活泼略带沙哑的成都男声 / 节奏感强的男声 / 阳光美式男声 / 轻快的日语女声 / 富有情绪的韩语女声），不是照名字的词根随便配一张脸；"
          "认不出的选项（用户自己练的音色、语种、比例）一律回落到原来那颗小圆点，绝不乱配。"
          "图在 `frontend/public/voices/`，256px WebP，一张约 15KB\n")
s = s.replace(anchor, bullet + anchor, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("README updated")
