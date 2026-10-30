# -*- coding: utf-8 -*-
import io
p = r"C:/Users/Administrator/Documents/ChatGPT/苏醒图库/frontend/src/__tests__/clone-modal.test.ts"
s = io.open(p, encoding="utf-8").read()
pairs = [
    ("const pillFace = screen.querySelector('.cm-pill-face')", "const pillFace = screen.container.querySelector('.cm-pill-face')"),
    ("expect(screen.querySelector('.cm-pill-face')).toBeNull();", "expect(screen.container.querySelector('.cm-pill-face')).toBeNull();"),
    ("expect((screen.querySelector('.cm-pill-face') as HTMLImageElement)", "expect((screen.container.querySelector('.cm-pill-face') as HTMLImageElement)"),
]
for old, new in pairs:
    assert s.count(old) == 1, old[:50]
    s = s.replace(old, new, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
