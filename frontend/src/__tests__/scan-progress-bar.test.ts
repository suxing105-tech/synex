import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ScanProgressBar from "../components/ScanProgressBar.svelte";
import { scanProgress } from "../lib/stores";
import type { ScanProgress } from "../lib/types";

/**
 * 顶部那条进度条有两套计数：用户点出来的全量扫描（running），和后台每分钟自己跑的补扫
 * （sweeping）。补扫原先只写日志，于是一次收几百个文件时界面完全不动——
 * 「图悄悄回来了，但没人看见」。这里钉住三件事：补扫要显示、文案要分开、两者不同时抢。
 */
vi.mock("../lib/api", () => ({
  scanApi: { progress: vi.fn(async () => progress) },
  itemsApi: { list: vi.fn() },
  imagesApi: { list: vi.fn(), detail: vi.fn(), presence: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn() },
  comfyuiApi: {},
  audioApi: {},
}));

let progress: ScanProgress = {
  running: false, scanned: 0, indexed: 0, total: 0,
  current_path: "", error: null, sweeping: false, sweep_indexed: 0, sweep_total: 0,
};

const idle = (): ScanProgress => ({ ...progress });

beforeEach(() => {
  progress = idle();
  scanProgress.set(idle());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 挂载时组件会自己拉一次进度，先让那次落定，再灌要验的状态 */
async function mountBar(next: ScanProgress) {
  progress = next;
  render(ScanProgressBar);
  await tick();
  scanProgress.set(next);
  await tick();
}

const text = () => document.body.textContent ?? "";

describe("顶部进度条：补扫也要看得见", () => {
  it("两套计数都没在跑时什么都不渲染", async () => {
    await mountBar(idle());
    expect(text()).toBe("");
  });

  it("补扫中：显示「补录漏收的文件」和 N / M", async () => {
    await mountBar({ ...idle(), sweeping: true, sweep_indexed: 7, sweep_total: 106 });
    expect(text()).toContain("补录漏收的文件");
    expect(text()).toContain("7 / 106");
  });

  it("全量扫描的文案不受影响，仍旧是「扫描中」", async () => {
    await mountBar({ ...idle(), running: true, indexed: 4, total: 9, current_path: "D:/素材/a.png" });
    expect(text()).toContain("扫描中");
    expect(text()).not.toContain("补录漏收的文件");
    expect(text()).toContain("4 / 9");
    expect(text()).toContain("D:/素材/a.png");
  });

  it("万一两套同时为真，显示用户点的那件（扫描中）", async () => {
    await mountBar({
      ...idle(), running: true, indexed: 1, total: 500,
      sweeping: true, sweep_indexed: 2, sweep_total: 3,
    });
    expect(text()).toContain("扫描中");
    expect(text()).toContain("1 / 500");
  });
});
