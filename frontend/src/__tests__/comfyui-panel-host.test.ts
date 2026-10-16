import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const panel = readFileSync("src-tauri/src/comfyui_panel.js", "utf8");
const ORIGIN = "http://127.0.0.1:8188";
const CANVAS = `${ORIGIN}/?t=1`;
const RETURN = "SeekX.PanelReturn";
const DEPTH = "SeekX.PanelDepth";

function makeEl(tag: string): any {
  return {
    tag,
    className: "",
    attrs: {} as Record<string, string>,
    children: [] as any[],
    listeners: {} as Record<string, Function[]>,
    style: { cssText: "", display: "" },
    classList: { contains: () => false },
    setAttribute(key: string, value: string) { this.attrs[key] = value; },
    getAttribute(key: string) { return this.attrs[key]; },
    appendChild(child: any) { this.children.push(child); return child; },
    addEventListener(type: string, cb: Function) { (this.listeners[type] ||= []).push(cb); },
    dispatch(type: string, event: any = {}) { for (const cb of this.listeners[type] || []) cb(event); },
  };
}

// 一个「标签页」：sessionStorage 与 history 在同一个标签页里的多个文档之间共享
function makeTab(startUrl = CANVAS) {
  const session = new Map<string, string>();
  const sessionStorageShim = {
    getItem: (k: string) => (session.has(k) ? session.get(k)! : null),
    setItem: (k: string, v: string) => { session.set(k, String(v)); },
    removeItem: (k: string) => { session.delete(k); },
  };
  const entries = [startUrl];
  let index = 0;
  const location: any = { origin: ORIGIN, href: startUrl };
  location.assign = vi.fn((next: string) => {
    entries.splice(index + 1, entries.length, next);
    index = entries.length - 1;
    location.href = next;
  });
  const history = {
    get length() { return entries.length; },
    back: vi.fn(() => {
      if (index > 0) { index -= 1; location.href = entries[index]; }
    }),
    go: vi.fn((delta: number) => {
      index = Math.min(entries.length - 1, Math.max(0, index + delta));
      location.href = entries[index];
    }),
  };
  // 面板是 SPA，自己 pushState 也算历史；用它模拟「进面板后又跳了两页」
  const push = (url: string) => {
    entries.splice(index + 1, entries.length, url);
    index = entries.length - 1;
    location.href = url;
  };
  return { session, sessionStorageShim, entries, history, location, push };
}

// 在「同一个标签页里的一个文档」中跑一遍注入脚本
function openDocument(tab: ReturnType<typeof makeTab>, url: string) {
  tab.location.href = url;
  const body = makeEl("body");
  const document: any = {
    body,
    documentElement: body,
    createElement: (tag: string) => makeEl(tag),
    addEventListener: vi.fn(),
    querySelector: (selector: string) =>
      body.children.find((el: any) => selector.includes("data-seekx-panel") && el.attrs["data-seekx-panel"] === "back") || null,
    querySelectorAll: () => [] as any[],
  };
  const nativeOpen = vi.fn(() => ({ native: true }));
  const window: any = {
    location: tab.location,
    sessionStorage: tab.sessionStorageShim,
    history: tab.history,
    open: nativeOpen,
    postMessage: vi.fn(),
    listeners: {} as Record<string, Function[]>,
    addEventListener(type: string, cb: Function) { (this.listeners[type] ||= []).push(cb); },
    dispatch(type: string, event: any = {}) { for (const cb of this.listeners[type] || []) cb(event); },
  };
  window.top = window;
  vm.runInNewContext(panel, {
    window, document, location: tab.location, sessionStorage: tab.sessionStorageShim, history: tab.history,
    request: { origin: ORIGIN }, URL, setTimeout: (cb: () => void) => cb(),
  });
  const backButton = () => body.children.find((el: any) => el.attrs["data-seekx-panel"] === "back");
  return { window, document, body, nativeOpen, backButton };
}

const keyEvent = () => ({ key: "Escape", stopPropagation: vi.fn(), preventDefault: vi.fn() });

