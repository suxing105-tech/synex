import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

/** 全站界面源码（测试目录不算：断言里要拿这些色值做对照）。 */
function walk(dir: string, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/.(svelte|css)$/.test(entry.name)) out[p] = readFileSync(p, "utf8");
  }
  return out;
}
const SOURCES = walk("src");

it("--text-3 是最暗的一档正文灰，压在任何面板底上都要够 4.5:1", () => {
  const text3 = tokenValue("--text-3");
  // 侧栏与设置页底 / 画布底 / 抬起面（输入框和 placeholder 落在这上面）
  for (const bg of ["--ink-1", "--ink-0", "--ink-2"]) {
    expect(contrast(text3, tokenValue(bg)), "--text-3 压在 " + bg + " 上").toBeGreaterThanOrEqual(4.5);
  }
});

/**
 * 凭手感挑出来的低对比灰，全站 .svelte / .css 里一颗都不许留。
 * 2026-11-11 无障碍那轮先扫了侧栏和设置页（#6f6f76 / #7d7d86 / #6d6d75，压 #141418
 * 只有 3.7~3.9:1，偏偏都在 10.5~11px 的小字和 placeholder 上）；复跑又抓到同族三处：
 * 再次创作弹窗提示词框的 placeholder、参考格没绑上时那颗编号（都是 #62626a，3.0:1），
 * 和文本编辑器「点击开始写作…」（#72727e，4.1:1）。一律收进 --text-3。
 */
const DEAD_GRAYS = ["#6f6f76", "#7d7d86", "#6d6d75", "#62626a", "#72727e"];

