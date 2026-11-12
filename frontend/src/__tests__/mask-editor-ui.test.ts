import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import MaskEditor from "../components/MaskEditor.svelte";
import { MASK_TINTS } from "../lib/mask";

/**
 * 遮罩编辑器的顶栏（2026-11-12 照孤海那台编辑器重排，苏醒给的图2）。
 *
 * mask-editor.test.ts 那一堆只能读源文件，因为 happy-dom 不放画布；但**按钮渲染没渲染出来**
 * 这件事是能真测的——图2 要求的那几件工具、色板、说明行、右侧那一排，真挂载一次比 grep 源码可靠。
 * 画布相关的（ready 之后那几张 canvas）这里一概不碰，happy-dom 里没有 2d 上下文。
 */

const noop = () => {};
const props = {
  src: "/api/images/7/file", label: "图片1", modeText: "移除 · 提示词留空，把涂出来的地方去掉",
  promptSummary: "", hint: "", seed: "", imageId: 7, sourceWidth: 800,
  onCancel: noop, onDone: noop,
};

const btn = (name: string) => Array.from(document.querySelectorAll("button.me-btn"))
  .find((b) => (b.textContent ?? "").trim() === name) as HTMLButtonElement | undefined;

afterEach(() => {
  cleanup();
});

it("顶栏三件工具齐，选框是一件工具（图2 左侧那一排）", () => {
  render(MaskEditor, props as never);
  const names = ["画笔", "橡皮擦", "选框"];
  for (const n of names) expect(btn(n), "顶栏少了「" + n + "」").toBeTruthy();
  const bar = document.querySelector('[aria-label="工具"]');
  expect(bar?.querySelectorAll("button").length).toBe(3);
  // 默认在画笔上
  expect(btn("画笔")!.getAttribute("aria-pressed")).toBe("true");
  expect(btn("选框")!.getAttribute("aria-pressed")).toBe("false");
});

it("点选框就切过去，aria-pressed 跟着走（三件互斥，不是叠加开关）", async () => {
  render(MaskEditor, props as never);
  await fireEvent.click(btn("选框")!);
  expect(btn("选框")!.getAttribute("aria-pressed")).toBe("true");
  expect(btn("画笔")!.getAttribute("aria-pressed")).toBe("false");
  expect(btn("橡皮擦")!.getAttribute("aria-pressed")).toBe("false");
});

it("色板按图2 那几颗渲染，默认那颗按下；点灰只是换显示色", async () => {
  render(MaskEditor, props as never);
  const group = document.querySelector('[aria-label="遮罩显示色"]');
  expect(group).toBeTruthy();
  const swatches = Array.from(group!.querySelectorAll("button"));
  expect(swatches.length).toBe(MASK_TINTS.length);
  expect(swatches.length).toBeGreaterThanOrEqual(3);
  const on = swatches.filter((s) => s.getAttribute("aria-pressed") === "true");
  expect(on.length).toBe(1);
  expect(on[0].getAttribute("aria-label")).toContain(MASK_TINTS[0].label);
  const gray = swatches.find((s) => (s.getAttribute("aria-label") ?? "").includes("灰"));
  expect(gray).toBeTruthy();
  await fireEvent.click(gray!);
  expect(gray!.getAttribute("aria-pressed")).toBe("true");
  expect(swatches.filter((s) => s.getAttribute("aria-pressed") === "true").length).toBe(1);
  // 每颗的底色写在 style 上（不写进 CSS，避开 hex 棘轮），且带 rgb(
  for (const s of swatches) expect(s.getAttribute("style")).toContain("rgb(");
});

it("图2 中间那行说明文字在，四个键位一个都不能少", () => {
  render(MaskEditor, props as never);
  const legend = document.querySelector(".me-legend");
  expect(legend).toBeTruthy();
  const text = legend!.textContent ?? "";
  for (const s of ["Shift=1:1", "Alt=减选区", "框内拖动移动", "外部单击取消"]) {
    expect(text, "说明行少了「" + s + "」").toContain(s);
  }
});

it("右侧那一排齐：撤销 重做 反转 清空 | 取消 保存遮罩；什么都没涂时反转与清空是灰的", () => {
  render(MaskEditor, props as never);
  for (const n of ["撤销", "重做", "反转", "清空", "取消", "保存遮罩"]) {
    expect(btn(n), "顶栏少了「" + n + "」").toBeTruthy();
  }
  // painted 初值 0 → emptyMask：反转把空遮罩反相等于整图都要改，不给点
  expect(btn("反转")!.disabled).toBe(true);
  expect(btn("清空")!.disabled).toBe(true);
  expect(btn("重做")!.disabled).toBe(true);
  expect(btn("保存遮罩")!.className).toContain("me-btn-go");
});

it("还没涂时顶栏第二行说「还没涂」，而不是报个 0", () => {
  render(MaskEditor, props as never);
  const count = document.querySelector(".me-count");
  expect(count?.textContent).toBe("还没涂");
  expect(count?.className).toContain("is-none");
});
