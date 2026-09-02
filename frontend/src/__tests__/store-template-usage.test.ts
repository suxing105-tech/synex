import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";

// 守护：Svelte 模板里 `{#if storeName.xxx}` 或 `{storeName.xxx}` 时，
// 必须带 $ 前缀。否则裸 writable store 没有 .has / .length 等方法，
// 会运行时炸 xxx is not a function，把整块 {#each} 渲染拉黑。
//
// 历史 bug：Feed.svelte `{#if newIds.has(it.id)}` 缺 $ 前缀 → 图片全空。

const here = dirname(fileURLToPath(import.meta.url));
const componentsDir = resolve(here, "..", "components");

function listSvelte(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...listSvelte(p));
    else if (name.endsWith(".svelte")) out.push(p);
  }
  return out;
}

// stores.ts 导出的 writable store
const STORE_NAMES = [
  "selectedDetail", "selectedId", "folderId", "view", "query", "targetColumns",
  "feedItems", "feedTotal", "feedLoading", "folders", "stats", "scanProgress",
  "newIds", "multiSelectedIds", "selectionAnchorId",
];

// 只盯 store 没有的方法（set/update/subscribe 合法）。
// 常见误用：newIds.has / feedItems.length / feedItems.find / stats.total_images 等
const BAD_METHOD = /\.(?:has|size|length|find|findIndex|filter|map|forEach|some|every|includes|indexOf)/;

// 匹配裸 store 调用 storeName.method（前面不是 $）
const PATTERN = new RegExp(
  String.raw`(?<!\$)` + `(?:${STORE_NAMES.join("|")})` + BAD_METHOD.source,
);

function templateOf(src: string): string {
  const idx = src.indexOf("</script>");
  return idx >= 0 ? src.slice(idx) : "";
}

describe("Svelte 模板 store 使用规范", () => {
  for (const file of listSvelte(componentsDir)) {
    it(`${file.split(/[\\/]/).pop()} 模板里 store.xxx（缺 $）属 bug`, () => {
      const src = readFileSync(file, "utf8");
      const template = templateOf(src);
      // 去掉字符串字面量避免误伤
      const sanitized = template
        .replace(/`(?:\\.|[^`\\])*`/g, '""')
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/'(?:\\.|[^'\\])*'/g, "''");
      const m = sanitized.match(PATTERN);
      expect(m, `模板里裸 store 方法调用: ${m?.[0]}`).toBeNull();
    });
  }
});
