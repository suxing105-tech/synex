/**
 * 一键同款的数据层：同款工作流模板、槽位、生成任务状态。
 *
 * 为什么单独一个文件：这套东西的契约全在后端（clone_templates / clone_jobs），
 * 前端只负责「把槽位画出来 + 把用户填的原样交回去」。塞进 stores.ts 会把两个不相干
 * 的领域搅在一起，纯函数也不好单测。
 *
 * lib/api 用整模块引入：部分测试用 vi.mock 换掉 lib/api 且只声明自己用到的导出，
 * 具名 import 一个 mock 里不存在的导出会直接炸在 import 阶段（而不是调用阶段）。
 */
import { writable } from "svelte/store";
import * as api from "./api";
import type { ImageDetail, ImageSummary } from "./types";

export type CloneSlotKind = "prompt" | "image" | "audio" | "video" | "select" | "number";
/** 参考素材的三族：图片和音频和视频各排各的号，弹窗一行一族。 */
export type RefKind = "image" | "audio" | "video";
/**
 * 这份工作流出的是图、片子还是一段声音。它决定弹窗默认给哪一族卡片、
 * 工作流菜单里的徒标，以及 @ 引用插什么标签（只有 H3 那类视频工作流认尖括号）。
 */
export type MediaKind = "image" | "video" | "audio";
export const REF_KINDS: RefKind[] = ["image", "audio", "video"];
export const REF_KIND_NAMES: Record<RefKind, string> = { image: "图片", audio: "音频", video: "视频" };
/** 三族的量词：量词跟着族走，在一堆「张」里挑一段音频，读着就别扭。 */
export const REF_KIND_COUNTERS: Record<RefKind, string> = { image: "张", audio: "段", video: "条" };

export interface CloneSlot {
  kind: CloneSlotKind;
  node: string;
  input: string;
  label: string;
  /**
   * image 专用：ComfyUI 的 autogrow 输入组。工作流里往往只连了一台 LoadImage，
   * 但下游那个节点还能继续收图（例如 TextEncodeQwenImage 的 images.image_2…image_16）。
   * names 是还能续的槽名，弹窗按它自动补出「+ 参考」格，生成时后端克隆 LoadImage 接上去。
   */
  grow?: { node: string; group: string; names: string[]; type?: string } | null;
  /** select 专用：导入时从 ComfyUI 缓存下来的可选项，ComfyUI 没开也能画下拉 */
  options?: string[];
  value?: string | number | null;
  min?: number | null;
  max?: number | null;
  step?: number | null;
  /** number 专用：秒/MP 这类后缀，后端给准，前端不猜 */
  unit?: string | null;
  /** number 专用：后端算好的档位（时长的 5/8/10/12/15），没有就退回通用表 */
  presets?: number[];
}

export interface CloneTemplate {
  id: number;
  name: string;
  slots: CloneSlot[];
  default_prompt: string;
  is_active: boolean;
  /** 安装包自带的官方工作流：删得掉，但删了不会下次启动又长回来 */
  is_builtin?: boolean;
  created_at: string;
  updated_at: string;
  node_count: number;
  prompt_count: number;
  /** 这份工作流支持的生成档位；前端只用它判断「一张参考素材都不放」 */
  modes?: CloneMode[];
  reference_count: number;
  control_count: number;
  /** 出片还是出图。老模板没带就当 image，行为和图片一键同款一字不差。 */
  media_kind?: MediaKind;
  /** 后端算好的参考格清单（族、编号、H3 标签）。有就照它画，别再在前端算一遍。 */
  reference_cells?: RefCellWire[];
  /** 工作流里已连线的参考视频音轨数：算 <Audio j> 序号要先扣掉它们 */
  soundtracks?: number;
  image_reference_count?: number;
  audio_reference_count?: number;
  video_reference_count?: number;
}

export function isVideoTemplate(template: CloneTemplate | null | undefined): boolean {
  return (template?.media_kind ?? "image") === "video";
}

export function isAudioTemplate(template: CloneTemplate | null | undefined): boolean {
  return (template?.media_kind ?? "image") === "audio";
}

/** 工作流属哪一族；库里没带 media_kind 的老模板一律当图片（行为与历史一致）。 */
export function templateMediaKind(template: CloneTemplate | null | undefined): MediaKind {
  const kind = template?.media_kind ?? "image";
  return kind === "video" || kind === "audio" ? kind : "image";
}

/**
 * 音频弹窗顶上那排「模式」按钮吃的是哪几条工作流：出声音的那一族全列出来。
 * 参考音色 / 音色描述 / 指定音色是三份不同模型的工作流，不是一个能中途改的开关
 * （中途换要重载模型），所以按钮换的就是模板本身，不假装成一个参数。
 */
export function audioModeTemplates(
  templates: readonly CloneTemplate[] | null | undefined,
): CloneTemplate[] {
  return (templates ?? []).filter((item) => templateMediaKind(item) === "audio");
}

/** 音频族在「切换工作流」清单里折叠成一条时用的族名——三种出声方式共用一个入口。 */
export const AUDIO_MODE_GROUP_LABEL = "\u95ea\u5bfb\u97f3\u9891";

/**
 * 「切换工作流」那一列的行。图片、视频各列各的；音频族超过一条时**收成一条**（闪寻音频）。
 *
 * 出声音的那几条不是几份可换的配方，是同一件事的三种模式，而模式已经有弹窗顶上那排按钮了——
 * 清单里再列三条，用户就要在两个地方选同一件事，还得先想明白「音色描述」和「指定音色」谁在工作流列表里。
 * 只有一条音频工作流时照旧按名字列（那时候顶上根本没有模式按钮，藏名字就等于让人认错工作流）。
 *
 * targetId = 点这一条要落到的那条工作流：先看这条族里库里标的「当前」，其次现在弹窗正在用的，最后第一条。
 */
export interface WorkflowMenuRow {
  /** 渲染用的稳定 key */
  key: string;
  kind: MediaKind;
  label: string;
  /** 族内所有工作流的 id；当前弹窗用的那条落在里面时这一条要标「当前」 */
  memberIds: number[];
  targetId: number;
  collapsed: boolean;
}

export function workflowMenuRows(
  templates: readonly CloneTemplate[] | null | undefined,
  currentId?: number | null,
): WorkflowMenuRow[] {
  const list = (templates ?? []).filter((item) => item.id != null);
  const audio = list.filter((item) => templateMediaKind(item) === "audio");
  const collapse = audio.length > 1;
  const target =
    audio.find((item) => item.is_active) ??
    audio.find((item) => item.id === currentId) ??
    audio[0];
  const rows: WorkflowMenuRow[] = [];
  let emittedAudio = false;
  for (const item of list) {
    const kind = templateMediaKind(item);
    if (kind !== "audio") {
      rows.push({
        key: String(item.id),
        kind,
        label: templateDisplayName(item.name),
        memberIds: [item.id as number],
        targetId: item.id as number,
        collapsed: false,
      });
      continue;
    }
    if (!collapse) {
      rows.push({
        key: String(item.id),
        kind,
        label: templateDisplayName(item.name),
        memberIds: [item.id as number],
        targetId: item.id as number,
        collapsed: false,
      });
      continue;
    }
    if (emittedAudio) continue;
    emittedAudio = true;
    rows.push({
      key: "audio-group",
      kind: "audio",
      label: AUDIO_MODE_GROUP_LABEL,
      memberIds: audio.map((item) => item.id as number),
      targetId: (target?.id ?? audio[0]?.id) as number,
      collapsed: true,
    });
  }
  return rows;
}

