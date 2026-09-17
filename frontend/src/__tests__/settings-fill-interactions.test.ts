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
  it("侧栏入口为居中靠左的独立齿轮，保留无障碍名称", () => {
    const source = read("App.svelte");
    expect(source).toContain('sidebar-settings flex items-center justify-start');
    expect(source).toContain('aria-label="全局设置" title="设置"');
    expect(source).toContain('svg width="14" height="14"');
    expect(source).not.toContain('>⚙ 设置</button>');
    const entry = source.slice(source.indexOf('sidebar-settings'), source.indexOf('</aside>', source.indexOf('sidebar-settings')));
    expect(entry).toContain('hover:text-accent');
    expect(entry).not.toContain('hover:bg-');
    expect(entry).toContain('<circle cx="12" cy="12" r="4"');
    expect(read('components/FolderTree.svelte')).not.toContain('本地缓存');
    expect(read('components/FolderTree.svelte')).not.toContain(' 张图片</span>');
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
