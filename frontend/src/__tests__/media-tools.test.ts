import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describeMediaTools, describeTool } from "../lib/media-tools";
import type { MediaToolsStatus } from "../lib/types";

// 回归（0.2.22 线上反馈）：把安装包发给别人，那台机器没有 ffmpeg，
// 视频海报与容器里的 ComfyUI 提示词全部静默变空，视频却能播。
// 现在安装包自带 ffmpeg/ffprobe，后端 /api/health 报来源与版本，
// 设置页「关于与更新」常驻一条状态。这里锁翻译口径与设置页接线。

const here = dirname(fileURLToPath(import.meta.url));
const settingsRaw = readFileSync(resolve(here, "..", "components", "SettingsModal.svelte"), "utf8");

interface ToolPatch {
  path?: string | null;
  source?: string | null;
  version?: string | null;
}

function statusOf(
  ffmpegPatch: ToolPatch = {},
  ffprobePatch: ToolPatch = {},
  meta: { available: boolean; missing: string[] } = { available: true, missing: [] },
): MediaToolsStatus {
  const base = { path: "C:/app/tool.exe", source: "exe-dir", version: "8.1.1" };
  const ffmpeg = { ...base, ...ffmpegPatch };
  const ffprobe = { ...base, ...ffprobePatch };
  return {
    available: meta.available,
    missing: meta.missing,
    tools: { ffmpeg, ffprobe },
    versions: { ffmpeg: ffmpeg.version, ffprobe: ffprobe.version },
  };
}

describe("describeTool", () => {
  it("未找到时只说未找到，不暴露空路径", () => {
    expect(describeTool(undefined)).toBe("未找到");
    expect(describeTool({ path: null, source: null, version: null })).toBe("未找到");
  });

  it("来源标签翻成人话：安装包内置 / 系统 PATH / 数据目录", () => {
    expect(describeTool({ path: "/x/ffmpeg.exe", source: "exe-dir", version: "8.1.1" })).toBe("8.1.1（安装包内置）");
    expect(describeTool({ path: "/x/ffmpeg.exe", source: "path", version: "6.0" })).toBe("6.0（系统 PATH）");
    expect(describeTool({ path: "/x/ffmpeg.exe", source: "data-tools", version: null })).toBe("版本未知（数据目录 tools）");
    expect(describeTool({ path: "/x/ffmpeg.exe", source: "mystery", version: "1" })).toBe("1（本机）");
  });
});

describe("describeMediaTools", () => {
  it("还没拿到状态时不算失败，也不给修复提示", () => {
    expect(describeMediaTools(null)).toEqual({ ok: false, text: "正在检查媒体组件…", hint: "" });
  });

  it("两件工具都在时报版本和出处", () => {
    const s = describeMediaTools(statusOf());
    expect(s.ok).toBe(true);
    expect(s.text).toBe("ffmpeg 8.1.1（安装包内置） · ffprobe 8.1.1（安装包内置）");
    expect(s.hint).toBe("");
  });

  it("缺工具时点名缺哪个，并给出可执行的下一步", () => {
    const s = describeMediaTools(
      statusOf({}, { path: null, source: null, version: null }, { available: false, missing: ["ffprobe"] }),
    );
    expect(s.ok).toBe(false);
    expect(s.text).toBe("缺少 ffprobe");
    expect(s.hint).toContain("tools");
    expect(s.hint).toContain("安装包");
  });

  it("后端没带 media_tools 字段时按未找到处理，而不是崩", () => {
    const s = describeMediaTools({ available: false, missing: [], tools: undefined as never, versions: {} as never });
    expect(s.ok).toBe(false);
    expect(s.text).toBe("缺少 媒体工具");
  });
});

describe("设置页接线", () => {
  it("关于与更新里有常驻的媒体组件状态与重新检测入口", () => {
    expect(settingsRaw).toContain("媒体组件");
    expect(settingsRaw).toContain("refreshMediaTools");
    expect(settingsRaw).toContain('<button class="setting-button" disabled={mediaProbing}');
    expect(settingsRaw).toContain('role="status"');
    expect(settingsRaw).toContain("describeMediaTools");
  });

  it("状态取自 /api/health，且打开设置就刷新", () => {
    expect(settingsRaw).toContain("healthApi.get()");
    expect(settingsRaw).toMatch(/\$effect\(\(\) => \{ if \(open\) void refreshMediaTools\(\); \}\)/);
  });

  it("healthApi 打的是 /api/health", () => {
    const apiRaw = readFileSync(resolve(here, "..", "lib", "api.ts"), "utf8");
    expect(apiRaw).toContain('http<HealthPayload>("/api/health")');
  });
});
