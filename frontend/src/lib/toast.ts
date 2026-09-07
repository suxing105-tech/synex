// 全局 Toast 队列（堆叠，最多 N 个，自动消失）。
//
// 用法：
//   import { pushToast } from "../lib/toast";
//   pushToast("已复制 Prompt");
//   pushToast("复制失败", { kind: "error", ttl: 4000 });
import { writable } from "svelte/store";

export type ToastKind = "info" | "success" | "error" | "progress";

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
  /** 自动消失 ms；0 = 不自动消失（progress / error 默认 0） */
  ttl: number;
  /** 进度型可选：0-100；undefined = 不确定 */
  progress?: number;
  createdAt: number;
}

const MAX_TOASTS = 4;
const DEFAULT_TTL: Record<ToastKind, number> = {
  info: 1500,
  success: 1500,
  error: 4000,
  progress: 0,
};

export const toasts = writable<ToastItem[]>([]);

let nextId = 1;

export function pushToast(
  message: string,
  opts: {
    kind?: ToastKind;
    ttl?: number;
    progress?: number;
    id?: number;
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
  if (item.ttl > 0) {
    setTimeout(() => dismissToast(item.id), item.ttl);
  }
  return item.id;
}

export function updateToast(
  id: number,
  patch: Partial<Pick<ToastItem, "message" | "kind" | "progress" | "ttl">>,
): void {
  toasts.update((list) =>
    list.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  );
}

export function dismissToast(id: number): void {
  toasts.update((list) => list.filter((t) => t.id !== id));
}

export function clearToasts(): void {
  toasts.set([]);
}
