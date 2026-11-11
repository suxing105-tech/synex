/**
 * 提示词优化技能的前端那一侧：接口、store，以及「引用标记有没有被模型吃掉」这道校验。
 *
 * 为什么单独一个模块：一颗按钮要的清单、默认值、优化请求都归它，CloneModal 只管接线；
 * 这些逻辑不挂 DOM，能直接单测（见 __tests__/prompt-skills.test.ts）。
 */
import { writable } from "svelte/store";
import { http } from "./api";

export type PromptSkillKind = "image" | "video";
export type PromptSkillLanguage = "auto" | "zh" | "en";

export interface PromptSkill {
  id: number;
  name: string;
  note: string;
  kinds: PromptSkillKind[];
  instruction: string;
  language: PromptSkillLanguage;
  with_refs: boolean;
  /** 有值＝内置那两条：能改、能恢复默认，但不能删 */
  builtin_key: string | null;
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface PromptSkillDraft {
  name?: string;
  note?: string;
  kinds?: PromptSkillKind[];
  instruction?: string;
  language?: PromptSkillLanguage;
  with_refs?: boolean;
}

export interface PromptSkillSettings {
  default_image_skill: number | null;
  default_video_skill: number | null;
}

/** 一格参考图。ordinal 是提示词里的编号——空格子时它不连续，后端按它标「图 N」。 */
export interface OptimizeRef {
  ordinal: number;
  image_id: number;
}

export interface OptimizeResult {
  prompt: string;
  model_name: string;
  model: string;
  /** 参考图被少带了才非空：sent 是真发出去的张数，dropped 是被跳过的格子编号 */
  degraded_refs: { sent: number; dropped: number[] } | null;
}

export const LANGUAGE_WORDS: Record<PromptSkillLanguage, string> = { auto: "跟随原文", zh: "中文", en: "英文" };
export const KIND_WORDS: Record<PromptSkillKind, string> = { image: "图片", video: "视频" };

const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });

const skillPath = (id: number) => `/api/prompt-skills/${id}`;

export const promptSkillsApi = {
  list: () => http<PromptSkill[]>("/api/prompt-skills"),
  create: (draft: PromptSkillDraft) => http<PromptSkill>("/api/prompt-skills", json("POST", draft)),
  update: (id: number, draft: PromptSkillDraft) => http<PromptSkill>(skillPath(id), json("PATCH", draft)),
  remove: (id: number) => http<{ deleted: number }>(skillPath(id), { method: "DELETE" }),
  /** 内置那条回到出厂写法；自己建的那条没有默认可回，后端会顶 409 */
  restoreDefault: (id: number) => http<PromptSkill>(`${skillPath(id)}/restore-default`, json("POST", {})),
  /** 导入的是读到的原文，截断规则只在后端一处 */
  import: (filename: string, content: string) =>
    http<PromptSkill & { truncated: boolean }>("/api/prompt-skills/import", json("POST", { filename, content })),
  settings: () => http<PromptSkillSettings>("/api/prompt-skill-settings"),
  saveSettings: (value: PromptSkillSettings) =>
    http<PromptSkillSettings>("/api/prompt-skill-settings", json("PUT", value)),
  /** signal 是给「取消」用的：只断前端这一头的等待，服务端那次调用该跑完还是跑完 */
  optimize: (
    id: number,
    body: { prompt: string; kind: PromptSkillKind; refs: OptimizeRef[] },
    signal?: AbortSignal,
  ) => http<OptimizeResult>(`${skillPath(id)}/optimize`, { ...json("POST", body), signal }),
};

export const promptSkills = writable<PromptSkill[]>([]);
export const promptSkillSettings = writable<PromptSkillSettings | null>(null);

/**
 * 清单拿回来同时留一份同步可读的：右键菜单要在 pointerdown 那一刻现算，
 * 不能等 promise；store 那份留给界面响应式用。失败时不置 loaded，下一次点还能重试。
 */
let snapshot: PromptSkill[] = [];
let snapshotSettings: PromptSkillSettings | null = null;
promptSkills.subscribe((value) => {
  snapshot = value;
});
promptSkillSettings.subscribe((value) => {
  snapshotSettings = value;
});
let loaded = false;

