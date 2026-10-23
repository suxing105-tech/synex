import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// 视频也能在 ComfyUI 里打开工作流，设置页若只提图片会让人以为视频不支持。
const source = () => readFileSync("src/components/SettingsModal.svelte", "utf8");

it("ComfyUI 设置说明同时提到图片和视频", () => {
  const text = source();
  expect(text).toContain("从图库打开图片或视频中的工作流");
  expect(text).toContain("带有工作流的图片或视频会显示打开按钮");
  expect(text).not.toContain("带有工作流的图片会显示打开按钮");
});
