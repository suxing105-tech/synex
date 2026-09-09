import { get, writable } from "svelte/store";
import { isTauri } from "./tauri";

export interface UpdateStatus {
  current_version: string; configured: boolean; installable: boolean;
  phase: string; message: string; version: string | null; notes: string;
  downloaded: number; total: number | null; automatic: boolean; last_check: number;
}
export const updateStatus = writable<UpdateStatus | null>(null);
export const updateError = writable("");
export function isUpdateBusy(phase: string) {
  return ["checking", "downloading", "installing"].includes(phase);
}
export function downloadPercent(downloaded: number, total: number | null) {
  return total && total > 0 ? Math.min(100, Math.max(0, Math.floor(downloaded / total * 100))) : null;
}
export async function updateAction(command: string, args: Record<string, unknown> = {}) {
  if (!isTauri()) return;
  if (args.automatic && isUpdateBusy(get(updateStatus)?.phase ?? "")) return;
  updateError.set("");
  try {
    const result = await (window as any).__TAURI__.core.invoke(command, args);
    updateStatus.set(result);
  } catch (error) { updateError.set(String(error)); }
}
export function startUpdates() {
  if (!isTauri()) return () => {};
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  const timer = setTimeout(() => { if (!disposed) void updateAction("check_update", { automatic: true }); }, 15000);
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
  return () => { disposed = true; clearTimeout(timer); clearInterval(retry); unsubscribe?.(); };
}
