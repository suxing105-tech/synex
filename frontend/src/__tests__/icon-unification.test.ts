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