export async function loadPromptSkills(force = false): Promise<PromptSkill[]> {
  if (loaded && !force) return snapshot;
  const [list, settings] = await Promise.all([promptSkillsApi.list(), promptSkillsApi.settings()]);
  promptSkills.set(list);
  promptSkillSettings.set(settings);
  loaded = true;
  return list;
}

/** 单测与状态复位用：清掉「已经拉过一次」这件事。 */
export function resetPromptSkills(): void {
  loaded = false;
  promptSkills.set([]);
  promptSkillSettings.set(null);
}

export function skillsForKind(kind: PromptSkillKind): PromptSkill[] {
  return snapshot.filter((item) => item.kinds.includes(kind));
}

export function defaultSkillId(kind: PromptSkillKind): number | null {
  if (!snapshotSettings) return null;
  return kind === "video" ? snapshotSettings.default_video_skill : snapshotSettings.default_image_skill;
}

/** 设某一族的默认技能。先落本地再写库：菜单勾子必须立刻跟着走，不该等一次网络往返。 */
export async function setDefaultSkill(kind: PromptSkillKind, skillId: number | null): Promise<PromptSkillSettings> {
  const current = snapshotSettings ?? { default_image_skill: null, default_video_skill: null };
  const next: PromptSkillSettings =
    kind === "video"
      ? { ...current, default_video_skill: skillId }
      : { ...current, default_image_skill: skillId };
  promptSkillSettings.set(next);
  const saved = await promptSkillsApi.saveSettings(next);
  promptSkillSettings.set(saved);
  return saved;
}

/** 点左键该用哪一条：这一族的默认还在就用它，否则退回这一族的第一条——点了得有反应。 */
export function pickSkillFor(kind: PromptSkillKind): PromptSkill | null {
  const list = skillsForKind(kind);
  const wanted = defaultSkillId(kind);
  return list.find((item) => item.id === wanted) ?? list[0] ?? null;
}

/**
 * 提示词里的引用标记，按 @图片N / <Picture N> / 图N 三种写法认。
 *
 * 形状与 clone.ts 的 mentionChunks 同源（那边只管高亮，这边要拿去比对），改一边必须同步另一边：
 * 漏一种写法＝模型把它改写掉也查不出来，而「参考不生效」是不报错的。
 * 最后那条裸 图N 是给云端 Seedream 那类标签用的（它的 tag 就是 图1）。
 */
const MARK_RE =
  /@\s*(?:图片|图像|图|音频|音|视频|片|image|video|audio|picture)\s*\d+|<\s*(?:picture|video|audio)\s*\d+\s*>|(?<![@\w])(?:图片|图像|视频|音频|图)\s*\d+/gi;

/**
 * 一条标记折成「哪一族、第几格」。
 *
 * 为什么折到格子而不是照字面比：@图片1、图1、<Picture 1> 是同一格参考的三种写法（本地工作流用
 * @图片N，H3 那类只认 <Picture N>，云端 Seedream 的标签就是 图N）。模型把它们互相换一下写法，
 * 指的还是那一格参考，不算丢；整格没了或者编号错了才是事故。
 */
function markKey(mark: string): string {
  const text = mark.toLowerCase();
  // 图片那一族先判：「图片」里也带一个「片」字，后判就会把 图1 折到视频那一族去。
  const family = /图|image|picture/.test(text) ? "image" : /audio|音频|音/.test(text) ? "audio" : "video";
  return family + ((text.match(/\d+/) ?? ["0"])[0]);
}

/** 原句里点到过哪几格参考，每种写法留一句原样（报错时要照人自己打的字念给他听）。 */
export function promptMarks(text: string): string[] {
  const seen = new Map<string, string>();
  for (const match of text.matchAll(MARK_RE)) {
    const key = markKey(match[0]);
    if (!seen.has(key)) seen.set(key, match[0]);
  }
  return [...seen.values()];
}

/**
 * 优化结果弄丢了哪几格。只查「原来点过的还在不在」，不管模型新点了什么：
 * 多一个记号顶多是句废话，少一格是参考静默失效，两边后果不对等。
 */
export function missingMarks(original: string, result: string): string[] {
  const got = new Set(promptMarks(result).map(markKey));
  return promptMarks(original).filter((mark) => !got.has(markKey(mark)));
}
