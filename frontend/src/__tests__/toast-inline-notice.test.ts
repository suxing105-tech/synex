import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { get } from "svelte/store";
import Toast from "../components/Toast.svelte";
import { clearToasts, pauseToast, pushToast, resumeToast, toasts } from "../lib/toast";
import { ICON_PATHS } from "../lib/icons";

/** happy-dom 会把自闭合标签补成 <rect ...></rect>，归一化后才能和 ICON_PATHS 原文比对 */
function innerSvg(el?: Element | null): string {
  return (el?.innerHTML ?? "").replace(/<([a-z]+)([^>]*?)><\/\1>/gi, "<$1$2/>");
}


beforeEach(() => {
  vi.useFakeTimers();
  clearToasts();
});
afterEach(() => {
  cleanup();
  clearToasts();
  vi.useRealTimers();
});

describe("底部居中提示条（可撤销的 toast）", () => {
  it("center + actions 渲染成居中浮条：归档图标 + 文字 + 查看/撤销 + 关闭", () => {
    pushToast("已归档「output」· 文件还在磁盘上", {
      placement: "center",
      icon: "archive",
      ttl: 3000,
      actions: [{ label: "查看", onClick: () => {} }, { label: "撤销", primary: true, onClick: () => {} }],
    });
    const screen = render(Toast);
    expect(screen.container.querySelector(".toast-center")).toBeTruthy();
    const pill = screen.container.querySelector(".toast-pill");
    expect(pill).toBeTruthy();
    expect(innerSvg(pill?.querySelector("svg"))).toBe(ICON_PATHS.archive);
    expect(pill?.textContent).toContain("已归档「output」");
    const labels = [...(pill?.querySelectorAll("button") ?? [])]
      .map((b) => b.textContent?.trim())
      .filter(Boolean);
    expect(labels).toEqual(["查看", "撤销"]);
    expect(pill?.querySelector(".pill-action-primary")?.textContent?.trim()).toBe("撤销");
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
  });

  it("默认 corner 的 toast 仍旧走右下角卡片，不会冒出一条居中浮条", () => {
    pushToast("已复制");
    const screen = render(Toast);
    expect(screen.container.querySelector(".toast-center")).toBeNull();
    expect(screen.container.querySelector(".toast-card")).toBeTruthy();
  });

  it("点撤销：先执行回调再关掉这一条", async () => {
    let undone = 0;
    const id = pushToast("已归档", {
      placement: "center",
      ttl: 3000,
      actions: [{ label: "撤销", primary: true, onClick: () => { undone += 1; } }],
    });
    const screen = render(Toast);
    await fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(undone).toBe(1);
    expect(get(toasts).map((t) => t.id)).not.toContain(id);
  });

  it("3 秒到点自动消失", async () => {
    const id = pushToast("已归档", { placement: "center", ttl: 3000 });
    render(Toast);
    await vi.advanceTimersByTimeAsync(2900);
    expect(get(toasts).map((t) => t.id)).toContain(id);
    await vi.advanceTimersByTimeAsync(200);
    expect(get(toasts)).toEqual([]);
  });

  it("鼠标停在浮条上时倒计时冻结，移开后按剩余时间消失", async () => {
    const id = pushToast("已归档", { placement: "center", ttl: 3000, actions: [{ label: "撤销", onClick: () => {} }] });
    const screen = render(Toast);
    const pill = screen.container.querySelector(".toast-pill") as HTMLElement;
    await vi.advanceTimersByTimeAsync(2000);
    await fireEvent.mouseEnter(pill);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(get(toasts).map((t) => t.id)).toContain(id);
    await fireEvent.mouseLeave(pill);
    await vi.advanceTimersByTimeAsync(900);
    expect(get(toasts).map((t) => t.id)).toContain(id);
    await vi.advanceTimersByTimeAsync(300);
    expect(get(toasts)).toEqual([]);
  });

  it("pauseToast / resumeToast：暂停期间不会自己消失，恢复后走完剩余时间", async () => {
    const id = pushToast("普通条目", { ttl: 1000 });
    pauseToast(id);
    await vi.advanceTimersByTimeAsync(5000);
    expect(get(toasts).map((t) => t.id)).toContain(id);
    resumeToast(id);
    await vi.advanceTimersByTimeAsync(500);
    expect(get(toasts).map((t) => t.id)).toContain(id);
    await vi.advanceTimersByTimeAsync(600);
    expect(get(toasts)).toEqual([]);
  });

  it("clearToasts 把倒计时一起清掉（避免残留计时器误关后续条目）", async () => {
    pushToast("旧的", { ttl: 500 });
    clearToasts();
    const id = pushToast("新的", { ttl: 500 });
    await vi.advanceTimersByTimeAsync(400);
    expect(get(toasts).map((t) => t.id)).toEqual([id]);
    await vi.advanceTimersByTimeAsync(200);
    expect(get(toasts)).toEqual([]);
  });
});
