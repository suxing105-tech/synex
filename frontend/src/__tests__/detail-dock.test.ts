import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, "..", "components", "DetailPanel.svelte"), "utf8");

describe("右侧工作台顶部操作", () => {
  const headerStart = raw.indexOf('<header class="detail-header');
  const headerEnd = raw.indexOf("</header>", headerStart);
  const header = raw.slice(headerStart, headerEnd);

  it("更多操作随顶部信息吸附，工作流与再次创作按钮移除", () => {
    expect(headerStart).toBeGreaterThan(-1);
    expect(header).not.toContain('aria-label="打开工作流"');
    expect(header).not.toContain('aria-label="再次创作"');
    expect(header).toContain('aria-label="更多操作"');
    expect(raw).not.toContain('class="detail-dock"');
  });

  it("常用操作并列，低频复制操作收进更多菜单", () => {
    expect(header.indexOf('aria-label="更多操作"')).toBeGreaterThan(header.indexOf('title={d.filename}'));
    expect(raw).toContain('aria-label="复制全部参数"');
    expect(raw).toMatch(/role="menu"[\s\S]*aria-label="复制全部参数"/);
  });

  it("菜单从顶部操作下方展开，避免越过右栏顶部", () => {
    const css = raw.slice(raw.indexOf(".dock-menu {"), raw.indexOf("}", raw.indexOf(".dock-menu {")));
    expect(css).toContain("top:");
    expect(css).not.toContain("bottom:");
  });

});
