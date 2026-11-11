import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 间距与字号尺度护栏（2026-11-11 无障碍那一轮收尾）。
 *
 * AGENTS.md §3.1 写给后面每一轮看的，就是这里钉住的数。文档最容易烂在「写了但没人对齐」，
 * 所以尺度的真源只认两处：src/app.css 的 :root token 块、tailwind.config.js 的 theme.extend。
 * 两边任何一处挪了，这条先红，免得文档和代码各说各话。
 *
 * 字号是「已经定档、存量还没迁完」的那一项，所以跟裸 hex 一样做成棘轮：
 * 只许降不许升。要求等于 0 会逼着一轮里塞进几十个无关文件，棘轮能拦住本轮新写的那个。
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");
const appCss = readFileSync(join(srcRoot, "app.css"), "utf8");
const tailwindConfig = readFileSync(resolve(srcRoot, "..", "tailwind.config.js"), "utf8");

const TOKEN_START = appCss.indexOf(":root {");
const TOKEN_END = appCss.indexOf("\nhtml,");
if (TOKEN_START < 0 || TOKEN_END < 0) {
  throw new Error("app.css 里找不到 token 定义块的边界（:root 到 html, 之间）");
}

function tokenDeclarations(): Map<string, string> {
  const out = new Map<string, string>();
  const block = appCss.slice(TOKEN_START, TOKEN_END);
  for (const m of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    if (out.has(m[1])) throw new Error(m[1] + " 在 token 块里定义了两次");
    out.set(m[1], m[2].trim());
  }
  return out;
}

const TOKENS = tokenDeclarations();
const px = (name: string) => {
  const value = TOKENS.get(name);
  if (!value) throw new Error("token 块里找不到 " + name);
  return value;
};

/** token 名按尺度分组读出来，别在断言里再抄一份数字。 */
function tokensWithPrefix(prefix: string) {
  return [...TOKENS.keys()].filter((k) => k.startsWith(prefix)).sort();
}

function collectSourceFiles(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(p, out);
    else if (/\.(svelte|css|ts)$/.test(entry.name)) out.push(p);
  }
  return out;
}

describe("字号尺度：六档，真源在 :root", () => {
  it("只有 6 个 --fs-* 档位，值定死、严格递增", () => {
    const names = tokensWithPrefix("--fs-");
    expect(names).toEqual([
      "--fs-2xs",
      "--fs-base",
      "--fs-lg",
      "--fs-md",
      "--fs-sm",
      "--fs-xs",
    ]);
    expect(px("--fs-2xs")).toBe("10.5px");
    expect(px("--fs-xs")).toBe("11.5px");
    expect(px("--fs-sm")).toBe("12.5px");
    expect(px("--fs-base")).toBe("13.5px");
    expect(px("--fs-md")).toBe("15px");
    expect(px("--fs-lg")).toBe("18px");
    const sizes = ["--fs-2xs", "--fs-xs", "--fs-sm", "--fs-base", "--fs-md", "--fs-lg"].map(
      (n) => parseFloat(px(n)),
    );
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i], sizes[i - 1] + " → " + sizes[i] + " 没有递增").toBeGreaterThan(sizes[i - 1]);
    }
  });

  it("tailwind 的六个字号别名一一指回这六档，且自带行高", () => {
    const from = tailwindConfig.indexOf("fontSize: {");
    expect(from, "tailwind.config.js 里找不到 fontSize 块").toBeGreaterThan(0);
    const block = tailwindConfig.slice(from, tailwindConfig.indexOf("fontFamily:", from));
    const expectRows: [string, string, string][] = [
      ["2xs", "--fs-2xs", "1.35"],
      ["xs2", "--fs-xs", "1.35"],
      ["sm2", "--fs-sm", "1.4"],
      ["base2", "--fs-base", "1.45"],
      ["md2", "--fs-md", "1.4"],
      ["lg2", "--fs-lg", "1.35"],
    ];
    const parsed = new Map<string, [string, string]>();
    for (const m of block.matchAll(
      /"?([\w-]+)"?:\s*\[\s*"var\((--[\w-]+)\)"\s*,\s*\{\s*lineHeight:\s*"([\d.]+)"\s*\}\s*\]/g,
    )) {
      if (parsed.has(m[1])) throw new Error("别名 " + m[1] + " 写了两遍");
      parsed.set(m[1], [m[2], m[3]]);
    }
    // 别名数量也得刚好是 6：多一个就是有人绕过 :root 又造了一档
    expect([...parsed.keys()].sort()).toEqual(expectRows.map((r) => r[0]).sort());
    for (const [alias, token, lineHeight] of expectRows) {
      const row = parsed.get(alias);
      expect(row, "缺别名 text-" + alias).toBeTruthy();
      expect(row![0], "text-" + alias + " 没指向 " + token).toBe(token);
      expect(row![1], "text-" + alias + " 的行高漂了").toBe(lineHeight);
    }
    // 这个块里不许出现裸 px，否则又多一个真源
    expect(block.match(/\b\d+(?:\.\d+)?px\b/g) || [], "fontSize 块里出现了裸 px").toEqual([]);
  });
});

