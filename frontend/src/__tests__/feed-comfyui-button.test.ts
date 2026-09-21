import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/svelte";
import { get } from "svelte/store";
import { comfyuiStatus, multiSelectedIds, selectedId } from "../lib/stores";
import type { ImageSummary } from "../lib/types";

// 拿到 Feed 组件内部的 thumb 渲染需要它的子组件（ContextMenu、FolderPickerModal）。
// 这里我们直接构造最小化 thumb 标记的镜像组件来验证可见性逻辑，避免挂上整棵 Feed。
// 真实 Feed.svelte 中的核心条件：{#if $comfyuiStatus.running && it.has_workflow && (hoveredId === it.id || $selectedIdStore === it.id || $multiSelectedIds.has(it.id))}
// 在测试里我们用 stores 模拟这条表达式。

function isComfyuiButtonVisible(image: ImageSummary): boolean {
  if (!get(comfyuiStatus).running) return false;
  if (!image.has_workflow) return false;
  const sel = get(selectedId);
  const multi = get(multiSelectedIds);
  return sel === image.id || multi.has(image.id);
}

function makeImage(overrides: Partial<ImageSummary> = {}): ImageSummary {
  return {
    id: 1,
    filename: "a.png",
    path: "D:/a.png",
    original_url: null,
    kind: "image",
    thumbnail_url: null,
    play_url: null,
    playable: null,
    duration_seconds: null,
    video_codec: null,
    audio_codec: null,
    fps: null,
    width: 1024,
    height: 1024,
    mtime: 0,
    size_bytes: 0,
    favorite: false,
    folder_ids: [],
    tags: [],
    model: null,
    seed: 1,
    new: false,
    has_workflow: true,
    ...overrides,
  } as ImageSummary;
}

describe("Feed 缩略图 ComfyUI 按钮可见性", () => {
  beforeEach(() => {
    comfyuiStatus.set({ running: false, url: "http://127.0.0.1:8188", enabled: true, checked_at: 0 });
    multiSelectedIds.set(new Set());
    selectedId.set(null);
  });

  it("ComfyUI 离线 → 永远不显示按钮", () => {
    comfyuiStatus.update((s) => ({ ...s, running: false }));
    selectedId.set(1);
    expect(isComfyuiButtonVisible(makeImage({ id: 1 }))).toBe(false);
  });

  it("ComfyUI 在线 + 图片无 workflow → 不显示按钮", () => {
    comfyuiStatus.update((s) => ({ ...s, running: true }));
    selectedId.set(1);
    expect(isComfyuiButtonVisible(makeImage({ id: 1, has_workflow: false }))).toBe(false);
  });

  it("ComfyUI 在线 + 有 workflow + 已选中 → 显示按钮", () => {
    comfyuiStatus.update((s) => ({ ...s, running: true }));
    selectedId.set(1);
    expect(isComfyuiButtonVisible(makeImage({ id: 1 }))).toBe(true);
  });

  it("ComfyUI 在线 + 有 workflow + 多选中 → 显示按钮", () => {
    comfyuiStatus.update((s) => ({ ...s, running: true }));
    multiSelectedIds.set(new Set([1]));
    expect(isComfyuiButtonVisible(makeImage({ id: 1 }))).toBe(true);
  });

  it("ComfyUI 在线 + 有 workflow + 未选中 → 不显示按钮", () => {
    comfyuiStatus.update((s) => ({ ...s, running: true }));
    expect(isComfyuiButtonVisible(makeImage({ id: 1 }))).toBe(false);
  });

  it("不同 id 不互相影响：选 2 时按钮只在 2 上", () => {
    comfyuiStatus.update((s) => ({ ...s, running: true }));
    selectedId.set(2);
    expect(isComfyuiButtonVisible(makeImage({ id: 1 }))).toBe(false);
    expect(isComfyuiButtonVisible(makeImage({ id: 2 }))).toBe(true);
  });
});
it("ComfyUI 打开按钮：去掉外圈圆框，只保留实色背景 + 圆角矩形", () => {
  // 设计锁：用户明确要求"不要外面这个圆框"。
  // 因此 .comfyui-open-btn 不再使用 rounded-full，也不带 border / border-accent*。
  const fs = require("node:fs");
  const path = require("node:path");
  const p = path.resolve(__dirname, "..", "components", "Feed.svelte");
  const src = fs.readFileSync(p, "utf8");
  const idx = src.indexOf('class="comfyui-open-btn');
  expect(idx, "Feed.svelte 应包含 comfyui-open-btn class").toBeGreaterThanOrEqual(0);
  const start = idx + 'class="'.length;
  const endQuote = src.indexOf('"', start);
  const cls = src.slice(idx, endQuote);
  expect(cls, "comfyui-open-btn 不应再使用 rounded-full").not.toMatch(/rounded-full/);
  expect(cls, "comfyui-open-btn 不应再带 border 描边").not.toMatch(/border/);
  expect(cls).toMatch(/w-7 h-7/);
  expect(cls).toMatch(/flex items-center justify-center/);
});






