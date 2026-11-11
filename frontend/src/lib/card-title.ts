import { writable } from "svelte/store";
import { basenameOnly } from "./media-format";

/**
 * 卡片页脚第一行显示什么：文件名，还是提示词开头那一句。
 *
 * 默认文件名（2026-11-11 苏醒定稿）。方案 3 第二批曾把提示词提到第一行，理由是
 * 「挑图要读的是这张是什么」，实际用下来不成立：瀑布流里认的还是那张文件本身，
 * 提示词在详情栏和灯箱里读，占掉卡片最贵的一行不值。开关留着，设置里能切。
 */
export type CardTitleMode = "prompt" | "filename";

/**
 * v2：上一版键（…v1）作废。v1 那版是一上来订阅一次就把当前值写进盘，
 * 所以只要跑过一次就留下一条 "prompt"，之后翻默认值对老用户完全不生效——
 * 苏醒本机就是这条。换键等于把那份自动写进去的值丢掉，真手动选过的人重选一次。
 */
const STORAGE_KEY = "seekx.card-title-mode.v2";
const DEFAULT_MODE: CardTitleMode = "filename";

function readStored(): CardTitleMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "filename" || value === "prompt" ? value : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE; // 无痕模式：用内存值，不炸界面
  }
}

export const cardTitleMode = writable<CardTitleMode>(readStored());

/** 只有用户在设置里明确选过一次才落盘；单纯 store.set（测试、临时切换）不写存储。 */
export function setCardTitleMode(mode: CardTitleMode): void {
  cardTitleMode.set(mode);
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* 落不了盘就算了 */ }
}

/** 提示词模式碰上没提示词（截图、扫描件、只有标签串的）就退回文件名，不给空白。 */
export function footerTitleFor(
  item: { prompt_snippet?: string | null; filename: string },
  mode: CardTitleMode,
): string {
  const snippet = (item.prompt_snippet ?? "").trim();
  if (mode === "prompt" && snippet) return snippet;
  return basenameOnly(item.filename);
}
