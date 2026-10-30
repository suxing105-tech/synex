# -*- coding: utf-8 -*-
"""给「指定音色」的选项格换头像：改 clone.ts（认人）与 CloneModal.svelte（画脸）。"""
import io

ROOT = r"C:/Users/Administrator/Documents/ChatGPT/苏醒图库/frontend/src"


def patch(path, pairs):
    text = io.open(path, encoding="utf-8").read()
    for old, new in pairs:
        assert text.count(old) == 1, "anchor not unique in %s: %r" % (path, old[:70])
        text = text.replace(old, new, 1)
    io.open(path, "w", encoding="utf-8", newline="\n").write(text)
    print("patched", path)


LIB = ROOT + "/lib/clone.ts"
LIB_ANCHOR = '  return base.replace(/_+/g, " ").trim() || base;\n}\n'
LIB_ADD = LIB_ANCHOR + '''
/**
 * 九个内置音色的人脸头像（Qwen3-TTS CustomVoice 自带的那九个）。
 *
 * 为什么靠「选项自己认得出是谁」而不是看槽位标签：标签是用户在 ComfyUI 里随手可改的
 * （「音色」改成「Speaker」面板就瞎了），选项值却是模型给的。认不出的一律回落到
 * 原来那颗小圆点，绝不给陌生选项硬配一张脸。
 *
 * 图放在 frontend/public/voices/ 走静态托管（和 /logo.png 同一条路），路径就是文件名，
 * 不进 import、不依赖打包哈希。键 = 显示名去掉空格下划线后的小写。
 */
const VOICE_AVATARS: Record<string, string> = {
  vivian: "/voices/vivian.webp",
  serena: "/voices/serena.webp",
  unclefu: "/voices/uncle-fu.webp",
  dylan: "/voices/dylan.webp",
  eric: "/voices/eric.webp",
  ryan: "/voices/ryan.webp",
  aiden: "/voices/aiden.webp",
  onoanna: "/voices/ono-anna.webp",
  sohee: "/voices/sohee.webp",
};

/** 「Uncle_Fu」「Ono_Anna（日语）」这类选项 → 头像路径；认不出返回 null。 */
export function voiceAvatar(option: string): string | null {
  const key = optionLabel(option).toLowerCase().replace(/[^a-z0-9]/g, "");
  return VOICE_AVATARS[key] ?? null;
}
'''

MODAL = ROOT + "/components/CloneModal.svelte"
IMPORT_OLD = "    ratioShape, referenceCells, referenceIssues, resolvePromptSource, shouldOfferWorkflowPrompt, slotKey, visibleRefCells,"
IMPORT_NEW = "    ratioShape, referenceCells, referenceIssues, resolvePromptSource, shouldOfferWorkflowPrompt, slotKey, visibleRefCells, voiceAvatar,"

DERIVED_OLD = "  const hasParams = $derived(selectSlots.length + numberSlots.length > 0);\n"
DERIVED_NEW = DERIVED_OLD + """  /**
   * 底部胶囊上那颗小脸：当前参数里第一个「认得出是谁」的音色。语种、比例那类选项
   * voiceAvatar 直接返回 null，不会被误配；换成模型自带的其它音色时这颗自然消失。
   */
  const pickedFace = $derived(selectSlots.map((slot) => voiceAvatar(String(controls[slotKey(slot)] ?? ""))).find(Boolean) ?? "");
"""

PILL_OLD = '                      <span class="cm-pill-text">{summary || "设置画面参数"}</span>'
PILL_NEW = '''                      {#if pickedFace}
                        <img class="cm-pill-face" src={pickedFace} alt="" draggable="false" />
                      {/if}
''' + PILL_OLD

GRID_OLD = """                              {@const shape = ratioShape(option)}
"""
GRID_NEW = """                              {@const shape = ratioShape(option)}
                              {@const face = voiceAvatar(option)}
"""

FACE_OLD = """                                {#if shape.ratio}
                                  <span class="cm-ratio-box" style="width: {shape.box.w}px; height: {shape.box.h}px;" aria-hidden="true"></span>
"""
FACE_NEW = """                                {#if face}
                                  <!-- 内置音色：认得出是谁就摆那张脸。名字仍在下面，不看图也不影响读；
                                       圆形遮罩由 CSS 负责，图自己按「脸居中、头顶留白」出。 -->
                                  <img class="cm-ratio-face" src={face} alt="" draggable="false" />
                                {:else if shape.ratio}
                                  <span class="cm-ratio-box" style="width: {shape.box.w}px; height: {shape.box.h}px;" aria-hidden="true"></span>
"""

CSS_OLD = "  .cm-ratio-label { font-size: 11.5px; white-space: nowrap; }\n"
CSS_NEW = CSS_OLD + """  /* 内置音色那一格：40px 圆脸。选中时用品牌色描一圈，和顶上音频模式那三颗同一个色，
     不新造一套选中语言；未选中只留一层极淡的内描边，免得黑底头像看起来像没图。 */
  .cm-ratio-face { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: #2a2a2e; box-shadow: inset 0 0 0 1px rgb(255 255 255 / 12%); }
  .cm-ratio.is-on .cm-ratio-face { box-shadow: inset 0 0 0 2px rgb(242 78 78 / 85%), 0 0 0 1px rgb(0 0 0 / 45%); }
  .cm-pill-face { flex: none; width: 20px; height: 20px; border-radius: 50%; object-fit: cover; background: #2a2a2e; box-shadow: inset 0 0 0 1px rgb(255 255 255 / 14%); }
"""

patch(LIB, [(LIB_ANCHOR, LIB_ADD)])
patch(MODAL, [(IMPORT_OLD, IMPORT_NEW), (DERIVED_OLD, DERIVED_NEW), (PILL_OLD, PILL_NEW),
              (GRID_OLD, GRID_NEW), (FACE_OLD, FACE_NEW), (CSS_OLD, CSS_NEW)])
