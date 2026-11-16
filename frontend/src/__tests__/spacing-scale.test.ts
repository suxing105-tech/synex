import { expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tokenValue } from "./fixtures/css-tokens";
import { THUMB_GAP } from "../lib/media-format";

/**
 * 间距规范（2026-11-16）。
 *
 * 2026-11-11 那版 §3.1 写的「间距 = Tailwind 默认 4px 网格」其实只管住了 class：
 * app.css 和各组件 style 块里躺着 439 个脱档数值（6px×98、10px×87、14px×32、7px×28…），
 * 同一个视觉角色在不同面板里有三四种内边距。这一轮把它们全收进 --sp-* 档位：
 * class 写 p-2，样式里就写 var(--sp-2)，两侧同一个数说同一件事。
 *
 * 换档方向是「最近档，等距向上」（6→8、10→12、14→16）：向下一会把小控件压到
 * WCAG 2.5.8 的 24px 命中区以下，而且「比默认档宽一档」的元素会塌回默认档，层级反而糊掉。
 * 真正向下的是那些本来就更贴近小档的（5→4、9→8、25→24）。
 */

const SPACING_SCALE: Record<string, string> = {
  "--sp-05": "2px",
  "--sp-1": "4px",
  "--sp-2": "8px",
  "--sp-3": "12px",
  "--sp-4": "16px",
  "--sp-5": "20px",
  "--sp-6": "24px",
  "--sp-7": "28px",
  "--sp-8": "32px",
};

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

/**
 * padding / margin / gap 全族声明，含 style 属性里的内联写法。
 * 必须带 m：CSS 一条规则里的头一条声明前面是「花括号 + 换行」，没有 m 时行首不算，
 * 全量 701 条只会扫到 595 条，测试就会假装很干净。
 */
