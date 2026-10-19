import { writable } from "svelte/store";
import { http } from "./api";
import { errorMessage } from "./reverse-prompts";

export type PromptTarget = "seedance2" | "h3";
export type FrameEdge = "first" | "last";
export type H3Mode = "t2va" | "i2va" | "fl2va" | "ref2va";
export type TranslationLanguage = "zh" | "en";
export const TARGETS: PromptTarget[] = ["seedance2", "h3"];
export const TARGET_LABELS: Record<PromptTarget, string> = { seedance2: "Seedance 2.0", h3: "MiniMax H3" };
export const H3_MODES: H3Mode[] = ["t2va", "i2va", "fl2va", "ref2va"];
export const H3_MODE_LABELS: Record<H3Mode, string> = {
  t2va: "T2VA 纯文本", i2va: "I2VA 首帧图", fl2va: "FL2VA 首尾帧", ref2va: "Ref2VA 参考生视频",
};
export const TRANSLATION_LABELS: Record<TranslationLanguage, string> = { zh: "中文", en: "英文" };

/** 服务端按版本存的一条译文；正文本身不受影响。 */
export interface PromptTranslation {
  record_id: number; language: TranslationLanguage; text: string;
  model_name: string; model: string; created_at: string;
}
export interface TranslationResponse extends PromptTranslation { source: "cache" | "model" }

export interface VideoPromptDefaults {
  instruction_plan: string; instruction_seedance: string; instruction_h3: string;
  default_h3_mode: H3Mode; frame_limit: number; max_unit_seconds: number; max_units: number;
}
export interface VideoPromptSettings extends VideoPromptDefaults {
  id: number; default_model_id: number | null; defaults: VideoPromptDefaults;
}
export interface SegmentRecord {
  id: number; segment_index: number; target: PromptTarget; h3_mode: H3Mode | null; prompt: string;
  risk_terms: string[]; raw_text: string; status: "complete" | "format_warning" | "unstructured";
  source: "generated" | "edited"; parent_id: number | null; model_name: string; model: string;
  created_at: string; video_changed: boolean;
  /** 当前版本的译文，没有则 null。只在阅读时替换正文显示。 */
  translation: PromptTranslation | null;
  /** 正文引用了哪些参考素材；T2VA 这类不引用图片的正文是空表。 */
  references: PromptReference[];
}
/** 素材类型：只有这三类是要上传的文件，<Subject N> 是正文里的内容标签。 */
export type ReferenceSlot = "picture" | "video" | "audio";
/** MiniMax H3 参考生视频的上传上限。 */
export const SLOT_LIMITS: Record<ReferenceSlot, number> = { picture: 6, video: 3, audio: 3 };
export const SLOT_LABELS: Record<ReferenceSlot, string> = { picture: "图", video: "视频", audio: "音频" };

