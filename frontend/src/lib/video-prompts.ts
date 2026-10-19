import { writable } from "svelte/store";
import { http } from "./api";
import { errorMessage } from "./reverse-prompts";

export type PromptTarget = "seedance2" | "h3";
export type FrameEdge = "first" | "last";
export type H3Mode = "t2va" | "i2va" | "fl2va";
export type TranslationLanguage = "zh" | "en";
export const TARGETS: PromptTarget[] = ["seedance2", "h3"];
export const TARGET_LABELS: Record<PromptTarget, string> = { seedance2: "Seedance 2.0", h3: "MiniMax H3" };
export const H3_MODES: H3Mode[] = ["t2va", "i2va", "fl2va"];
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

/** 这张图在提示词里是谁、该喂给谁。链式续接时诚实说明它只是对照。 */
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

export function frameUsage(target: PromptTarget, mode: H3Mode, index: number, edge: FrameEdge): string {
  if (target === "seedance2") {
    if (edge === "last") return "本段末帧，用作下一段衔接的对照";
    return index === 1 ? "@图片 1 作为首帧上传" : "正文靠 将@视频 1 续接，本帧只是备用首帧";
  }
  if (mode === "t2va") return "参考帧（T2VA 正文不引用图片）";
  if (edge === "last") {
    return mode === "fl2va" ? "Picture 2 = 本段末帧" : "本段末帧，即下一段的 <Picture 1>";
  }
  if (index === 1) return mode === "fl2va" ? "Picture 1 = 视频真实首帧" : "<Picture 1> = 视频真实首帧";
  return mode === "fl2va"
    ? "Picture 1 请改用上一段生成结果的末帧（此帧仅作对照）"
    : "<Picture 1> 请改用上一段生成结果的末帧（此帧仅作对照）";
}
