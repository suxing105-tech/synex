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

export type CloneSlotKind = "prompt" | "image" | "select" | "number";

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
  grow?: { node: string; group: string; names: string[] } | null;
  /** select 专用：导入时从 ComfyUI 缓存下来的可选项，ComfyUI 没开也能画下拉 */
  options?: string[];
  value?: string | number | null;
  min?: number | null;
  max?: number | null;
  step?: number | null;
}

export interface CloneTemplate {
  id: number;
  name: string;
  slots: CloneSlot[];
  default_prompt: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  node_count: number;
  prompt_count: number;
  /** 这份工作流支持的生成档位；前端只用它判断「能不能一张参考图都不放」 */
  modes?: CloneMode[];
  reference_count: number;
  control_count: number;
}

/**
 * 给用户看的工作流名字。
 *
 * 从本地导入的那份文件名尾巴上挂着 .json——那是文件名去不掉的后缀，不是名字的一部分，
 * 显示出来只会让底部那颗 pill 白白变长、切换列表里两条看着一模一样。库里已有的名字
 * 也走这里，用户不必为了去掉后缀重导一遍。
 */
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
  template_id: number | null;
  source_image_id: number | null;
  elapsed: number;
}

export const EMPTY_CLONE_JOB: CloneJob = {
  active: false, job_id: "", state: "", running: false, message: "", error: "",
  image_ids: [], template_id: null, source_image_id: null, elapsed: 0,
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
    template_id: raw.template_id === null || raw.template_id === undefined ? null : Number(raw.template_id),
    source_image_id: raw.source_image_id === null || raw.source_image_id === undefined ? null : Number(raw.source_image_id),
    elapsed: Number(raw.elapsed ?? 0) || 0,
  };
  cloneJob.set(job);
  return job;
}

const STATE_LABELS: Record<CloneState, string> = {
  uploading: "上传参考图…",
  queued: "提交到 ComfyUI…",
  running: "生成中…",
  downloading: "登记生成结果…",
  done: "已生成",
  error: "生成失败",
  cancelled: "已取消",
};