/** 正文里的一条引用：label 照抄，what 说清要上传什么，frame 是本工具能直接给的对照帧。 */
export interface PromptReference {
  label: string; what: string;
  frame: { index: number; edge: FrameEdge } | null;
  warn: string | null;
  /** 要上传的文件类型；决定缩略图、导出文件名与上限计数。 */
  slot: ReferenceSlot;
}
/** 每类素材各要几个，用于清单标题与超限告警。 */
export function countSlots(refs: PromptReference[]): Record<ReferenceSlot, number> {
  const counts: Record<ReferenceSlot, number> = { picture: 0, video: 0, audio: 0 };
  refs.forEach((item) => { counts[item.slot] += 1; });
  return counts;
}
/** 超出 MiniMax 上限的素材类型，前端据此红字提示。 */
export function overSlots(refs: PromptReference[]): ReferenceSlot[] {
  const counts = countSlots(refs);
  return (Object.keys(SLOT_LIMITS) as ReferenceSlot[]).filter((slot) => counts[slot] > SLOT_LIMITS[slot]);
}
export interface PromptShot { start_ms: number; end_ms: number; synthetic: boolean }
export interface PromptUnit {
  index: number; start_ms: number; end_ms: number; shots: PromptShot[]; role: string;
  warn: string | null; current: Partial<Record<PromptTarget, SegmentRecord>>;
  /** 服务端已落盘的本段首/末帧秒数，即提示词引用的那张图。 */
  frames?: Partial<Record<FrameEdge, { at: number }>>;
}
/** 提示词引用的参考帧。source=cache 表示方案算好时就落盘的那一帧。 */
export interface ReferenceFrame {
  edge: FrameEdge; at: number; requested_at: number; source: "cache" | "video"; data_url: string;
}
export interface PromptRun {
  id: number; status: "planned" | "failed"; error: string | null; created_at: string;
  model_name: string; model: string; range_start_ms: number; range_end_ms: number;
  anchors_text: string; sound_note: string; max_unit_seconds: number; risk_terms: string[];
  video_changed: boolean; units: PromptUnit[]; versions: Record<PromptTarget, number>;
}
export interface VideoPromptHistory {
  runs: PromptRun[]; total: number; limit: number; offset: number;
  running: boolean; running_plan: boolean; running_segments: string[];
}
export interface PlanRequest {
  model_config_id?: number | null; sound_note?: string | null;
  start_ms?: number | null; end_ms?: number | null; max_unit_seconds?: number | null;
}
export interface FrameResponse { at: number; duration_ms: number; data_url: string }
export interface VersionList { records: SegmentRecord[]; total: number; limit: number; offset: number }

const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });
const base = (videoId: number) => `/api/videos/${videoId}/video-prompts`;

export const videoPromptApi = {
  settings: () => http<VideoPromptSettings>("/api/video-prompt-settings"),
  saveSettings: (value: VideoPromptSettings) => http<VideoPromptSettings>("/api/video-prompt-settings", json("PUT", value)),
  history: (videoId: number, limit = 10, offset = 0) =>
    http<VideoPromptHistory>(`${base(videoId)}?limit=${limit}&offset=${offset}`),
  plan: (videoId: number, body: PlanRequest) => http<PromptRun>(`${base(videoId)}/plans`, json("POST", body)),
  segment: (videoId: number, runId: number, index: number,
    body: { target: PromptTarget; h3_mode?: H3Mode | null; model_config_id?: number | null }) =>
    http<SegmentRecord>(`${base(videoId)}/runs/${runId}/segments/${index}`, json("POST", body)),
  edit: (videoId: number, runId: number, index: number,
    body: { target: PromptTarget; prompt: string; parent_id?: number | null }) =>
    http<SegmentRecord>(`${base(videoId)}/runs/${runId}/segments/${index}/edits`, json("POST", body)),
  versions: (videoId: number, runId: number, index: number, target: PromptTarget) =>
    http<VersionList>(`${base(videoId)}/runs/${runId}/segments/${index}/records?target=${target}`),
  frame: (videoId: number, at: number) => http<FrameResponse>(`/api/videos/${videoId}/frame?at=${at}`),
  referenceFrame: (videoId: number, runId: number, index: number, edge: FrameEdge) =>
    http<ReferenceFrame>(`${base(videoId)}/runs/${runId}/segments/${index}/frame?which=${edge}`),
  translate: (videoId: number, runId: number, index: number,
    body: { target: PromptTarget; model_config_id?: number | null }) =>
    http<TranslationResponse>(`${base(videoId)}/runs/${runId}/segments/${index}/translations`, json("POST", body)),
};

export const videoPromptSettings = writable<VideoPromptSettings | null>(null);
export async function refreshVideoPromptSettings() {
  videoPromptSettings.set(await videoPromptApi.settings());
}

export type VideoPromptJob = { running: boolean; error?: string; result?: SegmentRecord; run?: PromptRun };
export const videoPromptJobs = writable<Record<string, VideoPromptJob>>({});
/** 串行队列的整体进度（全部生成时用），null = 没有队列在跑。 */
export const segmentQueue = writable<{ total: number; done: number } | null>(null);
const active = new Set<string>();

