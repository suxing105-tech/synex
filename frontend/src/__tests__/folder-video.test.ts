import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { get } from "svelte/store";
import FolderTree from "../components/FolderTree.svelte";
import { folders, folderId, kind, query, tag, view } from "../lib/stores";

vi.mock("../lib/native-drop", () => ({ subscribeFileDrop: vi.fn(() => () => {}) }));
vi.mock("../lib/api", () => ({
  foldersApi: {
    tree: vi.fn(async () => []), importDirectories: vi.fn(async () => ({ moved: [], failed: [], warnings: [] })),
    create: vi.fn(), rename: vi.fn(), reorder: vi.fn(), reveal: vi.fn(),
  },
}));
vi.mock("../lib/stores", async () => {
  const { writable } = await import("svelte/store");
  return {
    folders: writable([]), folderId: writable(null), view: writable("all"),
    kind: writable("image"), query: writable(""), tag: writable(null),
    stats: writable({ total_images: 0, total_videos: 5, favorites: 0 }),
    refreshFolders: vi.fn(), refreshFeed: vi.fn(), refreshStats: vi.fn(),
  };
});

beforeEach(() => {
  folders.set([]);
  folderId.set(null);
  view.set("all");
  kind.set("image");
  query.set("");
  tag.set(null);
});
afterEach(() => cleanup());

it("侧栏显示所有视频并显示视频计数", () => {
  const screen = render(FolderTree);
  expect(screen.getByText('所有视频')).toBeTruthy();
  expect(screen.getByText('5')).toBeTruthy();
});

it("点击所有视频设 kind=video 并清空 folder/view/tag/query", async () => {
  const screen = render(FolderTree);
  await fireEvent.click(screen.getByText('所有视频'));
  expect(get(kind)).toBe("video");
  expect(get(view)).toBe("all");
  expect(get(folderId)).toBe(null);
  expect(get(query)).toBe("");
  expect(get(tag)).toBe(null);
});