/**
 * 弹窗标题与底部那颗胶囊上的名字：当前工作流在「切换工作流」清单里叫什么，这两处就叫什么。
 *
 * 清单里三条音频折成一条「闪寻音频」，底下那颗也必须叫「闪寻音频」——同一个弹窗里两种叫法，
 * 用户会以为清单那一行和底部这颗管的是两件事（2026-10-30 苏醒点名：三种模式底下都要同步）。
 * 具体是哪一种出声方式由弹窗顶上那排按钮的高亮说，全名留在悬浮提示与设置页。
 */
export function workflowDisplayName(
  templates: readonly CloneTemplate[] | null | undefined,
  current: CloneTemplate | null | undefined,
): string {
  const id = current?.id ?? null;
  const row = id == null
    ? undefined
    : workflowMenuRows(templates, id).find((item) => item.memberIds.includes(id));
  return row?.label ?? templateDisplayName(current?.name);
}

/** 按钮上的字：品牌前缀在这排按钮里是三份重复信息，去掉；去掉就空了则用全名。 */
export function audioModeLabel(name: string): string {
  const full = templateDisplayName(name);
  return full.replace(/^闪寻/, "").trim() || full;
}

/**
 * 给用户看的工作流名字。
 *
 * 从本地导入的那份文件名尾巴上挂着 .json——那是文件名去不掉的后缀，不是名字的一部分，
 * 显示出来只会让底部那颗 pill 白白变长、切换列表里两条看着一模一样。库里已有的名字
 * 也走这里，用户不必为了去掉后缀重导一遍。
 */
/** 工作流徒标与弹窗菜单里称呼一族；三族并列时不能只有「图片/视频」两个词。 */
export const WF_KIND_WORDS: Record<MediaKind, string> = { image: "图片", video: "视频", audio: "音频" };
export const WF_OUTPUT_WORDS: Record<MediaKind, string> = { image: "出图", video: "出片", audio: "出声音" };

/** 后端回的产出族别只认这三个值，其实不是就当未知（空串）。 */
function asOutputKind(value: unknown): MediaKind | "" {
  return value === "image" || value === "video" || value === "audio" ? value : "";
}

export function templateDisplayName(name: string | null | undefined): string {
  const base = (name ?? "").trim();
  return base.replace(/\.json$/i, "").trim() || base;
}

export interface CloneNodeOverview {
  node: string;
  class_type: string;
  title: string;
  inputs: { input: string; kind: string; literal: boolean }[];
}

export interface CloneInspect {
  slots: CloneSlot[];
  modes?: CloneMode[];
  candidates: CloneSlot[];
  nodes: CloneNodeOverview[];
  default_prompt: string;
  warnings: string[];
  suggested_name: string;
  media_kind?: MediaKind;
  reference_cells?: RefCellWire[];
  soundtracks?: number;
}

/** 把 inspect 的结果当成模板用：设置页在「还没落库」的阶段就要按族画格子。 */
export function inspectAsTemplate(inspect: CloneInspect, id = 0): CloneTemplate {
  return {
    id, name: "", slots: inspect.slots ?? [], default_prompt: inspect.default_prompt ?? "",
    is_active: false, created_at: "", updated_at: "", node_count: (inspect.nodes ?? []).length,
    prompt_count: (inspect.slots ?? []).filter((s) => s.kind === "prompt").length,
    modes: inspect.modes, reference_count: 0, control_count: 0,
    media_kind: inspect.media_kind ?? "image",
    reference_cells: inspect.reference_cells, soundtracks: inspect.soundtracks,
  };
}

export type CloneMode = "text" | "single" | "multi";

export const CLONE_MODES: CloneMode[] = ["text", "single", "multi"];
export const CLONE_MODE_LABELS: Record<CloneMode, string> = {
  text: "文生图",
  single: "单图编辑",
  multi: "多图编辑",
};

export type CloneState = "uploading" | "queued" | "running" | "downloading" | "done" | "error" | "cancelled";

export interface CloneJob {
  active: boolean;
  job_id: string;
  state: CloneState | "";
  running: boolean;
  message: string;
  error: string;
  image_ids: number[];
  /** 产出清单：图片也好视频也好，缩略图一律由后端给准地址 */
  outputs: CloneOutput[];
  media_kind: MediaKind | "";
  template_id: number | null;
  source_image_id: number | null;
  elapsed: number;
}

export interface CloneOutput {
  id: number;
  kind: MediaKind | string;
  filename: string;
  thumbnail_url: string;
}

export const EMPTY_CLONE_JOB: CloneJob = {
  active: false, job_id: "", state: "", running: false, message: "", error: "",
  image_ids: [], outputs: [], media_kind: "", template_id: null, source_image_id: null, elapsed: 0,
};

const CLONE_STATES: CloneState[] = ["uploading", "queued", "running", "downloading", "done", "error", "cancelled"];
const RUNNING_STATES: CloneState[] = ["uploading", "queued", "running", "downloading"];

/** 任务状态只活在内存 + WS：出图本身就是历史，不需要再造一张生成记录表。 */
export const cloneJob = writable<CloneJob>(EMPTY_CLONE_JOB);

/** WS 的 clone_progress 与 REST 的 jobs/current 都走这里；认不出的状态退回空壳。 */
export function applyCloneProgress(payload: unknown): CloneJob {
  if (!payload || typeof payload !== "object") return EMPTY_CLONE_JOB;
  const raw = payload as Record<string, unknown>;
  const state = String(raw.state ?? "") as CloneState;
  const known = CLONE_STATES.includes(state);
  const job: CloneJob = {
    active: Boolean(raw.active),
    job_id: String(raw.job_id ?? ""),
    state: known ? state : "",
    running: known ? RUNNING_STATES.includes(state) : Boolean(raw.running),
    message: String(raw.message ?? ""),
    error: String(raw.error ?? ""),
    // Number(null) 是 0，直接放过去会在弹窗里多出一个坏掉的缩略图，所以要正整数才算。
    image_ids: Array.isArray(raw.image_ids) ? raw.image_ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0) : [],
    outputs: Array.isArray(raw.outputs)
      ? (raw.outputs as Record<string, unknown>[])
        .map((item) => ({
          id: Number(item.id ?? 0),
          kind: String(item.kind ?? "image"),
          filename: String(item.filename ?? ""),
          thumbnail_url: String(item.thumbnail_url ?? ""),
        }))
        .filter((item) => Number.isInteger(item.id) && item.id > 0)
      : [],
    media_kind: asOutputKind(raw.media_kind),
    template_id: raw.template_id === null || raw.template_id === undefined ? null : Number(raw.template_id),
    source_image_id: raw.source_image_id === null || raw.source_image_id === undefined ? null : Number(raw.source_image_id),
    elapsed: Number(raw.elapsed ?? 0) || 0,
  };
  cloneJob.set(job);
  return job;
}

const STATE_LABELS: Record<CloneState, string> = {
  uploading: "上传参考素材…",
  queued: "提交到 ComfyUI…",
  running: "生成中…",
  downloading: "登记生成结果…",
  done: "已生成",
  error: "生成失败",
  cancelled: "已取消",
};

/** 生成时长说人话：一条片子跑了三分十二秒，只显示「3分」或「192秒」都看不出快慢。 */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (!minutes) return `${total}秒`;
  return rest ? `${minutes}分${rest}秒` : `${minutes}分钟`;
}

export function cloneStatusLabel(job: CloneJob): string {
  if (!job.state) return "";
  const label = STATE_LABELS[job.state];
  const count = job.outputs.length || job.image_ids.length;
  // 声音也说「条」：一段配音说「一张」比说「一条」更别扭。
  const counter = job.media_kind === "video" || job.media_kind === "audio" ? "条" : "张";
  if (job.state === "done" && count) return `${label} ${count} ${counter}`;
  if (job.running) {
    // 「生成中 · 3分12秒」：视频要等十分钟级，不给个走动的秒数，用户只会以为卡死了。
    return `${job.message || label} · ${formatElapsed(job.elapsed)}`;
  }
  return job.message || label;
}

