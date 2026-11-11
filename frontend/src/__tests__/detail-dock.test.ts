import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 详情面板的三段式版面（方案 3 · 生产力工作台第一批，2026-11-06）。
 *
 * 改动本身是：头部说「这是哪一张」、中间是数据、底部操作条是「能做什么」。
 * 这类版面规矩没法用挂载断言守住（要真视口才知道有没有被挤掉），
 * 所以按本仓库既有的写法锁源码：锚点找不到就直接红，别让它悄悄长回去。
 */

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, "..", "components", "DetailPanel.svelte"), "utf8");

const dockStart = raw.indexOf('<footer class="detail-dock"');
const bodyStart = raw.indexOf('class="flex-1 overflow-y-auto p-4 space-y-4 detail-body"');
const headerStart = raw.indexOf("<header");
const headerEnd = raw.indexOf("</header>");

describe("三段式：身份 / 数据 / 动作", () => {
  it("操作条存在，且排在可滚动的数据区之后", () => {
    expect(dockStart).toBeGreaterThan(-1);
    expect(bodyStart).toBeGreaterThan(-1);
    expect(dockStart).toBeGreaterThan(bodyStart);
  });

  it("操作条在 flex 列里是 flex:none —— body 再长也不许把它挤出视口", () => {
    const css = raw.slice(raw.indexOf(".detail-dock {"));
    expect(css).toMatch(/\.detail-dock \{[^}]*flex:\s*none/);
  });

  it("头部只留预览，ComfyUI 与 ⋯ 已经不在头部里", () => {
    const header = raw.slice(headerStart, headerEnd);
    expect(header).toContain('aria-label="播放视频"');
    expect(header).not.toContain('aria-label="在 ComfyUI 中打开工作流"');
    expect(header).not.toContain('aria-haspopup="menu"');
  });

  it("菜单的点击外区锚点只有一个，就是操作条本身", () => {
    // 数「真正带这个属性的标签」：模板顶上那条 svelte:window 里的 closest("[data-menu-root]")
    // 是点外面收菜单的判据，按字符串计数会把它当成第二个锚点，所以按标签形状匹配。
    const tags = raw.match(/<[a-zA-Z][^>]*\sdata-menu-root[\s>]/g) || [];
    expect(tags).toHaveLength(1);
    const dockTag = raw.slice(dockStart, raw.indexOf(">", dockStart));
    expect(dockTag).toContain("data-menu-root");
  });
});

describe("操作条的内容与顺序", () => {
  const dock = raw.slice(dockStart, raw.indexOf("</footer>", dockStart));

  it("一级动作在最左：在 ComfyUI 中打开工作流", () => {
    expect(dock.indexOf('aria-label="在 ComfyUI 中打开工作流"')).toBeLessThan(
      dock.indexOf('aria-label="复制全部参数"'),
    );
    expect(dock.indexOf('aria-label="复制全部参数"')).toBeLessThan(
      dock.indexOf('aria-haspopup="menu"'),
    );
  });

  it("三个动作各出现一次，不在头部和底部各摆一份", () => {
    for (const label of ['aria-label="在 ComfyUI 中打开工作流"', 'aria-label="复制全部参数"']) {
      expect(raw.split(label).length - 1, label + " 应当只有一处").toBe(1);
    }
    // 「更多操作」的入口在详情面板里唯一（TextDetailPanel 是另一个组件，不计数）
    expect(raw.split('aria-label="更多操作"').length - 1).toBe(1);
  });

  it("菜单往上开：操作条贴着视口底边，往下就掉出屏幕", () => {
    const css = raw.slice(raw.indexOf(".dock-menu {"));
    expect(css).toMatch(/\.dock-menu \{[^}]*bottom:/);
    expect(css.slice(0, 200)).not.toMatch(/top:\s*calc\(100%/);
  });
});

describe("红底按钮的字色", () => {
  it("主按钮用 --accent-ink，不用白字（白字压 #f24e4e 只有 3.1:1）", () => {
    const css = raw.slice(raw.indexOf(".dock-primary {"));
    expect(css).toMatch(/\.dock-primary \{[^}]*color:\s*var\(--accent-ink\)/);
  });

  it("没有工作流时退成中性描边，而不是褪成四成的红", () => {
    expect(raw).toMatch(/\.dock-primary:disabled \{[^}]*background:\s*transparent/);
    const primaryTag = raw.slice(
      raw.indexOf('class="dock-primary'),
      raw.indexOf(">", raw.indexOf('class="dock-primary')),
    );
    expect(primaryTag).not.toContain("disabled:opacity-40");
  });

  it("操作条上的按钮 hover 只改底色，不高亮边框", () => {
    const dock = raw.slice(dockStart, raw.indexOf("</footer>", dockStart));
    expect(dock).not.toMatch(/hover:border-/);
    expect(dock.match(/hover:bg-/g)!.length).toBeGreaterThanOrEqual(3);
  });
});
