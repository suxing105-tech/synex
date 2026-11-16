import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, "..", "components", "DetailPanel.svelte"), "utf8");
const promptCard = readFileSync(resolve(here, "..", "components", "PromptCard.svelte"), "utf8");
const reversePrompt = readFileSync(resolve(here, "..", "components", "ReversePromptPanel.svelte"), "utf8");
const videoPrompt = readFileSync(resolve(here, "..", "components", "VideoPromptPanel.svelte"), "utf8");
const modelPicker = readFileSync(resolve(here, "..", "components", "ModelPicker.svelte"), "utf8");

describe("右侧工作台纵向信息层级", () => {
  it("取消页签，按提示词、参数、队列顺序展示且移除详情区", () => {
    expect(raw).not.toContain("detailTab");
    expect(raw).not.toContain('class="detail-tabs"');
    const positions = [
      raw.indexOf('data-workbench-section="prompts"'),
      raw.indexOf('data-workbench-section="parameters"'),
      raw.indexOf('data-workbench-section="queue"'),
    ];
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(raw).not.toContain('data-workbench-section="details"');
    expect(raw).not.toContain('class="details-workspace');
  });

  it("顶部身份与操作区固定：原始提示词短预览，反推正文给足 350px 且可拖高", () => {
    // 两类提示词现在分成两套规矩，别再混成一句「短预览」：
    //  - 原始提示词（工作流原文）走短预览：默认截断，点「展开全文」才见全部；
    //  - AI 反推提示词反过来：默认就是 350px 的一整块，纵向拖拽可改高，不做折叠。
    //    2026-11-14 用户把反推正文从 96px 提到 350px（长提示词要能一眼读完）。
    expect(raw).toMatch(/class="detail-header[^\"]*sticky/);
    expect(raw).not.toContain('aria-label="再次创作"');
    // 原始提示词：短预览 + 展开/收起
    expect(promptCard).toContain('title={expanded ? "收起全文" : "展开全文"}');
    expect(raw).toContain('title="原始提示词"');
    expect(promptCard).not.toContain("字 {chars}");
    expect(promptCard).not.toContain("{lines} 行");
    // 反推正文：固定 350px 起手、可纵向拖高、不做「展开全文」折叠
    expect(raw).toContain("<ReversePromptPanel");
    expect(reversePrompt).toContain('aria-label="反推提示词"');
    expect(reversePrompt).toContain("height:350px");
    expect(reversePrompt).toContain("resize:vertical");
    expect(reversePrompt).not.toContain("展开全文");
  });

  it("参数细项按需展开，工作流提供直接下载", () => {
    expect(raw).toContain("查看完整参数");
    expect(raw).toContain("<WorkflowCard workflow={d.workflow} filename={d.filename} />");
    expect(raw).not.toContain("查看工作流数据");
    expect(raw).not.toContain("parameterSummary(d)");
  });

  it("工作台区块不描边，更多菜单只用文字并取消展开描边反馈", () => {
    expect(raw).toContain("border:0;");
    expect(raw).not.toContain("class:!border-accent={menuOpen}");
    const menuStart = raw.indexOf('class="dock-menu');
    const menuEnd = raw.indexOf("{/if}", menuStart);
    expect(menuStart).toBeGreaterThanOrEqual(0);
    expect(raw.slice(menuStart, menuEnd)).not.toContain("<Icon");
    expect(raw).toContain(".menu-item:hover");
  });

  it("反推与视频提示词组件保持挂载，队列只在右栏可见时取数据", () => {
    expect(raw).toContain("<ReversePromptPanel");
    expect(raw).toContain("<VideoPromptPanel");
    expect(raw).toContain("<CloneQueuePanel active={active} />");
  });

  /**
   * 2026-11-15 苏醒七条批注里落在右栏的四条：面板别套描边、标题去掉「AI」前缀、
   * 历史版本项不要描边只要白字、两颗语种 chip 等宽且写 EN。
   * happy-dom 量不了布局，所以照本文件的老规矩钉源文本。
   */
  it("右栏反推面板按 2026-11-15 批注收干净：无描边、标题无前缀、chip 等宽、头部与左栏同高", () => {
    // 整圈边框去掉，只靠底色分区（只看最外面那个 section，里面的小格子该有边框的还有）
    const sectionTag = (src: string) => src.slice(src.indexOf("<section"), src.indexOf(">", src.indexOf("<section")));
    expect(sectionTag(reversePrompt)).toContain('class="fill-interactions reverse-panel rounded-lg');
    expect(sectionTag(reversePrompt)).not.toContain("border");
    expect(sectionTag(videoPrompt)).not.toContain("border border-border");
    // 标题就叫「反推提示词」，两级标题的口径（§3.1）之外不留第二套措辞
    expect(reversePrompt).toContain('aria-label="反推提示词"');
    expect(reversePrompt).not.toContain("AI 反推提示词");
    expect(videoPrompt).toContain('aria-label="反推视频提示词"');
    // 历史版本项：不描边、白字，选中只加字重，不再拿品牌红描边喊
    const versionRule = reversePrompt.slice(reversePrompt.indexOf("button.version-item,"));
    expect(versionRule).toContain("border-color: transparent;");
    expect(versionRule).toContain("color: var(--text-1);");
    expect(versionRule).not.toContain("var(--accent)");
    // 语种切换：中文 / EN 两颗等宽（34px）且不再写全 English
    expect(reversePrompt).toContain("min-width:34px");
    expect(reversePrompt).toContain(">EN</button>");
    expect(reversePrompt).not.toContain(">English</button>");
    // 右栏头部与左侧工具栏同高：16 + 40 = 56 的内容带 + py-4
    expect(raw).toMatch(/class="detail-header[^"]*py-4/);
  });

  /**
   * 模型不用手输：清单由后端认（只报能对话的那几个），面板进来先认一次。
   * 下拉里那行手输框已经拆掉，所以这里钉的是「它不该存在」。
   */
  it("模型下拉不给手输模型 ID 的口子，只留服务商与清单", () => {
    expect(modelPicker).not.toContain("mp-manual");
    expect(modelPicker).not.toContain("直接输入模型 ID");
    expect(modelPicker).toContain("自动识别");
  });

  it("音频不展示提示词或参数区，文本仍走独立详情面板", () => {
    expect(raw).toContain("d.kind === \"audio\"");
    expect(raw).toContain("<TextDetailPanel />");
  });
});