export const segmentKey = (runId: number, index: number, target: PromptTarget) => `${runId}:${index}:${target}`;
export const planKey = (videoId: number) => `plan:${videoId}`;
export { errorMessage };

/** 展开生成任务：先按段、再按格式，所以"两种都要"会一段一段地出，便于横向对比。 */
export function expandSegments(indexes: number[], targets: PromptTarget[]) {
  const jobs: { index: number; target: PromptTarget }[] = [];
  for (const index of indexes) for (const target of targets) jobs.push({ index, target });
  return jobs;
}

function setJob(key: string, value: VideoPromptJob) {
  videoPromptJobs.update(jobs => ({ ...jobs, [key]: value }));
}

/** 阶段一：分镜方案。与目标格式无关，结果落在 job.run。 */
export async function generatePlan(videoId: number, body: PlanRequest): Promise<PromptRun | null> {
  const key = planKey(videoId);
  if (active.has(key)) return null;
  active.add(key);
  setJob(key, { running: true });
  try {
    const run = await videoPromptApi.plan(videoId, body);
    setJob(key, { running: false, run });
    return run;
  } catch (error) {
    setJob(key, { running: false, error: errorMessage(error) });
    return null;
  } finally {
    active.delete(key);
  }
}

/** 阶段二：段正文。串行执行，失败只标记该段，后续继续；返回失败的 key。 */
export async function generateSegments(
  videoId: number, runId: number, indexes: number[], targets: PromptTarget[],
  options: { h3_mode?: H3Mode; model_config_id?: number | null } = {},
): Promise<string[]> {
  const queue = expandSegments(indexes, targets)
    .filter(job => !active.has(segmentKey(runId, job.index, job.target)));
  for (const job of queue) active.add(segmentKey(runId, job.index, job.target));
  segmentQueue.set({ total: queue.length, done: 0 });
  const failures: string[] = [];
  try {
    let done = 0;
    for (const job of queue) {
      const key = segmentKey(runId, job.index, job.target);
      setJob(key, { running: true });
      try {
        const result = await videoPromptApi.segment(videoId, runId, job.index, {
          target: job.target,
          h3_mode: job.target === "h3" ? (options.h3_mode ?? "t2va") : null,
          model_config_id: options.model_config_id ?? null,
        });
        setJob(key, { running: false, result });
      } catch (error) {
        failures.push(key);
        setJob(key, { running: false, error: errorMessage(error) });
      } finally {
        active.delete(key);
        segmentQueue.set({ total: queue.length, done: ++done });
      }
    }
  } finally {
    segmentQueue.set(null);
  }
  return failures;
}

// ---------- 整数秒：界面里的时长、时间点与区间只用这一个口径 ----------

/** 四舍五入到整秒。界面上不出现小数秒。 */
export function wholeSecond(seconds: number): number {
  return Math.floor(Math.max(0, seconds) + 0.5);
}
/** 毫秒 → 整数秒文本，例如 15116 → "15"。 */
export function secondText(ms: number): string {
  return String(wholeSecond(ms / 1000));
}
export function secondsRangeText(startMs: number, endMs: number): string {
  return `${secondText(startMs)}–${secondText(endMs)} 秒`;
}
/** 区间输入：只认整数秒（输入 12.6 也按 13 秒算），空值返回 null。
 *  number 输入框在 Svelte 里绑出来的可能是 number，这里两种都吃。 */
export function secondsInputToMs(value: string | number | null | undefined): number | null {
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : String(value ?? "").trim();
  if (text === "") return null;
  const seconds = Number.parseFloat(text);
  if (!Number.isFinite(seconds)) return null;
  return wholeSecond(seconds) * 1000;
}

/** 本段首/末帧的实际秒数；后端没给 frames 时按段边界兜底。 */
export function unitFrameAt(unit: PromptUnit, edge: FrameEdge): number {
  const known = unit.frames?.[edge]?.at;
  if (typeof known === "number") return known;
  return edge === "first" ? unit.start_ms / 1000 : Math.max(0, (unit.end_ms - 250) / 1000);
}

// ---------- 译文：一键中英互译，只用于阅读 ----------

