import { afterEach, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { foldersApi, imagesApi, itemsApi, statsApi } from "../lib/api";
import { feedItems, newIds } from "../lib/stores";
import { clearToasts, toasts } from "../lib/toast";
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
  clearToasts();
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

// 监听的 emitter 掉了又被后台修好（Indexer.repair_watcher）。不吭声的话，用户只会以为
// 「这软件不收图了」；但反复掉线也不该把角落堆满同一句话，所以恢复提示复用同一条。
it("监听自动恢复要说一声，反复恢复也只占一条", async () => {
  for (const total of [1, 2, 3]) {
    // 每轮断一条新连接：connectEvents 见着现成的 socket 会直接复用，那样 onmessage 拿不到手
    disconnectEvents();
    await emit({ type: "watcher_restarted", dirs: ["D:/AI/ComfyUI/output"], total });
  }
  const list = get(toasts);
  expect(list).toHaveLength(1);
  expect(list[0].message).toContain("已自动恢复");
});
