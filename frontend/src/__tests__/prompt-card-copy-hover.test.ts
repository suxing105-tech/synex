import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// 回归：PromptCard 的「复制」按钮 hover 效果必须是底色变化，不能再
// 用 hover:border-* 高亮边框。用户反馈边框高亮在视觉上太突兀。
const here = dirname(fileURLToPath(import.meta.url));
const cardPath = resolve(here, "..", "components", "PromptCard.svelte");
const raw = readFileSync(cardPath, "utf8");

// 找到「复制」按钮所在的 <button ... class="..."> 行
const copyBtnRe = /<button[^>]*\bclass="([^"]*)"[^>]*\bonclick=\{copy\}/m;
const match = raw.match(copyBtnRe);
expect(match, "PromptCard 必须能找到带 onclick={copy} 的复制按钮").toBeTruthy();
const classAttr = match![1];

describe("PromptCard 复制按钮 hover 行为", () => {
  it("hover 时底色变化（hover:bg-*）", () => {
    expect(/hover:bg-/.test(classAttr), `复制按钮应使用 hover:bg-* 改变底色，实际类：${classAttr}`).toBe(true);
  });

  it("hover 不再高亮边框（不应出现 hover:border-*）", () => {
    expect(/hover:border-/.test(classAttr), `复制按钮不应使用 hover:border-* 高亮边框，实际类：${classAttr}`).toBe(false);
  });

  it("disabled 时不响应 hover（避免 ghost 高亮）", () => {
    expect(/disabled:hover:bg-transparent/.test(classAttr), `disabled 状态下 hover 应透明，实际类：${classAttr}`).toBe(true);
  });
});
