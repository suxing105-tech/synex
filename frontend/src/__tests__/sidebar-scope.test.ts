import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import FolderTree from "../components/FolderTree.svelte";
import { folderId, folders, scope, stats } from "../lib/stores";
import type { FolderNode, Stats } from "../lib/types";

vi.mock("../lib/native-drop", () => ({ subscribeFileDrop: vi.fn(() => () => {}) }));
vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []), importDirectories: vi.fn(), create: vi.fn(), rename: vi.fn(), reorder: vi.fn(), move: vi.fn(), remove: vi.fn() },
  statsApi: { get: vi.fn() },
  scanApi: { progress: vi.fn() },
  comfyuiApi: {},
}));

const LIBRARY: Stats = { total_images: 40, total_videos: 11, total_audio: 3, total_texts: 40, folders: 2 };

function node(partial: Partial<FolderNode> & { id: number; name: string }): FolderNode {
  const counts = partial.counts ?? { image: 0, video: 0, audio: 0, text: 0 };
  return {
    parent_id: null,
    order: 0,
    counts,
    total: counts.image + counts.video + counts.audio + counts.text,
    children: [],
    ...partial,
  } as FolderNode;
}

const PHOTO = node({ id: 11, name: "摄影", counts: { image: 12, video: 2, audio: 0, text: 5 } });
const NOTE = node({ id: 12, name: "笔记", counts: { image: 0, video: 0, audio: 1, text: 8 } });

function rowOf(container: HTMLElement, label: string): HTMLElement {
  const labelEl = [...container.querySelectorAll<HTMLElement>(".folder-item .label")]
    .find((el) => el.textContent?.trim() === label);
  if (!labelEl) throw new Error(`侧栏没有「${label}」这一行`);
  return labelEl.closest(".folder-item") as HTMLElement;
}

function countOf(container: HTMLElement, label: string): HTMLElement {
  return rowOf(container, label).querySelector(".count") as HTMLElement;
}

function systemRowCount(container: HTMLElement): number {
  const labels = [...container.querySelectorAll<HTMLElement>(".folder-item .label")].map((el) => el.textContent?.trim());
  return ["所有素材", "全部图片", "所有视频", "全部音频", "全部文本"].filter((l) => labels.includes(l)).length;
}

beforeEach(() => {
  scope.set("all");
  folderId.set(null);
  stats.set(LIBRARY);
  folders.set([PHOTO, NOTE]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  scope.set("all");
  folderId.set(null);
});

describe("侧栏系统区：一行 = 一个 scope", () => {
  it("五行齐全，顺序是 所有素材 / 图片 / 视频 / 音频 / 文本", () => {
    const { container } = render(FolderTree);
    const labels = [...container.querySelectorAll<HTMLElement>(".folder-item .label")].map((el) => el.textContent?.trim());
    expect(labels.slice(0, 5)).toEqual(["所有素材", "全部图片", "所有视频", "全部音频", "全部文本"]);
    expect(systemRowCount(container)).toBe(5);
  });

  it("收藏与最近生成不再出现在侧栏任何位置", () => {
    const { container } = render(FolderTree);
    const text = container.textContent || "";
    expect(text).not.toContain("收藏");
    expect(text).not.toContain("最近生成");
  });

  it("每行只有一个数字，且等于当前口径的量（不是四类之和）", () => {
    const { container } = render(FolderTree);
    expect(countOf(container, "所有素材").textContent).toBe("94");
    expect(countOf(container, "全部图片").textContent).toBe("40");
    expect(countOf(container, "所有视频").textContent).toBe("11");
    expect(countOf(container, "全部音频").textContent).toBe("3");
    expect(countOf(container, "全部文本").textContent).toBe("40");
    expect(rowOf(container, "全部音频").querySelectorAll(".count")).toHaveLength(1);
  });

  it("0 显示为暗灰（zero 类），不是隐藏", () => {
    stats.set({ ...LIBRARY, total_videos: 0 });
    const { container } = render(FolderTree);
    const el = countOf(container, "所有视频");
    expect(el.textContent).toBe("0");
    expect(el.classList.contains("zero")).toBe(true);
    expect(countOf(container, "全部图片").classList.contains("zero")).toBe(false);
  });

  it("一万以上折成「万」，侧栏不被长数字挤爆", () => {
    stats.set({ ...LIBRARY, total_images: 12345 });
    const { container } = render(FolderTree);
    expect(countOf(container, "全部图片").textContent).toBe("1.2万");
  });
});

describe("口径显式化：分组小字 + hover 明细", () => {
  it("「系统」右侧的口径小字随 scope 变化", async () => {
    const { container } = render(FolderTree);
    const caption = container.querySelector(".scope-caption") as HTMLElement;
    expect(caption.textContent).toBe("计数 · 全部素材");
    scope.set("audio");
    await tick();
    expect(caption.textContent).toBe("计数 · 音频");
    scope.set("text");
    await tick();
    expect(caption.textContent).toBe("计数 · 文本");
  });

  it("每个数字的 title 给出四类明细，含 0 项", async () => {
    const { container } = render(FolderTree);
    expect(countOf(container, "全部音频").getAttribute("title"))
      .toBe("40 张图片 · 11 个视频 · 3 条音频 · 40 篇文本");
    expect(countOf(container, "摄影").getAttribute("title"))
      .toBe("12 张图片 · 2 个视频 · 0 条音频 · 5 篇文本");
  });

  it("文件夹行的数字同样只数当前 scope，切换口径后同一行数字会变", async () => {
    const { container } = render(FolderTree);
    expect(countOf(container, "摄影").textContent).toBe("19");
    expect(countOf(container, "笔记").textContent).toBe("9");
    scope.set("image");
    await tick();
    expect(countOf(container, "摄影").textContent).toBe("12");
    expect(countOf(container, "笔记").textContent).toBe("0");
    expect(countOf(container, "笔记").classList.contains("zero")).toBe(true);
    scope.set("text");
    await tick();
    expect(countOf(container, "摄影").textContent).toBe("5");
  });

  it("只有系统行带口径小字，文件夹分组不重复标注", () => {
    const { container } = render(FolderTree);
    expect(container.querySelectorAll(".scope-caption")).toHaveLength(1);
  });
});

describe("侧栏导航：active 跟随 scope", () => {
  it("默认落在「所有素材」", () => {
    const { container } = render(FolderTree);
    expect(rowOf(container, "所有素材").classList.contains("active")).toBe(true);
    expect(rowOf(container, "全部图片").classList.contains("active")).toBe(false);
  });

  it("点某一行 = 切 scope 并回到该类型的根（取消文件夹选中）", async () => {
    folderId.set(11);
    const { container } = render(FolderTree);
    await fireEvent.click(rowOf(container, "全部音频"));
    expect(get(scope)).toBe("audio");
    expect(get(folderId)).toBeNull();
    await tick();
    expect(rowOf(container, "全部音频").classList.contains("active")).toBe(true);
    expect(rowOf(container, "所有素材").classList.contains("active")).toBe(false);
  });

  it("选中具体文件夹时，系统行都不高亮（否则两行同时亮，读不出在哪）", async () => {
    const { container } = render(FolderTree);
    folderId.set(11);
    await tick();
    const active = container.querySelectorAll(".folder-item.active");
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toContain("摄影");
    expect(rowOf(container, "所有素材").classList.contains("active")).toBe(false);
  });

  it("键盘 Enter 也能切口径", async () => {
    const { container } = render(FolderTree);
    await fireEvent.keyDown(rowOf(container, "所有视频"), { key: "Enter" });
    expect(get(scope)).toBe("video");
  });
});