/** 这条进度属不属于当前弹窗：同一时刻后端只允许一个任务在跑。 */
export function jobForTemplate(job: CloneJob, templateId: number | null): CloneJob | null {
  if (!job.active || job.state === "") return null;
  if (templateId !== null && job.template_id !== null && job.template_id !== templateId) return null;
  return job;
}

// ---------- 槽位 ----------

export function slotKey(slot: Pick<CloneSlot, "node" | "input">): string {
  return `${slot.node}.${slot.input}`;
}

export function promptSlots(template: CloneTemplate | null | undefined): CloneSlot[] {
  return (template?.slots ?? []).filter((s) => s.kind === "prompt");
}

/** 弹窗顶上那个大框的槽位标签，与后端 clone_templates.PRIMARY_PROMPT_LABEL 同一个词。 */
export const PRIMARY_PROMPT_LABEL = "完整提示词";

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

/**
 * 附框该摆哪句：工作流里此刻写着的那段打底，生成当时记下的那句盖在上面——
 * 重开「同款」要看到的是当初那句原话，不是别人后来改过的工作流默认值。
 * 只认这条工作流真有的附框键：换到别的工作流时不能把上一家的键带过去，
 * 后端认那些键不存在的请求会直接 400。
 */
export function promptGroupValues(
  template: CloneTemplate | null | undefined,
  recorded?: Record<string, string> | null,
): Record<string, string> {
  const out = defaultPromptGroupValues(template);
  if (!recorded) return out;
  for (const group of secondaryPromptGroups(template)) {
    for (const key of group.keys) {
      const value = recorded[key];
      if (typeof value === "string" && value.trim()) out[key] = value;
    }
  }
  return out;
}

/** 参考音频原话那一格的标签，与后端 clone_templates.SECONDARY_PROMPT_KEYS 的取值一致。 */
export const REFERENCE_TRANSCRIPT_LABEL = "\u53c2\u8003\u97f3\u9891\u7684\u6587\u672c";
/** 用文字描述音色那一格（VoiceDesign 的 instruct），同样与后端那张键名表同词。 */
export const VOICE_DESIGN_LABEL = "\u97f3\u8272\u63cf\u8ff0";
/** 「指定音色」那条工作流里可选的语气/风格那一格。 */
export const VOICE_STYLE_LABEL = "\u8bed\u6c14\u4e0e\u98ce\u683c";

/**
 * 附框下面那句解释。只认得出用途的那种才说得出人话——别的附框（工作流自己多出来的
 * 第二段文字）用途不明，硬编一句「照原话填」就是瞎指挥。
 */
export function promptGroupHint(label: string): string {
  if (label === REFERENCE_TRANSCRIPT_LABEL)
    return "\u8fd9\u4e00\u683c\u586b\u7684\u662f\u53c2\u8003\u97f3\u9891\u91cc\u8bf4\u7684\u90a3\u53e5\u539f\u8bdd\uff0c\u4e0d\u662f\u53f0\u8bcd\uff1b\u586b\u9519\u4e86\u97f3\u8272\u4f1a\u660e\u663e\u8dd1\u504f\u3002";
  if (label === VOICE_DESIGN_LABEL)
    return "\u8fd9\u4e00\u683c\u51b3\u5b9a\u58f0\u97f3\u957f\u4ec0\u4e48\u6837\uff08\u6027\u522b\u3001\u5e74\u9f84\u3001\u6c14\u8d28\u3001\u8bed\u6c14\uff09\uff0c\u4e0a\u9762\u90a3\u683c\u51b3\u5b9a\u5ff5\u4ec0\u4e48\uff1b\u522b\u628a\u53f0\u8bcd\u5199\u8fdb\u6765\u3002";
  if (label === VOICE_STYLE_LABEL)
    return "\u53ef\u4ee5\u7559\u7a7a\u3002\u60f3\u8c03\u8bed\u6c14\u3001\u60c5\u7eea\u6216\u8bed\u901f\u5c31\u5728\u8fd9\u91cc\u8bf4\u4e00\u53e5\uff0c\u4e0d\u5199\u5c31\u6309\u9ed8\u8ba4\u8bf4\u8bdd\u65b9\u5f0f\u3002";
  return "";
}

/**
 * 附框的占位语。「留空则跟随上面那段提示词」只对参考原话成立：
 * 音色描述留空＝没告诉模型想要什么声音，语气留空＝按默认说话方式，
 * 三种附框共用一句就是骗人。
 */
export function promptGroupPlaceholder(label: string): string {
  if (label === VOICE_DESIGN_LABEL)
    return "\u5fc5\u586b\uff1a\u60f3\u8981\u4ec0\u4e48\u6837\u7684\u58f0\u97f3\uff0c\u4f8b\u5982\u300c\u5e74\u8f7b\u5973\u6027\uff0c\u6e29\u67d4\uff0c\u8bed\u901f\u504f\u6162\u300d";
  if (label === VOICE_STYLE_LABEL)
    return "\u53ef\u7559\u7a7a\uff1a\u60f3\u8c03\u8bed\u6c14\u3001\u60c5\u7eea\u6216\u8bed\u901f\u5c31\u8bf4\u4e00\u53e5";
  return "\u7559\u7a7a\u5219\u8ddf\u968f\u4e0a\u9762\u90a3\u6bb5\u63d0\u793a\u8bcd";
}

/** 提示词框的提示语：出声音的工作流别问「要生成什么画面」。 */
export function promptPlaceholder(
  mediaKind: MediaKind | undefined = "image",
  refNoun = "参考图片",
  hasRefs = true,
): string {
  const ask = mediaKind === "audio" ? "要念什么" : "要生成什么画面";
  // 一个参考位都没有的工作流（音色描述、指定音色）里 @ 点了不会出东西，
  // 提示语就不许再写「打 @ 可以引用」。
  if (!hasRefs) return ask;
  return ask + "，打 @ 可以引用" + refNoun;
}

export function imageSlots(template: CloneTemplate | null | undefined): CloneSlot[] {
  return (template?.slots ?? []).filter((s) => s.kind === "image");
}

export function controlSlots(template: CloneTemplate | null | undefined): CloneSlot[] {
  return (template?.slots ?? []).filter((s) => s.kind === "select" || s.kind === "number");
}

/**
 * 弹窗支持的生成档位。老模板没带 modes 时按槽位兜底：有几台 LoadImage 就有几档。
 */
export function modesFor(template: CloneTemplate | null | undefined): CloneMode[] {
  const declared = (template?.modes ?? []).filter((m): m is CloneMode => CLONE_MODES.includes(m));
  if (declared.length) return CLONE_MODES.filter((m) => declared.includes(m));
  const refs = imageSlots(template).length;
  if (!refs) return ["text"];
  const grow = (template?.slots ?? []).some((s) => (s.grow?.names?.length ?? 0) > 0);
  return CLONE_MODES.filter((m) => m === "single" || (m === "multi" && (refs > 1 || grow)));
}

/**
 * 生成方式不是用户选的，是参考图数量的函数：0 张＝文生图、1 张＝单图编辑、2 张以上＝多图编辑。
 * 少一个开关就少一处能和实际画面打架的状态，和后端 clone_templates.mode_from_count 同一条规则。
 */
export function modeFromRefCount(count: number): CloneMode {
  if (count <= 0) return "text";
  return count === 1 ? "single" : "multi";
}

/** 这份工作流允许一张参考图都不放吗（把参考链摘掉之后还跑得起）。 */
export function allowsTextMode(template: CloneTemplate | null | undefined): boolean {
  return modesFor(template).includes("text");
}

