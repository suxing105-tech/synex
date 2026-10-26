/**
 * 把 /api/health 里的媒体工具状态翻译成人话。
 *
 * 单独一个纯函数模块的原因：设置页要显示、以后排障入口也要显示，口径必须一致；
 * 纯函数才好单测（不用挂载组件、不用发请求）。
 */
import type { MediaToolInfo, MediaToolsStatus } from "./types";

/** 后端 media_tools.py 里的来源标签 → 用户能看懂的出处。 */
const SOURCE_LABELS: Record<string, string> = {
  env: "手动指定目录",
  "exe-dir": "安装包内置",
  bundle: "安装包内置",
  "data-tools": "数据目录 tools",
  vendor: "开发环境",
  path: "系统 PATH",
};

export interface MediaToolsSummary {
  ok: boolean;
  /** 一行状态，直接进 UI */
  text: string;
  /** 缺工具时的下一步；正常时是空串 */
  hint: string;
}

const MISSING_HINT =
  "视频封面、音频波形和视频容器里的 ComfyUI 提示词都会生成不出来。" +
  "把 ffmpeg.exe 与 ffprobe.exe 放进数据目录的 tools 文件夹，或重装自带 ffmpeg 的安装包。";

export function describeTool(tool: MediaToolInfo | undefined): string {
  if (!tool || !tool.path) return "未找到";
  const source = (tool.source && SOURCE_LABELS[tool.source]) || "本机";
  return `${tool.version || "版本未知"}（${source}）`;
}

export function describeMediaTools(status: MediaToolsStatus | null): MediaToolsSummary {
  if (!status) return { ok: false, text: "正在检查媒体组件…", hint: "" };
  const missing = status.missing ?? [];
  if (status.available && missing.length === 0) {
    return {
      ok: true,
      text: `ffmpeg ${describeTool(status.tools?.ffmpeg)} · ffprobe ${describeTool(status.tools?.ffprobe)}`,
      hint: "",
    };
  }
  return {
    ok: false,
    text: `缺少 ${missing.length ? missing.join(" / ") : "媒体工具"}`,
    hint: MISSING_HINT,
  };
}