export type TranslationJob = { running: boolean; error?: string; value?: PromptTranslation };
export const translationJobs = writable<Record<string, TranslationJob>>({});
const activeTranslations = new Set<string>();
export const translationKey = (runId: number, index: number, target: PromptTarget) =>
  `${runId}:${index}:${target}:tr`;

/** 该版本当前的译文。译文只属于产生它的那个版本：重跑出新版本后，
 *  上一版残在内存里的译文不算数，否则会把旧内容的译文配到新正文上。 */
export function translationOf(record: SegmentRecord, key: string,
  jobs: Record<string, TranslationJob>): PromptTranslation | null {
  const fresh = jobs[key]?.value;
  if (fresh && fresh.record_id === record.id) return fresh;
  return record.translation ?? null;
}

/** 翻译该段该格式的当前版本。服务端按版本缓存，重复点不再花模型调用。 */
export async function translatePrompt(videoId: number, runId: number, index: number,
  target: PromptTarget, options: { model_config_id?: number | null } = {}): Promise<PromptTranslation | null> {
  const key = translationKey(runId, index, target);
  if (activeTranslations.has(key)) return null;
  activeTranslations.add(key);
  translationJobs.update(jobs => ({ ...jobs, [key]: { running: true } }));
  try {
    const result = await videoPromptApi.translate(videoId, runId, index,
      { target, model_config_id: options.model_config_id ?? null });
    const value: PromptTranslation = {
      record_id: result.record_id, language: result.language, text: result.text,
      model_name: result.model_name, model: result.model, created_at: result.created_at,
    };
    translationJobs.update(jobs => ({ ...jobs, [key]: { running: false, value } }));
    return value;
  } catch (error) {
    translationJobs.update(jobs => ({ ...jobs, [key]: { running: false, error: errorMessage(error) } }));
    return null;
  } finally {
    activeTranslations.delete(key);
  }
}

/** 把 <Picture 1> / @图片 1 变成能放进文件名的标记，导出图片时一眼看出它是哪个槽位。 */
export function refFileTag(label: string): string {
  return label.replace(/\s+/g, "").replace(/[^0-9A-Za-z\u4e00-\u9fff]/g, "");
}

function frameReference(unit: PromptUnit, edge: FrameEdge): PromptReference["frame"] {
  return { index: unit.index, edge };
}

/**
 * 还没生成正文时，按当前格式与模式先告诉用户这段要备哪些参考。
 * 生成之后一律以服务端从正文解析出的 record.references 为准。
 * T2VA 与 Ref2VA 在这里返回空表：前者不引用图片，后者要什么参考得看正文的 subject_definitions。
 */
export function plannedReferences(target: PromptTarget, mode: H3Mode, unit: PromptUnit): PromptReference[] {
  const chain = unit.index > 1;
  if (target === "seedance2") {
    return chain
      ? [{
        label: "@视频 1", what: "上一段生成结果的视频成品，正文用「将@视频 1 延长」续接",
        frame: null, warn: "本工具不生成视频：需要先跑完上一段并导出成片", slot: "video",
      } as PromptReference]
      : [{ label: "@图片 1", what: "作为本段首帧上传", frame: frameReference(unit, "first"), warn: null, slot: "picture" }];
  }
  if (mode === "t2va" || mode === "ref2va") return [];
  const items: PromptReference[] = [{
    label: "<Picture 1>",
    what: chain ? "上一段生成结果的末帧，作为本段首帧上传" : "原片首帧，直接上传这一张",
    frame: frameReference(unit, "first"),
    warn: chain ? "下面这张是原片对照帧；真正要上传的是上一段生成结果的最后一帧" : null,
    slot: "picture",
  }];
  if (mode === "fl2va") {
    items.push({
      label: "<Picture 2>",
      what: `本段末帧，正文把它对齐到 ${wholeSecond((unit.end_ms - unit.start_ms) / 1000)} 秒`,
      frame: frameReference(unit, "last"), warn: null, slot: "picture",
    });
  }
  return items;
}
