import { writable } from "svelte/store";
import { http } from "./api";
import { errorMessage } from "./reverse-prompts";
import { dismissToast, pushToast, updateToast } from "./toast";

export type PromptTarget = "seedance2" | "h3";
export type FrameEdge = "first" | "last";
export type H3Mode = "t2va" | "i2va" | "fl2va" | "ref2va";
/** Seedance 2.0 的四种任务模式：首帧与首尾帧的图不能和参考素材混在同一个请求里，必须分开选。 */
export type SeedanceMode = "t2v" | "i2v" | "flv" | "ref";
/** 两种目标格式共用一个「模式」字段，取值各自见 MODES_BY_TARGET。 */
export type PromptMode = SeedanceMode | H3Mode;
export type TranslationLanguage = "zh" | "en";
export const TARGETS: PromptTarget[] = ["seedance2", "h3"];
export const TARGET_LABELS: Record<PromptTarget, string> = { seedance2: "Seedance 2.0", h3: "MiniMax H3" };
export const H3_MODES: H3Mode[] = ["t2va", "i2va", "fl2va", "ref2va"];
export const SEEDANCE_MODES: SeedanceMode[] = ["t2v", "i2v", "flv", "ref"];
export const MODES_BY_TARGET: Record<PromptTarget, PromptMode[]> = {
  seedance2: SEEDANCE_MODES, h3: H3_MODES,
};
export const MODE_DEFAULTS: Record<PromptTarget, PromptMode> = { seedance2: "t2v", h3: "t2va" };
export const MODE_LABELS: Record<PromptMode, string> = {
  t2v: "文生视频", i2v: "图生视频·首帧", flv: "首尾帧", ref: "全能参考",
  t2va: "T2VA 纯文本", i2va: "I2VA 首帧图", fl2va: "FL2VA 首尾帧", ref2va: "Ref2VA 参考生视频",
};
/** 版本卡片上的小徽标：完整模式名太长，这里用最短的说法。 */
export const MODE_BADGES: Record<PromptMode, string> = {
  t2v: "文生", i2v: "首帧", flv: "首尾帧", ref: "全能参考",
  t2va: "T2VA", i2va: "I2VA", fl2va: "FL2VA", ref2va: "Ref2VA",
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
  default_mode_h3: H3Mode; default_mode_seedance: SeedanceMode;
  frame_limit: number; max_unit_seconds: number; max_units: number;
}
export interface VideoPromptSettings extends VideoPromptDefaults {
  id: number; default_model_id: number | null; defaults: VideoPromptDefaults;
}
export interface SegmentRecord {
  id: number; segment_index: number; target: PromptTarget;
  /** 生成这一版时用的模式；0.2.23 以前的老记录是 null，界面不再按模式过滤它。 */
  mode: PromptMode | null; prompt: string;
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
/** Seedance 2.0 官方口径：图 9 / 视频 3 / 音频 3，且一次请求合计不超过 12 个文件。 */
export const SEEDANCE_SLOT_LIMITS: Record<ReferenceSlot, number> = { picture: 9, video: 3, audio: 3 };
export const SEEDANCE_FILE_LIMIT = 12;
/** 官方建议单条正文不超过 500 字（中文按字算），超了模型会丢细节。 */
export const SEEDANCE_CHAR_GUIDE = 500;
export const SLOT_LABELS: Record<ReferenceSlot, string> = { picture: "图", video: "视频", audio: "音频" };
export const SLOT_LIMITS_BY_TARGET: Record<PromptTarget, Record<ReferenceSlot, number>> = {
  seedance2: SEEDANCE_SLOT_LIMITS, h3: SLOT_LIMITS,
};
/** 上限说的是什么话：给超限红字用，两家格式的数字不一样。 */
export function slotLimitText(target: PromptTarget): string {
  const limit = SLOT_LIMITS_BY_TARGET[target];
  const name = target === "seedance2" ? "Seedance" : "MiniMax";
  return `${name} 上限（图 ${limit.picture} / 视频 ${limit.video} / 音频 ${limit.audio}`
    + (target === "seedance2" ? `，合计 ${SEEDANCE_FILE_LIMIT}` : "") + "）";
}
/** 中文按字、其它按字符计数，用于「正文是否长过官方建议」。 */
export function cjkCount(text: string): number {
  return (text || "").replace(/\s/g, "").length;
}
/** 问号弹层里的一句话说明：每种模式一行，说清要上传什么、上限多少。 */
export const MODE_HINTS: Record<PromptMode, string> = {
  t2v: "文生视频：正文不引用任何 @ 素材，段与段只靠【约束】里的锚点文字衔接，所以不列参考文件。要人物一致就别用这一档。",
  i2v: "图生视频·首帧：每段传 1 张首帧图——第 1 段用原片首帧，第 2 段起用上一段生成结果的末帧。"
    + "正文只写变化，别重复首帧里已经有的东西。首帧图不能和参考图混在同一个请求里。",
  flv: "首尾帧：传两张图（@图片1 首帧、@图片2 末帧），末帧取自上一段生成结果，两张必须同一画幅。"
    + "这一档不能再传参考视频或音频。",
  ref: "全能参考：正文多一段【主体】定义，把要固定的人物与场景写成「将@图片N 的…定义为主体N」。"
    + `可上传 图 ≤${SEEDANCE_SLOT_LIMITS.picture}、视频 ≤${SEEDANCE_SLOT_LIMITS.video}、音频 ≤${SEEDANCE_SLOT_LIMITS.audio}`
    + `，合计 ≤${SEEDANCE_FILE_LIMIT}；这一档不能再传首帧/末帧图。`,
  t2va: "纯文本：正文不引用图片或视频，段与段只靠锚点文字衔接，所以不列参考素材。",
  i2va: "首帧图：每段首行写 <Picture 1> 对齐句——第 1 段用原片首帧，第 2 段起用上一段生成结果的末帧。",
  fl2va: "首尾帧：每段首行列出首帧与末帧两个 Picture 及其对齐时间，末帧取自上一段生成结果。",
  ref2va: `全参考：正文改成六段式（subject_definitions / summary / …）。要上传的素材只有三种编号：`
    + `<Picture N> 最多 ${SLOT_LIMITS.picture} 张、<Video N> 最多 ${SLOT_LIMITS.video} 个、`
    + `<Audio N> 最多 ${SLOT_LIMITS.audio} 个，够用就行、以图片为主。<Subject N> 只是正文里的内容标签，不用为它准备文件。`,
};

/** 正文里的一条引用：label 照抄，what 说清要上传什么，frame 是本工具能直接给的对照帧。 */
export interface PromptReference {
  label: string; what: string;
  frame: { index: number; edge: FrameEdge } | null;
  warn: string | null;
  /** 要上传的文件类型；决定缩略图、导出文件名与上限计数。 */
  slot: ReferenceSlot;
  /** 正文里的英文原文，只用于悬停提示；界面显示的是中文 what。 */
  what_en?: string;
}
/** 每类素材各要几个，用于清单标题与超限告警。 */
export function countSlots(refs: PromptReference[]): Record<ReferenceSlot, number> {
  const counts: Record<ReferenceSlot, number> = { picture: 0, video: 0, audio: 0 };
  refs.forEach((item) => { counts[item.slot] += 1; });
  return counts;
}
/** 超出该格式上限的素材类型，前端据此红字提示。 */
export function overSlots(refs: PromptReference[], target: PromptTarget = "h3"): ReferenceSlot[] {
  const counts = countSlots(refs);
  const limits = SLOT_LIMITS_BY_TARGET[target];
  return (Object.keys(limits) as ReferenceSlot[]).filter((slot) => counts[slot] > limits[slot]);
}
/** 已等待秒数（整秒，超过一分钟带分）。没有起点就返回空串，界面不显示时间。 */
export function elapsedText(startedAt: number | undefined, now: number): string {
  if (startedAt == null || now < startedAt) return "";
  const seconds = Math.floor((now - startedAt) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
}
export interface PromptShot { start_ms: number; end_ms: number; synthetic: boolean }
export interface PromptUnit {
  index: number; start_ms: number; end_ms: number; shots: PromptShot[]; role: string;
  warn: string | null; current: Partial<Record<PromptTarget, SegmentRecord>>;
  /** 这一段每种格式各有几个版本——"版本（N）"按钮说的是这一段，不是整个方案。 */
  versions?: Record<PromptTarget, number>;
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
    body: { target: PromptTarget; mode?: PromptMode | null; model_config_id?: number | null }) =>
    http<SegmentRecord>(`${base(videoId)}/runs/${runId}/segments/${index}`, json("POST", body)),
  edit: (videoId: number, runId: number, index: number,
    body: { target: PromptTarget; prompt: string; parent_id?: number | null }) =>
    http<SegmentRecord>(`${base(videoId)}/runs/${runId}/segments/${index}/edits`, json("POST", body)),
  versions: (videoId: number, runId: number, index: number, target: PromptTarget) =>
    http<VersionList>(`${base(videoId)}/runs/${runId}/segments/${index}/records?target=${target}`),
  /** 删掉一个历史版本；删的正好是最新版时后端把 current 回退成次新一版。 */
  removeRecord: (videoId: number, runId: number, index: number, target: PromptTarget, recordId: number) =>
    http<{ deleted: number; segment_index: number; target: PromptTarget; current: number | null }>(
      `${base(videoId)}/runs/${runId}/segments/${index}/records/${recordId}?target=${target}`,
      { method: "DELETE" }),
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

export type VideoPromptJob = {
  running: boolean;
  /** 本次调用在前端开始的时间戳，用来显示"已等待多少秒"；服务端触发的任务没有。 */
  startedAt?: number;
  error?: string; result?: SegmentRecord; run?: PromptRun;
};
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

/**
 * 把长驻的进度 Toast 原地换成结果。
 * updateToast 只改字段、不会重排自动消失的定时器（progress 的 ttl 是 0），
 * 所以这里自己补一个 timeout，否则结果条会一直堆在右下角。
 */
function finishToast(id: number, kind: "success" | "error", message: string, ttl: number) {
  updateToast(id, { kind, message, progress: undefined });
  if (ttl > 0) setTimeout(() => dismissToast(id), ttl);
}

/** 卡片标题与 Toast 共用段号：P01 / P02。 */
export function unitTag(index: number): string {
  return `P${String(index).padStart(2, "0")}`;
}

/** 生成中的 Toast 文案：一段时报格式名，多段时报当前第几项。 */
function segmentToastText(job: { index: number; target: PromptTarget }, position: number, total: number): string {
  const label = TARGET_LABELS[job.target];
  return total > 1
    ? `正在生成 ${unitTag(job.index)} · ${label}（第 ${position}/${total} 项）`
    : `正在生成 ${label} 正文 · ${unitTag(job.index)}`;
}

/** 阶段一：分镜方案。与目标格式无关，结果落在 job.run。 */
export async function generatePlan(videoId: number, body: PlanRequest): Promise<PromptRun | null> {
  const key = planKey(videoId);
  if (active.has(key)) return null;
  active.add(key);
  setJob(key, { running: true, startedAt: Date.now() });
  // 一次模型调用十几到几十秒，没有可上报的百分比，所以先在角落挂一条长驻进度，
  // 结束时原地换成成功/失败——面板滚到哪一段都能看见"还在跑"。
  const toastId = pushToast("正在反推分镜方案：切点已算好，模型正在写锚点与每段职责…",
    { kind: "progress", progress: 0 });
  try {
    const run = await videoPromptApi.plan(videoId, body);
    setJob(key, { running: false, run });
    finishToast(toastId, "success", `分镜方案已生成：${run.units.length} 段`, 2600);
    return run;
  } catch (error) {
    const reason = errorMessage(error);
    setJob(key, { running: false, error: reason });
    finishToast(toastId, "error", `分镜方案失败：${reason}`, 6000);
    return null;
  } finally {
    active.delete(key);
  }
}

/** 阶段二：段正文。串行执行，失败只标记该段，后续继续；返回失败的 key。 */
export async function generateSegments(
  videoId: number, runId: number, indexes: number[], targets: PromptTarget[],
  options: { modes?: Partial<Record<PromptTarget, PromptMode>>; model_config_id?: number | null } = {},
): Promise<string[]> {
  const queue = expandSegments(indexes, targets)
    .filter(job => !active.has(segmentKey(runId, job.index, job.target)));
  for (const job of queue) active.add(segmentKey(runId, job.index, job.target));
  segmentQueue.set({ total: queue.length, done: 0 });
  const failures: string[] = [];
  const first = queue[0];
  const toastId = first
    ? pushToast(segmentToastText(first, 1, queue.length), { kind: "progress", progress: 0 })
    : 0;
  try {
    let done = 0;
    for (const job of queue) {
      const key = segmentKey(runId, job.index, job.target);
      if (queue.length > 1) {
        updateToast(toastId, {
          message: segmentToastText(job, done + 1, queue.length),
          progress: (done / queue.length) * 100,
        });
      }
      setJob(key, { running: true, startedAt: Date.now() });
      try {
        const result = await videoPromptApi.segment(videoId, runId, job.index, {
          target: job.target,
          mode: options.modes?.[job.target] ?? MODE_DEFAULTS[job.target],
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
    if (first) {
      const ok = queue.length - failures.length;
      finishToast(toastId, failures.length ? "error" : "success",
        failures.length
          ? `正文生成结束：成功 ${ok} 段，失败 ${failures.length} 段，可在段卡片上单独重试`
          : queue.length > 1
            ? `${queue.length} 段正文已全部生成`
            : `${TARGET_LABELS[first.target]} 正文已生成`,
        failures.length ? 6000 : 2600);
    }
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
 * 不引用文件的模式（Seedance 文生视频、H3 的 T2VA / Ref2VA）返回空表：
 * 前两者没有文件可传，Ref2VA 要什么参考得看正文的 subject_definitions，预先列出来只会指错。
 */
export function plannedReferences(target: PromptTarget, mode: PromptMode, unit: PromptUnit): PromptReference[] {
  const chain = unit.index > 1;
  if (target === "seedance2") {
    if (mode === "t2v" || mode === "ref") return [];
    const items: PromptReference[] = [{
      label: "@图片1",
      what: chain ? "本段首帧 = 上一段生成结果的最后一帧，下面这张只是原片对照帧" : "本段首帧：把下面这张图存盘后作为首帧上传",
      frame: frameReference(unit, "first"),
      warn: chain ? "本工具只给原片帧：需要先跑完上一段，把它的末帧存下来当作本段首帧" : null,
      slot: "picture",
    }];
    if (mode === "flv") {
      items.push({
        label: "@图片2", what: "本段末帧：把下面这张图存盘后作为尾帧上传",
        frame: frameReference(unit, "last"), warn: "尾帧要和首帧同一画幅，生成时画幅选跟随首帧", slot: "picture",
      });
    }
    return items;
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
