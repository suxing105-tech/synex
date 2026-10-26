import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { get } from "svelte/store";
import { writable } from "svelte/store";
import FolderTree from "../components/FolderTree.svelte";
import { folderId, query, scope, stats, switchContent, tag } from "../lib/stores";

vi.mock("../lib/native-drop", () => ({ subscribeFileDrop: vi.fn(() => () => {}) }));
vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
foldersApi: {
    tree: vi.fn(async () => []), importDirectories: vi.fn(async () => ({ copied: [], failed: [], warnings: [] })),
    create: vi.fn(), rename: vi.fn(), reorder: vi.fn(), reveal: vi.fn(),
  },
}));
vi.mock("../lib/stores", async () => {
  const { writable } = await import("svelte/store");
  return {
    folders: writable([]), folderId: writable(null), scope: writable("image"),
    query: writable(""), tag: writable(null), textMode: writable(false),
    switchContent: vi.fn(),
    stats: writable({ total_images: 12, total_videos: 5, total_audio: 3, total_texts: 40, folders: 0 }),
    refreshFolders: vi.fn(), refreshFeed: vi.fn(), refreshStats: vi.fn(),
  };
});

beforeEach(() => {
  vi.mocked(switchContent).mockClear();
  folderId.set(null);
  scope.set("image");
  query.set("");
  tag.set(null);
});
afterEach(() => cleanup());

it("系统区只有四行素材入口，收藏与最近生成已经不存在", () => {
  const screen = render(FolderTree);
  for (const label of ["全部图片", "所有视频", "全部音频", "全部文本"]) {
    expect(screen.getByText(label)).toBeTruthy();
  }
  expect(screen.queryByText("收藏")).toBeNull();
  expect(screen.queryByText("最近生成")).toBeNull();
});

it("每一行显示自己类型的数量，量词与 hover 明细同时给出", () => {
  const screen = render(FolderTree);
  const rows = Array.from(screen.container.querySelectorAll(".folder-item"));
  const video = rows.find((r) => r.textContent?.includes("所有视频"))!;
  expect(video.querySelector(".count")?.textContent).toBe("5");
  expect(video.querySelector(".count")?.getAttribute("title")).toBe("12 张图片 · 5 个视频 · 3 条音频 · 40 篇文本");
  const audio = rows.find((r) => r.textContent?.includes("全部音频"))!;
  expect(audio.querySelector(".count")?.textContent).toBe("3");
});

it("点击「所有视频」切到视频口径并清空 folder/tag/query", async () => {
  const screen = render(FolderTree);
  await fireEvent.click(screen.getByText("所有视频"));
  expect(switchContent).toHaveBeenCalledWith("video", true);
  expect(get(scope)).toBe("image");
  expect(get(folderId)).toBe(null);
  expect(get(query)).toBe("");
  expect(get(tag)).toBe(null);
});

it("口径小字跟着当前 scope 走", () => {
  const screen = render(FolderTree);
  expect(screen.container.querySelector(".scope-caption")?.textContent).toBe("计数 · 图片");
});
