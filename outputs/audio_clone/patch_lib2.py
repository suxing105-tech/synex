# -*- coding: utf-8 -*-
"""前端数据层：把工作流的文字位分成「主框 + 附框」，附框单独交回。"""
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

L = r"frontend\src\lib\clone.ts"
patch(L, [
    # 1) 文字位分组
    ('''export function promptSlots(template: CloneTemplate | null | undefined): CloneSlot[] {
  return (template?.slots ?? []).filter((s) => s.kind === "prompt");
}''',
     '''export function promptSlots(template: CloneTemplate | null | undefined): CloneSlot[] {
  return (template?.slots ?? []).filter((s) => s.kind === "prompt");
}

/** 弹窗顶上那个大框的槽位标签，与后端 clone_templates.PRIMARY_PROMPT_LABEL 同一个词。 */
export const PRIMARY_PROMPT_LABEL = "\u5b8c\u6574\u63d0\u793a\u8bcd";

export interface PromptGroup {
  label: string;
  /** 这一框的话要写进哪些文字位（「节点.输入」）；同名的文字位共用一框。 */
  keys: string[];
  /** 工作流里此刻写着的那段字：弹窗拿它预填，用户不碰就原样交回去。 */
  value: string;
  /** true = 顶上那个大框（要生成什么）；其余是附框，例如音色克隆的「参考音频的文本」。 */
  primary: boolean;
}

/**
 * 按标签把工作流的文字位分成几个框。
 *
 * 为什么不能只有一个框：音色克隆那类节点要两段文字——要说的话 + 参考音频里的原话。
 * 合成一框就等于用户改台词的同时把原话冲掉，克隆出来的音色立刻不像了。
 * 主框认标签（后端保证一台节点只有一个主框），万一整条工作流没有主框标签就退回第一组，
 * 免得那条工作流在弹窗里填不进字。
 */
export function promptGroups(template: CloneTemplate | null | undefined): PromptGroup[] {
  const groups: PromptGroup[] = [];
  const byLabel = new Map<string, PromptGroup>();
  for (const slot of promptSlots(template)) {
    const label = (slot.label ?? "").trim() || PRIMARY_PROMPT_LABEL;
    let group = byLabel.get(label);
    if (!group) {
      group = {
        label,
        keys: [],
        value: typeof slot.value === "string" ? slot.value : "",
        primary: false,
      };
      byLabel.set(label, group);
      groups.push(group);
    }
    group.keys.push(slotKey(slot));
  }
  const primary = groups.find((g) => g.label === PRIMARY_PROMPT_LABEL) ?? groups[0];
  if (primary) primary.primary = true;
  return groups;
}

/** 主框对应的那组文字位；这条工作流没有文字位时 null。 */
export function primaryPromptGroup(template: CloneTemplate | null | undefined): PromptGroup | null {
  return promptGroups(template).find((g) => g.primary) ?? null;
}

/** 主框之外的附框（音色克隆的参考原话就在这儿）。 */
export function secondaryPromptGroups(template: CloneTemplate | null | undefined): PromptGroup[] {
  return promptGroups(template).filter((g) => !g.primary);
}

/**
 * 附框的初始值。预填的是工作流里那段原文本身，不是空框：空框等于让后端把原话
 * 回落成台词，用户没动那个框，音色却变了。
 */
export function defaultPromptGroupValues(template: CloneTemplate | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const group of secondaryPromptGroups(template)) {
    if (!group.value) continue;
    for (const key of group.keys) out[key] = group.value;
  }
  return out;
}

/** 提示词框的提示语：出声音的工作流别问「要生成什么画面」。 */
export function promptPlaceholder(mediaKind: MediaKind | undefined = "image", refNoun = "\u53c2\u8003\u56fe\u7247"): string {
  const ask = mediaKind === "audio" ? "\u8981\u5ff5\u4ec0\u4e48" : "\u8981\u751f\u6210\u4ec0\u4e48\u753b\u9762";
  return ask + "\uff0c\u6253 @ \u53ef\u4ee5\u5f15\u7528" + refNoun;
}'''),

    # 2) 请求体带上附框的文字
    ('''export interface GenerateRequest {
  template_id: number;
  prompt: string;
  references: { slot: string; image_id: number }[];
  controls: Record<string, string | number>;
  source_image_id: number | null;
}''',
     '''export interface GenerateRequest {
  template_id: number;
  prompt: string;
  /** 主框之外的文字位（键 =「节点.输入」）；没有附框就不带这个键。 */
  slot_prompts?: Record<string, string>;
  references: { slot: string; image_id: number }[];
  controls: Record<string, string | number>;
  source_image_id: number | null;
}'''),
    ('''  sourceImageId: number | null;
  /** referenceCells 的 key 顺序；不传就按 references 里已有的键序 */
  cellOrder?: string[];
}): GenerateRequest {''',
     '''  sourceImageId: number | null;
  /** referenceCells 的 key 顺序；不传就按 references 里已有的键序 */
  cellOrder?: string[];
  /** 附框（参考音频的原话等）填的内容；空的那几条不提交，让后端回落成主提示词 */
  slotPrompts?: Record<string, string>;
}): GenerateRequest {'''),
    ('''  return { template_id: args.templateId, prompt: args.prompt.trim(), references, controls, source_image_id: args.sourceImageId };''',
     '''  const slotPrompts: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.slotPrompts ?? {})) {
    if (typeof value === "string" && value.trim()) slotPrompts[key] = value;
  }
  const request: GenerateRequest = { template_id: args.templateId, prompt: args.prompt.trim(), references, controls, source_image_id: args.sourceImageId };
  // 没有附框的工作流不该凭空多出一个键：老请求体一字不改，测试与后端都按原样认。
  if (Object.keys(slotPrompts).length) request.slot_prompts = slotPrompts;
  return request;'''),
])
print("ALL OK")
