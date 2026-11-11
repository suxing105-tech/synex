import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 设计 token 门禁（方案 3 · 生产力工作台第一批，2026-11-06）。
 *
 * 管三件「不做就会慢慢烂回去」的事：
 *  1. tailwind 的 theme.colors 不许再出现裸 hex。否则同一个颜色有两个真源，
 *     下次只改 :root 会漏掉它，而且不报错——是最难查的那种漏。
 *  2. 带 -rgb 后缀的通道值必须和主 token 一字不差。这是全站唯一一个
 *     「同一个颜色写两遍」的地方（tailwind 要透明度只能这么喂），最容易手改歪。
 *  3. 裸 hex 棘轮：只许降不许升。存量一轮改不完，要求「等于 0」只会逼着
 *     一轮里塞进几十个无关文件；棘轮能立刻拦住本轮新加的那一个。
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");
const appCssPath = join(srcRoot, "app.css");
const appCss = readFileSync(appCssPath, "utf8");
const tailwindConfig = readFileSync(resolve(srcRoot, "..", "tailwind.config.js"), "utf8");

const HEX = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{3}\b/g;

/** 注释里的 hex 是写给人看的说明，不算「又造了一个色值」，两边都先剥掉。 */
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

/** token 定义块：从开头那个 :root 到第一条全局规则（html,）之前。 */
const TOKEN_START = appCss.indexOf(":root {");
const TOKEN_END = appCss.indexOf("\nhtml,");
if (TOKEN_START < 0 || TOKEN_END < 0) {
  throw new Error("app.css 里找不到 token 定义块的边界（:root 到 html, 之间），块名改了吗？");
}

function collectSourceFiles(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // 测试自己允许出现色值：断言里要拿它做对照
    if (entry.name === "__tests__") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(p, out);
    else if (/\.(svelte|css|ts)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** 全站裸 hex：token 定义块之内不算，app.css 只数块外。 */
function countRawHex() {
  let total = 0;
  for (const file of collectSourceFiles(srcRoot)) {
    let src = readFileSync(file, "utf8");
    if (file === appCssPath) src = src.slice(0, TOKEN_START) + src.slice(TOKEN_END);
    total += (stripComments(src).match(HEX) || []).length;
  }
  return total;
}

/** token 块里的变量声明：名 → 原始值；重名直接炸，别留两份真源。 */
function tokenDeclarations() {
  const block = appCss.slice(TOKEN_START, TOKEN_END);
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    if (out.has(m[1])) throw new Error(m[1] + " 在 token 块里定义了两次");
    out.set(m[1], m[2].trim());
  }
  return out;
}

function hexToChannels(hex: string) {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = h.split("").map((c: string) => c + c).join("");
  h = h.slice(0, 6);
  return [0, 2, 4].map((i: number) => parseInt(h.slice(i, i + 2), 16)).join(" ");
}

describe("token 是颜色的唯一来源", () => {
  it("tailwind.config.js 的 theme.colors 不出现裸 hex", () => {
    const from = tailwindConfig.indexOf("colors:");
    const block = tailwindConfig.slice(from, tailwindConfig.indexOf("borderRadius:", from));
    expect(block.length).toBeGreaterThan(20);
    expect(block.match(HEX) || []).toEqual([]);
  });

  it("token 块之外，app.css 自己也不留裸 hex", () => {
    const outside = stripComments(appCss.slice(0, TOKEN_START) + appCss.slice(TOKEN_END));
    expect(outside.match(HEX) || []).toEqual([]);
  });

  it("每个 -rgb 通道值和主 token 的十六进制对得上", () => {
    const decl = tokenDeclarations();
    const checked = [];
    // 认两种命名：--accent / --accent-rgb，--ink-0 / --ink-rgb-0
    for (const channel of decl.keys()) {
      // 只从「通道」这一侧走一遍：--accent-rgb 与 --ink-rgb-0 两种命名都算通道，其余跳过
      const isPlain = channel.endsWith("-rgb");
      const isInk = /^--ink-rgb-\d+$/.test(channel);
      if (!isPlain && !isInk) continue;
      const primary = isPlain ? channel.replace(/-rgb$/, "") : channel.replace(/^(--ink)-rgb-/, "$1-");
      if (!decl.has(primary)) throw new Error(channel + " 找不到配对的 " + primary);
      const hex = decl.get(primary);
      if (!hex || !hex.startsWith("#")) continue;
      expect(hexToChannels(hex), primary + " 与 " + channel + " 对不上").toBe(decl.get(channel));
      checked.push(primary);
    }
    // 少说也得覆盖墨阶、文本、分隔线和主色，别整段没匹配上还照样全绿
    for (const must of ["--ink-0", "--ink-5", "--text-1", "--text-3", "--line", "--accent"]) {
      expect(checked, must + " 没被配对校验覆盖到").toContain(must);
    }
  });

  it("文本最低一档不许再往下暗（对比度下限）", () => {
    const text3 = tokenDeclarations().get("--text-3");
    if (!text3) throw new Error("token 块里找不到 --text-3，文本对比度下限就没地方守了");
    const lum = (hex: string) => {
      const [r, g, b] = hexToChannels(hex).split(" ").map(Number);
      const lin = (c: number) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    // #8a8a8e 压在 --ink-0 上约 6.1:1；再往下暗就守不住正文可读性了
    expect(lum(text3)).toBeGreaterThanOrEqual(0.25);
  });
});

describe("裸 hex 棘轮：只许降，不许升", () => {
  // 2026-11-06 方案 3 第一批落地后的存量（大头在 CloneModal / TextWorkspace /
  // VideoPromptPanel）。往下改组件时顺手把这个数调小，别调大。
  const BASELINE = 730;

  it("全站 token 之外的裸 hex 不超过基线", () => {
    const now = countRawHex();
    expect(
      now,
        "裸 hex 从基线 " + BASELINE + " 涨到 " + now +
          "。颜色一律引 src/app.css 的 :root token；" +
          "要透明度用 --raise-* / --shade-*，或 rgb(var(--x-rgb) / n)。",
    ).toBeLessThanOrEqual(BASELINE);
  });
});
