# -*- coding: utf-8 -*-
"""新增音频一族的纯逻辑用例。"""
import io, os
P = r"frontend\src\__tests__\clone-lib.test.ts"
s = io.open(P, encoding="utf-8").read()

def rep(old, new):
    global s
    assert s.count(old) == 1, old[:70]
    s = s.replace(old, new)

rep('''  familyCells, formatElapsed, inspectAsTemplate, isImageOnlyRefs, isVideoTemplate, mentionInsertText, refTag,''',
    '''  familyCells, formatElapsed, inspectAsTemplate, isAudioOnlyRefs, isAudioTemplate, isImageOnlyRefs, isVideoTemplate,
  mentionInsertText, refTag, templateMediaKind, WF_KIND_WORDS, WF_OUTPUT_WORDS,''')

s = s.rstrip("\n") + '''

describe("音频一族：叫法、量词与档位名", () => {
  const refTextSlot: CloneSlot = { kind: "prompt", node: "45", input: "ref_text", label: "参考音频的文本" };
  const audioSlot: CloneSlot = { kind: "audio", node: "44", input: "audio", label: "加载音频" };
  const langSlot: CloneSlot = { kind: "select", node: "45", input: "language", label: "语言", options: ["Auto", "Chinese"], value: "Auto" };
  const audioTpl = tpl([refTextSlot, promptSlot, audioSlot, langSlot],
    { name: "闪寻音频克隆", media_kind: "audio" });

  it("族别只看 media_kind；库里没带这个字段的老行一律当图片", () => {
    expect(templateMediaKind(audioTpl)).toBe("audio");
    expect(isAudioTemplate(audioTpl)).toBe(true);
    expect(isVideoTemplate(audioTpl)).toBe(false);
    expect(templateMediaKind(tpl([promptSlot, imageSlot]))).toBe("image");
    expect(isAudioTemplate(tpl([promptSlot, imageSlot]))).toBe(false);
  });

  it("只有音频一族：参考音频 / 段，档位叫文本配音 / 参考音色克隆 / 多参考音频", () => {
    expect(referenceNoun(audioTpl)).toBe("参考音频");
    expect(referenceCounter(audioTpl)).toBe("段");
    expect(isAudioOnlyRefs(audioTpl)).toBe(true);
    expect(isImageOnlyRefs(audioTpl)).toBe(false);
    expect(referenceFamilies(audioTpl)).toEqual(["audio"]);
    expect(modeLabel("text", "audio")).toBe("文本配音");
    expect(modeLabel("single", "audio")).toBe("参考音色克隆");
    expect(modeLabel("multi", "audio")).toBe("多参考音频");
  });

  it("格子只有「音频1」一格，标签仍然是中文编号，不暴露 ref_text 那种节点词", () => {
    expect(referenceCells(audioTpl).map((c) => [c.key, c.kind, c.label])).toEqual([["44.audio", "audio", "音频1"]]);
    // 两个提示词槽都算提示词位，不会有一个被当成参考位
    expect(promptSlots(audioTpl).map(slotKey)).toEqual(["45.ref_text", "45.prompt"]);
    expect(controlSlots(audioTpl).map(slotKey)).toEqual(["45.language"]);
  });

  it("音频工作流插的还是 @音频1：只有 H3 那种视频工作流才换尖括号标签", () => {
    const cell = referenceCells(audioTpl)[0];
    expect(mentionInsertText(cell, "audio")).toBe("@音频1");
    expect(mentionInsertText(cell, "image")).toBe("@音频1");
    expect(mentionItems(referenceCells(audioTpl), { "44.audio": image(9, "音色.flac") }, "", "audio")
      .filter((i) => !i.add).map((i) => [i.label, i.insert])).toEqual([["音频1", "@音频1"]]);
  });

  it("三族徽标与产出说法齐了：设置页与弹窗菜单共用这一张表", () => {
    expect(WF_KIND_WORDS).toEqual({ image: "图片", video: "视频", audio: "音频" });
    expect(WF_OUTPUT_WORDS).toEqual({ image: "出图", video: "出片", audio: "出声音" });
  });
});
'''
tmp = P + ".tmp"
io.open(tmp, "w", encoding="utf-8", newline="\n").write(s)
os.replace(tmp, P)
print("ok")
