import { get, writable } from "svelte/store";
import { shortcutBlocked } from "./shortcut-settings";

/**
 * 对比方式：左右并排 / 分割线擦除。
 *
 * 图片和视频共用这一份偏好：两种素材在中间栏是同一层同一套手势，
 * 记两个开关只会让人记不住「现在按 S 会改谁」。默认左右 —— 分割擦除
 * 一次只看得清一张，视频播放时尤其看不出差别。
 */
export type CompareMode = "side" | "split";

const STORAGE_KEY = "seekx.compare-mode.v1";
const DEFAULT_MODE: CompareMode = "side";

function readStored(): CompareMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "split" || value === "side" ? value : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export const compareMode = writable<CompareMode>(readStored());
// 任何一条写入路径都落盘：界面上有两个入口（顶栏按钮 + S 键），少一处就少一个坑。
compareMode.subscribe((mode) => {
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* 无痕模式下用内存值 */ }
});

export function compareModeLabel(mode: CompareMode): string {
  return mode === "side" ? "左右对比" : "分割对比";
}

export function toggleCompareMode(): CompareMode {
  const next: CompareMode = get(compareMode) === "side" ? "split" : "side";
  compareMode.set(next);
  return next;
}

/**
 * S 键切换对比方式，只在对比真的开着时生效。
 *
 * 用捕获阶段 + stopImmediatePropagation：详情栏把 S 绑成了「复制 Seed」，
 * 它先注册、也在冒泡阶段，不抢在前面就会被它吃掉。
 */
export function registerCompareToggle(isOpen: () => boolean, blocked = () => false): () => void {
  const handle = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() !== "s" || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (e.defaultPrevented || shortcutBlocked(e) || blocked() || !isOpen()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toggleCompareMode();
  };
  window.addEventListener("keydown", handle, true);
  return () => window.removeEventListener("keydown", handle, true);
}
