import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 把 app.css 的 :root 变量解回真实色值。
 *
 * 2026-11-06 起全站颜色的唯一来源是 app.css 顶部那批 token，所以老断言从
 * :root 里读到的是 var(--ink-2) 这种名字，不再是 hex。直接放宽成 toBeTruthy
 * 等于把「这个颜色必须是这个值」这条约束扔了；这里把 var() 解一层，
 * 断言继续管真值，源码继续保持唯一来源。
 */

const here = dirname(fileURLToPath(import.meta.url));
const appCss = readFileSync(join(here, "..", "..", "app.css"), "utf8");

const rootVars = new Map<string, string>();
for (const block of appCss.matchAll(/:root\s*\{([\s\S]*?)\}/g)) {
  for (const m of block[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    rootVars.set(m[1], m[2].trim());
  }
}

export function resolveCssVar(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let out = value;
  for (let i = 0; i < 10 && out.includes("var(--"); i++) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_all, name: string) => {
      const hit = rootVars.get(name);
      if (hit === undefined) throw new Error("app.css 的 :root 里找不到 " + name);
      return hit;
    });
  }
  if (out.includes("var(--")) throw new Error("变量嵌套超过 10 层，八成是自我引用了：" + value);
  return out.trim();
}

export function tokenValue(name: string): string {
  if (!rootVars.has(name)) throw new Error("app.css 的 :root 里找不到 " + name);
  return resolveCssVar(rootVars.get(name)) as string;
}
