import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// 回归测试：App.svelte 模板引用了若干 narrowMode / detailWidth /
// drawerOpen / startDetailDrag / checkNarrow，这些必须在 <script> 里
// 用 $state / function 声明。Svelte 5 模板里的未声明标识符在 mount 时会
// 抛 ReferenceError，导致 #app 永远是空 div（页面黑屏）。
//
// 此前的 PR4（窄屏底部抽屉）只改了模板，缺漏了 script 里的声明；
// 当时没被 vitest 抓到。本测试用静态扫描锁住这些名字必须在 <script> 里。

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "..", "App.svelte");
const raw = readFileSync(appPath, "utf8");

function extractBlock(source: string, openTag: string, closeTag: string): string {
  const start = source.indexOf(openTag);
  if (start < 0) throw new Error("App.svelte missing " + openTag);
  const end = source.indexOf(closeTag, start);
  if (end < 0) throw new Error("App.svelte missing " + closeTag);
  return source.slice(start + openTag.length, end);
}

const scriptSrc = extractBlock(raw, "<script", "</script>");
const beforeScript = raw.slice(0, raw.indexOf("<script"));
const afterScript = raw.slice(raw.indexOf("</script>") + "</script>".length);
const templateSrc = beforeScript + afterScript;

const requiredNames = [
  "narrowMode",
  "detailWidth",
  "drawerOpen",
  "startDetailDrag",
  "checkNarrow",
] as const;

describe("App.svelte 模板依赖的 script 声明", () => {
  for (const name of requiredNames) {
    it(name + " 必须在 <script> 里声明", () => {
      // 形如 "let NAME = $state(...)" / "const NAME = ..." / "function NAME("
      const declRe = new RegExp("\\b(?:let|const|var|function)\\s+" + name + "\\b");
      const declared = declRe.test(scriptSrc);
      expect(
        declared,
        "App.svelte <script> 缺 " + name + " 声明；模板用到它但 Svelte 5 mount 时会抛 ReferenceError，导致 #app 空（黑屏）"
      ).toBe(true);
      // 反向确认整个文件里确实用到了 name：避免把测试写成永远 true。
      // checkNarrow 仅在 onMount 内调用（不在 template HTML），所以查整文件。
      const usedInTemplate = raw.includes(name);
      expect(
        usedInTemplate,
        "模板必须真的引用 " + name + "，否则该测试形同虚设"
      ).toBe(true);
    });
  }

  it("DETAIL_MIN / DETAIL_MAX 常量也存在（拖拽列宽限位）", () => {
    expect(/\bconst\s+DETAIL_MIN\b/.test(scriptSrc)).toBe(true);
    expect(/\bconst\s+DETAIL_MAX\b/.test(scriptSrc)).toBe(true);
  });
});
