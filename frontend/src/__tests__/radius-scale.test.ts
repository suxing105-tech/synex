import { expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tokenValue } from "./fixtures/css-tokens";

/**
 * 圆角规范（2026-11-16 R5）。
 *
 * 2026-11-11 那版 §3.1 写了「圆角 4 档」，但真源只被引用了 25 次，剩下 233 处把数写死：
 * 同一个视觉角色在 2/3/4/5/6/7/8/9px 之间来回跳，最刺眼的是瀑布流卡片自己 8px、
 * 选中那一圈描边 6px，角上明显脱开。这一轮把实际成簇的 4 和 8 收进档位，
 * 并且把「完全圆角」拆成两种：胶囊（--r-pill）和正圆（--r-circle），
 * 因为 50% 压在长条上会切成透镜形，999px 压在正圆上又依赖宽高恰好相等，两件事不该共用一个数。
 *
 * 换档方向和间距同一口径：最近档，等距向上（4→6、8→10、16→14 那类按语义就近）。
 * 唯一一处故意向下的是窄卡的 --thumb-radius 8px→6px：那条规则自己的注释就是「收一档」，
 * 在新的五档里「收一档」是 10→6，不是 10→8。
 */

const RADIUS_SCALE: Record<string, string> = {
  "--r-0": "3px",
  "--r-1": "6px",
  "--r-2": "10px",
  "--r-3": "14px",
  "--r-pill": "999px",
  "--r-circle": "50%",
};

/** 样式里允许的圆角落值。0 与 inherit 是几何事实，不算脱档。 */
const OK_VALUE =
  /^(?:var\(--r-(?:0|1|2|3|pill|circle)\)|var\(--thumb-radius(?:, ?var\(--r-2\))?\)|inherit|0|calc\(var\(--r-\w+\) - \d+px\))(?: +0| +(?:0|var\(--r-\w+\))| +calc\(var\(--r-\w+\) - \d+px\))*$/;

function walk(dir: string, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(svelte|css)$/.test(entry.name))
      out[p] = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  }
  return out;
}
const SOURCES = walk("src");
const CONFIG = readFileSync("tailwind.config.js", "utf8");

/** 声明扫描必须带 m：一条规则里第一条声明前面是换行，不带 m 会整批漏掉。 */
const DECL = /border-radius[ \t]*:[ \t]*([^;{}"']+?)(?=[;{}"']|[\r\n])/g;

function eachDeclaration(fn: (file: string, line: number, value: string) => void) {
  for (const [file, src] of Object.entries(SOURCES)) {
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(DECL)) fn(file, i + 1, m[1].trim());
    }
  }
}

it("--r-* 六档数值钉死，圆角的真源只有 app.css 的 :root", () => {
  for (const [name, value] of Object.entries(RADIUS_SCALE)) {
    expect(tokenValue(name), name).toBe(value);
  }
  // theme.extend 里不许再有第二份 borderRadius：那是 class 侧的尺度，必须整体在 theme 顶层
  const extend = CONFIG.match(/extend:[\s\S]*?\{([\s\S]*?)\n\s{2}\}/);
  expect(extend ? extend[1] : "", "theme.extend 里出现了 borderRadius，两套尺度会打架").not.toMatch(/borderRadius\s*:/);
});

it("tailwind 的 rounded-* 只指回 --r-* token，站内不再出现第二个数", () => {
  const block = CONFIG.match(/borderRadius:\s*\{([\s\S]*?)\n    \},/);
  if (!block) throw new Error("theme 顶层找不到 borderRadius 块，尺度整个没接上");
  const entries = [...block[1].matchAll(/"?([\w-]*)"?:\s*"([^"]+)"/g)];
  expect(entries.length).toBeGreaterThanOrEqual(6);
  for (const [, key, value] of entries) {
    expect(value, key).toMatch(/^(?:0|var\(--r-(?:0|1|2|3|pill|circle)\))$/);
  }
  // rounded 这个裸 class 必须仍然等于控件档，站内 20 处靠它
  expect(block[1]).toMatch(/DEFAULT:\s*"var\(--r-1\)"/);
});

it("每条 border-radius 都落在档位上：样式里不许再写死像素", () => {
  const bad: string[] = [];
  eachDeclaration((file, line, value) => {
    if (!OK_VALUE.test(value)) bad.push(file + ":" + line + "  border-radius: " + value);
  });
  expect(bad, "脱档圆角\n" + bad.join("\n")).toEqual([]);
});

