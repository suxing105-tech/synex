/**
 * 侧栏收起那一列的图标按钮只有一副底框（2026-11-15 苏醒：缩起时按钮上下左右各缩 2px）。
 * 这一列的三颗按钮分属三处写法——导航在 CollapsedSidebar 的 scoped style 里，
 * 「设置」直接挂在 App.svelte、「更新」在 SidebarUpdateButton 里，两颗都写死 w-10 h-10（40px）。
 * 尺寸真源是 app.css token 块的 --rail-btn，这里钉死「三处都引它」，别再各写各的数。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");
const read = (rel: string) => readFileSync(join(srcRoot, rel), "utf8");

/** token 块里某个变量的声明值：不在块里、或者定义两次都直接炸，不留两份真源。 */
function tokenValue(name: string) {
  const css = read("app.css");
  const block = css.slice(css.indexOf(":root {"), css.indexOf("\nhtml,"));
  const hits = [...block.matchAll(new RegExp("(?<![-\\w])" + name + ":\\s*([^;]+);", "g"))];
  if (hits.length !== 1) throw new Error(name + " 在 token 块里出现 " + hits.length + " 次");
  return hits[0][1].trim();
}

/** 抠某条规则块里的一个声明；同一块里写了两份也算错。 */
function declOf(source: string, selector: string, prop: string) {
  const at = source.indexOf(selector);
  if (at < 0) throw new Error("找不到规则块 " + selector);
  const block = source.slice(at, source.indexOf("}", at));
  const hits = [...block.matchAll(new RegExp("(?<![-\\w])" + prop + ":\\s*([^;]+);", "g"))];
  if (hits.length !== 1) throw new Error(selector + " 里的 " + prop + " 出现 " + hits.length + " 次");
  return hits[0][1].trim();
}

const RAIL = "var(--rail-btn)";

describe("侧栏收起那一列的图标按钮同一副底框", () => {
  it("底框尺寸只有一份真源：token 里的 --rail-btn = 36px", () => {
    // 36 = 原来那副 40 的上下左右各缩 2px。它故意不进 --ctl-* 三档（理由写在 app.css 那条注释里），
    // 所以钉在 token 层，不是拿 --ctl-lg(38) 或者旧的 40 顶上。
    expect(tokenValue("--rail-btn")).toBe("36px");
  });

  it("收起态的导航按钮引 --rail-btn，不再自己写 40px", () => {
    const nav = read("components/CollapsedSidebar.svelte");
    expect(declOf(nav, "button {", "width")).toBe(RAIL);
    expect(declOf(nav, "button {", "height")).toBe(RAIL);
    expect(nav).not.toMatch(/(?:width|height):\s*40px/);
  });

  it("同一列底部的「设置 / 更新」在收起态收进同一个尺寸", () => {
    const app = read("App.svelte");
    const selector = ".sidebar-actions.collapsed-actions :global(button) {";
    expect(declOf(app, selector, "width")).toBe(RAIL);
    expect(declOf(app, selector, "height")).toBe(RAIL);
  });

  it("收的是按钮底框，不是整条栏：收起态栏宽还是 44", () => {
    // 这条只说了按钮，栏宽跟着缩会把图标顶到边上，所以挡住顺手一起改。
    expect(read("App.svelte")).toContain("sidebarCollapsed ? 44 : 260");
  });
});
