import { describe, it, expect } from "vitest";
import { ICON_PATHS, ICON_NAMES } from "../lib/icons";

describe("lib/icons 数据契约", () => {
  it("ICON_NAMES 与 ICON_PATHS 的键完全一致", () => {
    expect(ICON_NAMES.sort()).toEqual(Object.keys(ICON_PATHS).sort());
  });

  it("包含所有当前用到的图标", () => {
    // 这里锁住项目里实际在用的图标集合，避免被无意中删掉
    const required = [
      "image",
      "star",
      "clock",
      "folder",
      "plus",
      "more-vertical",
      "arrow-left",
      "comfyui",
    ];
    for (const n of required) {
      expect(ICON_PATHS[n], `缺少 ${n}`).toBeDefined();
      expect(ICON_PATHS[n].length, `${n} 的 inner SVG 不应为空`).toBeGreaterThan(0);
    }
  });

  it("inner SVG 不包含 <svg> 包裹（约定由 Icon.svelte 提供）", () => {
    for (const [name, p] of Object.entries(ICON_PATHS)) {
      expect(p.toLowerCase().includes("<svg"), `${name} 不应自带 <svg>`).toBe(false);
    }
  });

  it("inner SVG 只用 stroke 风格元素（rect/circle/path/line/polyline/polygon）", () => {
    // 简化校验：不允许出现 fill="..." 非 none 的硬编码
    for (const [name, p] of Object.entries(ICON_PATHS)) {
      const fillMatch = p.match(/fill="([^"]+)"/g) ?? [];
      for (const m of fillMatch) {
        expect(m, `${name} 不应硬编码 fill 非 none`).toMatch(/fill="none"/);
      }
    }
  });

  it("未知 name → ICON_PATHS 返回 undefined（让 Icon.svelte 走空分支）", () => {
    expect(ICON_PATHS["nope"]).toBeUndefined();
  });

  it("comfyui 图标：3 个圆 + 2 条线，Y 形 workflow 拓扑，无外框", () => {
    // 锁住“极简节点图”设计，避免又被改回六边形 / 多边形。
    const p = ICON_PATHS["comfyui"];
    const circles = (p.match(/<circle /g) ?? []).length;
    const lines = (p.match(/<line /g) ?? []).length;
    expect(circles, "comfyui 图标应有 3 个节点").toBe(3);
    expect(lines, "comfyui 图标应有 2 条连线（Y 形）").toBe(2);
    expect(p.includes("<polygon"), "comfyui 图标不应再含 polygon 外框").toBe(false);
    expect(p.includes("<path"), "comfyui 图标不应含 <path>").toBe(false);
  });
});
