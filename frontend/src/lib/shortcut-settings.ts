import { writable, get } from "svelte/store";

export const shortcutActions = [
  { id: "rightSidebar", label: "展开 / 收起右侧栏", key: "ctrl+alt+b" },
  { id: "leftSidebar", label: "展开 / 收起左侧栏", key: "backquote" },
  { id: "positive", label: "复制正向 Prompt", key: "p" },
  { id: "negative", label: "复制反向 Prompt", key: "n" },
  { id: "seed", label: "复制 Seed", key: "s" },
  { id: "comfy", label: "在 ComfyUI 打开", key: "shift+c" },
  { id: "tags", label: "编辑标签", key: "shift+t" },
  { id: "preview", label: "预览图片 / 预览下一张", key: "space" },
  { id: "focusMode", label: "沉浸浏览：侧栏→最大化→全屏→还原", key: "f" },
  { id: "searchFocus", label: "定位到搜索框", key: "ctrl+f" },
  { id: "previous", label: "预览上一张", key: "arrowleft" },
  { id: "next", label: "预览下一张", key: "arrowright" },
  // 预览顶栏那两个旋转按钮的键盘入口：裸方向键已经给上一张/下一张，旋转用 Alt 修饰。
  { id: "rotateLeft", label: "预览：向左旋转 90°（存回原文件）", key: "alt+arrowleft" },
  { id: "rotateRight", label: "预览：向右旋转 90°（存回原文件）", key: "alt+arrowright" },
] as const;
export type ShortcutId = typeof shortcutActions[number]["id"];
export type ShortcutMap = Record<ShortcutId, string>;
export const defaultShortcuts = Object.fromEntries(shortcutActions.map(a => [a.id, a.key])) as ShortcutMap;
/**
 * Tab 曾经是「展开 / 收起右侧栏」的默认键（2026-11-11 撤掉）。
 * 它把整站的键盘焦点遍历吃掉了：只要焦点不在输入框里，按 Tab 不走到下一个控件，
 * 而是收起右栏 —— WCAG 2.1.2「不能卡住键盘焦点」。这里留一张迁移表，
 * 让已经存过 "tab" 的设备平移到新默认键，其它自定义一个不动。
 */
const TAB_KEY_MIGRATION: Partial<Record<ShortcutId, string>> = { rightSidebar: "ctrl+alt+b" };
/** 一个快捷键绑定的最后一段（裸键名），用来识别「这一条其实按的是 Tab」。 */
function baseKey(key: string): string {
  return key.split("+").at(-1) || "";
}
const storageKey = "suxing.shortcuts.v1";
const validKey = /^(?:(?:ctrl|alt|shift|meta)\+)*(?:[a-z0-9]|space|tab|backquote|arrowleft|arrowright|arrowup|arrowdown|f[1-9]|f1[0-2]|home|end|pageup|pagedown)$/;
/** 素材口径键在 lib/content-shortcuts.ts 里硬编码，自定义快捷键不能占用。 */
export const RESERVED_SCOPE_KEYS = ["0", "a", "i", "v", "t", "q"];
export function validateShortcuts(value: ShortcutMap): string | null {
  const seen = new Map<string, string>();
  for (const a of shortcutActions) {
    const key = value[a.id];
    if (typeof key !== "string" || (key && !validKey.test(key))) return `${a.label}：不支持该按键`;
    if (!key) continue;
    if (RESERVED_SCOPE_KEYS.includes(key)) return `${a.label}：0 / A / I / V / T / Q 保留用于切换素材类型`;
    if (baseKey(key) === "tab") return `${a.label}：Tab 用于键盘焦点遍历，不能绑定`;
    const parts = key.split("+");
    const canonical = [...new Set(parts.slice(0, -1))].sort().concat(parts.at(-1)!).join("+");
    if (seen.has(canonical)) return `「${a.label}」与「${seen.get(canonical)}」的快捷键冲突`;
    seen.set(canonical, a.label);
  }
  return null;
}
export function loadShortcuts(): ShortcutMap {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
    const value = { ...defaultShortcuts, ...saved };
    // 老设备可能还把 Tab 绑在某个动作上：那一律解绑，右栏迁到新默认键，其余自定义不动。
    for (const action of shortcutActions) {
      if (baseKey(value[action.id]) !== "tab") continue;
      value[action.id] = TAB_KEY_MIGRATION[action.id] ?? "";
    }
    for (const action of shortcutActions) {
      if (RESERVED_SCOPE_KEYS.includes(value[action.id])) value[action.id] = action.id === 'tags' && value[action.id] === 't' ? 'shift+t' : '';
    }
    if (!validateShortcuts(value)) return value;
  } catch { /* 损坏或不可用的本地存储使用默认值 */ }
  return { ...defaultShortcuts };
}
export const shortcutSettings = writable<ShortcutMap>(loadShortcuts());
export function saveShortcuts(value: ShortcutMap) {
  const error = validateShortcuts(value);
  if (error) throw new Error(error);
  localStorage.setItem(storageKey, JSON.stringify(value));
  shortcutSettings.set({ ...value });
}
export function eventShortcut(e: KeyboardEvent): string {
  if (["Dead", "Process"].includes(e.key) || e.isComposing) return "";
  const backquote = e.code === "Backquote" || e.key === "`" || e.key === "~";
  const key = backquote ? "backquote" : e.key === " " ? "space" : e.key.toLowerCase();
  if (["control", "shift", "alt", "meta", "dead", "process"].includes(key) || e.isComposing) return "";
  return [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && !backquote && "shift", e.metaKey && "meta", key].filter(Boolean).join("+");
}
export function shortcutBlocked(e: KeyboardEvent): boolean {
  const target = e.target;
  // Tab / Shift+Tab 归键盘焦点遍历，任何快捷键都不许把它拦下来（见上面 TAB_KEY_MIGRATION）。
  if (e.key === "Tab") return true;
  return e.isComposing || e.repeat || !!document.querySelector('[data-settings-dialog]') ||
    (target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]'));
}
export function matchesAction(e: KeyboardEvent, action: ShortcutId): boolean {
  const key = get(shortcutSettings)[action];
  return !!key && !shortcutBlocked(e) && eventShortcut(e) === key;
}
export function shortcutLabel(key: string): string {
  if (!key) return "未设置";
  const names: Record<string, string> = { tab: "Tab", backquote: "~ / `", space: "Space", arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓", ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Win / Cmd" };
  return key.split("+").map(k => names[k] || k.toUpperCase()).join(" + ");
}