it("内缩圆角不许把值减成负数", () => {
  const bad: string[] = [];
  eachDeclaration((file, line, value) => {
    for (const m of value.matchAll(/calc\(var\(--r-\w+\) - (\d+)px\)/g)) {
      const name = "--r-" + (/var\(--r-(\w+)\)/.exec(m[0]) as RegExpExecArray)[1];
      const token = RADIUS_SCALE[name];
      if (!token) throw new Error(file + ":" + line + " 引用了不存在的档位 " + name);
      if (parseInt(token, 10) - parseInt(m[1], 10) < 1) bad.push(file + ":" + line + "  " + value);
    }
  });
  expect(bad, "内缩后小于 1px\n" + bad.join("\n")).toEqual([]);
});

const SIDES = ["t", "r", "b", "l", "s", "e", "tl", "tr", "bl", "br", "x", "y"];
const KEYS = ["none", "tight", "ctl", "card", "panel", "full"];
const LEGACY = /^rounded(?:-(?:t|r|b|l|s|e|tl|tr|bl|br|x|y))?-(?:sm|md|lg|xl|2xl|3xl)$/;

/**
 * class 侧只剩档位名。内置的 rounded-sm/md/lg/xl/2xl/3xl 这一版起从 theme 里删掉了，
 * 写了不报错但一点样式都没有，属于本项目反复踩的那类静默失效；方括号里直接挑像素数
 * 的任意值则是把尺度直接绕开。两种都拦，顺带拦拼错的档位名。
 * 连 :global(.rounded-lg.border) 这种在选择器里引用 class 的写法一起扫——
 * 那种引用一旦被改名就再也不匹配任何元素，是更难发现的一种静默失效。
 * 反例在本文件里也不许写成完整 class 字面量：tailwind 的 content 连 .ts 一起扫，
 * 扫到就当真实 class 生成进产物 CSS（写死一个任意值那回，产物里多了一条没人用的规则）。
 */
it("class 侧只剩档位名：内置档、任意值、拼错的名字一律不许", () => {
  const bad: string[] = [];
  for (const [file, src] of Object.entries(SOURCES)) {
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(/rounded(?:-[^\s"\x60;,)]*)?/g)) {
        const cls = m[0].split(".")[0];
        if (LEGACY.test(cls) || cls.startsWith("rounded-[")) {
          bad.push(file + ":" + (i + 1) + "  " + cls);
          continue;
        }
        const parts = cls.split("-");
        if (parts.length === 1) continue; // 裸 rounded 就是 theme.borderRadius.DEFAULT
        const key = parts[parts.length - 1];
        const side = parts.length === 3 ? parts[1] : parts.length === 2 ? "" : "?";
        if (parts.length > 3 || !KEYS.includes(key) || (side !== "" && !SIDES.includes(side)))
          bad.push(file + ":" + (i + 1) + "  不存在的圆角 class " + cls);
      }
    }
  }
  expect(bad, "非法圆角 class\n" + bad.join("\n")).toEqual([]);
});

it("档位 class 真的在用，不是摆着好看", () => {
  const all = Object.values(SOURCES).join("\n");
  for (const cls of ["rounded-ctl", "rounded-card", "rounded-panel", "rounded-full"]) {
    expect(all.split(cls).length - 1, cls).toBeGreaterThan(0);
  }
});

it("正圆和胶囊各有归属：token 定义了就得有人用", () => {
  const all = Object.values(SOURCES).join("\n");
  expect(all.split("var(--r-circle)").length - 1).toBeGreaterThan(10);
  expect(all.split("var(--r-pill)").length - 1).toBeGreaterThan(10);
});

it("缩略卡圆角走档位，窄卡照「收一档」比常规卡小一档", () => {
  const appCss = SOURCES[join("src", "app.css")];
  const compact = /\.media-card--compact\s*\{[^}]*--thumb-radius:\s*([^;]+);/.exec(appCss);
  if (!compact) throw new Error("窄卡那条 --thumb-radius 没了，「窄卡收一档」这条口径没人管了");
  const narrow = /--r-[\w-]+/.exec(compact[1]);
  if (!narrow) throw new Error("窄卡的 --thumb-radius 没走档位，现在是 " + compact[1].trim());
  const base = tokenValue("--thumb-radius");
  expect(base).toBe("10px");
  expect(tokenValue(narrow[0])).toBe("6px");
  expect(parseInt(tokenValue(narrow[0]), 10)).toBeLessThan(parseInt(base, 10));
});

it("ComfyUI 注入脚本是给别人的页面写的，不许引用本站 --r-* token", () => {
  for (const p of ["src-tauri/src/comfyui_panel.js", "src-tauri/src/comfyui_bridge.js"]) {
    const src = readFileSync(p, "utf8");
    expect(src, p + " 里出现了本站 token").not.toMatch(/var\(--r-/);
  }
});
