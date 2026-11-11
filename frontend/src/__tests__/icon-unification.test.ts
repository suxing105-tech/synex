import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ICON_PATHS, ICON_SIZES, iconStroke } from "../lib/icons";

/**
 * 图标统一（2026-11-11 无障碍/视觉那一轮）。
 *
 * 定档之前 <Icon size> 一共用了 14 个不同数值（10/11/12/13/14/15/16/18/20/22/24/34/36/56），
 * 描边散着写 1.2 / 1.25 / 1.5 / 1.6 / 1.7 / 1.8 / 2，还有三个形状（左右栏展开收起）
 * 在三个文件里各画一遍。这里锁住三件事：尺寸只有档位、描边只有一把尺子、
 * 手画 <svg> 只允许出现在 Icon.svelte（见文件末尾那条）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");

function svelteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) svelteFiles(p, out);
    else if (/\.svelte$/.test(entry.name)) out.push(p);
  }
  return out;
}

it("尺寸只取档位：<Icon size> 不许再随手写一个新数值", () => {
  const ladder = new Set<number>(ICON_SIZES);
  const offenders: string[] = [];
  for (const file of svelteFiles(srcRoot)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/<Icon\b[^>]*?\bsize=\{(\d+)\}/g)) {
      if (!ladder.has(Number(m[1]))) offenders.push(`${file.split(/[\\/]/).pop()} size=${m[1]}`);
    }
  }
  expect(offenders, "越档的尺寸：" + offenders.join(", ")).toEqual([]);
});

it("描边只有一把尺子：≤16 一档，≥20 一档", () => {
  for (const size of [12, 14, 16]) expect(iconStroke(size), String(size)).toBe(1.75);
  for (const size of [20, 24, 36, 56]) expect(iconStroke(size), String(size)).toBe(2);
  // 尺子必须真的接在 Icon.svelte 上，别只是导出了个函数没人用
  const icon = readFileSync(join(srcRoot, "components", "Icon.svelte"), "utf8");
  expect(icon).toContain("stroke-width={iconStroke(size)}");
});

it("每个档位都能落到 ICON_SIZES，档位之间不留 1px 的歧义", () => {
  const sizes = [...ICON_SIZES];
  expect(sizes).toEqual([...new Set(sizes)].sort((a, b) => a - b));
  for (let i = 1; i < sizes.length; i++) {
    expect(sizes[i] - sizes[i - 1], `档位 ${sizes[i - 1]} → ${sizes[i]} 挨太近`).toBeGreaterThanOrEqual(2);
  }
});

it("栏位开关与窗口三键的形状进了图标库，不再是各文件手画", () => {
  for (const name of [
    "search",
    "brand",
    "panel-left-collapse",
    "panel-left-expand",
    "panel-right-collapse",
    "panel-right-expand",
    "window-minimize",
    "window-maximize",
    "window-restore",
  ]) {
    expect(ICON_PATHS[name], `缺少图标 ${name}`).toBeTruthy();
    // 关闭用已有的 x，不再另起名字
    expect(ICON_PATHS[name]).not.toContain("<svg");
  }
});
/**
 * 允许继续手画 <svg> 的文件，以及为什么：
 *   - TextWorkspace.svelte：已经下线、没挂在 App 上的旧文本工作台（文件头有 ⚠ 说明），
 *     下一轮连同 text-workspace.test.ts 一起删，不值得先给它的 10 个图标搬家。
 *   - MediaPickerModal.svelte：音频卡上那颗播放/暂停角标是「半透明圆底 + 白色实心图形」
 *     的合成徽标，压在缩略图上；Icon 的 currentColor + fill:none 线性图标画不出它。
 *   - VideoPromptPanel.svelte：翻译那颗里有 <text> 字形（中 / A）和一块遮住重叠的实心矩形，
 *     同理不是线性图标；而且 lib/icons.ts 的约定禁止非 none/currentColor 的 fill。
 * 除此之外再出现手画 <svg>，这条就红。
 */
const SVG_ALLOWLIST = [
  "components/TextWorkspace.svelte",
  "components/MediaPickerModal.svelte",
  "components/VideoPromptPanel.svelte",
];
const allowed = new Set(["components/Icon.svelte", ...SVG_ALLOWLIST]);

it("手画 <svg> 只允许出现在 Icon.svelte 和那三个合成徽标里", () => {
  const offenders: string[] = [];
  for (const file of svelteFiles(srcRoot)) {
    const rel = file.slice(srcRoot.length + 1).split("\\").join("/");
    const src = readFileSync(file, "utf8");
    const count = (src.match(/<svg\b/g) || []).length;
    if (count > 0 && !allowed.has(rel)) offenders.push(`${rel}（${count} 处）`);
  }
  expect(offenders, "这些文件还在自己画图标：" + offenders.join(", ")).toEqual([]);
});

it("stroke-width 只在 Icon.svelte 出现一次，别的文件一律不许调描边", () => {
  const offenders: string[] = [];
  for (const file of svelteFiles(srcRoot)) {
    const rel = file.slice(srcRoot.length + 1).split("\\").join("/");
    const src = readFileSync(file, "utf8");
    // 只数真正写下来的声明，注释里提到这个词不算
    const count = (src.match(/stroke-width\s*[:=]/g) || []).length;
    if (rel === "components/Icon.svelte") {
      expect(count, "Icon.svelte 只该有一处 stroke-width（由 iconStroke 给）").toBe(1);
      expect(src, "描边宽度写死回定值了").not.toContain('stroke-width="2"');
    } else if (count > 0 && !allowed.has(rel)) {
      // 上面那三个合成徽标自带描边（实心图形压在缩略图上），跟着 <svg> 的豁免一起放行
      offenders.push(`${rel}（${count} 处）`);
    }
  }
  expect(offenders, "还在单独调描边的文件：" + offenders.join(", ")).toEqual([]);
});

it("设置页左栏的每一项都能在图标库里找到形状", () => {
  // navIcons 现在是「分区 → 图标名」，形状全在 lib/icons.ts；漏一个就是静默画个空
  const src = readFileSync(join(srcRoot, "components", "SettingsModal.svelte"), "utf8");
  const block = src.match(/const navIcons: Record<string, string> = \{([\s\S]*?)\n  \};/);
  expect(block, "navIcons 表找不到了").toBeTruthy();
  const names = [...block![1].matchAll(/^\s*"?[\w-]+"?:\s*"([^"]+)"/gm)].map((m) => m[1]);
  expect(names.length).toBeGreaterThanOrEqual(10);
  for (const name of names) expect(ICON_PATHS[name], `缺少图标 ${name}`).toBeTruthy();
  // 并且不能反过来留一堆没人用的 nav-*
  const used = new Set(names);
  for (const name of Object.keys(ICON_PATHS)) {
    if (name.startsWith("nav-")) expect(used.has(name), `${name} 没人用了，删掉`).toBe(true);
  }
});
