// 全局快捷键 hook。
//
// 设计：
// - 用一组 {key, ctrl?, shift?, alt?, meta?, handler, allowInInput} 描述一个绑定。
// - allowInInput=false 时，若 e.target 在 input/textarea/contenteditable 中则忽略。
//   这样 P/N/S/F/T 在搜索框聚焦时不会误触。
// - 同一个组件 / 页面 onMount 时 register，onDestroy 时 cleanup。
// - 多个 binding 共存：按注册顺序匹配；先匹配先生效。

export interface ShortcutBinding {
  key: string; // 不区分大小写；可写 "p" "shift+c" "ctrl+f" "escape"
  description?: string;
  handler: (e: KeyboardEvent) => void;
  /** 默认 false：input/textarea/contenteditable 中不触发 */
  allowInInput?: boolean;
  /** 阻止默认行为 */
  preventDefault?: boolean;
}

export function parseKey(spec: string): {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
} {
  const parts = spec.toLowerCase().split("+").map((s) => s.trim());
  const out = {
    key: parts[parts.length - 1],
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
  };
  for (const p of parts.slice(0, -1)) {
    if (p === "ctrl" || p === "control") out.ctrl = true;
    else if (p === "shift") out.shift = true;
    else if (p === "alt" || p === "option") out.alt = true;
    else if (p === "meta" || p === "cmd" || p === "command") out.meta = true;
  }
  return out;
}

function isInEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function matches(e: KeyboardEvent, parsed: ReturnType<typeof parseKey>): boolean {
  if (e.key.toLowerCase() !== parsed.key) return false;
  const ctrl = e.ctrlKey;
  const shift = e.shiftKey;
  const alt = e.altKey;
  const meta = e.metaKey;
  if (parsed.ctrl !== ctrl) return false;
  if (parsed.shift !== shift) return false;
  if (parsed.alt !== alt) return false;
  if (parsed.meta !== meta) return false;
  return true;
}

export function registerShortcuts(
  bindings: ShortcutBinding[],
  scope: HTMLElement | Window = window,
): () => void {
  const parsed = bindings.map((b) => ({ ...b, parsed: parseKey(b.key) }));
  const handler = (e: Event) => {
    if (!(e instanceof KeyboardEvent)) return;
    for (const b of parsed) {
      if (!matches(e, b.parsed)) continue;
      if (!b.allowInInput && isInEditableTarget(e.target)) continue;
      if (b.preventDefault !== false) e.preventDefault();
      b.handler(e);
      return;
    }
  };
  scope.addEventListener("keydown", handler as EventListener);
  return () => scope.removeEventListener("keydown", handler as EventListener);
}

// 工具：把 "shift+c" 这种规范化为可读字符串（用于帮助 / 文档）。
export function describeKey(spec: string): string {
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const parts = spec.split("+").map((s) => s.trim());
  const last = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const labels = mods.map((m) => {
    if (m === "ctrl") return isMac ? "⌃" : "Ctrl";
    if (m === "shift") return isMac ? "⇧" : "Shift";
    if (m === "alt") return isMac ? "⌥" : "Alt";
    if (m === "meta" || m === "cmd") return isMac ? "⌘" : "Win";
    return m;
  });
  const keyLabel =
    last.length === 1 ? last.toUpperCase() : last[0].toUpperCase() + last.slice(1);
  return [...labels, keyLabel].join("+");
}

