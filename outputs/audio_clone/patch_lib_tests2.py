import io, os
P = r"frontend\src\__tests__\clone-lib.test.ts"
s = io.open(P, encoding="utf-8").read()
def rep(old, new):
    global s
    assert s.count(old) == 1, old[:60]
    s = s.replace(old, new)
rep('''  const audioSlot: CloneSlot = { kind: "audio", node: "44", input: "audio", label: "加载音频" };
  const langSlot: CloneSlot = { kind: "select", node: "45", input: "language", label: "语言", options: ["Auto", "Chinese"], value: "Auto" };
  const audioTpl = tpl([refTextSlot, promptSlot, audioSlot, langSlot],
    { name: "闪寻音频克隆", media_kind: "audio" });''',
    '''  const speechSlot: CloneSlot = { kind: "prompt", node: "45", input: "text", label: "完整提示词" };
  const audioSlot: CloneSlot = { kind: "audio", node: "44", input: "audio", label: "加载音频" };
  const langSlot: CloneSlot = { kind: "select", node: "45", input: "language", label: "语言", options: ["Auto", "Chinese"], value: "Auto" };
  const audioTpl = tpl([refTextSlot, speechSlot, audioSlot, langSlot],
    { name: "闪寻音频克隆", media_kind: "audio" });''')
rep('''    expect(promptSlots(audioTpl).map(slotKey)).toEqual(["45.ref_text", "45.prompt"]);''',
    '''    expect(promptSlots(audioTpl).map(slotKey)).toEqual(["45.ref_text", "45.text"]);''')
tmp = P + ".tmp"
io.open(tmp, "w", encoding="utf-8", newline="\n").write(s)
os.replace(tmp, P)
print("ok")
