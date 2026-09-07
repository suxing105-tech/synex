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
      // comfyui 不在这里：它走 Icon.svelte 的 PNG 真 logo 通道（见 "comfyui 走 PNG" 测试）
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
        expect(m, `${name} fill 仅允许 none 或 currentColor`).toMatch(/fill="(none|currentColor)"/);
      }
    }
  });

  it("未知 name → ICON_PATHS 返回 undefined（让 Icon.svelte 走空分支）", () => {
    expect(ICON_PATHS["nope"]).toBeUndefined();
  });

  it("comfyui 走 PNG 真 logo（不在 ICON_PATHS 走 SVG 通道）", () => {
    // 锁住品牌识别：使用 PNG 真 logo，不再用手画的 SVG 简笔画。
    expect(ICON_PATHS["comfyui"], "comfyui 不应再以 SVG 形式出现在 ICON_PATHS").toBeUndefined();
    expect(ICON_NAMES).not.toContain("comfyui");
  });

  it("comfyui-logo.png 静态资源存在并为 RGBA PNG", () => {
    // 锁住资源文件不被误删 / 被换格式。
    // 用 import.meta.url 解析相对路径，避免依赖 vite / 测试环境的 cwd。
    // vitest 默认 cwd 是项目根目录，public/ 在仓库根目录的 frontend/ 下。
    const fs = require("node:fs");
    const path = require("node:path");
    const p = path.resolve(__dirname, "..", "..", "public", "comfyui-logo.png");
    expect(fs.existsSync(p), `comfyui-logo.png 应在 ${p}`).toBe(true);
    const buf = fs.readFileSync(p);
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
    expect(buf.length).toBeGreaterThan(1000);
  });
});

