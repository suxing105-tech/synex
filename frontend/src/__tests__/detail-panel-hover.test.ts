import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// 回归：详情面板（DetailPanel.svelte + MetadataCard.svelte）中所有交互按钮 / chip
// 的 hover 效果必须改为底色变化（hover:bg-*），不能再用 hover:border-accent
// 高亮边框。用户反馈边框高亮在视觉上太突兀，参考 PromptCard 复制按钮
// （commit 834e0e1）已统一改为 hover:bg-surface-3。

const here = dirname(fileURLToPath(import.meta.url));
const detailPanelPath = resolve(here, "..", "components", "DetailPanel.svelte");
const metadataCardPath = resolve(here, "..", "components", "MetadataCard.svelte");
const detailPanelRaw = readFileSync(detailPanelPath, "utf8");
const metadataCardRaw = readFileSync(metadataCardPath, "utf8");

// 通过「位于按钮内部」的唯一标识符定位按钮起始标签 \<button\，再从
// 该起始位置起 300 字符内抓取第一个 class="..."。这种方式可以跨多行 +
// onclick 中的 \=>\ （不能简单用 [^>]*），并能锁定到具体按钮。

function findOpenTagClass(raw: string, anchor: RegExp, openTag: "<button" | "<span"): string | null {
  const m = raw.match(anchor);
  if (!m) return null;
  const idx = m.index ?? -1;
  if (idx < 0) return null;
  const start = raw.lastIndexOf(openTag, idx);
  if (start < 0) return null;
  const after = raw.substring(start, idx + 300);
  const classMatch = after.match(/\bclass="([^"]*?)"/);
  return classMatch ? classMatch[1] : null;
}

const detailPanelTargets: Array<{ name: string; anchor: RegExp }> = [
  { name: "Header 缩略图按钮", anchor: /title="查看大图"/ },
  { name: "收藏按钮", anchor: /aria-pressed=\{d\.favorite\}/ },
  { name: "ComfyUI 打开按钮", anchor: /title="在 ComfyUI 中打开"/ },
  { name: "更多菜单按钮", anchor: /aria-haspopup="menu"/ },
  { name: "Workflow 复制按钮", anchor: /copy\(d\.workflow, "Workflow JSON"\)/ },
  { name: "Workflow 格式化并复制按钮", anchor: /JSON\.stringify/ },
  { name: "Workflow 下载按钮", anchor: /Blob\(\[d\.workflow\]/ },
];

const metadataCardTarget: { name: string; anchor: RegExp } = {
  name: "标签 chip",
  anchor: /onclick=\{\(\) => onTagClick/,
};

describe("详情面板 hover 行为（参考 PromptCard 834e0e1）", () => {
  describe("DetailPanel.svelte 全局回归", () => {
    it("文件中不应再出现 hover:border-accent（已统一改为底色变化）", () => {
      const matches = detailPanelRaw.match(/hover:border-accent/g) || [];
      expect(
        matches.length,
        "DetailPanel.svelte 还残留 " + matches.length + " 处 hover:border-accent",
      ).toBe(0);
    });
  });

  describe("DetailPanel.svelte 各按钮 hover 行为", () => {
    for (const { name, anchor } of detailPanelTargets) {
      it(name + "：hover 时底色变化（hover:bg-*）", () => {
        const classAttr = findOpenTagClass(detailPanelRaw, anchor, "<button");
        expect(classAttr, name + " 必须能在 DetailPanel.svelte 中匹配到").toBeTruthy();
        expect(
          /hover:bg-/.test(classAttr!),
          name + " 应使用 hover:bg-* 改变底色，实际类：" + classAttr,
        ).toBe(true);
      });

      it(name + "：hover 不再高亮边框（不应出现 hover:border-*）", () => {
        const classAttr = findOpenTagClass(detailPanelRaw, anchor, "<button");
        expect(classAttr, name + " 必须能在 DetailPanel.svelte 中匹配到").toBeTruthy();
        expect(
          /hover:border-/.test(classAttr!),
          name + " 不应使用 hover:border-* 高亮边框，实际类：" + classAttr,
        ).toBe(false);
      });
    }
  });

  describe("MetadataCard.svelte 标签 chip hover 行为", () => {
    it("文件中不应再出现 hover:border-accent", () => {
      const matches = metadataCardRaw.match(/hover:border-accent/g) || [];
      expect(
        matches.length,
        "MetadataCard.svelte 还残留 " + matches.length + " 处 hover:border-accent",
      ).toBe(0);
    });

    it(metadataCardTarget.name + "：hover 时底色变化（hover:bg-*）", () => {
      const classAttr = findOpenTagClass(metadataCardRaw, metadataCardTarget.anchor, "<span");
      expect(classAttr, metadataCardTarget.name + " 必须能在 MetadataCard.svelte 中匹配到").toBeTruthy();
      expect(
        /hover:bg-/.test(classAttr!),
        metadataCardTarget.name + " 应使用 hover:bg-* 改变底色，实际类：" + classAttr,
      ).toBe(true);
    });

    it(metadataCardTarget.name + "：hover 不再高亮边框（不应出现 hover:border-*）", () => {
      const classAttr = findOpenTagClass(metadataCardRaw, metadataCardTarget.anchor, "<span");
      expect(classAttr, metadataCardTarget.name + " 必须能在 MetadataCard.svelte 中匹配到").toBeTruthy();
      expect(
        /hover:border-/.test(classAttr!),
        metadataCardTarget.name + " 不应使用 hover:border-* 高亮边框，实际类：" + classAttr,
      ).toBe(false);
    });
  });
});