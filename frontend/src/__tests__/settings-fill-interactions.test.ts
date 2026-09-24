import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";

const read = (path: string) => readFileSync(resolve(process.cwd(), "src", path), "utf8");
const css = postcss.parse(read("app.css"));

describe("设置与反推使用底色交互", () => {
  it("设置占满窗口，正文限宽并独立滚动", () => {
    const source = read("components/SettingsModal.svelte");
    expect(source).toContain('fixed inset-0 z-[60] bg-surface-2');
    expect(source).toContain('settings-shell w-full h-full');
    expect(source).toContain('settings-content flex-1 min-w-0 overflow-y-auto');
    expect(source).toContain('max-w-[960px] mx-auto');
    expect(source).not.toMatch(/max-w-\[94vw\]|88vh|bg-black\/75/);
  });
  it("移除左下设置入口，标题与分类统一底色且分类有线性图标", () => {
    expect(read("App.svelte")).not.toContain('sidebar-settings');
    expect(read("App.svelte")).not.toContain('<HeaderBar');
    expect(read("App.svelte")).toContain('sidebar-actions');
    expect(read("App.svelte")).toContain('aria-label="导入目录"');
    expect(read("components/Feed.svelte")).toContain('<GallerySearch label=');
    const source = read("components/SettingsModal.svelte");
    expect(source).toContain('settings-title w-[240px] shrink-0 bg-surface');
    expect(source).toContain('overflow-y-auto bg-surface');
    expect(source).toContain('width="18" height="18"');
    expect(source).toContain('aria-label="返回图库"');
    expect(source).not.toContain('>×</button>');
    expect(read('components/FolderTree.svelte')).not.toContain('本地缓存');
  });
  it("返回图标悬停与键盘焦点使用品牌底色", () => {
    const states: string[] = [];
    css.walkRules(rule => {
      if (!rule.selector.includes('button.settings-return')) return;
      states.push(rule.selector);
      expect(rule.nodes.some(n => n.type === 'decl' && n.prop === 'background-color' && n.value === '#f24e4e')).toBe(true);
    });
    expect(states.join()).toContain(':enabled:hover');
    expect(states.join()).toContain(':enabled:focus-visible');
  });
  it.each(["SettingsModal", "ModelSettings", "ReversePromptPanel", "UpdatePanel", "HeaderBar"])(
    "%s 不引入悬停或选中的高亮边框", (name) => {
      const source = read(`components/${name}.svelte`);
      expect(source).not.toMatch(/(?:hover|focus|focus-visible):border-(?:accent|danger)|class:!?border-accent/);
      expect(source).not.toMatch(/(?:button:hover|button\.active|button\.chosen)[^{]*\{[^}]*border-color/);
    },
  );
  it("共享交互只改变底色或文字，不改变边框、阴影或轮廓颜色", () => {
    let states = 0;
    css.walkRules(rule => {
      if (!rule.selector.includes(".fill-interactions") || !/hover|focus|aria-pressed/.test(rule.selector)) return;
      states++;
      rule.walkDecls(declaration => {
        expect(declaration.prop).not.toMatch(/^(border|box-shadow|outline-color)/);
      });
    });
    expect(states).toBeGreaterThan(5);
  });
  it("选中为品牌底色；悬停排除禁用控件；键盘焦点用底色与下划线", () => {
    const rules: Record<string, Record<string, string>> = {};
    css.walkRules(rule => {
      const declarations: Record<string, string> = {};
      rule.walkDecls(d => { declarations[d.prop] = d.value; });
      rules[rule.selector] = declarations;
    });
    expect(Object.entries(rules).some(([s, d]) => s.includes('button[aria-pressed="true"]') && d["background-color"] === "#f24e4e")).toBe(true);
    expect(Object.entries(rules).some(([s, d]) => s.includes("button:enabled:hover") && d["background-color"] === "#323237")).toBe(true);
    expect(rules[".fill-interactions button:focus-visible"]["text-decoration"]).toBe("underline");
    expect(rules[".fill-interactions button:focus-visible"].outline).toBe("none");
  });
});
