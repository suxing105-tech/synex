import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import postcss from "postcss";

it("selected thumbnails use a neutral gray-white border above the image", () => {
  const source = readFileSync("src/components/Feed.svelte", "utf8");
  const css = postcss.parse(source.split("<style>")[1].split("</style>")[0]);
  const declarations: Record<string, string> = {};
  css.walkRules(".thumb.is-selected::after", rule => {
    rule.walkDecls(decl => { declarations[decl.prop] = decl.value; });
  });
  expect(declarations.border).toBe("2px solid #d4d4d4");
  expect(declarations["z-index"]).toBe("3");
  expect(declarations["pointer-events"]).toBe("none");
  expect(declarations["box-sizing"]).toBe("border-box");
  expect(declarations.inset).toBe("0");
});