const CLONE_VIDEO_MODE_LABELS: Record<CloneMode, string> = {
  text: "文生视频",
  single: "图生视频",
  multi: "多参考视频",
};
const CLONE_AUDIO_MODE_LABELS: Record<CloneMode, string> = {
  text: "文本配音",
  single: "参考音色克隆",
  multi: "多参考音频",
};

export function modeLabel(mode: CloneMode, mediaKind: MediaKind | undefined = "image"): string {
  const table = mediaKind === "video"
    ? CLONE_VIDEO_MODE_LABELS
    : mediaKind === "audio"
      ? CLONE_AUDIO_MODE_LABELS
      : CLONE_MODE_LABELS;
  return table[mode] ?? mode;
}

export interface RefCell {
  key: string;
  label: string;
  /** 这一格最终喂给哪台加载器（节点标题），放进 title 里方便核对 */
  slotLabel: string;
  /** 哪一族：图片 / 音频 / 视频 */
  kind?: RefKind;
  /** 族内编号（1 起），H3 标签的序号就是它，音频族另加音轨偏移 */
  ordinal?: number;
  /** H3 原生标签：<Picture 1> / <Audio 2> / <Video 1>。只有视频工作流会插进提示词 */
  tag?: string;
}

/**
 * 后端传来的参考格（wire 形状，snake_case，照 /api/clone/templates 的真实返回）。
 *
 * 进渲染层之前一律过 referenceCells() 归一化成 RefCell。字段名两边各写一套是真踩过的坑：
 * 后端发 slot_label、前端类型写 slotLabel，展开后就剩一个 undefined，格子悬停只剩
 * 「undefined｜文件名」；当时假数据写的是 camelCase，所以测试一路绿灯。
 */
export interface RefCellWire {
  key: string;
  kind?: RefKind;
  ordinal?: number;
  label?: string;
  /** 扩位用的下游槽名（ref_image_2 之类），真槽位为空串 */
  name?: string;
  /** 这一格最终喂给哪台加载器（节点标题） */
  slot_label?: string;
  tag?: string;
}

const TAG_TEMPLATES: Record<RefKind, string> = {
  image: "<Picture {n}>",
  audio: "<Audio {n}>",
  video: "<Video {n}>",
};

export function refKindOf(slot: CloneSlot): RefKind | "" {
  return slot.kind === "image" || slot.kind === "audio" || slot.kind === "video" ? slot.kind : "";
}

export function referenceSlotsOf(template: CloneTemplate | null | undefined, kind: RefKind): CloneSlot[] {
  return (template?.slots ?? []).filter((slot) => slot.kind === kind);
}

/**
 * 某一族的 H3 标签序号：图片/视频按族内编号，音频要从已连线的参考视频音轨之后接着数。
 * H3 把参考摆进上下文时按 图片 → 视频（音轨在该视频之前先占一个 Audio 号）→ 独立音频 排，
 * 所以独立音频的 <Audio j> 必须整体后移，否则插进去的 <Audio 1> 指的是视频的音轨，指错人。
 */
export function refTag(kind: RefKind, ordinal: number, soundtracks = 0): string {
  const n = kind === "audio" ? ordinal + Math.max(0, soundtracks) : ordinal;
  return (TAG_TEMPLATES[kind] ?? "").replace("{n}", String(n));
}

/**
 * 弹窗里的参考格：一族一族排（图片 → 音频 → 视频），每族先排工作流真槽位、再排扩位。
 *
 * 后端把这份清单算好带回来（template.reference_cells），因为「第 3 格到底接到
 * ref_audio_2 还是 ref_video_1」这种事两边各算一遍早晚会分家；后端没带（老模板、
 * 老后端）时才在这里按同一套规则现算，规则与 clone_templates.reference_cells 一致。
 */
export function referenceCells(template: CloneTemplate | null | undefined): RefCell[] {
  const fromBackend = template?.reference_cells;
  if (Array.isArray(fromBackend) && fromBackend.length) {
    return fromBackend.map((cell) => {
      const kind = (cell.kind ?? "image") as RefKind;
      const ordinal = cell.ordinal ?? 0;
      return {
        key: cell.key,
        label: cell.label || `${REF_KIND_NAMES[kind]}${ordinal}`,
        slotLabel: cell.slot_label || cell.label || cell.key,
        kind,
        ordinal,
        tag: cell.tag || refTag(kind, ordinal || 1, template?.soundtracks ?? 0),
      };
    });
  }
  const soundtracks = template?.soundtracks ?? 0;
  const cells: RefCell[] = [];
  for (const kind of REF_KINDS) {
    const slots = referenceSlotsOf(template, kind);
    if (!slots.length) continue;
    const label = (slot: CloneSlot) => slot.label || slotKey(slot);
    let ordinal = 0;
    // 先把真槽位排完再排扩位：交错排的话，第二台加载器会被第一台的十几个扩位推到最后，
    // 用户看到的就是「图片1、图片2、图片16」——编号像坏了。
    for (const slot of slots) {
      ordinal += 1;
      cells.push({
        key: slotKey(slot), label: `${REF_KIND_NAMES[kind]}${ordinal}`, slotLabel: label(slot),
        kind, ordinal, tag: refTag(kind, ordinal, soundtracks),
      });
    }
    const claimed = new Set<string>();
    for (const slot of slots) {
      for (const name of slot.grow?.names ?? []) {
        const target = `${slot.grow?.node}.${slot.grow?.group}::${name}`;
        if (claimed.has(target)) continue;
        claimed.add(target);
        ordinal += 1;
        cells.push({
          key: `${slotKey(slot)}::${name}`, label: `${REF_KIND_NAMES[kind]}${ordinal}`,
          slotLabel: label(slot), kind, ordinal, tag: refTag(kind, ordinal, soundtracks),
        });
      }
    }
  }
  return cells;
}

/** 某一族的格子。弹窗按族分三行画，跳族编号（图片9 后面接音频1）也靠它对齐。 */
export function familyCells(cells: RefCell[], kind: RefKind): RefCell[] {
  return cells.filter((cell) => (cell.kind ?? "image") === kind);
}

/** 这份工作流有几族参考位。只有一族（图片）时，弹窗版面和图片一键同款一字不差。 */
export function referenceFamilies(template: CloneTemplate | null | undefined): RefKind[] {
  const cells = referenceCells(template);
  return REF_KINDS.filter((kind) => familyCells(cells, kind).length > 0);
}

/**
 * 参考条实际画出来的格子：已填的 + 永远只有最后一颗「+ 参考」。
 * 十颗空格排在那儿不像能加十张，只像版面没收干净。
 */
export function visibleRefCells(cells: RefCell[], refs: Record<string, ImageSummary | null>): RefCell[] {
  const firstEmpty = cells.find((cell) => !refs[cell.key])?.key;
  return cells.filter((cell) => refs[cell.key] || cell.key === firstEmpty);
}

/**
 * 参考区合并成一行时的展示族序：图片 → 视频 → 音频。
 *
 * 这不是 REF_KINDS（那一处是编号与接线口径，动了等于改接线顺序），只管「挤在同一行里谁先出现」。
 * 取这个顺序是因为它和 H3 把参考摆进上下文的顺序一致——眼睛看到的次序与 <Audio j> 的
 * 偏移口径同一套说法，用户照着画面写标签不会数错人。
 */
export const REF_DISPLAY_ORDER: RefKind[] = ["image", "video", "audio"];

/** 按展示族序重排；族内原有顺序（＝接线顺序）原样保留。 */
export function sortByDisplayFamily(cells: RefCell[]): RefCell[] {
  return REF_DISPLAY_ORDER.flatMap((kind) => cells.filter((cell) => (cell.kind ?? "image") === kind));
}

/**
 * 合并进同一行的格子：只画已经填上的，族与族之间按展示序排。
 *
 * 只有一族时调用方仍走 visibleRefCells——图片一键同款的版面一个字都不动。
 * 「+参考」不绑族，所以合并行不再替每一族摆一颗空格子。
 */
