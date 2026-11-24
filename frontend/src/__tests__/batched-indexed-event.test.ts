import { afterEach, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { foldersApi, imagesApi, itemsApi, statsApi } from "../lib/api";
import { feedItems, newIds } from "../lib/stores";
import { connectEvents, disconnectEvents } from "../lib/ws";

// 后端补扫一次能捞回上百张图。逐条 image_indexed 会让前端为每张图串行发三个请求、
// 重排一次瀑布流（106 张 = 三百多次），所以补扫走的是批量事件，这里钉住「只刷一遍」。
vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn(async () => ({ total_images: 0, total_videos: 0, total_audio: 0, total_texts: 0, folders: 0 })) },
  scanApi: { progress: vi.fn() },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  disconnectEvents();
  feedItems.set([]);
  newIds.set(new Set());
  vi.clearAllMocks();
});

async function emit(payload: Record<string, unknown>) {
  let socket: any;
  class Socket {
    readyState = 1;
    onmessage: any;
    constructor() { socket = this; }
    close() {}
  }
  vi.stubGlobal("WebSocket", Socket);
  connectEvents();
  await socket.onmessage({ data: JSON.stringify(payload) });
}

it("一批补扫结果只刷一遍列表、统计和目录树", async () => {
  await emit({ type: "images_indexed", count: 106, ids: Array.from({ length: 50 }, (_, i) => i + 1) });

  expect(itemsApi.list).toHaveBeenCalledTimes(1);
  expect(statsApi.get).toHaveBeenCalledTimes(1);
  expect(foldersApi.tree).toHaveBeenCalledTimes(1);
  expect(get(newIds).size).toBe(50);
});

it("ids 缺省也不会炸，仍然刷一遍", async () => {
  await emit({ type: "images_indexed", count: 3 });
  expect(itemsApi.list).toHaveBeenCalledTimes(1);
  expect(get(newIds).size).toBe(0);
});