describe("控件与圆角尺度", () => {
  it("控件高三档，最矮一档不低于 24px（WCAG 2.5.8 目标尺寸）", () => {
    expect(tokensWithPrefix("--ctl-")).toEqual(["--ctl-lg", "--ctl-md", "--ctl-sm"]);
    expect(px("--ctl-sm")).toBe("26px");
    expect(px("--ctl-md")).toBe("32px");
    expect(px("--ctl-lg")).toBe("38px");
    expect(parseFloat(px("--ctl-sm"))).toBeGreaterThanOrEqual(24);
  });

  it("圆角四档，pill 是唯一的「完全圆」", () => {
    expect(tokensWithPrefix("--r-")).toEqual(["--r-1", "--r-2", "--r-3", "--r-pill"]);
    expect(px("--r-1")).toBe("6px");
    expect(px("--r-2")).toBe("10px");
    expect(px("--r-3")).toBe("14px");
    expect(px("--r-pill")).toBe("999px");
  });

  it("间距沿用 tailwind 默认 4px 网格，没在 theme 里另造一套", () => {
    // 一旦有人往 extend.spacing 里塞东西，AGENTS.md §3.1 的「p-N × 4px」口径就失效了
    expect(tailwindConfig).not.toMatch(/\bspacing\s*:/);
    expect(tailwindConfig).not.toMatch(/\bextend:\s*\{[^}]*\bspacing\s*:/s);
  });
});

describe("脱档字号棘轮：只许降，不许升", () => {
  /** 六档的 px 数值，从 token 现取，token 改了棘轮跟着走。 */
  const tierValues = new Set(
    tokensWithPrefix("--fs-").map((n) => parseFloat(px(n)).toString()),
  );

  /** 两种写法：class 里的 text-[12px]，和 <style>/app.css 里的 font-size: 12px。 */
  const CLASS = /\btext-\[(\d+(?:\.\d+)?)px\]/g;
  const DECL = /(?<![-\w])font-size:\s*(\d+(?:\.\d+)?)px/g;

  function countOffScale() {
    let total = 0;
    const offenders = new Map<string, number>();
    for (const file of collectSourceFiles(srcRoot)) {
      const src = readFileSync(file, "utf8");
      for (const re of [CLASS, DECL]) {
        re.lastIndex = 0;
        for (const m of src.matchAll(re)) {
          if (tierValues.has(m[1])) continue;
          total += 1;
          const key = m[1] + "px";
          offenders.set(key, (offenders.get(key) || 0) + 1);
        }
      }
    }
    return { total, offenders: [...offenders.entries()].sort((a, b) => b[1] - a[1]) };
  }

  // 2026-11-11 定稿时的存量：六档定得下来，但存量（class 任意值 + <style> 里的裸 px）
  // 一轮迁不完。往下改组件时顺手把这个数调小，别调大。
  const BASELINE = 280;

  it("全站写在六档之外的字号不超过基线", () => {
    const { total, offenders } = countOffScale();
    expect(
      total,
      "脱档字号从基线 " + BASELINE + " 涨到 " + total + "。字号只有六档：" +
        "class 用 text-2xs/xs2/sm2/base2/md2/lg2，<style> 用 font-size: var(--fs-*)。" +
        " 现存分布：" + offenders.map(([k, v]) => k + "×" + v).join(" "),
    ).toBeLessThanOrEqual(BASELINE);
  });
});