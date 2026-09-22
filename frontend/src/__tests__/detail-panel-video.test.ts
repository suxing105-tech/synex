import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// 回归：详情面板按 media kind 分支 —— 视频展示内嵌播放器/系统打开 + 视频信息卡，
// 并隐藏反推 Prompt / 生成参数 / Workflow 等图片专属模块。
const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, "..", "components", "DetailPanel.svelte"), "utf8");

function firstElseAfterVideo(): number {
  const videoIdx = raw.indexOf('{#if d.kind === "video"}');
  const regex = /\{:else\}/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(raw)) !== null) {
    if (m.index > videoIdx) return m.index;
  }
  return -1;
}

describe("详情面板视频分支", () => {
  it("按 kind 分支而非无差别渲染图片模块", () => {
    expect(raw).toContain('{#if d.kind === "video"}');
    const elseIdx = firstElseAfterVideo();
    expect(elseIdx).toBeGreaterThan(0);
    // 图片专属模块应位于 :else 之后（仅在非视频分支渲染）
    expect(raw.indexOf("<ReversePromptPanel")).toBeGreaterThan(elseIdx);
    expect(raw.indexOf("<PromptCard")).toBeGreaterThan(elseIdx);
  });

  it("视频分支不再内嵌播放器，提供静态预览 / 系统打开入口与视频信息卡", () => {
    expect(raw).toContain("视频信息");
    expect(raw).toContain("用系统播放器打开");
    expect(raw).not.toContain("<video");
  });

  it("视频信息卡展示分辨率/时长/容器/编码/帧率", () => {
    for (const label of ["分辨率", "时长", "容器", "视频编码", "音频编码", "帧率"]) {
      expect(raw).toContain(label);
    }
  });

  it("视频 header 隐藏 ComfyUI 与标签编辑入口", () => {
    expect(raw).toContain('{#if d.kind !== "video"}');
  });
});
