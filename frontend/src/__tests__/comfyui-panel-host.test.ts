import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const panel = readFileSync("src-tauri/src/comfyui_panel.js", "utf8");

function makeEl(tag: string): any {
  return {
    tag,
    attrs: {} as Record<string, string>,
    children: [] as any[],
    listeners: {} as Record<string, Function[]>,
    style: { cssText: "", display: "" },
    setAttribute(key: string, value: string) {
      this.attrs[key] = value;
    },
    getAttribute(key: string) {
      return this.attrs[key];
    },
    appendChild(child: any) {
      this.children.push(child);
      return child;
    },
    addEventListener(type: string, cb: Function) {
      (this.listeners[type] ||= []).push(cb);
    },
    dispatch(type: string, event: any = {}) {
      for (const cb of this.listeners[type] || []) cb(event);
    },
  };
}

function setup(origin = "http://127.0.0.1:8188") {
  const body = makeEl("body");
  const document: any = {
    body,
    documentElement: body,
    createElement: (tag: string) => makeEl(tag),
    addEventListener: vi.fn(),
  };
  const location: any = { origin, href: origin + "/" };
  const nativeOpen = vi.fn(() => ({ native: true }));
  const window: any = {
    location,
    open: nativeOpen,
    listeners: {} as Record<string, Function[]>,
    addEventListener(type: string, cb: Function) {
      (this.listeners[type] ||= []).push(cb);
    },
    dispatch(type: string, event: any = {}) {
      for (const cb of this.listeners[type] || []) cb(event);
    },
  };
  vm.runInNewContext(panel, { window, document, location, request: { origin }, URL });
  const host = () => body.children.find((el: any) => el.attrs["data-seekx-panel"] === "host");
  const frame = () => host()?.children.find((el: any) => el.attrs["data-seekx-panel"] === "frame");
  const closeButton = () => host()?.children.find((el: any) => el.attrs["data-seekx-panel"] === "close");
  return { window, document, location, body, nativeOpen, host, frame, closeButton };
}

const keyEvent = () => ({ key: "Escape", stopPropagation: vi.fn(), preventDefault: vi.fn() });

describe("ComfyUI 面板宿主", () => {
  it("同源 window.open 不开新窗口，而是在当前窗口里落出一个面板", () => {
    const ctx = setup();
    const handle = ctx.window.open("http://127.0.0.1:8188/loras", "_blank");
    expect(ctx.nativeOpen).not.toHaveBeenCalled();
    expect(ctx.host()).toBeTruthy();
    expect(ctx.frame().src).toBe("http://127.0.0.1:8188/loras");
    expect(ctx.host().style.display).toBe("block");
    expect(ctx.window.__seekxPanel.isOpen()).toBe(true);
    // 返回值仍是类 window 对象，插件里 w.focus()/w.close() 这类调用不会炸
    expect(() => handle.focus()).not.toThrow();
    handle.close();
    expect(handle.closed).toBe(true);
    expect(ctx.window.__seekxPanel.isOpen()).toBe(false);
  });

  it("相对地址会被解析成同源绝对地址再进面板", () => {
    const ctx = setup();
    ctx.window.open("/loras?tab=image", "_blank");
    expect(ctx.frame().src).toBe("http://127.0.0.1:8188/loras?tab=image");
  });

  it("带 width/height 的 window.open（LoRA 管理器 Shift+点）保留独立窗口", () => {
    const ctx = setup();
    ctx.window.open("http://127.0.0.1:8188/loras", "_blank", "width=1200,height=800,resizable=yes");
    expect(ctx.nativeOpen).toHaveBeenCalledTimes(1);
    expect(ctx.window.__seekxPanel.isOpen()).toBe(false);
  });

  it("跨源链接原样交给原生 window.open，由壳层转系统浏览器", () => {
    const ctx = setup();
    ctx.window.open("https://civitai.com/models/123", "_blank");
    expect(ctx.nativeOpen).toHaveBeenCalledTimes(1);
    expect(ctx.window.__seekxPanel.isOpen()).toBe(false);
  });

  it("返回画布按钮与 Esc 都能收起面板，且不会重复注入宿主", () => {
    const ctx = setup();
    ctx.window.open("http://127.0.0.1:8188/loras", "_blank");
    ctx.closeButton().dispatch("click");
    expect(ctx.window.__seekxPanel.isOpen()).toBe(false);

    ctx.window.open("http://127.0.0.1:8188/loras", "_blank");
    const event = keyEvent();
    ctx.window.dispatch("keydown", event);
    expect(ctx.window.__seekxPanel.isOpen()).toBe(false);
    expect(event.stopPropagation).toHaveBeenCalled();

    // 同一个 origin 再开同一个地址，只保留一层宿主
    ctx.window.open("http://127.0.0.1:8188/loras", "_blank");
    expect(ctx.body.children.filter((el: any) => el.attrs["data-seekx-panel"] === "host")).toHaveLength(1);
  });

  it("面板收起后 Esc 不再拦截事件，画布自己的快捷键照常工作", () => {
    const ctx = setup();
    const event = keyEvent();
    ctx.window.dispatch("keydown", event);
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it("非当前 ComfyUI origin 时脚本不生效", () => {
    const ctx = setup("http://127.0.0.1:8188");
    const other: any = { origin: "http://evil.example", href: "http://evil.example/" };
    vm.runInNewContext(panel, {
      window: { location: other, open: vi.fn(), addEventListener: vi.fn() },
      document: ctx.document,
      location: other,
      request: { origin: "http://127.0.0.1:8188" },
      URL,
    });
    expect(ctx.document.body.children.filter((el: any) => el.attrs["data-seekx-panel"] === "host")).toHaveLength(0);
  });
});
