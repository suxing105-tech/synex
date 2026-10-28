import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import postcss from "postcss";

it("选中缩略图用 1px 贴合描边 + 外阴影，且这是唯一的描边状态", () => {
  // 描边从 outline 2px（显粗、离卡片 2px）改成 1px box-shadow 贴边画。
  // box-shadow 不占布局，所以 .masonry-scroller 只需给阴影留 2px 余量。
  const css = postcss.parse(readFileSync("src/app.css", "utf8"));
  const declarations: Record<string, string> = {};
  css.walkRules(".media-card.is-selected", rule => {
    rule.walkDecls(decl => { declarations[decl.prop] = decl.value; });
  });
  expect(declarations["box-shadow"]).toBe("0 0 0 1px var(--thumb-ring), 0 4px 14px rgba(0, 0, 0, 0.45)");
  expect(declarations.outline).toBeUndefined();
  expect(declarations["outline-offset"]).toBeUndefined();

  // hover 不画描边：否则选中跟未选中长得一样，圈就没意义了
  let hoverShadow: string | undefined;
  css.walkRules(".media-card:hover", rule => {
    rule.walkDecls(decl => { if (decl.prop === "box-shadow") hoverShadow = decl.value; });
  });
  expect(hoverShadow).toBeUndefined();

  // 环的颜色沿用 2026-09-30 的定案：中性灰白，不用强调色
  const root: Record<string, string> = {};
  css.walkRules(":root", rule => {
    rule.walkDecls(decl => { root[decl.prop] = decl.value; });
  });
  expect(root["--thumb-ring"]).toBe("#d4d4d4");
});
