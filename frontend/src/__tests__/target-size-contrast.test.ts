import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { tokenValue } from "./fixtures/css-tokens";

/**
 * 2026-11-11 无障碍审计第二批：文本对比度下限 + 点击目标尺寸下限。
 *
 * 这两类问题都是「肉眼在暗主题的亮屏幕上看不出毛病、拿数值一比就不合格」：
 *  - 侧栏那几档灰是凭手感调的，实测压在 4.5:1 以下（10.5px 的小字最吃亏）；
 *  - 22px 的 chip、22×22 的加号、4px 高的滑块，用鼠标去够都得瞄半天。
 * 所以这里不截图、也不对着源码念数字：色值解出来按 WCAG 公式算，
 * 尺寸直接从样式块里抠数值。
 */

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
};

/** WCAG 相对亮度 */
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度：1 = 一模一样，21 = 纯黑对纯白 */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

it("--text-3 是最暗的一档正文灰，压在任何面板底上都要够 4.5:1", () => {
  const text3 = tokenValue("--text-3");
  // 侧栏与设置页底 / 画布底 / 抬起面（输入框和 placeholder 落在这上面）
  for (const bg of ["--ink-1", "--ink-0", "--ink-2"]) {
    expect(contrast(text3, tokenValue(bg)), "--text-3 压在 " + bg + " 上").toBeGreaterThanOrEqual(4.5);
  }
});

it("侧栏与设置页不再留着凭手感调出来的低对比灰", () => {
  // 改之前：#6f6f76 / #7d7d86 / #6d6d75 压 #141418 只有 3.7~3.9:1，
  // 偏偏都用在 10.5~11px 的小字和 placeholder 上。全部收进 --text-3 这一档。
  const sources: Record<string, string> = {
    "FolderTree.svelte": readFileSync("src/components/FolderTree.svelte", "utf8"),
    "SettingsModal.svelte": readFileSync("src/components/SettingsModal.svelte", "utf8"),
  };
  for (const [name, src] of Object.entries(sources)) {
    for (const dead of ["#6f6f76", "#7d7d86", "#6d6d75"]) {
      expect(src, name + " 里还留着 " + dead).not.toContain(dead);
    }
  }
});

it("选中项的红色计数够得着正文对比度，且和同一行的标签同档", () => {
  // .folder-item.active 的标签是 --accent-strong，计数原来却还是 #f24e4e 压在红色薄底上（4.6:1 擦线）
  expect(contrast(tokenValue("--accent-strong"), tokenValue("--ink-1"))).toBeGreaterThanOrEqual(4.5);
  expect(readFileSync("src/components/FolderTree.svelte", "utf8")).toMatch(
    /\.folder-item\.active \.count\) \{\s*\n\s*color: var\(--accent-strong\);/,
  );
});

/** 抠出某条规则块里的一个数值声明 */
function decl(source: string, selector: string, prop: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = source.match(new RegExp("(?:^|\\n)[ \\t]*" + escaped + "\\s*\\{([^}]*)\\}"));
  if (!block) throw new Error("找不到规则块 " + selector);
  // 前一个字不许是字母/数字/-，否则 min-height 会被当成 height 读到
  const hit = block[1].match(new RegExp("(?<![-\\w])" + prop + ":\\s*([^;]+);"));
  if (!hit) throw new Error(selector + " 里没有 " + prop);
  return hit[1].trim();
}

const px = (v: string) => Number(v.replace("px", ""));

it("点击目标够 WCAG 2.5.8 的 24×24：类型 chips、分组加号、列数滑块", () => {
  const chips = readFileSync("src/components/TypeChips.svelte", "utf8");
  expect(px(decl(chips, ".chip", "height"))).toBeGreaterThanOrEqual(24);

  const tree = readFileSync("src/components/FolderTree.svelte", "utf8");
  expect(px(decl(tree, ".group-add", "width"))).toBeGreaterThanOrEqual(24);
  expect(px(decl(tree, ".group-add", "height"))).toBeGreaterThanOrEqual(24);

  const feed = readFileSync("src/components/Feed.svelte", "utf8");
  // 滑块：命中区抬到 24px，视觉那条细轨仍然是 4px（改画在轨道伪元素上）
  expect(px(decl(feed, ".columns-slider", "height"))).toBeGreaterThanOrEqual(24);
  expect(px(decl(feed, ".columns-slider::-webkit-slider-runnable-track", "height"))).toBe(4);
});

it("尺子本身也在水位线上：--ctl-sm 不许低到 24 以下", () => {
  expect(px(tokenValue("--ctl-sm"))).toBeGreaterThanOrEqual(24);
});