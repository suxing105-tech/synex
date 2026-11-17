import { writable, get } from "svelte/store";

export const shortcutActions = [
  // 右栏默认键 = Tab（2026-11-16 苏醒：「收起展开右边栏，我还是想默认 tab 键为快捷键」）。
  // 2026-11-11 曾因「Tab 把整站焦点遍历吃掉」换成 Ctrl+Alt+B，这次不是整体回退：
  // Tab 只在素材网格里归右栏，焦点在输入框 / 侧栏 / 右栏 / 弹层里时照旧走焦点遍历，
  // 挡在哪、为什么不卡键盘，见 lib/sidebar-shortcuts.ts 的 gridHasTab。
  { id: "rightSidebar", label: "展开 / 收起右侧栏", key: "tab" },
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
 * Tab 与右栏默认键来回过两次，口径记全，免得下一轮又反着改：
 * 2026-11-11 撤掉 Tab（焦点遍历被整个吃掉，WCAG 2.1.2）；2026-11-16 苏醒要回来，
 * 但不是整体回退——Tab 只在素材网格里归右栏，其余地方照常走焦点（sidebar-shortcuts 把关）。
 * 下面这串是当年那次迁移自动写进配置的，不是人挑的键：存过的设备把它让给新默认键 Tab。
 * 代价如实说清：谁要是自己把右栏设成了同一个 Ctrl+Alt+B，这一版会把它换回 Tab，需要重设一次。
 */
const TAB_AUTO_KEYS: Partial<Record<ShortcutId, string>> = { rightSidebar: "ctrl+alt+b" };
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
    // Tab 只许给「展开 / 收起右侧栏」：它是苏醒要的那一手势，而且运行期只在素材网格里接管。
    // 别的动作绑上 Tab 也只会在那一格里误触，所以这里直接不收（焦点遍历仍然照常走 Tab）。
    if (baseKey(key) === "tab" && a.id !== "rightSidebar") return `${a.label}：Tab 只给「展开 / 收起右侧栏」，这一条请用带修饰键的组合`;
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
    // 上一轮自动写进配置的右栏键让给新默认键 Tab，其余自定义一个不动。
    for (const [action, autoKey] of Object.entries(TAB_AUTO_KEYS) as [ShortcutId, string][]) {
      if (value[action] === autoKey) value[action] = defaultShortcuts[action];
    }
    // 右栏之外谁还留着 Tab（2026-11-11 之前的老配置里会有）：就地清掉那一条。
    // 不清的话 validateShortcuts 会把整份配置判坏，别的自定义改键会跟着一起回默认。
    for (const action of shortcutActions) {
      if (action.id !== "rightSidebar" && baseKey(value[action.id]) === "tab") value[action.id] = "";
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
  // Tab 不再在这里一刀切禁掉（2026-11-16：右栏默认键就是它）。
  // 「只在素材网格里接管、其余地方照常走焦点」由 lib/sidebar-shortcuts.ts 的 gridHasTab 把关；
  // 留在这里挡的话，右栏那手快捷键永远不会响。
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