const DECL =
  /([{};]|^)[ \t]*(padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block|x|y))?[ \t]*:[ \t]*([^;{}]+?)(?=;|[{}]|[\r\n]|")/gm;
const NUM = /([0-9]+(?:[.][0-9]+)?)px/g;

const LAYOUT_EXEMPT = [
  "src/app.css|padding", // 40px：页面级左右留白
  "src/components/SettingsModal.svelte|padding", // 40 / clamp(…, 4.4vw, 84) / 120
  "src/components/SplashOverlay.svelte|margin", // -310px：启动页那圈环的居中偏移
  "src/components/SplashOverlay.svelte|margin", // 40px：字标下面那段
  "src/components/TextEditor.svelte|padding", // clamp(…, 5vw, 90) / 120 底
  "src/components/TextReader.svelte|padding", // 40px 顶
].sort();

/** 竖向 2px 的存量：只该出现在图标和文字之间那种紧贴排布上。棘轮只降不升。 */
const HALF_STEP_BASELINE = 41;

it("--sp-* 九档数值钉死，并且等于 Tailwind 同名档（class 与 CSS 同一个数）", () => {
  for (const [name, value] of Object.entries(SPACING_SCALE)) {
    expect(tokenValue(name), name).toBe(value);
  }
  expect(parseInt(tokenValue("--sp-2"), 10)).toBe(2 * 4);
  expect(parseInt(tokenValue("--sp-8"), 10)).toBe(8 * 4);
  expect(tokenValue("--sp-05")).toBe("2px");
});

it("间距尺度的真源只有一处：tailwind 的 theme.extend 里不许再塞 spacing", () => {
  const cfg = readFileSync("tailwind.config.js", "utf8");
  const extend = cfg.match(/extend:[\s\S]*?\{([\s\S]*?)\n\s{2}\}/);
  expect(extend ? extend[1] : "", "theme.extend 里出现了 spacing，两套尺度会打架").not.toMatch(/spacing\s*:/);
});

it("扫描还在扫全量：间距声明至少 690 条，正则退化了就报这里", () => {
  let total = 0;
  for (const src of Object.values(SOURCES)) {
    for (const m of src.matchAll(DECL)) if (m[0]) total += 1;
  }
  expect(total).toBeGreaterThanOrEqual(690);
  // 光数条数不够：分组号写错时每条都读成 undefined，扫描会「零违规」地假绿。
  // 再钉一条「确实读到值、而且绝大多数已经走档位」，捕获组一失效这里就红。
  let withToken = 0;
  let withAnyValue = 0;
  for (const src of Object.values(SOURCES)) {
    for (const m of src.matchAll(DECL)) {
      if (typeof m[3] !== "string" || !m[3].trim()) continue;
      withAnyValue += 1;
      if (/var\(--sp-/.test(m[3])) withToken += 1;
    }
  }
  expect(withAnyValue).toBeGreaterThanOrEqual(690);
  expect(withToken, "读到值但没走档位的只有 " + withToken + " 条，扫描或迁移退化了").toBeGreaterThanOrEqual(560);
});

it("脱档间距清零：1px/3px 的微调和 >=40px 的版式尺寸之外，一律走 --sp-*", () => {
  const bad: string[] = [];
  const big: string[] = [];
  for (const [file, src] of Object.entries(SOURCES)) {
    const rel = file.replace(/\\/g, "/");
    for (const m of src.matchAll(DECL)) {
      const nums = [...m[3].matchAll(NUM)].map((x) => parseFloat(x[1]));
      const off = nums.filter((n) => n !== 1 && n !== 3 && n < 40 && n % 4 !== 0);
      if (off.length) bad.push(rel + " " + m[2] + ": " + m[3].trim() + "  => " + off.join("/"));
      if (nums.some((n) => n >= 40)) big.push(rel + "|" + m[2]);
    }
  }
  expect(bad, "又出现脱档手值，换成 var(--sp-*) 或最近的档位：" + bad.join(" | ")).toEqual([]);
  expect(big.sort(), "版式尺寸那几条例外变了：核对每条是不是真的不算间距尺度").toEqual(LAYOUT_EXEMPT);
});

it("负间距不许直接减 var：减号紧挨 var( 是非法写法，整条声明作废", () => {
  const bad: string[] = [];
  for (const [file, src] of Object.entries(SOURCES)) {
    src.split(/\r?\n/).forEach((line, i) => {
      if (/-var\(--/.test(line)) bad.push(file + ":" + (i + 1));
    });
  }
  expect(bad, "改成 calc(var(--sp-3) * -1)：" + bad.join(", ")).toEqual([]);
});

it("class 侧不许用任意值写间距，绕开尺度的 p-[7px] 这类写法", () => {
  const bad: string[] = [];
  for (const [file, src] of Object.entries(SOURCES)) {
    // 形状必须是 p/m/gap/space + 可选轴向 + -[值]，写成 (?:-[xy])? 而不是 -(?:x|y)?，
    // 否则 px-[14px] 这种最常见的写法正好从指缝里漏掉（第一版就漏了）。
    const re = /(?:^|[\s"])(?:p|m|gap|space)[trblxy]?(?:-[xy])?-\[[0-9.]+(?:px|rem)\]/g;
    for (const m of src.matchAll(re)) bad.push(file + " " + m[0].trim());
  }
  expect(bad, "改成档位类名（p-2 / gap-3 / mt-1）：" + bad.join(", ")).toEqual([]);
});

it("半步 2px 不当竖向内边距用（棘轮）", () => {
  let half = 0;
  for (const src of Object.values(SOURCES)) {
    for (const m of src.matchAll(DECL)) {
      if (!/^(padding|margin)$/.test(m[2])) continue;
      if (/var\(--sp-05\)/.test(m[3])) half += 1;
    }
  }
  expect(half, "竖向 2px 从 " + HALF_STEP_BASELINE + " 涨到 " + half + "：那是图标和文字之间的半步").toBeLessThanOrEqual(HALF_STEP_BASELINE);
});

it("class 侧的半步只有 0.5：p-1.5 / gap-2.5 这类是伪装成档位的脱档值", () => {
  const bad: string[] = [];
  for (const [file, src] of Object.entries(SOURCES)) {
    if (!/[.]svelte$/.test(file)) continue;
    // Tailwind 默认刻度里 1.5=6px、2.5=10px、3.5=14px，全都不在 4px 网格上；
    // 只有 0.5=2px 是 §3.1 认的半步（图标和文字之间）。
    const re = /(?:^|[\s"])(?:p|m|gap|space)[trblxy]?(?:-[xy])?-[1-9][0-9]*\.5(?=$|[\s"])/g;
    for (const m of src.matchAll(re)) bad.push(file + " " + m[0].trim());
  }
  expect(bad, "换成整档（1.5→2、2.5→3、3.5→4）：" + bad.join(", ")).toEqual([]);
});

it("注入 ComfyUI 的那块面板不许改用 --sp-*：那边是别人的页面，没有我们的 :root", () => {
  const panel = readFileSync("src-tauri/src/comfyui_panel.js", "utf8");
  const bridge = readFileSync("src-tauri/src/comfyui_bridge.js", "utf8");
  expect(panel + bridge, "注入脚本里的 var(--sp-*) 在 ComfyUI 页面解析不出来，会整条声明作废").not.toMatch(/var\(--sp-/);
  // 那颗浮动药丸是这一族里唯一的间距字面值：值按 4px 网格（8 12，和界面默认档一致），
  // 但只能写数字——钉住这组数，别顺手改成 token，也别再漂回 6px。
  const pills = [...panel.matchAll(/padding:[ ]*([0-9.]+)px[ ]*([0-9.]+)px/g)];
  expect(pills).toHaveLength(1);
  expect(pills[0][1] + " " + pills[0][2]).toBe("8 12");
});

it("瀑布流的列间距也在网格上：THUMB_GAP 是 JS 侧的间距入口，脱档就是整个网格脱档", () => {
  expect(THUMB_GAP % 4).toBe(0);
  expect(tokenValue("--thumb-gap")).toBe(THUMB_GAP + "px");
});

it("两棵目录树的缩进同一档：12px，不再一棵 14 一棵 12", () => {
  const pick = (name: string) => {
    const key = Object.keys(SOURCES).find((k) => k.split(/[\\/]/).pop() === name);
    expect(key, name + " 没扫到，测试自身的扫描先坏了").toBeTruthy();
    return SOURCES[key as string];
  };
  const tree = pick("FolderTree.svelte");
  const picker = pick("PickerFolderTree.svelte");
  expect([...tree.matchAll(/\{depth \* ([0-9]+)\}px/g)].map((m) => m[1]).join(","), "FolderTree 的层级缩进").toBe("12,12");
  expect([...picker.matchAll(/\{depth \* ([0-9]+)\}px/g)].map((m) => m[1]).join(","), "PickerFolderTree 的层级缩进").toBe("12");
});
it("控件高三档没被间距收敛带跑：26 / 32 / 38 还在", () => {
  expect(tokenValue("--ctl-sm")).toBe("26px");
  expect(tokenValue("--ctl-md")).toBe("32px");
  expect(tokenValue("--ctl-lg")).toBe("38px");
});
