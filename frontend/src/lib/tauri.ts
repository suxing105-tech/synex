// 苏醒图库 — Tauri 壳层适配层
//
// 仅在 Tauri WebView 中可用（isTauri() 判断）。
// - isTauri()         是否运行在 Tauri 壳里
// - getSidecarStatus() 读 Rust 端 SidecarState
// - onSidecarReady()  订阅后端 READY（spawn 后立刻）
// - onSidecarDied()   订阅后端崩溃

export interface SidecarStatus {
  ready: boolean;
  port: number;
  data_dir: string;
  pid: number | null;
  last_error: string | null;
}

/**
 * 当前是否在 Tauri 壳中运行。
 * 在浏览器 dev (`pnpm dev`) 或生产构建 (`pnpm build`) 直接打开 dist/index.html 时为 false。
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as any).__TAURI__;
}

/** 原生单目录选择；取消返回 null，不触发保存或扫描。 */
export async function selectImportDirectory(current = "", previous = ""): Promise<string | null> {
  if (!isTauri()) throw new Error("文件夹选择仅在桌面版提供，请手动输入后台电脑上的路径");
  return (window as any).__TAURI__.core.invoke("select_import_directory", { current, previous });
}

/**
 * 读取 sidecar 当前状态（同步 invoke）。
 * Tauri 不可用时返回 null。
 */
export async function getSidecarStatus(): Promise<SidecarStatus | null> {
  if (!isTauri()) return null;
  const t = (window as any).__TAURI__;
  return await t.core.invoke("get_sidecar_status") as SidecarStatus;
}

/**
 * 订阅 sidecar-ready 事件。回调收到 sidecar READY 时打印的 JSON。
 * Tauri 不可用时返回 no-op unsubscribe。
 */
export async function onSidecarReady(
  cb: (payload: unknown) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const t = (window as any).__TAURI__;
  const un = await t.event.listen("sidecar-ready", (e: { payload: unknown }) =>
    cb(e.payload),
  );
  return un;
}

/**
 * 订阅 sidecar-died 事件。
 */
export async function onSidecarDied(
  cb: (payload: { reason: string }) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const t = (window as any).__TAURI__;
  const un = await t.event.listen("sidecar-died", (e: { payload: { reason: string } }) =>
    cb(e.payload),
  );
  return un;
}

/**
 * 重启 sidecar（P0 M0-c 暂为 kill-only 占位）
 */
export async function restartSidecar(): Promise<SidecarStatus | null> {
  if (!isTauri()) return null;
  const t = (window as any).__TAURI__;
  return await t.core.invoke("restart_sidecar") as SidecarStatus;
}
