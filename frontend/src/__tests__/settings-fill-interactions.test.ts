import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";

const read = (path: string) => readFileSync(resolve(process.cwd(), "src", path), "utf8");
const css = postcss.parse(read("app.css"));

describe("设置与反推使用底色交互", () => {
  it("设置占满窗口，正文按窗口加宽、文字限行长并独立滚动", () => {
    const source = read("components/SettingsModal.svelte");
    expect(source).toContain('fixed inset-0 z-[60] bg-bg');
    expect(source).toContain('settings-shell w-full h-full');
    expect(source).toContain('settings-content min-w-0 overflow-y-auto');
    // 正文宽度跟着窗口加宽：最大化时不再是一条 820px 的窄柱（0.2.23 后用户反馈「太空」）。
    expect(source).toMatch(/\.settings-page \{ width: min\(100%, 1440px\); padding: 40px clamp\(/);
    expect(source).toContain('.settings-page { width: min(100%, 1440px);');
    expect(source).not.toContain('max-width: 820px');
    expect(source).not.toMatch(/\.settings-page \{ max-width: \d+px/);
    // 加宽的是卡片与行，文字仍限行长，避免说明拉成一条横线。
    expect(source).toMatch(/\.section-description \{[^}]*max-width: 88ch/);
    expect(read('app.css')).toMatch(/\.setting-row-desc \{[^}]*max-width: 88ch/);
    expect(read('app.css')).toMatch(/\.settings-hint \{[^}]*max-width: 88ch/);
    expect(read('components/ModelSettings.svelte')).toMatch(/fieldset \{ max-width: min\(100%, 1160px\)/);
    expect(source).not.toMatch(/max-w-\[94vw\]|88vh|bg-black\/75/);
  });
  it("底部保留设置入口，导入目录进入通用设置", () => {
    expect(read("App.svelte")).not.toContain('sidebar-settings');
    expect(read("App.svelte")).not.toContain('<HeaderBar');
    expect(read("App.svelte")).toContain('sidebar-actions fill-interactions flex items-center mt-auto pt-4 pb-2 shrink-0');
    expect(read("App.svelte")).not.toContain('aria-label="导入目录"');
    expect(read("components/SettingsModal.svelte")).toContain('onclick={onOpenOnboarding}>导入目录</button>');
    expect(read("components/Feed.svelte")).toContain('<GallerySearch label=');
    const source = read("components/SettingsModal.svelte");
    expect(source).toContain('settings-rail');
    expect(source).toContain('aria-controls={`settings-${section.id}`}');
    expect(source).toContain('grid-template-columns: 264px minmax(0, 1fr)');
    expect(source).toContain('aria-label="搜索设置"');
    // 目录挪到正文左边：源码里 settings-rail 必须出现在 settings-content 之前（旧版是正文 + 右侧索引）。
    expect(source.indexOf('settings-rail')).toBeLessThan(source.indexOf('settings-content'));
    expect(source).not.toContain('settings-index');
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
