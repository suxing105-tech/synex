import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import StatusBar from "../components/StatusBar.svelte";
import { comfyuiEnabled, comfyuiStatus, stats } from "../lib/stores";
import { healthApi } from "../lib/api";
import { tauriFlag } from "./fixtures/tauri-flag";

/**
 * 底部状态栏（方案 3 · 生产力工作台第一批，2026-11-06）。
 *
 * 重点不是「有没有渲染」，是它替谁说话：ffmpeg 缺失这件事以前只写在设置页里，
 * 而它的症状是「视频能播、但封面全黑、波形全空、视频里的提示词全没有」，
 * 用户根本想不到去设置页翻（AGENTS.md §7.2）。所以缺了必须变红，
 * 并把怎么补写进 title；而后端还在答话的中间态不许先亮红灯。
 */

vi.mock("../lib/api", () => ({
  healthApi: { get: vi.fn(async () => ({ status: "ok" })) },
  // stores.ts 在模块加载时挂了个 feed 自动刷新定时器，它认 itemsApi。
  // 不给这一格，测试跑完前那条定时器会往 stderr 倒一堆和用例无关的报错。
  itemsApi: {
    list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })),
  },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
}));
vi.mock("../lib/tauri", async () => {
  const { tauriFlag } = await import("./fixtures/tauri-flag");
  return {
    isTauri: () => tauriFlag.desktop,
    getSidecarStatus: vi.fn(async () =>
      tauriFlag.desktop
        ? { ready: true, port: 8765, data_dir: "D:\\SeekX-Data", pid: 1, last_error: null }
        : null,
    ),
  };
});

const READY = {
  available: true,
  missing: [],
  tools: {
    ffmpeg: { path: "C:/app/ffmpeg.exe", source: "exe-dir", version: "8.1.1" },
    ffprobe: { path: "C:/app/ffprobe.exe", source: "exe-dir", version: "8.1.1" },
  },
  versions: { ffmpeg: "8.1.1", ffprobe: "8.1.1" },
};
const MISSING = {
  available: false,
  missing: ["ffmpeg", "ffprobe"],
  tools: {
    ffmpeg: { path: null, source: null, version: null },
    ffprobe: { path: null, source: null, version: null },
  },
  versions: { ffmpeg: null, ffprobe: null },
};

/** onMount 里那两个请求都是 fire-and-forget，把微任务队列跑完再断言。 */
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

async function boot(payload: unknown) {
  vi.mocked(healthApi.get).mockResolvedValue(payload as never);
  const screen = render(StatusBar);
  await flush();
  return screen;
}

/** 两格的状态点，按出现顺序：第 1 颗 ComfyUI，第 2 颗 ffmpeg。 */
const dots = (screen: Awaited<ReturnType<typeof boot>>) =>
  [...screen.container.querySelectorAll<HTMLElement>(".dot")];

beforeEach(() => {
  tauriFlag.desktop = false;
  comfyuiEnabled.set(true);
  comfyuiStatus.set({ running: true, url: "http://127.0.0.1:8188", enabled: true, checked_at: 1 });
  stats.set({ total_images: 292, total_videos: 38, total_audio: 21, total_texts: 0, folders: 4 });
});
afterEach(() => cleanup());

describe("ComfyUI 那一格", () => {
  it("连上时说已连接，title 给出真正在用的地址", async () => {
    const screen = await boot({ status: "ok", media_tools: READY });
    expect(screen.getByText("ComfyUI 已连接").title).toBe("http://127.0.0.1:8188");
    expect(dots(screen)[0].className).toContain("on");
  });

  it("没连上时说未连接，并带上后端给的人话原因", async () => {
    comfyuiStatus.set({
      running: false,
      url: "http://127.0.0.1:8188",
      enabled: true,
      checked_at: 1,
      reason: "127.0.0.1:8188 上没有服务在监听",
    });
    const screen = await boot({ status: "ok", media_tools: READY });
    const cell = screen.getByText("ComfyUI 未连接");
    expect(cell.title).toContain("没有服务在监听");
    expect(dots(screen)[0].className).toContain("bad");
  });

  it("在设置里被关掉时说「已停用」，不是「未连接」——那是关的，不是坏的", async () => {
    comfyuiEnabled.set(false);
    const screen = await boot({ status: "ok", media_tools: READY });
    expect(screen.getByText("ComfyUI 已停用")).toBeTruthy();
    expect(screen.queryByText("ComfyUI 未连接")).toBeNull();
    expect(dots(screen)[0].className).not.toContain("bad");
  });
});

describe("ffmpeg 那一格", () => {
  it("齐了写「就绪」，出处和版本留在 title 里", async () => {
    const screen = await boot({ status: "ok", media_tools: READY });
    const cell = screen.getByText("ffmpeg 就绪");
    expect(cell.title).toContain("安装包内置");
    expect(cell.title).toContain("8.1.1");
    expect(dots(screen)[1].className).toContain("on");
  });

  it("缺了要变红，并把怎么补写进 title", async () => {
    const screen = await boot({ status: "ok", media_tools: MISSING });
    expect(dots(screen)[1].className).toContain("bad");
    const cell = screen.getByText("缺少 ffmpeg / ffprobe");
    expect(cell.title).toContain("ffmpeg.exe");
  });

  it("后端还没答话时既不亮绿灯也不亮红灯", async () => {
    vi.mocked(healthApi.get).mockRejectedValue(new Error("offline"));
    const screen = render(StatusBar);
    await flush();
    expect(screen.getByText("正在检查 ffmpeg…")).toBeTruthy();
    expect(dots(screen)[1].className).not.toContain("on");
    expect(dots(screen)[1].className).not.toContain("bad");
  });
});

describe("右侧两格", () => {
  it("库内合计是四类之和，不是当前筛选出来的条数", async () => {
    const screen = await boot({ status: "ok", media_tools: READY });
    expect(screen.getByText("351")).toBeTruthy();
    expect(screen.getByText("项")).toBeTruthy();
  });

  it("浏览器 dev 里没有桌面壳，就不硬摆一格空目录", async () => {
    const screen = await boot({ status: "ok", media_tools: READY });
    expect(screen.container.querySelector(".dir")).toBeNull();
  });

  it("桌面版摆出数据目录的末级名，完整路径留在 title", async () => {
    tauriFlag.desktop = true;
    const screen = await boot({ status: "ok", media_tools: READY });
    const dir = screen.container.querySelector(".dir");
    expect(dir?.textContent).toBe("SeekX-Data");
    expect(dir?.parentElement?.getAttribute("title")).toBe("D:\\SeekX-Data");
  });
});

it("是一条 footer，且不摆任何抢焦点的可交互件（信息用 title 承载）", async () => {
  const screen = await boot({ status: "ok", media_tools: READY });
  expect(screen.getByRole("contentinfo")).toBeTruthy();
  expect(screen.container.querySelectorAll("button,a,input,select")).toHaveLength(0);
});
