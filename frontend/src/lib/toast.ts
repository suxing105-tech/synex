// 全局 Toast 队列（堆叠，最多 N 个，自动消失）。
//
// 用法：
//   import { pushToast } from "../lib/toast";
//   pushToast("已复制 Prompt");
//   pushToast("复制失败", { kind: "error", ttl: 4000 });
//
// 带操作的底部居中提示条（「一句话 + 可撤销」这类反馈，例如归档目录）：
//   pushToast("已归档「output」· 磁盘上的文件没有动", {
//     placement: "center", icon: "archive", ttl: 3000,
//     actions: [{ label: "查看", onClick }, { label: "撤销", onClick, primary: true }],
//   });
//
// placement: "center" 的条目会在鼠标悬停时暂停倒计时（pauseToast / resumeToast），
// 否则 3 秒自动消失会把「撤销」按钮从指尖抽走。
import { writable } from "svelte/store";

export type ToastKind = "info" | "success" | "error" | "progress";
/** corner = 右下角堆叠（历史默认）；center = 底部居中浮动药丸 */
export type ToastPlacement = "corner" | "center";

export interface ToastAction {
  label: string;
  onClick: () => void;
  /** 主操作：浅底实心药丸；其余按幽灵按钮渲染 */
  primary?: boolean;
}

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
  /** 自动消失 ms；0 = 不自动消失（progress / error 默认 0） */
  ttl: number;
  /** 进度型可选：0-100；undefined = 不确定 */
  progress?: number;
  createdAt: number;
  /** 文字左侧的图标名（Icon.svelte 的 key）；主要给居中提示条用 */
  icon?: string;
  placement: ToastPlacement;
  /** 行内操作按钮；点任意一个都会关掉这条 */
  actions?: ToastAction[];
}

const MAX_TOASTS = 4;
const DEFAULT_TTL: Record<ToastKind, number> = {
  info: 1500,
  success: 1500,
  error: 4000,
  progress: 0,
};
/** 悬停后恢复时至少还留这么久，别让用户移开鼠标就眼睁睁看它消失 */
const MIN_RESUME_MS = 600;

export const toasts = writable<ToastItem[]>([]);

let nextId = 1;

// 倒计时归这里管：pauseToast 要把剩余时间记下来，resumeToast 才能接着走完。
interface TimerEntry {
  remaining: number;
  started: number;
  timer: ReturnType<typeof setTimeout> | null;
}
const timers = new Map<number, TimerEntry>();

function schedule(id: number, ttl: number): void {
  const existing = timers.get(id);
  if (existing?.timer) clearTimeout(existing.timer);
  if (ttl <= 0) {
    timers.delete(id);
    return;
  }
  const entry: TimerEntry = {
    remaining: ttl,
    started: Date.now(),
    timer: setTimeout(() => {
      timers.delete(id);
      dismissToast(id);
    }, ttl),
  };
  timers.set(id, entry);
}

/** 悬停在提示条上：冻结倒计时 */
export function pauseToast(id: number): void {
  const entry = timers.get(id);
  if (!entry || entry.timer === null) return;
  clearTimeout(entry.timer);
  entry.timer = null;
  entry.remaining = Math.max(MIN_RESUME_MS, entry.remaining - (Date.now() - entry.started));
}

/** 鼠标离开：用剩余时间继续，剩余不足 MIN_RESUME_MS 时按 MIN_RESUME_MS 兜底 */
export function resumeToast(id: number): void {
  const entry = timers.get(id);
  if (!entry || entry.timer !== null) return;
  entry.remaining = Math.max(MIN_RESUME_MS, entry.remaining);
  entry.started = Date.now();
  entry.timer = setTimeout(() => {
    timers.delete(id);
    dismissToast(id);
  }, entry.remaining);
}

export function pushToast(
  message: string,
  opts: {
    kind?: ToastKind;
    ttl?: number;
    progress?: number;
    id?: number;
    icon?: string;
    placement?: ToastPlacement;
    actions?: ToastAction[];
  } = {},
): number {
  const kind = opts.kind ?? "info";
  const item: ToastItem = {
    id: opts.id ?? nextId++,
    message,
    kind,
    ttl: opts.ttl ?? DEFAULT_TTL[kind],
    progress: opts.progress,
    createdAt: Date.now(),
    icon: opts.icon,
    placement: opts.placement ?? "corner",
    actions: opts.actions,
  };
  toasts.update((list) => {
    // 同 id 更新：替换
    const idx = list.findIndex((t) => t.id === item.id);
    let next: ToastItem[];
    if (idx >= 0) {
      next = [...list];
      next[idx] = item;
    } else {
      next = [...list, item];
    }
    // 超长裁剪（最早的优先丢）
    if (next.length > MAX_TOASTS) next = next.slice(next.length - MAX_TOASTS);
    return next;
  });
  schedule(item.id, item.ttl);
  return item.id;
}

export function updateToast(
  id: number,
  patch: Partial<Pick<ToastItem, "message" | "kind" | "progress" | "ttl">>,
): void {
  toasts.update((list) =>
    list.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  );
  if (patch.ttl !== undefined) schedule(id, patch.ttl);
}

export function dismissToast(id: number): void {
  const entry = timers.get(id);
  if (entry?.timer) clearTimeout(entry.timer);
  timers.delete(id);
  toasts.update((list) => list.filter((t) => t.id !== id));
}

export function clearToasts(): void {
  for (const entry of timers.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  timers.clear();
  toasts.set([]);
}
