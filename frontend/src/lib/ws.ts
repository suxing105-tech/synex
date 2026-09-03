import { feedItems, feedTotal, markNew, refreshFolders, refreshFeed, refreshScanProgress, refreshStats } from "./stores";

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function connectEvents() {
  if (socket && socket.readyState <= 1) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws/events`;
  const ws = new WebSocket(url);
  socket = ws;
  ws.onmessage = async (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      if (payload.type === "image_indexed") {
        // 拉一次最新 feed（保持倒序）
        await refreshFeed();
        await refreshStats();
        markNew([payload.id]);
      } else if (payload.type === "image_removed") {
        // 乐观更新本地 feedItems（filter 掉该 id），避免 refreshFeed 重排导致滚动条跳顶。
        const id = payload.id;
        let removed = false;
        feedItems.update((items) => {
          const next = items.filter((it) => it.id !== id);
          removed = next.length !== items.length;
          return next;
        });
        if (removed) feedTotal.update((n) => Math.max(0, n - 1));
        await refreshStats();
      } else if (payload.type === "scan_progress") {
        // 后端会发 scan 进度；用单独轮询补上
        await refreshScanProgress();
      }
    } catch (e) {
      console.warn("ws message parse failed", e);
    }
  };
  ws.onclose = () => {
    socket = null;
    reconnectTimer = setTimeout(connectEvents, 2000);
  };
  ws.onerror = () => {
    ws.close();
  };
}

export function disconnectEvents() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) {
    socket.close();
    socket = null;
  }
}

// ---------- 复制工具 ----------


export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 后备方案
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }
}

// ---------- 格式化 ----------


export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDate(mtime: number): string {
  return new Date(mtime * 1000).toLocaleString("zh-CN");
}

export function paramsToKv(params: Record<string, unknown>): [string, string][] {
  return Object.entries(params).map(([k, v]) => [k, String(v)]);
}

export function allParamsText(detail: {
  positive_prompt: string;
  negative_prompt: string;
  parameters: Record<string, unknown>;
  seed: number | null;
  model: string | null;
  sampler: string | null;
  steps: number | null;
  cfg: number | null;
}): string {
  const lines: string[] = [];
  if (detail.positive_prompt) lines.push(detail.positive_prompt);
  if (detail.negative_prompt) lines.push(`Negative prompt: ${detail.negative_prompt}`);
  const extras: string[] = [];
  if (detail.seed !== null) extras.push(`Seed: ${detail.seed}`);
  if (detail.sampler) extras.push(`Sampler: ${detail.sampler}`);
  if (detail.steps !== null) extras.push(`Steps: ${detail.steps}`);
  if (detail.cfg !== null) extras.push(`CFG scale: ${detail.cfg}`);
  if (detail.model) extras.push(`Model: ${detail.model}`);
  for (const [k, v] of Object.entries(detail.parameters)) {
    extras.push(`${k}: ${v}`);
  }
  if (extras.length) lines.push(extras.join(", "));
  return lines.join("\n");
}

// 防止重复加载
export const _noDuplicate = refreshFolders;