describe("ComfyUI 页面模式宿主", () => {
  it("同源 window.open 不开新窗口，而是在当前窗口换页并记住画布地址", () => {
    const tab = makeTab();
    const doc = openDocument(tab, CANVAS);
    const handle = doc.window.open(`${ORIGIN}/loras`, "_blank");
    expect(doc.nativeOpen).not.toHaveBeenCalled();
    expect(tab.location.href).toBe(`${ORIGIN}/loras`);
    expect(tab.sessionStorageShim.getItem(RETURN)).toBe(CANVAS);
    expect(tab.sessionStorageShim.getItem(DEPTH)).toBe("1");
    expect(() => handle.focus()).not.toThrow();
    expect(handle.location.href).toBe(`${ORIGIN}/loras`);
    handle.location.href = `${ORIGIN}/recipes`;
    expect(tab.location.href).toBe(`${ORIGIN}/recipes`);
  });

  it("相对地址会被解析成同源绝对地址再换页", () => {
    const tab = makeTab();
    const doc = openDocument(tab, CANVAS);
    doc.window.open("/loras?tab=image", "_blank");
    expect(tab.location.href).toBe(`${ORIGIN}/loras?tab=image`);
  });

  it("带 width/height 的 window.open（LoRA 管理器 Shift+点）保留独立窗口", () => {
    const tab = makeTab();
    const doc = openDocument(tab, CANVAS);
    doc.window.open(`${ORIGIN}/loras`, "_blank", "width=1200,height=800,resizable=yes");
    expect(doc.nativeOpen).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe(CANVAS);
  });

  it("明确要 noopener 的打开（图片、外链）不换掉当前页，仍走原生", () => {
    const tab = makeTab();
    const doc = openDocument(tab, `${ORIGIN}/loras`);
    doc.window.open(`${ORIGIN}/view?filename=1.png`, "_blank", "noopener,noreferrer");
    expect(doc.nativeOpen).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe(`${ORIGIN}/loras`);
  });

  it("跨源链接原样交给原生 window.open，由壳层转系统浏览器", () => {
    const tab = makeTab();
    const doc = openDocument(tab, CANVAS);
    doc.window.open("https://civitai.com/models/123", "_blank");
    expect(doc.nativeOpen).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe(CANVAS);
  });

  it("面板文档里有返回画布按钮，点击走历史回到画布", () => {
    const tab = makeTab();
    openDocument(tab, CANVAS).window.open(`${ORIGIN}/loras`, "_blank");
    const panelDoc = openDocument(tab, `${ORIGIN}/loras`);
    expect(panelDoc.backButton()).toBeTruthy();
    panelDoc.backButton().dispatch("click");
    expect(tab.location.href).toBe(CANVAS);
    expect(tab.sessionStorageShim.getItem(RETURN)).toBeNull();
    expect(tab.sessionStorageShim.getItem(DEPTH)).toBeNull();
  });

  it("面板内部自己跳过几页之后，返回仍然回到画布而不是半途", () => {
    const tab = makeTab();
    openDocument(tab, CANVAS).window.open(`${ORIGIN}/loras`, "_blank");
    const panelDoc = openDocument(tab, `${ORIGIN}/loras`);
    tab.push(`${ORIGIN}/loras/detail/8`);
    tab.push(`${ORIGIN}/loras/detail/9`);
    panelDoc.backButton().dispatch("click");
    expect(tab.location.href).toBe(CANVAS);
    // 历史直接回到画布，没有触发「跳不过去就硬导航」的兜底
    expect(tab.location.assign).not.toHaveBeenCalledWith(CANVAS);
  });

  it("历史回不去时直接跳回画布地址", () => {
    const tab = makeTab();
    openDocument(tab, CANVAS).window.open(`${ORIGIN}/loras`, "_blank");
    const panelDoc = openDocument(tab, `${ORIGIN}/loras`);
    tab.history.go.mockImplementation(() => {}); // bfcache / 历史都不生效
    panelDoc.backButton().dispatch("click");
    expect(tab.location.assign).toHaveBeenCalledWith(CANVAS);
  });

  it("Esc 只在面板里拦截，画布上的快捷键照常工作", () => {
    const tab = makeTab();
    const canvasDoc = openDocument(tab, CANVAS);
    const quiet = keyEvent();
    canvasDoc.window.dispatch("keydown", quiet);
    expect(quiet.stopPropagation).not.toHaveBeenCalled();

    canvasDoc.window.open(`${ORIGIN}/loras`, "_blank");
    const panelDoc = openDocument(tab, `${ORIGIN}/loras`);
    const loud = keyEvent();
    panelDoc.window.dispatch("keydown", loud);
    expect(loud.stopPropagation).toHaveBeenCalled();
    expect(loud.preventDefault).toHaveBeenCalled();
    expect(tab.location.href).toBe(CANVAS);
  });

  it("面板里的弹窗开着时，Esc 留给插件自己关弹窗", () => {
    const tab = makeTab();
    openDocument(tab, CANVAS).window.open(`${ORIGIN}/loras`, "_blank");
    const panelDoc = openDocument(tab, `${ORIGIN}/loras`);
    panelDoc.body.className = "modal-open";
    const event = keyEvent();
    panelDoc.window.dispatch("keydown", event);
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(tab.location.href).toBe(`${ORIGIN}/loras`);
  });

  it("面板里再点开的同源页面继续留在同一窗口，且不会覆盖画布返回地址", () => {
    const tab = makeTab();
    openDocument(tab, CANVAS).window.open(`${ORIGIN}/loras`, "_blank");
    const panelDoc = openDocument(tab, `${ORIGIN}/loras`);
    panelDoc.window.open(`${ORIGIN}/loras/detail/9`, "_blank");
    expect(tab.location.href).toBe(`${ORIGIN}/loras/detail/9`);
    expect(tab.sessionStorageShim.getItem(RETURN)).toBe(CANVAS);
  });

  it("非当前 ComfyUI origin 时脚本不生效", () => {
    const evil: any = { origin: "http://evil.example", href: "http://evil.example/", assign: vi.fn() };
    const body = makeEl("body");
    const document: any = { body, documentElement: body, createElement: (tag: string) => makeEl(tag), addEventListener: vi.fn(), querySelector: () => null, querySelectorAll: () => [] };
    const window: any = { location: evil, open: vi.fn(), addEventListener: vi.fn(), sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } };
    window.top = window;
    vm.runInNewContext(panel, { window, document, location: evil, request: { origin: ORIGIN }, URL, setTimeout: (cb: () => void) => cb() });
    expect(body.children).toHaveLength(0);
    expect(window.__seekxPanel).toBeUndefined();
  });
});