export function mergedRefCells(cells: RefCell[], refs: Record<string, ImageSummary | null>): RefCell[] {
  return sortByDisplayFamily(cells).filter((cell) => refs[cell.key]);
}

/** 还有空位的族（展示序）：决定那颗「+参考」点不点得动、素材选择器给哪几个族 tab。 */
export function openRefKinds(cells: RefCell[], refs: Record<string, ImageSummary | null>): RefKind[] {
  return REF_DISPLAY_ORDER.filter((kind) => cells.some((cell) => (cell.kind ?? "image") === kind && !refs[cell.key]));
}

/**
 * 某一族第一个空位。+参考不绑族：挑到哪一族就落这一格，
 * 天然从第 1 格连着填，跳格校验（referenceIssues）永远不会被这条路径触发。
 */
export function firstFreeRefKey(cells: RefCell[], refs: Record<string, ImageSummary | null>, kind: RefKind): string {
  return familyCells(cells, kind).find((cell) => !refs[cell.key])?.key ?? "";
}

/**
 * 弹窗打开时参考位的初始摆法，分两种情况：
 *
 *  - 这张图本身就是一键同款出的：按来源记录把当初那几张参考图原样摆回去（顺序＝参考位
 *    顺序）。用两张参考做出来的画面，点开同款就该看到那两张；只摆一张等于把多图编辑
 *    悄悄降级成单图，用户还得自己回忆当初喂了什么。
 *  - 没有来源记录（在 ComfyUI 里手动出的图）：退回把被点的那张放进「图片1」＝默认单图
 *    编辑，想要多图点「+ 参考」，想要文生图点掉 X。
 *
 * 来源比参考位多出来的张数直接丢掉：位置是工作流里接出来的，弹窗不能凭空变出格子。
 */
export function defaultReferences(
  template: CloneTemplate | null | undefined,
  source: ImageSummary | null,
  prior: CloneSourceImage[] = [],
  options: { kind?: RefKind } = {},
): Record<string, ImageSummary | null> {
  const out: Record<string, ImageSummary | null> = {};
  const cells = referenceCells(template);
  const picks = prior.filter(Boolean).slice(0, cells.length);
  if (picks.length) {
    // 记着参考位的那份先各回各位：当初站在「图片3」的那张不能因为「图片2」没了就顶上去，
    // 那样用户看到的编号就成了假的。没带 slot 的（从成图 workflow 认回来的）按族补空位——
    // 补错行比空着更糟：音频会画进图片行，用户以为当初喂的是张图。
    const free = new Set(cells.map((cell) => cell.key));
    const queue = [...picks];
    for (const image of picks) {
      const key = image.slot ?? "";
      const cell = key ? cells.find((c) => c.key === key && free.has(key)) : undefined;
      if (!cell) continue;
      out[cell.key] = image;
      free.delete(cell.key);
      queue.splice(queue.indexOf(image), 1);
    }
    for (const kind of REF_KINDS) {
      const mine = queue.filter((image) => (image.kind ?? "image") === kind);
      for (const cell of familyCells(cells, kind)) {
        if (!free.has(cell.key) || !mine.length) continue;
        const [next, ...rest] = mine;
        out[cell.key] = next;
        mine.length = 0;
        mine.push(...rest);
        free.delete(cell.key);
        queue.splice(queue.indexOf(next), 1);
      }
    }
    return out;
  }
  // 没有来源记录：从图片卡点开进「图片1」，从视频卡点开进「视频1」。
  // 这份工作流没接那一族的加载器时退回第一格，至少用户放的素材不会凭空消失。
  const want = options.kind ?? "image";
  const first = familyCells(cells, want)[0] ?? cells[0];
  if (first) out[first.key] = source ?? null;
  return out;
}

/** 这份工作流是不是只有图片一族（＝图片一键同款的老样子）。 */
export function isImageOnlyRefs(template: CloneTemplate | null | undefined): boolean {
  const families = referenceFamilies(template);
  if (families.some((family) => family !== "image")) return false;
  return !isVideoTemplate(template) && !isAudioTemplate(template);
}

/** 音频工作流且只有音频一族：叙述里直接说「参考音频/一段」，别泛称「参考素材」。 */
export function isAudioOnlyRefs(template: CloneTemplate | null | undefined): boolean {
  const families = referenceFamilies(template);
  if (families.some((family) => family !== "audio")) return false;
  return isAudioTemplate(template);
}

/** 报错文案里怎么称呼参考素材：视频工作流里说「参考图」是骗人。 */
export function referenceNoun(template: CloneTemplate | null | undefined): string {
  if (isImageOnlyRefs(template)) return "参考图";
  if (isAudioOnlyRefs(template)) return "参考音频";
  return "参考素材";
}

/** 量词跟着称呼走：三族素材混在一起时别硬说「一张」。 */
export function referenceCounter(template: CloneTemplate | null | undefined): string {
  if (isImageOnlyRefs(template)) return "张";
  if (isAudioOnlyRefs(template)) return "段";
  return "份";
}

/**
 * 提交前的参考图问题，空数组＝可以生成。两种情况：
 * 一张都没放但这工作流摘不掉参考链；或者中间空了一格（序号就是接线顺序，不能跳着填）。
 */
export function referenceIssues(
  template: CloneTemplate | null | undefined,
  refs: Record<string, ImageSummary | null>,
  canText = true,
): string[] {
  const cells = referenceCells(template);
  if (!cells.length) return [];
  const filled = cells.filter((cell) => refs[cell.key]);
  if (!filled.length) {
    return canText ? [] : [`至少放一${referenceCounter(template)}${referenceNoun(template)}`];
  }
  // 一族一族查跳格：图片填到第 6 张、音频只填第 2 段，报的是「音频1 还空着」，
  // 不会把跨族的编号混成一句看不懂的话。
  const issues: string[] = [];
  for (const kind of REF_KINDS) {
    const family = familyCells(cells, kind);
    let last = -1;
    family.forEach((cell, index) => { if (refs[cell.key]) last = index; });
    // 这一族一份都没放不算「跳格」：slice(0, -1) 会把整族除了最后一格全报成空着，
    // 于是只喂图片的用户会看到「音频1 还空着、视频1 还空着」这种莫名其妙的话。
    if (last < 0) continue;
    for (const cell of family.slice(0, last).filter((c) => !refs[c.key])) issues.push(`${cell.label} 还空着`);
  }
  return issues;
}

export function defaultControlValues(template: CloneTemplate | null | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const slot of controlSlots(template)) {
    if (typeof slot.value === "number" || typeof slot.value === "string") out[slotKey(slot)] = slot.value;
  }
  return out;
}

export interface GenerateRequest {
  template_id: number;
  prompt: string;
  /** 主框之外的文字位（键 =「节点.输入」）；没有附框就不带这个键。 */
  slot_prompts?: Record<string, string>;
  references: { slot: string; image_id: number }[];
  controls: Record<string, string | number>;
  source_image_id: number | null;
}

/**
 * 只提交填好的参考位与非空控件值，键名一定是模板声明过的那些。
 * 请求里没有 mode：生成方式是「几张参考图」这件事的结果，后端自己数（clone_jobs.plan_request）。
 */
