/**
 * Ctrl+F 定位到中间栏的搜索框。
 *
 * 搜索框在 Feed 的工具栏里，而内嵌层（图片 / 文本 / 视频）开着时整块网格是
 * inert —— 聚焦 inert 里的元素会被浏览器静默拒绝。所以这里等 inert 撤掉再聚焦：
 * 应用先关层，再调 focusGallerySearch()，它逐帧重试到能聚焦为止。
 */
import { get } from "svelte/store";
import { eventShortcut, shortcutSettings } from "./shortcut-settings";

let input: HTMLInputElement | null = null;

export function registerGallerySearchElement(el: HTMLInputElement | null): void {
  input = el;
}

export function gallerySearchElement(): HTMLInputElement | null {
  return input && input.isConnected ? input : null;
}

/**
 * 单独注册「定位搜索框」的快捷键。
 *
 * 不走 registerShortcuts：那条通道对输入框里的按键一律放行不了（shortcutBlocked
 * 见到 input/textarea 就返回 true），而「跳去搜索」恰恰要在正在打字的时候也能按。
 * 捕获阶段 + stopImmediatePropagation，避免和别的绑定抢同一次按键。
 */
export function registerSearchFocusShortcut(trigger: () => void): () => void {
  const handle = (e: KeyboardEvent) => {
    if (e.isComposing || e.repeat || e.defaultPrevented) return;
    // 弹窗开着时不抢焦点：把光标从「新建文本」这类对话框里抽走，比按不动更糟。
    if (document.querySelector("[data-settings-dialog], [aria-modal=\"true\"], [role=\"dialog\"]")) return;
    const wanted = get(shortcutSettings).searchFocus;
    if (!wanted || eventShortcut(e) !== wanted) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    trigger();
  };
  window.addEventListener("keydown", handle, true);
  return () => window.removeEventListener("keydown", handle, true);
}

const MAX_FRAMES = 30;

/** @returns 是否真的把光标送进了搜索框（已有内容会整段选中，直接打字即替换）。 */
export function focusGallerySearch(frame = 0): Promise<boolean> {
  return new Promise((resolve) => {
    const step = (n: number) => {
      const el = gallerySearchElement();
      if (el && !el.closest("[inert]")) {
        el.focus();
        try { el.select(); } catch { /* type=search 在个别实现里没有 select */ }
        resolve(document.activeElement === el);
        return;
      }
      if (n >= MAX_FRAMES) { resolve(false); return; }
      requestAnimationFrame(() => step(n + 1));
    };
    step(frame);
  });
}
