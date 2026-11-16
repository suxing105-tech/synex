import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { tokenValue } from "./fixtures/css-tokens";

it("选中缩略图用 1px 内描边 + 外阴影，且这是唯一的描边状态", () => {
  // 描边口径改了三次：outline 2px 外描边（显粗、啃间距）→ 1px inset box-shadow → outline 1px +
  // outline-offset:-1px。后两种都被图区 .media-card-media（position:relative，独立绘制层）整个
  // 盖住：只有页脚那截看得见，2026-11-15 苏醒因此点名「内描边不在最上层」。现在环画在卡片自己
  // 那颗 ::after 覆盖层上——绝对定位的最后一个子层，按树序排在图区之后，压得住。
  // .masonry-scroller 那 2px 余量继续留给投影。
  const css = postcss.parse(readFileSync("src/app.css", "utf8"));
  const declarations: Record<string, string> = {};
  css.walkRules(".media-card.is-selected", rule => {
    rule.walkDecls(decl => { declarations[decl.prop] = decl.value; });
  });
  // 卡片本体只剩投影：环和投影分家，投影在框外没人挡，环必须走覆盖层
  expect(declarations["box-shadow"]).toBe("0 4px 14px rgba(0, 0, 0, 0.45)");
  expect(declarations["box-shadow"]).not.toContain("inset");
  expect(declarations.outline).toBeUndefined();
  const ring: Record<string, string> = {};
  css.walkRules(".media-card.is-selected::after", rule => {
    rule.walkDecls(decl => { ring[decl.prop] = decl.value; });
  });
  expect(ring["box-shadow"]).toBe("inset 0 0 0 1px var(--thumb-ring)");
  const layer: Record<string, string> = {};
  css.walkRules(".media-card::after", rule => {
    rule.walkDecls(decl => { layer[decl.prop] = decl.value; });
  });
  expect(layer.position).toBe("absolute");
  expect(layer.inset).toBe("0");
  expect(layer["pointer-events"]).toBe("none");
  expect(layer["box-shadow"]).toBe("none");

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
  // 2026-11-06 起环色引 --text-1：#d4d4d4 → #f4f4f5，亮一档但仍是中性白，
  // 没有改成强调色（下面这条就是钉住这件事的）。
  expect(root["--thumb-ring"]).toBe("var(--text-1)");
  expect(tokenValue("--thumb-ring")).toBe("#f4f4f5");
  expect(tokenValue("--thumb-ring")).not.toBe(tokenValue("--accent"));
});