export function buildGenerateRequest(args: {
  templateId: number;
  prompt: string;
  references: Record<string, ImageSummary | null>;
  controls: Record<string, string | number>;
  sourceImageId: number | null;
  /** referenceCells 的 key 顺序；不传就按 references 里已有的键序 */
  cellOrder?: string[];
  /** 附框（参考音频的原话等）填的内容；空的那几条不提交，让后端回落成主提示词 */
  slotPrompts?: Record<string, string>;
}): GenerateRequest {
  const rawReferences: { slot: string; image_id: number }[] = [];
  for (const [slot, image] of Object.entries(args.references)) {
    if (image) rawReferences.push({ slot, image_id: image.id });
  }
  const controls: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(args.controls)) {
    if (value !== null && value !== undefined && value !== "") controls[key] = value;
  }
  // 按参考位的画面顺序提交：序号＝接线顺序，后端据此数出文生图/单图/多图
  const order = new Map((args.cellOrder ?? Object.keys(args.references)).map((key, index) => [key, index]));
  const references = rawReferences
    .sort((a, b) => (order.get(a.slot) ?? 0) - (order.get(b.slot) ?? 0));
  const slotPrompts: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.slotPrompts ?? {})) {
    if (typeof value === "string" && value.trim()) slotPrompts[key] = value;
  }
  const request: GenerateRequest = { template_id: args.templateId, prompt: args.prompt.trim(), references, controls, source_image_id: args.sourceImageId };
  // 没有附框的工作流不该凭空多出一个键：老请求体一字不改，测试与后端都按原样认。
  if (Object.keys(slotPrompts).length) request.slot_prompts = slotPrompts;
  return request;
}

// ---------- 提示词来源 ----------

export type PromptOrigin = "image" | "recorded" | "none";

/**
 * 预填顺序：这张产出自带的 ComfyUI 提示词 → 当初生成时记下的那句 → 最新一条反推提示词 → 空。
 * 中间那条为什么要有：flac 之类的产出带不走提示词（PNG 有 tEXt、片子有元数据），
 * 不记下来，点「一键同款」就是一句空白的台词。
 * 工作流内置那条不自动填：换了参考图之后，工作流里的原文十有八九对不上内容；
 * 但给一个按钮让人一键填回来（见 shouldOfferWorkflowPrompt）。
 */
export function resolvePromptSource(input: {
  imagePrompt?: string | null;
  reversePrompt?: string | null;
  /** 生成当时记在来源里的那句：音频文件带不走提示词，只有这条路说得清。 */
  recordedPrompt?: string | null;
}): { text: string; origin: PromptOrigin } {
  const image = (input.imagePrompt ?? "").trim();
  if (image) return { text: image, origin: "image" };
  // 记下来的那句排在反推前面：反推是看图猜的，记下来的是当初真喂进去的
  const recorded = (input.recordedPrompt ?? "").trim();
  if (recorded) return { text: recorded, origin: "recorded" };
  const reverse = (input.reversePrompt ?? "").trim();
  if (reverse) return { text: reverse, origin: "image" };
  return { text: "", origin: "none" };
}

export function promptSourceLabel(origin: PromptOrigin): string {
  if (origin === "image") return "已带上这张图自己的提示词";
  if (origin === "recorded") return "已带上当初生成时用的提示词";
  return "提示词为空时会用工作流里内置的那条";
}

/** 提示词框下面的「填入工作流内置提示词」什么时候出现。 */
export function shouldOfferWorkflowPrompt(promptText: string, workflowPrompt: string): boolean {
  return !promptText.trim() && Boolean(workflowPrompt.trim());
}

/** 反推历史按新→旧排，只要第一条有中文的。 */
export function latestReversePrompt(items: { prompt_zh?: string | null }[] | undefined | null): string {
  for (const item of items ?? []) {
    const text = (item?.prompt_zh ?? "").trim();
    if (text) return text;
  }
  return "";
}

// ---------- 参数面板（弹窗底部那颗 pill 弹出来的菜单） ----------

/** 去掉 ComfyUI 选项里括号中的说明：「9:16 (Portrait Widescreen)」→「9:16」。 */
/**
 * ComfyUI 的 combo 选项常常是英文原名（语种最典型：Auto / Chinese / Japanese）。
 * 面板上按中文念，提交给 ComfyUI 的仍然是原值——翻译只发生在显示这一层。
 * 认不出的照原样显示，绝不猜：宁可多一个英文词，也不能把某个自定义选项翻译成奇怪的东西。
 */
const LANGUAGE_LABELS: Record<string, string> = {
  auto: "自动", none: "不指定", default: "默认", multilingual: "多语种",
  chinese: "中文", zh: "中文", mandarin: "普通话", cantonese: "粤语", yue: "粤语",
  english: "英文", en: "英文", japanese: "日文", ja: "日文", korean: "韩文", ko: "韩文",
  german: "德文", de: "德文", french: "法文", fr: "法文", spanish: "西班牙文", es: "西班牙文",
  italian: "意大利文", it: "意大利文", portuguese: "葡萄牙文", pt: "葡萄牙文",
  russian: "俄文", ru: "俄文", thai: "泰文", th: "泰文", vietnamese: "越南文", vi: "越南文",
  arabic: "阿拉伯文", ar: "阿拉伯文", hindi: "印地文", hi: "印地文",
};

export function languageLabel(option: string): string {
  const key = String(option ?? "").trim().toLowerCase().replace(/[_\s]+/g, " ");
  return LANGUAGE_LABELS[key] ?? "";
}

