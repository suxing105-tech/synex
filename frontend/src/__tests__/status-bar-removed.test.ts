import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/**
 * 底部状态栏整条撤了（2026-11-11 苏醒：页面保持相对简洁，那 28px 还给瀑布流）。
 * 钉两件事：一是别哪天又冒回来；二是撤一条栏不等于把它承载的信息一起撤——
 * ffmpeg 和 ComfyUI 在设置页各有常驻位置，库内条数一直在侧栏的计数区。
 */
const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(here, "..", rel), "utf8");

it("StatusBar 的组件文件和它在 App 里的挂载一起没了", () => {
  expect(existsSync(resolve(here, "..", "components", "StatusBar.svelte"))).toBe(false);
  const app = src("App.svelte");
  expect(app).not.toContain("StatusBar");
  expect(app).not.toContain("status-bar");
});

it("ffmpeg 状态退回设置页常驻（AGENTS §7.2：缺了不报错，只会让人以为程序坏了）", () => {
  const settings = src("components/SettingsModal.svelte");
  expect(settings).toContain("媒体组件");
  expect(settings).toContain("describeMediaTools");
  expect(settings).toContain("healthApi.get()");
});

it("ComfyUI 连接状态退回设置页，再次创作弹窗另有断连提示", () => {
  expect(src("components/SettingsModal.svelte")).toContain("已连接 ComfyUI");
  expect(src("components/CloneModal.svelte")).toContain("连不上 ComfyUI");
});
