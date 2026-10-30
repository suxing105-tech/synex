# -*- coding: utf-8 -*-
"""附框下面补一句人话：这一格到底填什么，填错会怎样。"""
import io, os

def patch(path, pairs):
    s = io.open(path, encoding="utf-8").read()
    before = s
    for old, new in pairs:
        assert s.count(old) == 1, (path, s.count(old), old[:70])
        s = s.replace(old, new)
    assert s != before
    tmp = path + ".tmp"
    io.open(tmp, "w", encoding="utf-8", newline="\n").write(s)
    os.replace(tmp, path)
    print("patched", path)

M = r"frontend\src\components\CloneModal.svelte"
patch(M, [
    ("""                  oninput={(e) => setPromptGroup(group, (e.target as HTMLTextAreaElement).value)}></textarea>
              {/each}""",
     """                  oninput={(e) => setPromptGroup(group, (e.target as HTMLTextAreaElement).value)}></textarea>
                <p class="cm-note">这一格填的是参考音频里说的那句原话，不是台词；填错了音色会明显跑偏。</p>
              {/each}"""),
])

B = r"outputs\audio_clone\make_bundle.py"
patch(B, [
    # detect_slots 现在自己认得出 ref_text，不再手工补槽
    ("""    language = next((c for c in detected["candidates"]
                     if c["node"] == "45" and c["input"] == "language"), None)
    ref_text_prompt = {"kind": "prompt", "node": "45", "input": "ref_text",
                       "label": "\u53c2\u8003\u97f3\u9891\u7684\u6587\u672c"}
    slots = list(detected["slots"])
    slots.append(ref_text_prompt)
    if language:""",
     """    language = next((c for c in detected["candidates"]
                     if c["node"] == "45" and c["input"] == "language"), None)
    # ref_text 由 detect_slots 自己认（SECONDARY_PROMPT_KEYS），不再手工补一条：
    # 手工那条没有 value，弹窗预填不了，用户一改台词就把原话冲掉。
    slots = list(detected["slots"])
    if language:"""),
    # notes 里那句「同取弹窗里那段话」已经不成立
    ("""                  "ref_text \u4e0e text \u540c\u53d6\u5f39\u7a97\u91cc\u90a3\u6bb5\u8bdd\uff08\u8282\u70b9\u8981\u6c42\u4e24\u8005\u5fc5\u586b\uff09\u3002"),""",
     """                  "ref_text\uff08\u53c2\u8003\u97f3\u9891\u91cc\u8bf4\u7684\u539f\u8bdd\uff09\u5728\u5f39\u7a97\u91cc\u5355\u72ec\u4e00\u683c\uff1a\u5b83\u51b3\u5b9a\u514b\u9686\u5f97\u50cf\u4e0d\u50cf\uff0c"
                  "\u548c\u53f0\u8bcd\u6df7\u7528\u4f1a\u660e\u663e\u8dd1\u504f\u3002"),"""),
])
print("ALL OK")
