import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// 回归：详情面板按 media kind 分支 —— 视频展示视频信息卡 + 反推面板，
// 隐藏图片专属的 ComfyUI 反推与生成参数模块；但 ComfyUI 自己导出的视频
// 容器里带着整份画布和提示词，所以「在 ComfyUI 中打开」和 Workflow 卡片
// 对视频同样成立（按有没有 workflow 决定，不按 kind 屏蔽）。
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
    expect(raw.indexOf("<ParamsCard")).toBeGreaterThan(elseIdx);
    // 视频反推面板只在视频分支，图片反推面板只在图片分支
    expect(raw.indexOf("<VideoPromptPanel")).toBeLessThan(elseIdx);
  });

  it("视频分支提供视频信息卡与「修改封面」入口，不再内嵌播放器", () => {
    expect(raw).toContain("视频信息");
    expect(raw).toContain("修改封面");
    expect(raw).not.toContain("<video");
  });

  it("视频信息卡展示分辨率/时长/容器/编码/帧率", () => {
    for (const label of ["分辨率", "时长", "容器", "视频编码", "音频编码", "帧率"]) {
      expect(raw).toContain(label);
    }
  });

  it("视频 header 隐藏标签编辑，但 ComfyUI 打开按钮对视频同样存在", () => {
    // 标签仍是图片专属（视频不做标签）
    expect(raw).toContain('{#if d.kind !== "video"}');
    // 打开工作流不再按 kind 屏蔽：按钮只按「有没有工作流」决定可用
    expect(raw).toContain('disabled={!d.workflow}');
    expect(raw).toContain('title={d.workflow ? "在 ComfyUI 中打开工作流" : noWorkflowText(d.kind)}');
    expect(raw).toContain('"该视频未携带 ComfyUI 工作流"');
    // 图片和视频共用同一条打开路径（桌面版应用内加载，浏览器版复用标签）
    expect(raw).toContain("openWorkflowForMedia(");
    expect(raw).not.toContain("openOrReuseComfyuiTab(");
  });

  it("视频分支渲染容器里读出的提示词与 Workflow 卡片", () => {
    const videoIdx = raw.indexOf('{#if d.kind === "video"}');
    const elseIdx = firstElseAfterVideo();
    const videoBranch = raw.slice(videoIdx, elseIdx);
    expect(videoBranch).toContain('title="ComfyUI 提示词"');
    expect(videoBranch).toContain("<WorkflowCard");
    expect(raw).toContain("<WorkflowCard workflow={d.workflow} filename={d.filename}");
  });
});