export function optionLabel(option: string): string {
  const text = String(option ?? "").trim();
  const cut = text.search(/[（(\[]/);
  const base = (cut > 0 ? text.slice(0, cut).trim() : text) || text;
  // 语种这类选项在这里换成中文；括号后缀（比如「Chinese（中文）」）已经先被切掉了
  const zh = languageLabel(base);
  if (zh) return zh;
  // 音色那类下拉的选项是模型内部的名字（Uncle_Fu、Ono_Anna）：下划线在按钮里读着像代码，
  // 换成空格。认不出是谁就照原样显示，绝不替模型编一个中文人名。
  return base.replace(/_+/g, " ").trim() || base;
}

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

const RATIO_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*[:：xX×]\s*(\d+(?:\.\d+)?)\s*$/;

export interface RatioShape {
  /** 面板上显示的字，认不出比例时就是原选项文字 */
  label: string;
  /** 真实宽高比，认不出来时为 null（那就只排文字，不画框） */
  ratio: { w: number; h: number } | null;
  /** 小方框的像素尺寸（最长边 26px，最短边不低于 7px），认不出比例时为 0 */
  box: { w: number; h: number };
}

/** 把 combo 里的一个选项变成能画小方框的数据，版式照的是主流生图工具的比例菜单。 */
export function ratioShape(option: string): RatioShape {
  const label = optionLabel(option);
  const matched = RATIO_PATTERN.exec(label);
  const w = matched ? Number(matched[1]) : 0;
  const h = matched ? Number(matched[2]) : 0;
  if (!matched || !w || !h || !Number.isFinite(w) || !Number.isFinite(h)) {
    return { label, ratio: null, box: { w: 0, h: 0 } };
  }
  const scale = 26 / Math.max(w, h);
  return { label, ratio: { w, h }, box: { w: Math.max(7, Math.round(w * scale)), h: Math.max(7, Math.round(h * scale)) } };
}

/** 数值控件的单位后缀：只有百万像素那种带 MP，别的一律裸数字，不瞎猜单位。 */
export function numberUnit(slot: CloneSlot): string {
  // 后端认得出的单位才显示（时长带「秒」）；剩下仍只认百万像素那种 MP，不瞎猜。
  if (slot.unit) return slot.unit;
  const text = `${slot.label ?? ""} ${slot.input ?? ""}`.toLowerCase();
  return /mega|百万/.test(text) ? "MP" : "";
}

const NUMBER_PRESETS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 6, 8];
const DURATION_PRESETS = [5, 8, 10, 12, 15];

/**
 * 数值档位：后端给了 presets 就照它的（时长那档是 5/8/10/12/15 秒，
 * 用分辨率那张通用表会给出 0.5 秒这种没人能跑的片子）。没给才退回通用表 + min/max 收窄。
 */
export function numberPresets(slot: CloneSlot): number[] {
  const min = typeof slot.min === "number" ? slot.min : -Infinity;
  const max = typeof slot.max === "number" ? slot.max : Infinity;
  const declared = (slot.presets ?? []).filter((v) => typeof v === "number" && v >= min && v <= max);
  if (declared.length) {
    const current = typeof slot.value === "number" ? slot.value : null;
    if (current !== null && !declared.includes(current)) declared.push(current);
    return declared.sort((a, b) => a - b).slice(0, 12);
  }
  const values = ((slot.label ?? "").includes("时长") || (slot.unit ?? "") === "秒"
    ? DURATION_PRESETS
    : NUMBER_PRESETS).filter((v) => v >= min && v <= max);
  const current = typeof slot.value === "number" ? slot.value : null;
  if (current !== null && current >= min && current <= max && !values.includes(current)) values.push(current);
  return values.sort((a, b) => a - b).slice(0, 10);
}

export function formatControlValue(slot: CloneSlot, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  if (slot.kind === "select") return optionLabel(String(value));
  return `${value}${numberUnit(slot)}`;
}

/** 底部 pill 上的汇总，例：「9:16 / 2.2MP」。 */
export function controlSummary(
  template: CloneTemplate | null | undefined,
  controls: Record<string, string | number>,
): string {
  return controlSlots(template)
    .map((slot) => formatControlValue(slot, controls[slotKey(slot)]))
    .filter(Boolean)
    .join(" / ");
}

/** 一张参考图，外加生成当时记下的参考位（只有库里记的那份才有，见 defaultReferences）。 */
export type CloneSourceImage = ImageSummary & { slot?: string; kind?: string };

/**
 * 这份来源是怎么来的，弹窗据此决定要不要跟用户解释：
 * db＝生成当时记下的；file＝从成图自己的 workflow 认回来的（只有顺序，没有 slot）；
 * unrecorded＝这张是 AI 出的图，但参考图认不出来；""＝说不清（导入的照片、没带 workflow）。
 */
export type CloneSourceOrigin = "db" | "file" | "unrecorded" | "";

/**
 * 一键同款的来源：产出图当初喂的参考图（已按参考位顺序排好）。
 * dropped 是「当初喂过、如今在图库里认不出来」的张数，弹窗要如实说出来，不能默默少一张。
 */
export interface CloneSources {
  references: CloneSourceImage[];
  template_id: number | null;
  source_image_id: number | null;
  dropped: number;
  origin?: CloneSourceOrigin;
  /** 当初提交的那句提示词。音频（以及任何不带元数据的产出）只能从这里拿回来。 */
  prompt?: string;
  /** 附框当初的值，键是「节点.输入」。只用于当初那条工作流。 */
  slot_prompts?: Record<string, string>;
}

export const CLONE_SETTINGS_TAB = "一键同款";

// ---------- 接口 ----------

export const cloneApi = {
  templates(): Promise<{ items: CloneTemplate[] }> {
    return api.http<{ items: CloneTemplate[] }>("/api/clone/templates");
  },
  inspect(payload: { workflow?: unknown; path?: string }): Promise<CloneInspect> {
    return api.http<CloneInspect>("/api/clone/templates/inspect", { method: "POST", body: JSON.stringify(payload) });
  },
  create(payload: {
    name: string; workflow?: unknown; path?: string; slots?: CloneSlot[]; media_kind?: MediaKind;
  }): Promise<CloneTemplate> {
    return api.http<CloneTemplate>("/api/clone/templates", { method: "POST", body: JSON.stringify(payload) });
  },
  update(id: number, patch: {
    name?: string; workflow?: unknown; slots?: CloneSlot[]; is_active?: boolean; media_kind?: MediaKind;
  }): Promise<CloneTemplate> {
    return api.http<CloneTemplate>(`/api/clone/templates/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  },
  remove(id: number): Promise<{ ok: boolean; deleted: number }> {
    return api.http<{ ok: boolean; deleted: number }>(`/api/clone/templates/${id}`, { method: "DELETE" });
  },
  /** 导出：把 JSON 文本交给调用方落盘，不新增上传接口。 */
  workflow(id: number): Promise<string> {
    return api.http<string>(`/api/clone/templates/${id}/workflow`);
  },
  /** 按存着的工作流重新检测槽位：导入时 ComfyUI 没开的话，比例/分辨率靠这个补回来。 */
  redetect(id: number): Promise<CloneTemplate> {
    return api.http<CloneTemplate>(`/api/clone/templates/${id}/redetect`, { method: "POST" });
  },
  nodes(id: number): Promise<CloneNodeOverview[]> {
    return api.http<{ nodes: CloneNodeOverview[] }>(`/api/clone/templates/${id}/nodes`).then((r) => r.nodes);
  },
  generate(body: GenerateRequest): Promise<CloneJob> {
    return api.http<CloneJob>("/api/clone/generate", { method: "POST", body: JSON.stringify(body) });
  },
  /** 反推历史：弹窗取最新一条中文提示词。走 clone 自己的接口层，省得把整个反推模块拖进这个弹窗。 */
  reverseHistory(id: number): Promise<{ items: { prompt_zh?: string | null }[] }> {
    return api.http<{ items: { prompt_zh?: string | null }[] }>(`/api/images/${id}/reverse-prompts?offset=0`);
  },
  detail(id: number): Promise<ImageDetail> {
    return api.http<ImageDetail>(`/api/images/${id}`);
  },
  /** 这张图当初喂了哪几张参考图。一键同款生成过的才有，没记过时 references 是空的。 */
  sources(id: number): Promise<CloneSources> {
    return api.http<CloneSources>(`/api/clone/sources/${id}`);
  },
  currentJob(): Promise<CloneJob> {
    return api.http<CloneJob>("/api/clone/jobs/current");
  },
  cancelJob(): Promise<CloneJob> {
    return api.http<CloneJob>("/api/clone/jobs/current/cancel", { method: "POST" });
  },
};

/** 后端错误统一是 {detail:"中文"}；没有 detail 时退回 message，绝不显示 undefined。 */
export function cloneError(error: unknown): string {
  const withDetail = error as { detail?: string; message?: string };
  return withDetail?.detail || withDetail?.message || "操作失败，请确认图库后端正在运行。";
}


/* ── @ 引用素材 ──────────────────────────────────────────────────────
   提示词里打 @ 就能指着参考图说话（@图片1 换衣服，@图片2 借姿势）。
   这里只放纯逻辑：命中判断、候选列表、插入文本、光标测位。
   弹窗那边只管「什么时候弹、弹在哪儿」，这几件事全部可单测。 */

/* ── 点产出图 → 直接和原图对比 ───────────────────────────────────────
   Lightbox 的对比条件是「正好两张被选中」，所以点弹窗里的产出图要做的是
   把「原图 + 产出图」这两张一起选中，再让 Lightbox 打开。
   前提是两张都还在当前列表里（筛选、翻页都可能把原图挪出去）：
   少一张就别硬凑对比，交回调用方退回「只选中产出图」。 */

export function comparePair(sourceId: number | null | undefined, producedId: number, feedIds: number[]): number[] | null {
  if (!sourceId || sourceId === producedId) return null;
  return feedIds.includes(sourceId) && feedIds.includes(producedId) ? [sourceId, producedId] : null;
}


export interface MentionToken { start: number; end: number; query: string }

/**
 * caret 前面是不是一个还没打完的 @token。
 * 查询串只收「汉字 / 字母 / 数字 / _ / -」，长度上限 32：
 * 中文逗号句号不是 \s，只用「遇空格才收」的话，打完「@图片1，一镜到底」菜单会一直挂着。
 */
export function mentionToken(text: string, caret: number): MentionToken | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const hit = /@([\u4e00-\u9fff\w-]{0,32})$/.exec(before);
  if (!hit) return null;
  return { start: before.length - hit[0].length, end: before.length, query: hit[1] };
}

export interface MentionItem {
  key: string;
  /** 菜单上显示的「图片N / 音频N / 视频N」，跟参考条上的编号一字不差 */
  label: string;
  /** 真正写进提示词的文本：图片工作流是 @图片N，H3 视频工作流是 <Picture 1> */
  insert: string;
  kind: RefKind;
  filename: string;
  thumb: string;
  /** true = 「再从图库挂一张」那条动作，不是一张已经存在的图 */
  add: boolean;
}

/**
 * 写进提示词的引用文本。
 *
 * 图片那条链路一个字不改：Qwen 的工作流里 @图片N 是提示词自己写的记号，
 * 模型读的就是这两个字符加编号。H3 不认这个——它在自己拼上下文时用的是
 * "<Picture 1>: "（comfy/text_encoders/minimax.py），提示词里只有写成同样的
 * 尖括号标签，模型才知道「Picture 1」指的是第 1 张参考图，写 @图片1 就是一行普通文字。
 */
export function mentionInsertText(cell: RefCell, mediaKind: MediaKind | undefined): string {
  if (mediaKind !== "video") return `@${cell.label}`;
  return cell.tag || refTag((cell.kind ?? "image") as RefKind, cell.ordinal ?? 1);
}

/**
 * 「@」菜单末尾那颗「再去挂一份」的文案。它指向的是第一个空着的格子，那一格可能是音频也可能是视频，
 * 量词与名词必须跟着那一族走——音频位空着时菜单上还写着「再挂一张参考图」，用户会以为点进去挑的是图。
 */
export function mentionAddLabel(kind: RefKind): string {
  if (kind === "image") return "从图库再挂一张参考图";
  return `从图库再挂一${REF_KIND_COUNTERS[kind]}参考${REF_KIND_NAMES[kind]}`;
}

const mentionNorm = (value: string) => value.toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]/g, "");

/** 「图2」「图片2」「2」都命中图片2；文件名也搜——只记得画面不记得编号的时候用得上。 */
export function matchMention(label: string, filename: string, query: string): boolean {
  const q = mentionNorm(query);
  if (!q) return true;
  if (mentionNorm(label).includes(q) || mentionNorm(filename).includes(q)) return true;
  const digits = q.replace(/\D/g, "");
  const tail = /(\d+)$/.exec(label)?.[1] ?? "";
  return Boolean(digits) && digits === tail;
}

/**
 * 菜单 = 已经挂上参考位的图（图片N + 文件名）+ 末尾一条「再从图库挂一张」。
 * 只有挂进参考位的图才值得 @：模型看得见的是那几张，没挂上来的图 @ 了也是空话。
 */
export function mentionItems(
  cells: RefCell[],
  refs: Record<string, ImageSummary | null>,
  query = "",
  mediaKind: MediaKind | undefined = "image",
): MentionItem[] {
  if (!cells.length) return [];
  const filled: MentionItem[] = cells
    .filter((cell) => refs[cell.key])
    .map((cell) => {
      const picked = refs[cell.key];
      return {
        key: cell.key,
        label: cell.label,
        insert: mentionInsertText(cell, mediaKind),
        kind: (cell.kind ?? "image") as RefKind,
        filename: picked?.filename ?? "",
        thumb: picked?.thumbnail_url || picked?.original_url || "",
        add: false,
      };
    });
  const items = query ? filled.filter((item) => matchMention(item.label, item.filename, query)) : filled;
  const room = cells.find((cell) => !refs[cell.key]);
  if (room) {
    items.push({
      key: room.key, label: "", insert: "", kind: (room.kind ?? "image") as RefKind,
      filename: "", thumb: "", add: true,
    });
  }
  return items;
}

/**
 * 把 caret 前那段 @xxx 换成引用文本，后面补一个空格，光标停在空格后面接着打字。
 * 传进来的已经是最终文本（@图片1 或 <Picture 1>），这里不再自己拼 @。
 */
export function applyMention(
  text: string,
  token: MentionToken,
  labelOrInsert: string,
): { text: string; caret: number } {
  const inserted = labelOrInsert.startsWith("@") || labelOrInsert.startsWith("<")
    ? labelOrInsert
    : `@${labelOrInsert}`;
  const withSpace = `${inserted} `;
  return {
    text: text.slice(0, token.start) + withSpace + text.slice(token.end),
    caret: token.start + withSpace.length,
  };
}

export interface CaretBox { left: number; top: number; height: number }

const CARET_STYLE_PROPS = [
  "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight",
  "textTransform", "textIndent", "whiteSpace", "wordBreak",
];

/**
 * 光标在 textarea 里的像素位置：抄一份同样式的隐形 div，量光标处那个 span 的 rect。
 * 没有布局引擎（happy-dom）时所有 rect 都是 0，菜单退回框子左上角，不炸就行。
 */
export function caretCoordinates(el: HTMLTextAreaElement, position: number): CaretBox {
  const fallback: CaretBox = { left: 0, top: 0, height: 20 };
  const host = el.parentElement;
  if (!host || typeof window === "undefined") return fallback;
  const kebab = (name: string) => name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
  let mirror: HTMLDivElement | null = null;
  try {
    const computed = window.getComputedStyle(el);
    const lineHeight = Number.parseFloat(computed.lineHeight) || Number.parseFloat(computed.fontSize) * 1.5 || 20;
    const value = el.value;
    const at = Math.max(0, Math.min(position, value.length));
    mirror = document.createElement("div");
    mirror.style.position = "absolute";
    mirror.style.top = "0";
    mirror.style.left = "0";
    mirror.style.visibility = "hidden";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.wordBreak = "break-word";
    mirror.style.overflow = "hidden";
    for (const prop of CARET_STYLE_PROPS) mirror.style.setProperty(kebab(prop), computed.getPropertyValue(kebab(prop)));
    mirror.textContent = value.slice(0, at);
    const marker = document.createElement("span");
    marker.textContent = value.slice(at) || ".";
    mirror.appendChild(marker);
    host.appendChild(mirror);
    const markerBox = marker.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return { left: markerBox.left - box.left, top: markerBox.top - box.top - el.scrollTop, height: lineHeight };
  } catch {
    return fallback;
  } finally {
    mirror?.remove();
  }
}

export interface PromptChunk { text: string; mention: boolean }

/**
 * 把提示词切成「普通文字 / @图片N 引用」两段一类，喂给输入框背后的高亮遮罩。
 * 只认 @图片N 和 @图N（@ 后面必须紧跟数字）——邮箱、@谁谁 这类不点亮，免得满屏红。
 * 结尾是换行时补一个零宽字符：textarea 会为此多画一行，遮罩少一行的话滚到底就错位。
 */
export function mentionChunks(text: string): PromptChunk[] {
  const chunks: PromptChunk[] = [];
  // @图片N（图片工作流）与 <Picture 1> / <Audio 2> / <Video 1>（H3）都算引用，
  // 遮罩高亮必须跟插入的文本一致，否则插进去的东西在输入框里成了普通字。
  const re = /@(?:图片|图|音频|音|视频|片)\d+|<(?:Picture|Audio|Video)\s*\d+>/gi;
  let cursor = 0;
  let hit = re.exec(text);
  while (hit) {
    if (hit.index > cursor) chunks.push({ text: text.slice(cursor, hit.index), mention: false });
    chunks.push({ text: hit[0], mention: true });
    cursor = hit.index + hit[0].length;
    hit = re.exec(text);
  }
  const rest = text.slice(cursor) + (text.endsWith("\n") ? "\u200b" : "");
  if (rest) chunks.push({ text: rest, mention: false });
  return chunks;
}
