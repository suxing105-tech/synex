import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const detail = readFileSync(resolve(root, "components", "DetailPanel.svelte"), "utf8");
const feed = readFileSync(resolve(root, "components", "Feed.svelte"), "utf8");

describe("详情栏再次创作入口", () => {
  it("详情栏不再提供再次创作快捷入口，图库卡片入口保留", () => {
    expect(detail).not.toContain('new CustomEvent("open-clone"');
    expect(feed).toContain("openClone(item)");
  });
});
