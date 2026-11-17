import { existsSync, readFileSync, readdirSync } from "node:fs";
import { it, expect } from "vitest";
/**
 * 厂商 LOGO 这张表的守卫。
 *
 * 为什么值得钉：这张表是「前端手写的一份后端注册表的副本」，两边走偏不会报错——
 * 后端加了一家、前端没补 LOGO，界面上只是那张卡悄悄退回字母块，谁都不会发现。
 * 这里把它钉成「要么补 LOGO，要么登记进 NO_LOGO」。
 */
import { brandLogo, brandInitials, brandLogoIds } from "../lib/brand-logos";

/** 内置服务商 id：真源是后端注册表，这里按 8 空格缩进那一层取（模型条目不写 "id"）。 */
function registryIds(): string[] {
  const py = readFileSync("../backend/app/providers.py", "utf8");
  return [...py.matchAll(/^ {8}"id": "([a-z0-9_-]+)",$/gm)].map(m => m[1]);
}

/** 拿不到 LOGO、走字母块的厂商（simple-icons 与 LobeHub Icons 都没有这两家的现成图标）。 */
const NO_LOGO = ["runninghub", "siliconflow"];

const BRAND_DIR = "public/brands";

/** WCAG 1.4.11 非文本对比度用的相对亮度。 */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/** 那颗 LOGO 底座的底色，从组件里读，别在这儿抄第二份。 */
function chipBackground(): string {
  const css = readFileSync("src/components/BrandMark.svelte", "utf8");
  const hit = css.match(/\.brand-mark\s*\{[\s\S]*?background:\s*(#[0-9a-f]{6})/i);
  if (!hit) throw new Error("BrandMark.svelte 里读不到 .brand-mark 的底色");
  return hit[1];
}

it("注册表还在按那个缩进报 id：至少 10 家，正则退化了先红这里", () => {
  expect(registryIds().length).toBeGreaterThanOrEqual(10);
});

it("每张 LOGO 都对得上后端注册表里的一个服务商 id，孤儿条目不许留", () => {
  const ids = registryIds();
  const orphans = brandLogoIds().filter(id => !ids.includes(id));
  expect(orphans, "LOGO 表里有注册表没有的 id：" + orphans.join("/")).toEqual([]);
});

it("没 LOGO 的厂商只剩登记过的那两家：新加服务商要么补图要么登记", () => {
  const missing = registryIds().filter(id => brandLogo(id) === null).sort();
  expect(missing, "要么补 public/brands/*.svg，要么加进 NO_LOGO 说明为什么用字母块").toEqual(NO_LOGO);
});

it("表里每一条都指向真存在的随包文件", () => {
  for (const id of brandLogoIds()) {
    const url = brandLogo(id)!;
    expect(url.startsWith("/brands/"), id + " 的路径要落在 public/brands 下").toBe(true);
    const file = BRAND_DIR + "/" + url.split("/").pop();
    expect(existsSync(file), file + " 不在包里").toBe(true);
  }
});

it("LOGO 文件是干净的单色图形：不引外链、不留 currentColor", () => {
  for (const id of brandLogoIds()) {
    const svg = readFileSync(BRAND_DIR + "/" + id + ".svg", "utf8");
    expect(svg, id + " 要有 viewBox 才能按格子缩放").toContain('viewBox="0 0 24 24"');
    expect(svg, id + " 里的 currentColor 在 <img> 里会掉成黑色").not.toContain("currentColor");
    expect(svg, id + " 不许留外部引用").not.toMatch(/<image|xlink:href|https?:\/\/(?!www\.w3\.org)/);
    expect(svg.match(/fill="(#[0-9a-f]{6})"/gi)?.length ?? 0, id + " 只许一个写死的色值").toBe(1);
  }
});

it("LOGO 压在底座上还看得清：非文本对比度 3:1 是地板（WCAG 1.4.11）", () => {
  const chip = chipBackground();
  const bad: string[] = [];
  for (const id of brandLogoIds()) {
    const svg = readFileSync(BRAND_DIR + "/" + id + ".svg", "utf8");
    const hex = svg.match(/fill="(#[0-9a-f]{6})"/i)?.[1];
    if (!hex) continue;
    const r = ratio(hex, chip);
    if (r < 3) bad.push(`${id} ${hex} 压在 ${chip} 上只有 ${r.toFixed(2)}:1`);
  }
  expect(bad, "把色值调亮到能看清，或者换那颗底座的底色：" + bad.join(" | ")).toEqual([]);
});

it("授权与来源逐张登记：brands-manifest.json 和包里的文件不许分叉", () => {
  const manifest = JSON.parse(readFileSync(BRAND_DIR + "/brands-manifest.json", "utf8"));
  expect(typeof manifest.source).toBe("string");
  expect(String(manifest.source)).toMatch(/MIT/);
  const listed = manifest.files.map((f: { file: string }) => f.file).sort();
  const onDisk = readdirSync(BRAND_DIR).filter(f => f.endsWith(".svg")).sort();
  expect(listed, "登记的和包里的对不上").toEqual(onDisk);
});

it("认不得的 id 一律回 null，由调用方画字母块，不许留空格子", () => {
  expect(brandLogo(null)).toBeNull();
  expect(brandLogo(undefined)).toBeNull();
  expect(brandLogo("")).toBeNull();
  expect(brandLogo("custom")).toBeNull();
  expect(brandLogo("siliconflow")).toBeNull();
  expect(brandLogo("zhipu")).toBe("/brands/zhipu.svg");
});

it("字母块取名字头两个字：中文厂商是两个汉字，英文是两个字母的大写", () => {
  expect(brandInitials("智谱 GLM")).toBe("智谱");
  expect(brandInitials("  Google Gemini ")).toBe("GO");
  expect(brandInitials("")).toBe("?");
});

it("厂商标识只有 BrandMark 一个入口：两个用它的地方不许再各自画字母", () => {
  for (const file of ["src/components/ModelApiSettings.svelte", "src/components/ModelPicker.svelte"]) {
    const src = readFileSync(file, "utf8");
    expect(src, file + " 没在用 BrandMark").toContain("<BrandMark");
    expect(src, file + " 又自己写了一份字母块").not.toMatch(/const avatar = /);
  }
  expect(readFileSync("src/components/BrandMark.svelte", "utf8")).not.toContain("<svg");
});

it("反推下拉里那句「另外报了 N 个模型」的说明已经删掉", () => {
  expect(readFileSync("src/components/ModelPicker.svelte", "utf8")).not.toContain("另外报了");
});
