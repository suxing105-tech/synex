import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { get, writable } from "svelte/store";
import { tick } from "svelte";
import FolderTree from "../components/FolderTree.svelte";
import { scanApi, settingsApi } from "../lib/api";
import { selectImportDirectory } from "../lib/tauri";
import { folders, refreshFolders, refreshStats } from "../lib/stores";
import { addSourceDirectory, directoryBaseName } from "../lib/source-import";
import { clearToasts, toasts } from "../lib/toast";

// 来源目录 = 只登记位置 + 监听，不复制不移动。入口在侧栏标题右边的 +。
vi.mock("../lib/native-drop", () => ({ subscribeFileDrop: vi.fn(() => () => {}) }));
vi.mock("../lib/tauri", () => ({ selectImportDirectory: vi.fn(async () => null) }));
vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  foldersApi: { tree: vi.fn(), create: vi.fn(), rename: vi.fn(), reorder: vi.fn(), move: vi.fn(), remove: vi.fn(), importDirectories: vi.fn() },
  settingsApi: { get: vi.fn(async () => ({ watch_dirs: ["D:/AI/ComfyUI/output"] })) },
  scanApi: { importDirectory: vi.fn(async (path: string) => ({ ok: true, path })) },
}));
vi.mock("../lib/stores", () => ({
  folders: writable([]), folderId: writable(null), scope: writable("all"),
  query: writable(""), tag: writable(null),
  textMode: writable(false), switchContent: vi.fn(),
  stats: writable({ total_images: 0, total_videos: 0, total_audio: 0, total_texts: 0, folders: 0 }),
  refreshFolders: vi.fn(), refreshFeed: vi.fn(), refreshStats: vi.fn(),
}));

const messages = () => get(toasts).map((t) => t.message);

beforeEach(() => {
  vi.clearAllMocks();
  clearToasts();
  folders.set([
    { id: 1, name: "output", parent_id: null, order: 0, is_system: true, path: "D:/AI/ComfyUI/output", counts: { image: 0, video: 0, audio: 0, text: 0 }, total: 0, 
      children: [{ id: 2, name: "krea2", parent_id: 1, order: 0, is_system: true, path: "D:/AI/ComfyUI/output/krea2", counts: { image: 0, video: 0, audio: 0, text: 0 }, total: 0, children: [] }] },
    { id: 9, name: "我的文件夹", parent_id: null, order: 0, counts: { image: 0, video: 0, audio: 0, text: 0 }, total: 0, children: [] },
  ]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("添加来源目录", () => {
  it("来源目录标题右边有添加入口，和「我的文件夹」的 + 并存", () => {
    const screen = render(FolderTree);
    const add = screen.getByRole("button", { name: "添加来源目录" });
    expect(add.getAttribute("title")).toContain("不复制也不移动原文件");
    expect(screen.getByRole("button", { name: "新建文件夹" })).toBeTruthy();
  });

  it("还没有来源目录时也留着入口，并说明只监听不移动", () => {
    folders.set([]);
    const screen = render(FolderTree);
    expect(screen.getByRole("button", { name: "添加来源目录" })).toBeTruthy();
    expect(screen.getByText(/图库只读取并监听它，原文件留在原地/)).toBeTruthy();
  });

  it("选完目录就登记为来源目录并开始扫描，同时刷新侧栏", async () => {
    vi.mocked(selectImportDirectory).mockResolvedValueOnce("D:/AI/ComfyUI_windows/output");
    const screen = render(FolderTree);
    await fireEvent.click(screen.getByRole("button", { name: "添加来源目录" }));
    await tick();
    expect(settingsApi.get).toHaveBeenCalled();
    expect(selectImportDirectory).toHaveBeenCalledWith("", "D:/AI/ComfyUI/output");
    expect(scanApi.importDirectory).toHaveBeenCalledWith("D:/AI/ComfyUI_windows/output");
    expect(refreshFolders).toHaveBeenCalled();
    expect(refreshStats).toHaveBeenCalled();
    expect(messages().some((m) => m.includes("开始监听「output」") && m.includes("不移动原文件"))).toBe(true);
  });

  it("取消选择不发任何请求，也不弹提示", async () => {
    const screen = render(FolderTree);
    await fireEvent.click(screen.getByRole("button", { name: "添加来源目录" }));
    await tick();
    expect(scanApi.importDirectory).not.toHaveBeenCalled();
    expect(messages()).toEqual([]);
  });

  it("浏览器版没有原生选择框时给可读提示，不是一句失败", async () => {
    vi.mocked(selectImportDirectory).mockRejectedValueOnce(
      new Error("文件夹选择仅在桌面版提供，请手动输入后台电脑上的路径"));
    const screen = render(FolderTree);
    await fireEvent.click(screen.getByRole("button", { name: "添加来源目录" }));
    await tick();
    expect(messages().some((m) => m.includes("添加来源目录失败") && m.includes("桌面版"))).toBe(true);
  });

  it("连点两次只登记一次", async () => {
    let release: (value: string) => void = () => {};
    vi.mocked(selectImportDirectory).mockImplementation(() => new Promise<string>((resolve) => { release = resolve; }));
    const screen = render(FolderTree);
    const button = screen.getByRole("button", { name: "添加来源目录" });
    await fireEvent.click(button);
    await fireEvent.click(button);
    release("D:/素材盘");
    await tick();
    expect(scanApi.importDirectory).toHaveBeenCalledTimes(1);
  });
});

describe("来源目录末级名", () => {
  it("反斜杠、正斜杠、结尾斜杠、盘符根都能取到名字", () => {
    expect(directoryBaseName("D:\\AI\\ComfyUI\\output")).toBe("output");
    expect(directoryBaseName("F:/常用/5080 HOF EX 16G/")).toBe("5080 HOF EX 16G");
    expect(directoryBaseName("资料")).toBe("资料");
    expect(directoryBaseName("D:/")).toBe("D:");
  });

  it("记住最后一次导入的目录，取消时不记", async () => {
    vi.mocked(selectImportDirectory).mockResolvedValueOnce("F:/常用/新素材");
    await addSourceDirectory();
    expect(localStorage.getItem("suxing.lastImportDirectory")).toBe("F:/常用/新素材");
    vi.mocked(selectImportDirectory).mockResolvedValueOnce(null);
    await addSourceDirectory();
    expect(localStorage.getItem("suxing.lastImportDirectory")).toBe("F:/常用/新素材");
  });
});
