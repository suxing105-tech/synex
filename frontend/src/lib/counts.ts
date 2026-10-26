import type { FolderCounts, Scope } from "./types";

/**
 * 侧栏计数的唯一口径来源。
 *
 * 之前侧栏同时存在 image_count / recursive_count / text_count 三种数，
 * 同一行在不同类型下含义不同，用户没法知道屏幕上那个数字到底数了什么。
 * 现在：每一行只有一个数字 = 当前 scope 的数量，其余三类进 hover 明细。
 */

export const COUNT_SCOPES: readonly Scope[] = ["all", "image", "video", "audio", "text"];

const UNIT: Record<string, string> = {
  image: "张图片",
  video: "个视频",
  audio: "条音频",
  text: "篇文本",
};

/** 混合场景（统一流、多选）用的中性量词。 */
export const NEUTRAL_UNIT = "项";

export function unitFor(scope: Scope): string {
  return UNIT[scope] ?? NEUTRAL_UNIT;
}

function emptyCounts(): FolderCounts {
  return { image: 0, video: 0, audio: 0, text: 0 };
}

/**
 * 计数来源有两种形状：`{ image, video, audio, text }`（stats / chips）
 * 和 `{ counts: {...} }`（后端返回的 FolderNode）。两种都得认，
 * 之前只认扁平形状，侧栏传 FolderNode 进来时每一行都渲染成 0。
 */
export type CountsInput =
  | Partial<FolderCounts>
  | { counts?: Partial<FolderCounts> }
  | null
  | undefined;

function countsSource(node: CountsInput): Partial<FolderCounts> {
  if (!node || typeof node !== "object") return {};
  const nested = (node as { counts?: unknown }).counts;
  if (nested && typeof nested === "object") return nested as Partial<FolderCounts>;
  return node as Partial<FolderCounts>;
}

export function asCounts(node: CountsInput): FolderCounts {
  const base = emptyCounts();
  const source = countsSource(node);
  for (const key of ["image", "video", "audio", "text"] as const) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) base[key] = value;
  }
  return base;
}

/** 这一行该显示的数字：scope=all 时是四类之和，否则只有当前那一种。 */
export function countFor(node: CountsInput, scope: Scope): number {
  const counts = asCounts(node);
  if (scope === "all") return counts.image + counts.video + counts.audio + counts.text;
  return counts[scope];
}

/** 12345 → "1.2万"；9999 → "9,999"。侧栏宽度只有 260px，长数字会把名字挤没。 */
export function formatCount(n: number): string {
  const value = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  if (value < 10000) return value.toLocaleString("en-US");
  const wan = value / 10000;
  const text = wan >= 100 ? String(Math.round(wan)) : String(Math.round(wan * 10) / 10);
  return `${text}万`;
}

/** hover 明细：四类全列，0 也列出来 —— 「没有音频」本身就是信息。 */
export function countBreakdown(node: CountsInput): string {
  const counts = asCounts(node);
  return (["image", "video", "audio", "text"] as const)
    .map((kind) => `${counts[kind]} ${UNIT[kind]}`)
    .join(" · ");
}

export function totalOf(counts: CountsInput): number {
  return asCounts(counts).image + asCounts(counts).video + asCounts(counts).audio + asCounts(counts).text;
}

/** 工具栏那一行：`40 张图片 · 11 个视频 · 3 条音频 · 40 篇文本`，只列非零项。 */
export function mediaSummary(counts: CountsInput): string {
  const full = asCounts(counts);
  const parts = (["image", "video", "audio", "text"] as const)
    .filter((kind) => full[kind] > 0)
    .map((kind) => `${formatCount(full[kind])} ${UNIT[kind]}`);
  return parts.length ? parts.join(" · ") : `0 ${NEUTRAL_UNIT}`;
}

/** 选区文案：单一类型用「张/个/条/篇」，跨类型用「项」。 */
export function selectionSummary(count: number, kinds: readonly string[]): string {
  if (count <= 0) return "";
  const only = kinds.length === 1 ? kinds[0] : null;
  return `已选 ${formatCount(count)} ${unitFor((only ?? NEUTRAL_UNIT) as Scope)}`;
}

/** 侧栏「系统」分组右侧的口径小字。 */
export function scopeCaption(scope: Scope): string {
  const label: Record<Scope, string> = {
    all: "全部素材",
    image: "图片",
    video: "视频",
    audio: "音频",
    text: "文本",
  };
  return `计数 · ${label[scope]}`;
}