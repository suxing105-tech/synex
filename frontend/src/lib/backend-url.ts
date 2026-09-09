import { isTauri } from "./tauri";

// 与 Rust sidecar 端口及 Tauri CSP 保持一致。
export function backendUrl(path: string): string {
  return isTauri() && /^\/(?:api|thumbs)(?:\/|\?|$)/.test(path)
    ? `http://127.0.0.1:8765${path}`
    : path;
}

export function eventsUrl(): string {
  if (isTauri()) return "ws://127.0.0.1:8765/ws/events";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws/events`;
}