export function cloneStatusLabel(job: CloneJob): string {
  if (!job.state) return "";
  const label = STATE_LABELS[job.state];
  if (job.state === "done" && job.image_ids.length) return `${label} ${job.image_ids.length} 张`;
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

export function modeLabel(mode: CloneMode): string {
  return CLONE_MODE_LABELS[mode] ?? mode;
}

export interface RefCell {
  key: string;
  label: string;
  /** 这一格最终喂给哪个 LoadImage（节点标题），放进 title 里方便核对 */
  slotLabel: string;
}

/**
 * 弹窗里的参考位 = 工作流真槽位 + autogrow 续出来的格子，按画面顺序编号「图片1…N」。
 * 数量与档位无关：档位是「填了几张」的结果，不是「能摆几格」的前提。
 * 续位的 key 与后端 clone_templates.grow_key 一致（node.input::image_2），原样透传回去。
 *
 * 扩位按「目标节点+图组+格名」去重：两台 LoadImage 往往长进同一个图组，
 * 不去重就会数出双倍的格子，还会在同一格里互相覆盖。
 * 顺序必须和后端 clone_templates.reference_cell_keys 一模一样，否则编号和实际接线对不上。
 */
export function referenceCells(template: CloneTemplate | null | undefined): RefCell[] {
  const slots = imageSlots(template);
  const label = (slot: CloneSlot) => slot.label || slotKey(slot);
  const cells: RefCell[] = [];
  // 先把工作流真槽位排完再排扩位：交错排的话，第二台 LoadImage 会被第一台的十几个
  // 扩位推到最后，用户看到的就是「图片1、图片2、图片16」——编号像坏了。
  for (const slot of slots) {
    cells.push({ key: slotKey(slot), label: `图片${cells.length + 1}`, slotLabel: label(slot) });
  }
  const claimed = new Set<string>();
  for (const slot of slots) {
    for (const name of slot.grow?.names ?? []) {
      const target = `${slot.grow?.node}.${slot.grow?.group}::${name}`;
      if (claimed.has(target)) continue;
      claimed.add(target);
      cells.push({ key: `${slotKey(slot)}::${name}`, label: `图片${cells.length + 1}`, slotLabel: label(slot) });
    }
  }
  return cells;
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
): Record<string, ImageSummary | null> {
  const out: Record<string, ImageSummary | null> = {};
  const cells = referenceCells(template);
  const picks = prior.filter(Boolean).slice(0, cells.length);
  if (picks.length) {
    // 记着参考位的那份先各回各位：当初站在「图片3」的那张不能因为「图片2」没了就顶上去，
    // 那样用户看到的编号就成了假的。没带 slot 的（从成图 workflow 认回来的）按顺序补空位。
    const free = new Set(cells.map((cell) => cell.key));
    const queue = [...picks];
    for (const image of picks) {
      const key = image.slot ?? "";
      if (!key || !free.has(key)) continue;
      out[key] = image;
      free.delete(key);
      queue.splice(queue.indexOf(image), 1);
    }
    for (const cell of cells) {
      if (!free.has(cell.key) || !queue.length) continue;
      out[cell.key] = queue.shift()!;
      free.delete(cell.key);
    }
    return out;
  }
  const [first] = cells;
  if (first) out[first.key] = source ?? null;
  return out;
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
  if (!filled.length) return canText ? [] : ["至少放一张参考图"];
  let last = 0;
  cells.forEach((cell, index) => { if (refs[cell.key]) last = index; });
  return cells.slice(0, last).filter((cell) => !refs[cell.key]).map((cell) => `${cell.label} 还空着`);
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
  return { template_id: args.templateId, prompt: args.prompt.trim(), references, controls, source_image_id: args.sourceImageId };
}

// ---------- 提示词来源 ----------

export type PromptOrigin = "image" | "none";

/**
 * 预填顺序：这张图自带的 ComfyUI 提示词 → 最新一条反推提示词 → 空。
 * 工作流内置那条不自动填：换了参考图之后，工作流里的原文十有八九对不上内容；
 * 但给一个按钮让人一键填回来（见 shouldOfferWorkflowPrompt）。
 */
export function resolvePromptSource(input: {
  imagePrompt?: string | null;
  reversePrompt?: string | null;
}): { text: string; origin: PromptOrigin } {
  const image = (input.imagePrompt ?? "").trim();
  if (image) return { text: image, origin: "image" };
  const reverse = (input.reversePrompt ?? "").trim();
  if (reverse) return { text: reverse, origin: "image" };
  return { text: "", origin: "none" };
}

export function promptSourceLabel(origin: PromptOrigin): string {
  return origin === "image" ? "已带上这张图自己的提示词" : "提示词为空时会用工作流里内置的那条";
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
export function optionLabel(option: string): string {
  const text = String(option ?? "").trim();
  const cut = text.search(/[（(\[]/);
  return (cut > 0 ? text.slice(0, cut).trim() : text) || text;
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
  const text = `${slot.label ?? ""} ${slot.input ?? ""}`.toLowerCase();
  return /mega|百万/.test(text) ? "MP" : "";
}

const NUMBER_PRESETS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 6, 8];

/** 分辨率档位：常量表按 min/max 收窄，再把工作流当前值补进去，否则默认值在面板里选不中。 */
export function numberPresets(slot: CloneSlot): number[] {
  const min = typeof slot.min === "number" ? slot.min : -Infinity;
  const max = typeof slot.max === "number" ? slot.max : Infinity;
  const values = NUMBER_PRESETS.filter((v) => v >= min && v <= max);
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
export type CloneSourceImage = ImageSummary & { slot?: string };

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
  create(payload: { name: string; workflow?: unknown; path?: string; slots?: CloneSlot[] }): Promise<CloneTemplate> {
    return api.http<CloneTemplate>("/api/clone/templates", { method: "POST", body: JSON.stringify(payload) });
  },
  update(id: number, patch: { name?: string; workflow?: unknown; slots?: CloneSlot[]; is_active?: boolean }): Promise<CloneTemplate> {
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
  /** 显示和插入用的是同一个「图片N」，跟参考条上的编号一字不差 */
  label: string;
  filename: string;
  thumb: string;
  /** true = 「再从图库挂一张」那条动作，不是一张已经存在的图 */
  add: boolean;
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
): MentionItem[] {
  if (!cells.length) return [];
  const filled: MentionItem[] = cells
    .filter((cell) => refs[cell.key])
    .map((cell) => {
      const picked = refs[cell.key];
      return {
        key: cell.key,
        label: cell.label,
        filename: picked?.filename ?? "",
        thumb: picked?.thumbnail_url || picked?.original_url || "",
        add: false,
      };
    });
  const items = query ? filled.filter((item) => matchMention(item.label, item.filename, query)) : filled;
  const room = cells.find((cell) => !refs[cell.key]);
  if (room) items.push({ key: room.key, label: "", filename: "", thumb: "", add: true });
  return items;
}

/** 把 caret 前那段 @xxx 换成 @图片N，后面补一个空格，光标停在空格后面接着打字。 */
export function applyMention(text: string, token: MentionToken, label: string): { text: string; caret: number } {
  const inserted = `@${label} `;
  return {
    text: text.slice(0, token.start) + inserted + text.slice(token.end),
    caret: token.start + inserted.length,
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
  const re = /@(?:图片|图)\d+/g;
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
