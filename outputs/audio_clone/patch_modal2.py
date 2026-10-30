# -*- coding: utf-8 -*-
"""弹窗：主提示词下面按文字位多出几个附框（音色克隆的「参考音频的文本」）。"""
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
    # 1) 导入
    ("""    modeFromRefCount, modeLabel, numberPresets, numberUnit, promptSlots, promptSourceLabel,""",
     """    defaultPromptGroupValues, modeFromRefCount, modeLabel, numberPresets, numberUnit,
    primaryPromptGroup, promptPlaceholder, promptSlots, promptSourceLabel, secondaryPromptGroups,"""),
    ("""    type CloneOutput, type CloneSlot, type MediaKind, type MentionItem, type MentionToken, type RefCell, type RefKind,""",
     """    type CloneOutput, type CloneSlot, type MediaKind, type MentionItem, type MentionToken, type PromptGroup, type RefCell, type RefKind,"""),

    # 2) 附框的状态
    ("""  let controls = $state<Record<string, string | number>>({});""",
     """  let controls = $state<Record<string, string | number>>({});
  /**
   * 主框之外那几个附框填了什么（键 =「节点.输入」）。
   * 音色克隆那类节点要两段文字：要说的话进主框，参考音频里的原话进附框。合成一框就等于
   * 用户改台词的同时把原话冲掉，克隆出来的音色立刻不像——所以各填各的，各交各的。
   */
  let extraPrompts = $state<Record<string, string>>({});"""),

    # 3) 派生
    ("""  const refNoun = $derived(referenceNoun(template));
  const refCounter = $derived(referenceCounter(template));""",
     """  const refNoun = $derived(referenceNoun(template));
  const refCounter = $derived(referenceCounter(template));
  /** 主框下面还要多摆几个框（参考音频的原话那种）。没有就一个都不摆。 */
  const secondaryGroups = $derived(secondaryPromptGroups(template));
  /** 提示词那块的标题跟着主框的标签走：工作流自己管它叫什么就叫什么（空则用通用名字）。 */
  const promptBlockTitle = $derived(primaryPromptGroup(template)?.label ?? "");"""),

    # 4) 换工作流 = 附框重新按工作流里那段原文预填
    ("""    refs = defaultReferences(next, image, sources?.references ?? [], { kind: cardKind });
    controls = defaultControlValues(next);""",
     """    refs = defaultReferences(next, image, sources?.references ?? [], { kind: cardKind });
    controls = defaultControlValues(next);
    // 附框预填工作流里此刻写着的那段话：空着就等于把原话交给后端回落成台词，
    // 用户什么也没动，音色却变了。
    extraPrompts = defaultPromptGroupValues(next);"""),

    # 5) 提交带上附框
    ("""        sourceImageId: image?.id ?? null,
        cellOrder: cells.map((cell) => cell.key),""",
     """        sourceImageId: image?.id ?? null,
        cellOrder: cells.map((cell) => cell.key),
        slotPrompts: extraPrompts,"""),

    # 6) 标题 + placeholder + 附框本体
    ("""              <p class="cm-block-title">完整提示词</p>""",
     """              <p class="cm-block-title">{promptBlockTitle || "完整提示词"}</p>"""),
    ("placeholder={" + "\u0060" + "要生成什么画面，打 @ 可以引用" + "\u0024{" + "refNoun}" + "\u0060" + "}",
     "placeholder={promptPlaceholder(mediaKind, refNoun)}"),
    ("""                {#if shouldOfferWorkflowPrompt(prompt, workflowPrompt)}
                  <button class="cm-btn" onclick={() => (prompt = workflowPrompt)}>填入工作流内置提示词</button>
                {/if}
              </div>
            </section>""",
     """                {#if shouldOfferWorkflowPrompt(prompt, workflowPrompt)}
                  <button class="cm-btn" onclick={() => (prompt = workflowPrompt)}>填入工作流内置提示词</button>
                {/if}
              </div>
              {#each secondaryGroups as group (group.label)}
                <p class="cm-block-title cm-sub-prompt-title">{group.label}</p>
                <textarea class="cm-textarea cm-textarea-sub" rows="3" aria-label={group.label}
                  placeholder="留空则跟随上面那段提示词" value={extraPrompts[group.keys[0]] ?? ""}
                  oninput={(e) => setPromptGroup(group, (e.target as HTMLTextAreaElement).value)}></textarea>
              {/each}
            </section>"""),

    # 7) 写附框的函数（同名文字位共用一框）
    ("""  async function generate() {""",
     """  /** 附框改一次要落到这一组的所有文字位上：一组就是一个框，不是一个输入键。 */
  function setPromptGroup(group: PromptGroup, value: string) {
    for (const key of group.keys) extraPrompts[key] = value;
  }

  async function generate() {"""),

    # 8) 样式：附框矮一截，别和台词抢视线
    ("""  .cm-textarea::placeholder { color: #62626a; opacity: 1; }""",
     """  .cm-textarea::placeholder { color: #62626a; opacity: 1; }
  /* 附框（参考音频的原话那种）比主框矮：它是「别乱动」的东西，占了大半个弹窗反而没人看台词 */
  .cm-textarea-sub { height: auto; min-height: 60px; }
  .cm-sub-prompt-title { margin-top: 12px; }"""),
])
print("ALL OK")
