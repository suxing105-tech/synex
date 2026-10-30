# -*- coding: utf-8 -*-
"""Feed.svelte：音频卡量词改成「一段」+ 角标注释更新；顺带对齐测试。"""
import io, os
P = r"frontend\src\components\Feed.svelte"
s = io.open(P, encoding="utf-8").read()
orig = s

def rep(old, new, n=1):
    global s
    assert s.count(old) == n, (s.count(old), old[:80])
    s = s.replace(old, new)

rep('aria-label={`用同款工作流再生成${it.kind === "image" ? "一张" : "一条"}`}',
    'aria-label={`用同款工作流再生成${it.kind === "image" ? "一张" : it.kind === "audio" ? "一段" : "一条"}`}')

rep('''                    <!-- 「一键同款」角标：几何与音频播放角标完全一致（同尺寸、同右下角、在页脚高度里同垂直居中），
                         两种卡在右下角的控件位置就是同一个，不用重新学。卡片本身是 <button>，所以这里
                         只能再用 role="button" 的 div，并且按下的事件都要拦，否则点图标会变成选中/拖动那张卡。
                         图片卡和视频卡挂同一颗：点开的是同一个弹窗，只是默认换成另一族当前工作流。 -->''',
    '''                    <!-- 「一键同款」角标：图片、视频、音频三类卡共用同一颗，右下角位置与尺寸只有一套规矩。
                         音频卡原来右下角那颗播放键挪进了画面左下角（右下角统一给一键同款），单击/双击卡片照播。
                         卡片本身是 <button>，所以这里只能再用 role="button" 的 div，并且按下的事件都要拦，
                         否则点图标会变成选中/拖动那张卡。点开的是同一个弹窗，只是默认换成那一族的当前工作流。 -->''')

assert s != orig
tmp = P + ".tmp"
io.open(tmp, "w", encoding="utf-8", newline="\n").write(s)
os.replace(tmp, P)
print("ok")
