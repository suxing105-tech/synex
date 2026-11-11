import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 右栏分页（方案 3 第三批，2026-11-11）：详情 / 提示词 / 参数 / 队列。
 *
 * 这里最容易长回去的一件事，是有人把换页改成 {#if detailTab === "prompt"}。
 * 看着等价，实际是把反推面板和视频提示词面板从树上摘下来——那两个组件把跑出来的
 * 结果和进行中的请求都存在自己身上，切出去看一眼参数再切回来，反推就白跑一次。
 * 所以「用 hidden 不卸载」必须钉住，光靠人记不住。
 *
 * 版面类断言按本仓库既有写法锁源码（同 detail-dock.test.ts），锚点找不到就红。
 */

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, "..", "components", "DetailPanel.svelte"), "utf8");

/** 从某个函数名起截到下一个锚点，用来把断言限制在那一段里。 */
function slice(from: string, to: string): string {
  const start = raw.indexOf(from);
  expect(start, '锚点找不到：' + from).toBeGreaterThan(-1);
  const end = raw.indexOf(to, start + from.length);
  return end < 0 ? raw.slice(start) : raw.slice(start, end);
}

describe("右栏分页用 hidden 切，不卸载组件", () => {
  it("不存在按 detailTab 条件渲染的分支", () => {
    expect(raw).not.toMatch(/\{#if\s+detailTab/);
    expect(raw).not.toMatch(/\{:else\s+if\s+detailTab/);
  });

  it("每一页都是一个带 hidden 的 detail-pane", () => {
    const panes = raw.match(/class="detail-pane"[^>]*hidden=\{detailTab !== "[a-z]+"\}/g) ?? [];
    const keys = panes.map((tag) => (tag.match(/detailTab !== "([a-z]+)"/) ?? [])[1] ?? "");
    expect([...new Set(keys)].sort()).toEqual(["detail", "params", "prompt", "queue"]);
    // 三种 kind 分支各自摊开四页（音频只摊两页），所以 pane 标签必然多于四个
    expect(panes.length).toBeGreaterThanOrEqual(8);
  });

  it("CSS 里 hidden 真的会收起来（hidden 属性本身不带默认样式）", () => {
    expect(raw).toMatch(/\.detail-pane\[hidden\]\s*\{\s*display:\s*none/);
  });
});

describe("分页导航本身", () => {
  it("四个页签名，队列那一格带进度角标", () => {
    expect(raw).toContain('detail: "详情", prompt: "提示词", params: "参数", queue: "队列"');
    expect(raw).toContain("detail-tab-count");
    expect(raw).toContain("detail-tab-dot");
  });

  it("音频不给提示词页和参数页（它两样都没有）", () => {
    const fn = slice("function tabsForKind", "let detailTab");
    expect(fn).toContain('kind === "audio"');
    expect(fn).toContain('["detail", "queue"]');
    expect(fn).toContain('["detail", "prompt", "params", "queue"]');
  });

  it("换卡才重置页签，同一张卡里切页不跳回", () => {
    const effect = slice("let tabSeedId", "function openTagEditor");
    expect(effect).toContain('if (d.id !== tabSeedId)');
    // 默认页跟卡片页脚同一个口径：有提示词就先给提示词
    expect(effect).toContain('d.kind !== "audio" && d.positive_prompt ? "prompt" : "detail"');
    // 换到不该出现的页（比如从图片的队列页换到音频）要退回该 kind 的第一页
    expect(effect).toContain('if (!allowed.includes(detailTab)) detailTab = allowed[0] ?? "detail"');
  });

  it("标签输入框住在详情页，外部入口先把那一页翻开", () => {
    const fn = slice("function openTagEditor", "// ---------- 派生");
    expect(fn).toContain('detailTab = "detail"');
    expect(fn).toContain("showTagInput = true");
    // 两处外部入口（T 快捷键 / ⋯ 菜单）都得走它，不然在别的页上按就看不见输入框
    expect(raw.split("openTagEditor()").length - 1).toBeGreaterThanOrEqual(2);
  });
});

describe("队列页挂在右栏里", () => {
  it("把「这一页露不露着」传给队列面板，云端待取回只在露着时取", () => {
    expect(raw).toContain('<CloneQueuePanel active={detailTab === "queue"} />');
  });

  it("分页条在头部之上：切页不动「这是哪一张」那一行", () => {
    const nav = raw.indexOf('<nav class="detail-tabs"');
    expect(nav).toBeGreaterThan(-1);
    expect(nav).toBeLessThan(raw.indexOf("<header"));
  });

  it("页签条高度走令牌，不裸写像素；选中只用下边线，不画整圈框", () => {
    const css = slice(".detail-tabs {", ".detail-tab:hover");
    expect(css).toMatch(/\.detail-tabs \{[^}]*height:\s*var\(--ctl-lg\)/);
    expect(css).not.toMatch(/height:\s*\d+px/);
    expect(css).not.toContain("border-radius");
  });
});
