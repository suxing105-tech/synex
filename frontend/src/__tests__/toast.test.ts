import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  pushToast,
  updateToast,
  dismissToast,
  clearToasts,
  toasts,
} from "../lib/toast";

describe("toast store（全局堆叠通知）", () => {
  beforeEach(() => {
    clearToasts();
  });

  it("pushToast 默认 info + 1.5s 自动消失", () => {
    const id = pushToast("hello");
    const list = get(toasts);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
    expect(list[0].kind).toBe("info");
    expect(list[0].message).toBe("hello");
    expect(list[0].ttl).toBe(1500);
  });

  it("error 类型 ttl 默认 4000 且不自动消失（除非手动 dismiss）", () => {
    pushToast("oops", { kind: "error" });
    expect(get(toasts)[0].ttl).toBe(4000);
  });

  it("progress 类型 ttl 默认 0（不自动消失）", () => {
    pushToast("scanning…", { kind: "progress", progress: 30 });
    const list = get(toasts);
    expect(list[0].ttl).toBe(0);
    expect(list[0].progress).toBe(30);
  });

  it("updateToast 合并字段（按 id）", () => {
    const id = pushToast("scanning…", { kind: "progress", progress: 10 });
    updateToast(id, { progress: 50, message: "扫描到一半" });
    const list = get(toasts);
    expect(list[0].progress).toBe(50);
    expect(list[0].message).toBe("扫描到一半");
    expect(list[0].id).toBe(id);
  });

  it("同 id 再次 push 会替换原条目，不增加长度", () => {
    pushToast("first", { id: 1 });
    pushToast("second", { id: 1 });
    const list = get(toasts);
    expect(list).toHaveLength(1);
    expect(list[0].message).toBe("second");
  });

  it("dismissToast 移除指定 id", () => {
    pushToast("a");
    pushToast("b");
    const ids = get(toasts).map((t) => t.id);
    dismissToast(ids[0]);
    expect(get(toasts).map((t) => t.message)).toEqual(["b"]);
  });

  it("clearToasts 清空", () => {
    pushToast("a");
    pushToast("b");
    clearToasts();
    expect(get(toasts)).toEqual([]);
  });

  it("超过 4 个时丢弃最早的", () => {
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(pushToast(`t${i}`));
    const list = get(toasts);
    expect(list).toHaveLength(4);
    // 保留最新 4 个
    expect(list.map((t) => t.message)).toEqual(["t2", "t3", "t4", "t5"]);
  });

  it("自定义 ttl 生效", () => {
    pushToast("custom", { ttl: 100 });
    expect(get(toasts)[0].ttl).toBe(100);
  });
});
