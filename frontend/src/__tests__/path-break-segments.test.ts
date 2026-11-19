import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pathBreakSegments } from "../lib/path-segments";

/**
 * 详情栏「路径」按分隔符优先断行（2026-11-13 oil-ui 评审第三刀 T11）。
 *
 * 动手前那两处挂 break-all，浏览器逐字符断，末行经常只剩一个 t（.txt 被劈开）。
 * 现在切成段、段间放 <wbr>，断行优先落在 \ 或 / 之后。
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");

describe("pathBreakSegments（第三刀 T11）", () => {
  const win = "D:\\ComfyUI\\output\\2026-11-09\\角色定妆.SRT";

  it("拼回去与原串逐字符相等，分隔符一个都不许丢", () => {
    for (const p of [win, "C:\\a\\b", "/var/tmp/notes.md", "README.md", "无分隔符"]) {
      expect(pathBreakSegments(p).join("")).toBe(p);
    }
  });

  it("除最后一段，每段都以分隔符结尾 —— 断点因此只可能落在分隔符之后", () => {
    const segs = pathBreakSegments(win);
    expect(segs.length).toBeGreaterThan(1);
    segs.slice(0, -1).forEach((s) => expect(s).toMatch(/[\\/]$/));
    expect(segs[segs.length - 1]).toBe("角色定妆.SRT");
  });

  it("正斜杠同样切段；没有分隔符时保持一整段", () => {
    expect(pathBreakSegments("/var/tmp/notes.md").length).toBe(4);
    expect(pathBreakSegments("notes.md")).toEqual(["notes.md"]);
  });

  it("空值返回空数组，渲染出空元素而不是 undefined 字样", () => {
    expect(pathBreakSegments("")).toEqual([]);
    expect(pathBreakSegments(null)).toEqual([]);
    expect(pathBreakSegments(undefined)).toEqual([]);
  });

  it("详情栏的路径走段渲染，break-all 撤掉", () => {
    const src = readFileSync(join(srcRoot, "components/TextDetailPanel.svelte"), "utf8");
    expect(src).toContain('import { pathBreakSegments } from "../lib/path-segments";');
    expect(src, "路径还在逐字符断行").not.toMatch(/break-all/);
    // 2026-11-18 撤掉「确认移入回收站」那块时，里面那份路径渲染跟着退；正文这一份还在。
    expect(src.match(/<wbr \/>/g) ?? []).toHaveLength(1);
    expect(src).toContain("{@const pathSegs = pathBreakSegments(it?.path)}");
  });
});