import { get } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import GallerySearch from "../components/GallerySearch.svelte";
import { query } from "../lib/stores";

/**
 * 工具栏搜索框（0.2.22 第三轮验收）：
 *  - 全圆角 pill；
 *  - 拿到焦点（点进去）placeholder 立刻消失，失焦再回来；
 *  - 隐字不能顺手吃掉外部 onfocus（文本工作区靠它展开列表）和输入本身。
 * 居中是布局层的规矩，jsdom 量不出来，钉在 toolbar-responsive-layout.test.ts 的 CSS 契约里。
 */
describe("搜索框：全圆角 + 聚焦即隐去 placeholder", () => {
  afterEach(cleanup);

  it("输入框是全圆角 pill", () => {
    const { container } = render(GallerySearch, { label: "搜索图片" });
    const input = container.querySelector("input")!;
    expect(input.className).toContain("rounded-full");
    expect(input.className).not.toMatch(/rounded-(sm|md|lg|xl)\b/);
  });

  it("placeholder 默认在、点进去消失、失焦回来", async () => {
    const { container } = render(GallerySearch, { label: "搜索图片", placeholder: "搜索 prompt、文件名、标签…" });
    const input = container.querySelector<HTMLInputElement>("input")!;
    expect(input.placeholder).toBe("搜索 prompt、文件名、标签…");
    // 真实浏览器里 mousedown 会让输入框拿到焦点并派发 focus；jsdom 不做命中测试，直接派发 focus
    await fireEvent.focus(input);
    expect(input.placeholder).toBe("");
    await fireEvent.blur(input);
    expect(input.placeholder).toBe("搜索 prompt、文件名、标签…");
  });

  it("隐字不吞掉外部 onfocus，也不影响输入", async () => {
    const onsearch = vi.fn();
    const onfocus = vi.fn();
    const { container } = render(GallerySearch, { value: "", onsearch, onfocus, label: "搜索文本", placeholder: "搜索标题、正文和标签…" });
    const input = container.querySelector<HTMLInputElement>("input")!;
    await fireEvent.focus(input);
    expect(onfocus).toHaveBeenCalledTimes(1);
    expect(input.placeholder).toBe("");
    await fireEvent.input(input, { target: { value: "猫" } });
    expect(onsearch).toHaveBeenCalledWith("猫");
  });

  it("未传 value 时仍绑全局 query（图库搜索照旧生效）", async () => {
    query.set("");
    const { container } = render(GallerySearch, { label: "搜索图片" });
    const input = container.querySelector<HTMLInputElement>("input")!;
    await fireEvent.input(input, { target: { value: "夜景" } });
    expect(get(query)).toBe("夜景");
    query.set("");
  });
});