it("全站不再留着凭手感挑出来的低对比灰", () => {
  const offenders: string[] = [];
  for (const [name, src] of Object.entries(SOURCES)) {
    for (const dead of DEAD_GRAYS) {
      if (src.includes(dead)) offenders.push(name + " 还留着 " + dead);
    }
  }
  expect(offenders, offenders.join("；")).toEqual([]);
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

/** 同一个选择器可能有多条规则（.cm-tile-x 一条管外观、一条管尺寸），合起来看 */
function declAll(source: string, selector: string, prop: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blocks = [...source.matchAll(new RegExp("(?:^|\\n)[ \\t]*" + escaped + "\\s*\\{([^}]*)\\}", "g"))];
  if (!blocks.length) throw new Error("找不到规则块 " + selector);
  for (const b of blocks) {
    const hit = b[1].match(new RegExp("(?<![-\\w])" + prop + ":\\s*([^;]+);"));
    if (hit) return hit[1].trim();
  }
  throw new Error(selector + " 里没有 " + prop);
}

it("点击目标够 24×24 第二批：详情栏页签、两处文字按钮、侧栏行内菜单、快捷键清除、内置厂商筛选、参考格移除", () => {
  // 这六处是 design-QA 那轮在浏览器里按 getBoundingClientRect 实测挑出来的：
  // 数值都在 16~20px 之间，肉眼在暗色面板上看不出毛病，量出来全部够不着 WCAG 2.5.8。
  const detail = readFileSync("src/components/DetailPanel.svelte", "utf8");
  expect(px(decl(detail, ".detail-tab", "min-width"))).toBeGreaterThanOrEqual(24);
  // 两处 11px 的文字按钮走 Tailwind 的 min-h-6（=1.5rem=24px，根字号 16px）。
  // 必须配 items-center：不然字贴在 24 高盒子上沿，看着就是往上跳了一截
  const detailTag = readFileSync("src/components/DetailPanel.svelte", "utf8");
  expect(detailTag).toMatch(/class="text-\[11px\][^"]*inline-flex min-h-6 items-center/);
  const meta = readFileSync("src/components/MetadataCard.svelte", "utf8");
  expect(meta).toMatch(/class="ml-auto inline-flex min-h-6 min-w-6 items-center/);

  const tree = readFileSync("src/components/FolderTree.svelte", "utf8");
  expect(px(decl(tree, ":global(.folder-item .menu-btn)", "min-height"))).toBeGreaterThanOrEqual(24);

  const shortcuts = readFileSync("src/components/ShortcutSettings.svelte", "utf8");
  expect(px(decl(shortcuts, ".shortcut-clear", "min-height"))).toBeGreaterThanOrEqual(24);

  // 那颗方框只有 13×13，原生外观不该放大：label 包着方框和文字，整行才是命中区
  const api = readFileSync("src/components/ModelApiSettings.svelte", "utf8");
  expect(px(decl(api, ".api-filter-builtin", "min-height"))).toBeGreaterThanOrEqual(24);

  const clone = readFileSync("src/components/CloneModal.svelte", "utf8");
  expect(px(declAll(clone, ".cm-tile-x", "width"))).toBeGreaterThanOrEqual(24);
  expect(px(declAll(clone, ".cm-tile-x", "height"))).toBeGreaterThanOrEqual(24);
});

it("点击目标够 24×24 第三批：design-QA 同视口复跑剩下的三处", () => {
  // 复跑是在真浏览器里按 getBoundingClientRect 扫整页：首页已经 0 处不合格，
  // 剩下的藏在详情栏和设置页里。那颗「切换」上一轮只抬了高度、还差 1px 宽，
  // 补 min-w-6（断言并到第二批）；这里钉另外两处。

  const feed = readFileSync("src/components/Feed.svelte", "utf8");
  expect(feed).toMatch(/class="px-1\.5 py-0\.5 text-\[11px\][^"]*inline-flex min-h-6 items-center/);

  // 分段控件里那颗按钮原来写 --ctl-sm 减 6px，等于自己把尺子往下垫了 6px。
  // 抬回 var(--ctl-sm) 之后外框 26+2×2+1×2=32，正好还是 --ctl-md 那一档。
  const appCss = readFileSync("src/app.css", "utf8");
  expect(declAll(appCss, ".settings-seg button", "height")).toBe("var(--ctl-sm)");
  expect(px(tokenValue("--ctl-sm"))).toBeGreaterThanOrEqual(24);
  // 技术上的一条铁律：把命中区抬到 24 不能把行高顶下去。
  // 侧栏那颗 ⋯ 抬到 24 之后，文件夹行的上下内边距从 6 收到 4：24+4×2=32，
  // 还是 --ctl-md 那一档。不收的话复跑实测 20 行全部被撑成 36，侧栏整体变疏。
  const tree = readFileSync("src/components/FolderTree.svelte", "utf8");
  expect(decl(tree, ":global(.folder-item)", "padding")).toBe("4px 10px");
  expect(decl(tree, ":global(.folder-item)", "min-height")).toBe("32px");
  expect(px(decl(tree, ":global(.folder-item .menu-btn)", "min-height"))).toBeGreaterThanOrEqual(24);
});

it("尺子本身也在水位线上：--ctl-sm 不许低到 24 以下", () => {
  expect(px(tokenValue("--ctl-sm"))).toBeGreaterThanOrEqual(24);
});

it("placeholder 的灰一律引 token，不再各挑各的", () => {
  // placeholder 最容易「随手调个淡灰」，也恰恰是最常掉到 4.5:1 以下的那处文字
  const offenders: string[] = [];
  for (const [name, src] of Object.entries(SOURCES)) {
    for (const m of src.matchAll(/::placeholder\s*\{([^}]*)\}/g)) {
      if (/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/.test(m[1])) offenders.push(name + " → " + m[1].trim());
    }
  }
  expect(offenders, "这些 placeholder 还在写 hex：" + offenders.join("；")).toEqual([]);
});

it("--text-3 压不住 ink-3（控件底），不许和 surface-3 配在同一个元素上", () => {
  // 地板是相对底色说的：--text-3 压 ink-0 / ink-1 / ink-2 有 5.6 / 5.4 / 4.9，压 ink-3 只剩 4.3
  expect(contrast(tokenValue("--text-3"), tokenValue("--ink-3"))).toBeLessThan(4.5);
  const offenders: string[] = [];
  for (const [name, src] of Object.entries(SOURCES)) {
    for (const m of src.matchAll(/class="([^"]*)"/g)) {
      const list = m[1].split(/\s+/);
      // 只看静态底色：hover:bg-surface-3 那种一定配着 hover:text-* 一起换，不算
      if (list.includes("bg-surface-3") && list.includes("text-muted")) {
        offenders.push(name + " → " + m[1].trim());
      }
    }
    for (const m of src.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (/background(?:-color)?\s*:\s*var\(--ink-3\)/.test(m[2]) && /(^|;)\s*color\s*:\s*var\(--text-3\)/.test(m[2])) {
        offenders.push(name + " → " + m[1].trim().split("\n").pop());
      }
    }
  }
  expect(offenders, "text-3 压在控件底上：" + offenders.join("；")).toEqual([]);
});
