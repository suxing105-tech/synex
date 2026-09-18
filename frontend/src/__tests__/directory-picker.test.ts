import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { scanProgress, refreshFeed } from "../lib/stores";
import { scanApi, settingsApi } from "../lib/api";
import { selectImportDirectory, isTauri } from "../lib/tauri";
import Modal from "../components/OnboardingModal.svelte";

vi.mock("../lib/api", () => ({
  scanApi: { importDirectory: vi.fn(), validateDirectory: vi.fn(), progress: vi.fn() },
  settingsApi: { get: vi.fn() },
}));
vi.mock("../lib/tauri", () => ({ isTauri: vi.fn(), selectImportDirectory: vi.fn(), getSidecarStatus: vi.fn() }));
vi.mock("../lib/stores", async () => {
  const { writable } = await import("svelte/store");
  return { scanProgress: writable({ running: false, total: 0, indexed: 0, scanned: 0, current_path: "", error: null }),
    refreshFolders: vi.fn(), refreshStats: vi.fn(), refreshFeed: vi.fn() };
});

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(settingsApi.get).mockResolvedValue({ watch_dirs: ["D:\\old"] } as any);
  scanProgress.set({ running: false, total: 0, indexed: 0, scanned: 0, current_path: "", error: null });
});
afterEach(cleanup);

describe("目录选择与导入窗口", () => {
  it("fills a selected Chinese path without saving or scanning", async () => {
    vi.mocked(selectImportDirectory).mockResolvedValue("D:\\中文 output");
    vi.mocked(scanApi.validateDirectory).mockResolvedValue({ path: "D:\\中文 output" });
    const ui = render(Modal, { open: true });
    await fireEvent.click(ui.getByRole("button", { name: "选择文件夹" }));
    await waitFor(() => expect((ui.getByLabelText("目录路径") as HTMLInputElement).value).toBe("D:\\中文 output"));
    expect(scanApi.importDirectory).not.toHaveBeenCalled();
  });
  it("keeps manually entered paths on cancellation", async () => {
    vi.mocked(selectImportDirectory).mockResolvedValue(null);
    const ui = render(Modal, { open: true });
    await fireEvent.input(ui.getByLabelText("目录路径"), { target: { value: "D:\\original" } });
    await fireEvent.click(ui.getByRole("button", { name: "选择文件夹" }));
    await waitFor(() => expect(selectImportDirectory).toHaveBeenCalled());
    await tick();
    expect((ui.getByLabelText("目录路径") as HTMLInputElement).value).toBe("D:\\original");
    expect(scanApi.validateDirectory).not.toHaveBeenCalled();
  });
  it("ignores picker results after the modal closes", async () => {
    let finish!: (value: string) => void;
    vi.mocked(selectImportDirectory).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const ui = render(Modal, { open: true });
    await fireEvent.click(ui.getByRole("button", { name: "选择文件夹" }));
    await waitFor(() => expect(selectImportDirectory).toHaveBeenCalled());
    await ui.rerender({ open: false });
    finish("D:\\late"); await tick();
    expect(scanApi.validateDirectory).not.toHaveBeenCalled();
    await ui.rerender({ open: true });
    expect((ui.getByLabelText("目录路径") as HTMLInputElement).value).toBe("");
  });
  it("closes after successfully importing an empty directory", async () => {
    vi.mocked(scanApi.importDirectory).mockResolvedValue({ ok: true, path: "D:\\empty" });
    vi.mocked(scanApi.progress).mockResolvedValue({ running: false, total: 0, indexed: 0, scanned: 0, current_path: "", error: null });
    const ui = render(Modal, { open: true });
    await fireEvent.input(ui.getByLabelText("目录路径"), { target: { value: "D:\\empty" } });
    await fireEvent.click(ui.getByRole("button", { name: "开始导入" }));
    await waitFor(() => expect(ui.queryByRole("dialog")).toBeNull());
    expect(scanApi.importDirectory).toHaveBeenCalledWith("D:\\empty");
  });
  it("keeps the dialog busy until the imported gallery has refreshed", async () => {
    vi.mocked(scanApi.importDirectory).mockResolvedValue({ ok: true, path: "D:/images" });
    vi.mocked(scanApi.progress).mockResolvedValue({ running: false, total: 3, indexed: 3, scanned: 3, current_path: "", error: null });
    let finish!: () => void;
    vi.mocked(refreshFeed).mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const ui = render(Modal, { open: true });
    await fireEvent.input(ui.getByLabelText("目录路径"), { target: { value: "D:/images" } });
    await fireEvent.click(ui.getByRole("button", { name: "开始导入" }));
    await waitFor(() => expect(refreshFeed).toHaveBeenCalled());
    expect(ui.getByRole("dialog")).toBeTruthy();
    expect((ui.getByRole("button", { name: "导入中…" }) as HTMLButtonElement).disabled).toBe(true);
    finish();
    await waitFor(() => expect(ui.queryByRole("dialog")).toBeNull());
  });
  it.each(["scan", "refresh"])("keeps the dialog open after a %s failure", async (failure) => {
    vi.mocked(scanApi.importDirectory).mockResolvedValue({ ok: true, path: "D:/images" });
    vi.mocked(scanApi.progress).mockResolvedValue({ running: false, total: 3, indexed: 2, scanned: 3, current_path: "", error: failure === "scan" ? "扫描失败" : null });
    if (failure === "refresh") vi.mocked(refreshFeed).mockRejectedValue(new Error("offline"));
    const ui = render(Modal, { open: true });
    await fireEvent.input(ui.getByLabelText("目录路径"), { target: { value: "D:/images" } });
    await fireEvent.click(ui.getByRole("button", { name: "开始导入" }));
    await waitFor(() => expect(ui.getByRole("alert").textContent).toContain(failure === "scan" ? "扫描失败" : "刷新失败"));
    expect(ui.getByRole("dialog")).toBeTruthy();
  });
  it("shows server validation errors and preserves the path for retry", async () => {
    vi.mocked(scanApi.importDirectory).mockRejectedValue({ detail: "文件夹不存在，请重新选择" });
    const ui = render(Modal, { open: true });
    await fireEvent.input(ui.getByLabelText("目录路径"), { target: { value: "D:\\missing" } });
    await fireEvent.click(ui.getByRole("button", { name: "开始导入" }));
    await waitFor(() => expect(ui.getByRole("alert").textContent).toContain("文件夹不存在"));
    expect((ui.getByLabelText("目录路径") as HTMLInputElement).value).toBe("D:\\missing");
    expect(scanApi.progress).not.toHaveBeenCalled();
  });
  it("keeps manual input available in browser mode", () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const ui = render(Modal, { open: true });
    expect(ui.queryByRole("button", { name: "选择文件夹" })).toBeNull();
    expect(ui.getByLabelText("目录路径")).toBeTruthy();
  });
});
