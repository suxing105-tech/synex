import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { get } from "svelte/store";
import TextAssociateModal from "../components/TextAssociateModal.svelte";
import { itemsApi } from "../lib/api";
import { textsApi } from "../lib/texts";
import { associateTextPaths, feedItems, feedLoading, readerItem } from "../lib/stores";
import { isTextFilePath } from "../lib/text-reading";
import type { TextSummary } from "../lib/texts";

/**
 * 关联本地文本：文本不复制进图库，编辑直接写回原文件，所以入库前必须让用户
 * 看清范围（先 preview 再 associate）。拖进来的路径由 associateTextPaths 递进来。
 */
vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn(), presence: vi.fn(), remove: vi.fn(), rename: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn(async () => ({ total_images: 0, total_videos: 0, total_audio: 0, total_texts: 0, folders: 0 })) },
  scanApi: { progress: vi.fn() }, comfyuiApi: {}, videosApi: { open: vi.fn() }, audioApi: { open: vi.fn() },
}));

const saved = (id: number, filename: string): TextSummary => ({
  id, filename, path: `D:/notes/${filename}`, mtime: 1, created: 1, opened: 1, tags: [],
  format: filename.split(".").pop() || "txt", excerpt: "摘录", missing: false, error: "",
});
const PREVIEW = { total: 3, formats: { md: 2, txt: 1 }, roots: ["D:/notes"], errors: [] };

function openModal(paths: string[] = ["D:/notes"]) {
  const onClose = vi.fn();
  associateTextPaths.set(paths);
  const ui = render(TextAssociateModal, { open: true, paths, onClose });
  return { ...ui, onClose };
}

beforeEach(() => {
  localStorage.clear();
  feedLoading.set(false);
  readerItem.set(null);
  associateTextPaths.set(null);
  feedItems.set([]);
  vi.mocked(itemsApi.list).mockResolvedValue({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 }, limit: 500, offset: 0 });
  vi.spyOn(textsApi, "preview").mockResolvedValue(PREVIEW);
  vi.spyOn(textsApi, "associate").mockResolvedValue({ saved: [saved(11, "随想1.md"), saved(12, "随想2.txt")], errors: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  readerItem.set(null);
  associateTextPaths.set(null);
  feedItems.set([]);
});

describe("关联本地文本", () => {
  it("打开就按传进来的路径先预览范围，不直接入库", async () => {
    const ui = openModal(["D:/notes", "D:/x/随想.md"]);
    const dialog = await ui.findByRole("dialog", { name: "关联本地文本" });
    expect(vi.mocked(textsApi.preview).mock.calls[0][0]).toEqual(["D:/notes", "D:/x/随想.md"]);
    await ui.findByText("将纳入 3 个文本");
    expect(dialog.textContent).toContain("D:/notes");
    expect(dialog.textContent).toContain("MD 2 · TXT 1");
    expect(textsApi.associate).not.toHaveBeenCalled();
  });

  it("确认后入库 + 刷新网格 + 立刻打开第一篇，并关掉拖放入口", async () => {
    const ui = openModal();
    await ui.findByText("将纳入 3 个文本");
    await fireEvent.click(ui.getByRole("button", { name: "确认关联 · 编辑将保存到原文件" }));
    await waitFor(() => expect(textsApi.associate).toHaveBeenCalledWith(["D:/notes"]));
    await waitFor(() => expect(itemsApi.list).toHaveBeenCalled());
    await waitFor(() => expect(get(readerItem)?.id).toBe(11));
    expect(get(readerItem)?.filename).toBe("随想1.md");
    expect(ui.onClose).toHaveBeenCalled();
    expect(get(associateTextPaths)).toBeNull();
  });

  it("改过路径就作废上一次预览，必须重新预览；按钮在没路径时不可用", async () => {
    const ui = openModal([]);
    await ui.findByRole("dialog", { name: "关联本地文本" });
    expect(textsApi.preview).not.toHaveBeenCalled();
    const area = ui.getByLabelText("关联路径") as HTMLTextAreaElement;
    expect(area.value).toBe("");
    expect(ui.getByRole("button", { name: "预览范围" }).hasAttribute("disabled")).toBe(true);
    // 手打路径不能被传进来的 paths 覆盖回去
    await fireEvent.input(area, { target: { value: "D:/手打的目录" } });
    expect(area.value).toBe("D:/手打的目录");
    await fireEvent.input(area, { target: { value: "D:/新目录" } });
    expect(ui.queryByText(/将纳入/)).toBeNull();
    await fireEvent.click(ui.getByRole("button", { name: "预览范围" }));
    await waitFor(() => expect(textsApi.preview).toHaveBeenLastCalledWith(["D:/新目录"]));
    await fireEvent.click(ui.getByRole("button", { name: "确认关联 · 编辑将保存到原文件" }));
    await waitFor(() => expect(textsApi.associate).toHaveBeenLastCalledWith(["D:/新目录"]));
  });

  it("范围里有拿不了的文件时逐条说明原因，不让整批静默失败", async () => {
    vi.mocked(textsApi.preview).mockResolvedValue({ ...PREVIEW, errors: [{ path: "D:/notes/坏文件.md", reason: "文件超过 2MB" }] });
    const ui = openModal();
    const alert = await ui.findByText(/坏文件.md：文件超过 2MB/);
    expect(alert.className).toContain("error");
  });

  it("只认后端支持的那几种后缀，其余仍然走图片导入", () => {
    expect(["D:/a.md", "D:/a.markdown", "D:/a.txt", "D:/a.srt", "D:/a.vtt"].map(isTextFilePath)).toEqual([true, true, true, true, true]);
    expect(["D:/a.docx", "D:/a.pdf", "D:/a.png", "D:/readme"].map(isTextFilePath)).toEqual([false, false, false, false]);
  });
});
