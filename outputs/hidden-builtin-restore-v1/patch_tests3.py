# -*- coding: utf-8 -*-
"""两条测试自己的毛病：断言的字面量对不上话术、is_builtin 只在 public() 里有。"""
import io

BE = "C:/Users/Administrator/Documents/ChatGPT/苏醒图库/backend/tests/test_clone_bundled.py"
t = io.open(BE, encoding="utf-8", newline="").read()
nl = "\r\n" if "\r\n" in t[:4000] else "\n"

pairs = [
    ('assert "改名" in res.json()["detail"]',
     'assert "改个名" in res.json()["detail"]'),
    ('''    after = clone_templates.get_template(int(mine["id"]))
    assert after["bundled_key"] == AUDIO_KEY and after["is_builtin"] is True
    assert clone_bundled.workflow_sha(after["workflow"]) != after["bundled_sha"], "内容仍是用户那份"''',
     '''    after = [r for r in clone_templates.list_templates() if int(r["id"]) == int(mine["id"])][0]
    assert after["bundled_key"] == AUDIO_KEY and after["is_builtin"] is True
    raw = clone_templates.get_template(int(mine["id"]))
    assert clone_bundled.workflow_sha(raw["workflow"]) != raw["bundled_sha"], "内容仍是用户那份"'''),
]
for a, b in pairs:
    a2, b2 = a.replace("\n", nl), b.replace("\n", nl)
    assert t.count(a2) == 1, (a.splitlines()[0][:40], t.count(a2))
    t = t.replace(a2, b2)
io.open(BE, "w", encoding="utf-8", newline="").write(t)
print("fixed assertions")