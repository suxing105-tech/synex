import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import MediaPickerModal from "../components/MediaPickerModal.svelte";
import { imagesApi, foldersApi } from "../lib/api";

/**
 * 素材选择器左边的文件夹分类。
 *
 * 素材一多，「选一张参考图」只能靠搜索或翻页；图库本来已经按文件夹归好类，
 * 这里把同一棵树搬进选择器：点哪一类就只看那一类。
 */

/** 一棵小树：来源目录一个、我的文件夹一个（还带一个子目录），各自带三族计数。 */
const TREE = [
  {
    id: 10, parent_id: null, name: "ComfyUI 输出", order: 0, is_system: true, path: "D:/ComfyUI",
    counts: { image: 3, video: 1, audio: 0, text: 0 }, total: 4,
    children: [
      {
        id: 11, parent_id: 10, name: "动漫角色", order: 0, is_system: true, path: "D:/ComfyUI/anime",
        counts: { image: 2, video: 0, audio: 0, text: 0 }, total: 2, children: [],
      },
    ],
  },
  {
    id: 20, parent_id: null, name: "我的收藏", order: 0, is_system: false, path: null,
    counts: { image: 5, video: 0, audio: 2, text: 0 }, total: 7, children: [],
  },
];

vi.mock("../lib/api", () => ({
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  audioApi: { open: vi.fn(async () => ({ ok: true, id: 0, path: "" })) },
  foldersApi: { tree: vi.fn(async () => TREE) },
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: {} })) },
  scanApi: { start: vi.fn(async () => ({ ok: true })) },
  statsApi: { get: vi.fn(async () => ({})) },
  http: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 最后一次发给后端的查询参数：文件夹筛选有没有生效，只看这一处最准。 */
function lastQuery(): Record<string, unknown> {
  const calls = (imagesApi.list as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

async function opened() {
  (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0 });
  const screen = render(MediaPickerModal, { open: true, onPick: () => {}, onClose: () => {} });
  // 树是异步拉回来的：等左栏把文件夹名渲染出来
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "我的收藏" })).toBeTruthy());
  return screen;
}

it("左栏按来源目录 / 我的文件夹分组列出分类", async () => {
  const screen = await opened();
  expect(screen.getByText("来源目录")).toBeTruthy();
  expect(screen.getByText("我的文件夹")).toBeTruthy();
  expect(screen.getByRole("button", { name: "ComfyUI 输出" })).toBeTruthy();
  // 顶部那行的名字跟着当前族走：它显示的是「当前这族在全库有多少」
  expect(screen.getByRole("button", { name: "全部图片" })).toBeTruthy();
});

it("点一个文件夹：请求带上 folder_id，列表只剩那一类", async () => {
  const screen = await opened();
  await fireEvent.click(screen.getByRole("button", { name: "我的收藏" }));
  await vi.waitFor(() => expect(lastQuery()).toMatchObject({ folder_id: 20 }));
});

it("点回「全部素材」：folder_id 撤掉，回到全库", async () => {
  const screen = await opened();
  await fireEvent.click(screen.getByRole("button", { name: "我的收藏" }));
  await vi.waitFor(() => expect(lastQuery()).toMatchObject({ folder_id: 20 }));
  await fireEvent.click(screen.getByRole("button", { name: "全部图片" }));
  await vi.waitFor(() => expect(lastQuery().folder_id).toBeUndefined());
});

it("点子目录也算一次筛选：按它自己的 id 走", async () => {
  const screen = await opened();
  await fireEvent.click(screen.getByRole("button", { name: "动漫角色" }));
  await vi.waitFor(() => expect(lastQuery()).toMatchObject({ folder_id: 11 }));
});

it("切换素材族：每行右侧的数字跟着换成那一族的数量", async () => {
  (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0 });
  const screen = render(MediaPickerModal, {
    open: true, kind: "image", kinds: ["image", "audio", "video"], onPick: () => {}, onClose: () => {},
  });
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "ComfyUI 输出" })).toBeTruthy());
  const row = screen.getByRole("button", { name: "ComfyUI 输出" });
  expect(row.textContent).toContain("3"); // 图片 3 张
  await fireEvent.click(screen.getByRole("button", { name: "视频" }));
  await tick();
  const after = screen.getByRole("button", { name: "ComfyUI 输出" });
  expect(after.textContent).toContain("1"); // 视频 1 个
});