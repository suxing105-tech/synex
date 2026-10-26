import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// 回归：详情面板按 media kind 分支 —— 视频分支只剩提示词 / Workflow / 反推，
// 隐藏图片专属的 ComfyUI 反推与生成参数模块；但 ComfyUI 自己导出的视频
// 容器里带着整份画布和提示词，所以「在 ComfyUI 中打开」和 Workflow 卡片
// 对视频同样成立（按有没有 workflow 决定，不按 kind 屏蔽）。
// 0.2.22 追加：视频信息卡与大图封面区已删（重复且信息过剩），
// 帧率并进头部秒数后面，改封面的入口搬到头部缩略图。
const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, "..", "components", "DetailPanel.svelte"), "utf8");

// 头部也有一处 {#if d.kind === "video"}（播放按钮），所以视频分支要从 Body 起找
function videoBranchStart(): number {
  return raw.indexOf('{#if d.kind === "video"}', raw.indexOf("detail-body"));
}

/** 只含视频分支：遇到 {:else if d.kind === "audio"} 就结束，不会串到音频分支。 */
function videoBranchOnly(): string {
  const start = videoBranchStart();
  const next = raw.slice(start).match(/\{:else\b/);
  return raw.slice(start, start + (next ? next.index! : raw.length));
}

function firstElseAfterVideo(): number {
  const videoIdx = videoBranchStart();
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

  it("视频分支不再重复放大图封面区与视频信息卡，也不内嵌播放器", () => {
    const videoBranch = videoBranchOnly();
    expect(raw).not.toContain("视频信息");
    expect(raw).not.toContain("videoInfoRows");
    expect(videoBranch).not.toContain("aspect-video");
    expect(videoBranch).not.toContain("修改封面");
    expect(raw).not.toContain("<video");
  });

  it("改封面的入口是头部缩略图，弹层仍然挂在面板上", () => {
    expect(raw).toContain('title={headerThumbLabel(d.kind)}');
    expect(raw).toContain('kind === "video" ? "修改视频封面" : "查看大图"');
    expect(raw).toContain('(d.kind === "video" ? (coverModalOpen = true) : openLightbox(d))');
    expect(raw).toContain("<VideoCoverModal");
  });

  it("帧率显示在头部秒数之后，分辨率/编码等冗余字段不再出现", () => {
    const durationLine = raw.indexOf('<span>{formatDuration(d.duration_seconds)}</span>');
    const fpsLine = raw.indexOf('<span>{d.fps} fps</span>');
    expect(durationLine).toBeGreaterThan(0);
    expect(fpsLine).toBeGreaterThan(durationLine);
    // 帧率那行必须仍在头部信息行内（位于 Body 之前）
    expect(fpsLine).toBeLessThan(raw.indexOf("detail-body"));
    // 视频分支里不该再有任何信息卡字段（音频信息卡仍在自己的分支，不受影响）
    const videoBranch = videoBranchOnly();
    // 信息卡整块删除：不该再有 dl / label 行，也不该再有视频专属字段名
    for (const label of ["分辨率", "视频编码", "音频编码", "帧率", "<dl", 'label: "']) {
      expect(videoBranch).not.toContain(label);
    }
  });

  it("缩略图改成封面入口后，播放视频另有按钮", () => {
    expect(raw).toContain('title="播放视频"');
    expect(raw).toContain("onclick={playVideo}");
    expect(raw).toContain('<Icon name="play" size={14} />');
  });

  it("视频 header 隐藏标签编辑，但 ComfyUI 打开按钮对视频同样存在", () => {
    // 标签仍是图片专属（视频不做标签）
    expect(raw).toContain('{#if d.kind === "image"}');
    expect(raw).not.toContain('{#if d.kind !== "video"}');
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
