import { writable, get } from "svelte/store";

export const shortcutActions = [
  { id: "positive", label: "复制正向 Prompt", key: "p" },
  { id: "negative", label: "复制反向 Prompt", key: "n" },
  { id: "seed", label: "复制 Seed", key: "s" },
  { id: "comfy", label: "在 ComfyUI 打开", key: "shift+c" },
  { id: "favorite", label: "切换收藏", key: "f" },
  { id: "tags", label: "编辑标签", key: "shift+t" },
  { id: "preview", label: "预览图片 / 预览下一张", key: "space" },
  { id: "previous", label: "预览上一张", key: "arrowleft" },
  { id: "next", label: "预览下一张", key: "arrowright" },
] as const;
export type ShortcutId = typeof shortcutActions[number]["id"];
export type ShortcutMap = Record<ShortcutId, string>;
export const defaultShortcuts = Object.fromEntries(shortcutActions.map(a => [a.id, a.key])) as ShortcutMap;
const storageKey = "suxing.shortcuts.v1";
const validKey = /^(?:(?:ctrl|alt|shift|meta)\+)*(?:[a-z0-9]|space|arrowleft|arrowright|arrowup|arrowdown|f[1-9]|f1[0-2]|home|end|pageup|pagedown)$/;
export function validateShortcuts(value: ShortcutMap): string | null {
  const seen = new Map<string, string>();
  for (const a of shortcutActions) {
    const key = value[a.id];
    if (typeof key !== "string" || (key && !validKey.test(key))) return `${a.label}：不支持该按键`;
    if (!key) continue;
    if (["i", "v", "t"].includes(key)) return `${a.label}：I / V / T 保留用于切换内容类型`;
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
    for (const action of shortcutActions) {
      if (['i', 'v', 't'].includes(value[action.id])) value[action.id] = action.id === 'tags' && value[action.id] === 't' ? 'shift+t' : '';
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
  const key = e.key === " " ? "space" : e.key.toLowerCase();
  if (["control", "shift", "alt", "meta", "dead", "process"].includes(key) || e.isComposing) return "";
  return [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "meta", key].filter(Boolean).join("+");
}
export function shortcutBlocked(e: KeyboardEvent): boolean {
  const target = e.target;
  return e.isComposing || e.repeat || !!document.querySelector('[data-settings-dialog]') ||
    (target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]'));
}
export function matchesAction(e: KeyboardEvent, action: ShortcutId): boolean {
  const key = get(shortcutSettings)[action];
  return !!key && !shortcutBlocked(e) && eventShortcut(e) === key;
}
export function shortcutLabel(key: string): string {
  if (!key) return "未设置";
  const names: Record<string, string> = { space: "Space", arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓", ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Win / Cmd" };
  return key.split("+").map(k => names[k] || k.toUpperCase()).join(" + ");
}
