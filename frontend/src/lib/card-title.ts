import { writable } from "svelte/store";
import { basenameOnly } from "./media-format";

/**
 * 卡片页脚第一行显示什么：提示词开头，还是文件名。
 *
 * 方案 3 把提示词提到第一行——挑图时真正要读的是「这张是什么」，文件名基本都是
 * AnimateDiff_00001.png 这种机器名。但这条偏好是有真实反例的：有人就是要在瀑布流里
 * 一眼挑出 .png 和 .psd，所以留一个开关，默认提示词，整站一份、落盘记住。
 * 文件名没有消失：整张卡本来就带 title=文件名（旧口径），鼠标停在卡片上就在，详情栏里也一直都在。
 */
export type CardTitleMode = "prompt" | "filename";

const STORAGE_KEY = "seekx.card-title-mode.v1";
const DEFAULT_MODE: CardTitleMode = "prompt";

function readStored(): CardTitleMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "filename" || value === "prompt" ? value : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE; // 无痕模式：用内存值，不炸界面
  }
}

export const cardTitleMode = writable<CardTitleMode>(readStored());
cardTitleMode.subscribe((mode) => {
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* 落不了盘就算了 */ }
});

/** 提示词模式碰上没提示词（截图、扫描件、只有标签串的）就退回文件名，不给空白。 */
export function footerTitleFor(
  item: { prompt_snippet?: string | null; filename: string },
  mode: CardTitleMode,
): string {
  const snippet = (item.prompt_snippet ?? "").trim();
  if (mode === "prompt" && snippet) return snippet;
  return basenameOnly(item.filename);
}
