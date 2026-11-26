import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { get } from "svelte/store";
import SettingsModal from "../components/SettingsModal.svelte";
import { scanApi, settingsApi } from "../lib/api";
import { pushToast } from "../lib/toast";
import { scanProgress } from "../lib/stores";

// 出完一批图，右侧还看不见：来源目录的监听是尽力而为的（重启会带走没落地的事件），
// 所以设置页必须能「就重扫这一条目录」，而不是让人整库重建或干脆没入口。
const DIR = "D:\\AI\\ComfyUI\\output";

vi.mock("../lib/toast", () => ({ pushToast: vi.fn() }));

vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  settingsApi: { get: vi.fn(async () => ({ watch_dirs: [DIR], live_enabled: true })), update: vi.fn(async (cfg: any) => cfg) },
  scanApi: { start: vi.fn(async () => ({ ok: true, targets: [] })), progress: vi.fn(async () => ({ running: false, scanned: 0, indexed: 0, total: 0, current_path: "", error: null, sweeping: false, sweep_indexed: 0, sweep_total: 0 })) },
  comfyuiApi: { status: vi.fn(async () => ({ running: false, enabled: true, url: "", reason: "", reason_code: "" })), scan: vi.fn(async () => ({ current: "", running: false, reason: "", reason_code: "", candidates: [] })), updateConfig: vi.fn(async (patch: any) => patch) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  foldersApi: { tree: vi.fn(async () => []), archived: vi.fn(async () => []), restore: vi.fn(async () => ({ ok: true })) },
  healthApi: { get: vi.fn(async () => ({ available: true, missing: [], tools: {} })) },
  http: vi.fn(async (path: string) => (path === "/api/reverse-prompt-settings" ? { default_model_id: null, instruction: "", default_instruction: "" } : [])),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  scanProgress.set({ running: false, scanned: 0, indexed: 0, total: 0, current_path: "", error: null, sweeping: false, sweep_indexed: 0, sweep_total: 0 });
});

const rescanButton = (screen: any) => screen.getByRole("button", { name: `重新扫描监听目录 ${DIR}` });

it("每条来源目录都有「重新扫描」，点它就只扫那一条目录", async () => {
  const screen = render(SettingsModal, { open: true, tab: "通用" });
  await waitFor(() => expect(settingsApi.get).toHaveBeenCalled());
  await waitFor(() => expect(rescanButton(screen)).toBeTruthy());

  await fireEvent.click(rescanButton(screen));
  await waitFor(() => expect(scanApi.start).toHaveBeenCalledWith(DIR));
  expect(vi.mocked(pushToast)).toHaveBeenCalled();
});

it("扫描在跑时按钮禁用并改成「扫描中…」，不许重复发起", async () => {
  const screen = render(SettingsModal, { open: true, tab: "通用" });
  await waitFor(() => expect(rescanButton(screen)).toBeTruthy());

  scanProgress.set({ ...get(scanProgress), running: true, scanned: 3, total: 40 });
  await waitFor(() => expect((rescanButton(screen) as HTMLButtonElement).disabled).toBe(true));
  expect(rescanButton(screen).textContent).toBe("扫描中…");

  await fireEvent.click(rescanButton(screen));
  expect(scanApi.start).not.toHaveBeenCalled();
});

it("后端挡下并发扫描时把原因说出来，不静默失败", async () => {
  vi.mocked(scanApi.start).mockRejectedValueOnce(new Error("已有导入正在进行，请完成后再试"));
  const screen = render(SettingsModal, { open: true, tab: "通用" });
  await waitFor(() => expect(rescanButton(screen)).toBeTruthy());

  await fireEvent.click(rescanButton(screen));
  await waitFor(() =>
    expect(vi.mocked(pushToast).mock.calls.some(([msg]) => String(msg).includes("已有导入正在进行"))).toBe(true),
  );
});
