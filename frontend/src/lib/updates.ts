import { get, writable } from "svelte/store";
import { isTauri } from "./tauri";

export interface UpdateStatus {
  current_version: string; configured: boolean; installable: boolean;
  phase: string; message: string; version: string | null; notes: string;
  downloaded: number; total: number | null; automatic: boolean; auto_update: boolean; last_check: number;
}
export const updateStatus = writable<UpdateStatus | null>(null);
export const updateError = writable("");
export const oneClickUpdating = writable(false);
export function isUpdateBusy(phase: string) {
  return ["checking", "downloading", "installing"].includes(phase);
}
export function downloadPercent(downloaded: number, total: number | null) {
  return total && total > 0 ? Math.min(100, Math.max(0, Math.floor(downloaded / total * 100))) : null;
}
export async function updateAction(command: string, args: Record<string, unknown> = {}) {
  if (!isTauri()) return;
  if (args.automatic && (get(oneClickUpdating) || isUpdateBusy(get(updateStatus)?.phase ?? ""))) return;
  updateError.set("");
  try {
    const result = await (window as any).__TAURI__.core.invoke(command, args);
    updateStatus.set(result);
    return result as UpdateStatus;
  } catch (error) { updateError.set(String(error)); }
}
export async function installLatestUpdate() {
  const status = get(updateStatus);
  if (!status?.version || !status.installable || !status.configured ||
      get(oneClickUpdating) || isUpdateBusy(status.phase)) return;
  oneClickUpdating.set(true);
  try {
    const ready = status.phase === "ready" ? status : await updateAction("download_update");
    if (!ready) return;
    if (ready.phase !== "ready" || ready.version !== status.version) {
      updateError.set(ready.message || "更新未下载完成，请重试");
      return;
    }
    const installed = await updateAction("install_update");
    if (installed?.phase === "ready") updateError.set(installed.message);
  } finally { oneClickUpdating.set(false); }
}
/**
 * 自动更新：检查到新版本后自动下载并安装，复用侧栏那条一键更新链路
 * （download_update → install_update），不另起一套安装路径。
 * 只有用户显式打开开关、且安装位置已确认（非便携版）时才动手。
 */
export function shouldAutoInstall(status: UpdateStatus | null): status is UpdateStatus {
  return !!status?.auto_update && status.phase === "available" && !!status.version
    && status.installable && status.configured;
}
export function startUpdates() {
  if (!isTauri()) return () => {};
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  // 本次运行同一个版本只自动走一次，免得装完重启前被状态事件反复触发。
  let autoTarget: string | null = null;
  const watching = updateStatus.subscribe((status) => {
    if (disposed || !shouldAutoInstall(status)) return;
    if (autoTarget === status.version) return;
    autoTarget = status.version;
    void installLatestUpdate();
  });
  // 启动后尽快检查一次：Rust 侧对「本次启动还没检查成功」放行，不再被每日节流挡住。
  const timer = setTimeout(() => { if (!disposed) void updateAction("check_update", { automatic: true }); }, 3000);
  const retry = setInterval(() => { if (!disposed) void updateAction("check_update", { automatic: true }); }, 60000);
  void (async () => {
    try {
      const un = await (window as any).__TAURI__.event.listen("update-status", (e: { payload: UpdateStatus }) => {
        if (!disposed) updateStatus.set(e.payload);
      });
      if (disposed) { un(); return; }
      unsubscribe = un;
      await updateAction("get_update_status");
    } catch (error) { if (!disposed) updateError.set(String(error)); }
  })();
  return () => { disposed = true; clearTimeout(timer); clearInterval(retry); unsubscribe?.(); watching(); };
}
