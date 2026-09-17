import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";

const read = (path: string) => readFileSync(resolve(process.cwd(), "src", path), "utf8");
const css = postcss.parse(read("app.css"));

describe("设置与反推使用底色交互", () => {
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
