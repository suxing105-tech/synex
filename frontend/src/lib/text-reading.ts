/**
 * 文本阅读层的纯逻辑：版式偏好、命中偏移、标签文案。
 *
 * 放这里的都不碰 DOM，方便单测；组件里只留渲染和事件。
 */

import type { TextDetail, TextSummary } from "./texts";
import type { TextFeedItem } from "./types";

export type ReaderWidth = "narrow" | "wide";

export interface ReaderPrefs {
  width: ReaderWidth;
  fontScale: number;
}

const PREFS_KEY = "seekx.text-reading.v1";

export const DEFAULT_READER_PREFS: ReaderPrefs = { width: "narrow", fontScale: 1 };

/** 字号档位：夹在可读范围内，A- / A+ 只在这些值之间跳，不会越点越小。 */
export const FONT_SCALES = [0.85, 1, 1.15, 1.3];

type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void };

function store(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // 隐私模式 / Tauri 权限异常：读偏好失败不是错误，回到默认版式即可。
    return null;
  }
}

export function loadReaderPrefs(): ReaderPrefs {
  const s = store();
  if (!s) return { ...DEFAULT_READER_PREFS };
  try {
    const raw = s.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_READER_PREFS };
    const parsed = JSON.parse(raw) as Partial<ReaderPrefs>;
    const width = parsed.width === "wide" ? "wide" : "narrow";
    const scale = FONT_SCALES.includes(Number(parsed.fontScale)) ? Number(parsed.fontScale) : 1;
    return { width, fontScale: scale };
  } catch {
    return { ...DEFAULT_READER_PREFS };
  }
}

export function saveReaderPrefs(prefs: ReaderPrefs): void {
  const s = store();
  if (!s) return;
  try {
    s.setItem(PREFS_KEY, JSON.stringify({ width: prefs.width, fontScale: prefs.fontScale }));
  } catch {
    /* 写不进去就用当前会话的版式，不打扰用户 */
  }
}

export function stepFontScale(current: number, delta: 1 | -1): number {
  const index = FONT_SCALES.indexOf(Number(current));
  const at = index < 0 ? FONT_SCALES.indexOf(1) : index;
  return FONT_SCALES[Math.min(FONT_SCALES.length - 1, Math.max(0, at + delta))];
}

/**
 * 搜索命中的偏移表。
 *
 * /api/items 只回围绕命中点生成的 excerpt，不回偏移，所以打开文档后
 * 由前端在正文里自己找一遍。按字面（不区分大小写）匹配，中文直接可用。
 */
export function hitOffsets(body: string, term: string, cap = 500): number[] {
  const needle = term.trim().toLowerCase();
  if (!needle || !body) return [];
  const lower = body.toLowerCase();
  const hits: number[] = [];
  let at = lower.indexOf(needle);
  while (at >= 0 && hits.length < cap) {
    hits.push(at);
    at = lower.indexOf(needle, at + needle.length);
  }
  return hits;
}

/** 在命中表里前进 / 后退一格，到头循环；空表返回 -1。 */
export function stepHit(hits: number[], current: number, delta: 1 | -1): number {
  if (!hits.length) return -1;
  if (current < 0 || current >= hits.length) return delta > 0 ? 0 : hits.length - 1;
  return (current + delta + hits.length) % hits.length;
}

/** 后端 associate 只认这几种后缀，前端判定保持同一份清单，别在组件里各写一遍。 */
export const TEXT_FILE_EXTENSIONS = ["txt", "md", "markdown", "srt", "vtt"];

export function isTextFilePath(path: string): boolean {
  const ext = path.split(/[?#]/)[0].split(".").pop()?.toLowerCase() || "";
  return TEXT_FILE_EXTENSIONS.includes(ext);
}

/** 文本卡与阅读层共用的格式徽标文案（md → MD，无后缀 → TXT）。 */
export function textFormatLabel(format: string): string {
  return (format || "txt").replace(/^[.]+/, "").toUpperCase();
}

/**
 * 文本列表项 / 详情 → 统一流卡片数据。
 *
 * 关联或新建之后后端只回 TextSummary，但阅读层与右侧详情都按统一流的
 * TextFeedItem 走，这里单点转换，别在组件里各写一份字段映射。
 */
export function textFeedItemOf(item: TextSummary | TextDetail): TextFeedItem {
  return {
    item_type: "text",
    id: item.id,
    filename: item.filename,
    path: item.path,
    kind: "text",
    mtime: item.mtime,
    tags: item.tags,
    format: item.format,
    excerpt: item.excerpt,
  };
}

export const SAVE_STATE_LABEL: Record<string, string> = {
  saved: "已保存",
  saving: "保存中…",
  dirty: "等待保存",
  conflict: "外部冲突",
  error: "保存失败",
};

/** 页码：翻不动（文档不在当前流里）时显示「不在当前列表」而不是假页码。 */
export function readerPosition(index: number, total: number): string {
  return index < 0 || total <= 0 ? "不在当前列表" : `${index + 1} / ${total}`;
}