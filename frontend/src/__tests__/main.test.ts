import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// 回归测试：Svelte 5 不再支持 `new App({ target })`，必须用 mount() 才会建立 effect root。
// 这里直接读源文件校验，避免运行时需要 happy-dom + 真实构建产物。
const here = dirname(fileURLToPath(import.meta.url));
const mainPath = resolve(here, "..", "main.ts");
const raw = readFileSync(mainPath, "utf8");
// 去掉 // 和 /* */ 注释，避免注释里出现 "new App(...)" 误伤
const stripped = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\s+/g, " ");

describe("main.ts 入口", () => {
  it("必须使用 svelte 5 的 mount() API", () => {
    expect(stripped).toMatch(/import\s*\{\s*mount\s*\}\s*from\s*["']svelte["']/);
    expect(stripped).toMatch(/\bmount\(\s*App\s*,\s*\{\s*target/);
  });

  it("不允许使用 Svelte 4 的 `new App({ target })` 写法", () => {
    expect(stripped).not.toMatch(/new\s+App\s*\(/);
  });
});
