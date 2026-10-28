import { describe, expect, it } from "vitest";
import { ViewerZoom, ZOOM_HINT, ZOOM_LIMITS } from "../lib/viewer-zoom.svelte";

/**
 * 图片预览与视频播放器共用的缩放层（lib/viewer-zoom.svelte.ts）单测。
 *
 * 这里锁的是两边都依赖的行为契约：
 * - 适应窗口的两种口径（图片封顶原始分辨率 / 视频允许上采样）；
 * - 100% 与滚轮的倍率、边界、平移 clamp；
 * - enabled=false（对比模式、不可播兜底）时缩放整体让路；
 * - 拖动与单击的区分（视频放大态仍要能单击播放）。
 */

type Size = { w: number; h: number };

interface MakeOptions {
  content?: Size;
  viewport?: Size;
  inset?: number;
  upscaleToFit?: boolean;
  enabled?: () => boolean;
}

function make(opts: MakeOptions = {}) {
  let content = opts.content ?? { w: 1200, h: 800 };
  let viewport = opts.viewport ?? { w: 600, h: 500 };
  const changes: string[] = [];
  const zoom = new ViewerZoom({
    content: () => content,
    viewport: () => viewport,
    inset: opts.inset ?? 48,
    upscaleToFit: opts.upscaleToFit ?? false,
    enabled: opts.enabled,
    onModeChange: (mode) => changes.push(mode),
  });
  return {
    zoom,
    changes,
    setContent: (s: Size) => { content = s; },
    setViewport: (s: Size) => { viewport = s; },
  };
}

function wheel(deltaY: number, clientX = 500, clientY = 400) {
  let prevented = false;
  const e = {
    deltaY,
    clientX,
    clientY,
    defaultPrevented: false,
    preventDefault() { prevented = true; this.defaultPrevented = true; },
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }) },
  };
  return { e: e as unknown as WheelEvent, wasPrevented: () => prevented };
}

function pointer(clientX: number, clientY: number, id = 1) {
  const target = {
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  const e = {
    clientX,
    clientY,
    pointerId: id,
    pointerType: "mouse",
    button: 0,
    currentTarget: target,
    preventDefault() {},
    stopPropagation() {},
  };
  return e as unknown as PointerEvent;
}

describe("ViewerZoom：适应窗口口径", () => {
  it("图片：适应窗口按比例缩进画布", () => {
    const { zoom } = make({ content: { w: 1200, h: 800 }, viewport: { w: 600, h: 500 }, inset: 48 });
    // min((600-48)/1200, (500-48)/800) = 0.46
    expect(zoom.fitRatio).toBeCloseTo(0.46, 6);
    expect(zoom.displayW).toBe(552);
    expect(zoom.displayH).toBe(368);
    expect(zoom.percent).toBe(46);
  });

  it("图片：小图不放大超过原始分辨率", () => {
    const { zoom } = make({ content: { w: 600, h: 400 }, viewport: { w: 1200, h: 900 }, inset: 48 });
    expect(zoom.fitRatio).toBe(1);
    expect(zoom.displayW).toBe(600);
    expect(zoom.percent).toBe(100);
  });

  it("视频：适应窗口允许上采样铺满画布", () => {
    const { zoom } = make({
      content: { w: 480, h: 270 },
      viewport: { w: 1200, h: 900 },
      inset: 0,
      upscaleToFit: true,
    });
    expect(zoom.fitRatio).toBeCloseTo(2.5, 6);
    expect(zoom.displayW).toBe(1200);
    expect(zoom.displayH).toBe(675);
    expect(zoom.percent).toBe(250);
  });

  it("尺寸还没测到时不做计算，交给宿主兜底", () => {
    const { zoom } = make({ content: { w: 0, h: 0 }, viewport: { w: 0, h: 0 } });
    expect(zoom.fitRatio).toBe(1);
    expect(zoom.sized).toBe(false);
    expect(zoom.displayW).toBe(0);
  });
});

describe("ViewerZoom：100%、滚轮与平移", () => {
  it("100% 按原始像素显示并回调模式变化", () => {
    const { zoom, changes } = make({ content: { w: 1920, h: 1080 }, viewport: { w: 800, h: 600 } });
    zoom.setZoom100();
    expect(zoom.mode).toBe("zoom");
    expect(zoom.displayW).toBe(1920);
    expect(zoom.percent).toBe(100);
    expect(zoom.cursor).toBe("grab");
    expect(changes).toEqual(["zoom"]);
  });

  it("滚轮从适应窗口的倍率接着放大，并进入 100% 态", () => {
    const { zoom } = make({ content: { w: 1000, h: 1000 }, viewport: { w: 1000, h: 1000 }, inset: 0 });
    expect(zoom.fitRatio).toBe(1);
    const { e, wasPrevented } = wheel(-100);
    zoom.onWheel(e);
    expect(wasPrevented()).toBe(true);
    expect(zoom.mode).toBe("zoom");
    expect(zoom.scale).toBeCloseTo(1.15, 6);
    expect(zoom.displayW).toBe(1150);
  });

  it("滚轮下限不跌破 5%，上限不越过 800%", () => {
    const { zoom } = make({ content: { w: 1000, h: 1000 }, viewport: { w: 1000, h: 1000 }, inset: 0 });
    for (let i = 0; i < 40; i++) zoom.onWheel(wheel(100).e);
    expect(zoom.scale).toBeCloseTo(ZOOM_LIMITS.min, 6);
    for (let i = 0; i < 80; i++) zoom.onWheel(wheel(-100).e);
    expect(zoom.scale).toBeCloseTo(ZOOM_LIMITS.max, 6);
  });

  it("平移超出边界会被拉回", () => {
    const { zoom } = make({ content: { w: 2000, h: 1200 }, viewport: { w: 1000, h: 800 }, inset: 0 });
    zoom.setZoom100();
    zoom.pan = { x: 9999, y: -9999 };
    zoom.clampNow();
    // x: (2000-1000)/2 = 500；y: (1200-800)/2 = 200
    expect(zoom.pan).toEqual({ x: 500, y: -200 });
  });

  it("画布变大后重新 clamp，画面不会留在画布外", () => {
    const { zoom, setViewport } = make({ content: { w: 2000, h: 1200 }, viewport: { w: 1000, h: 800 }, inset: 0 });
    zoom.setZoom100();
    zoom.pan = { x: 500, y: 200 };
    setViewport({ w: 3000, h: 2000 });
    zoom.clampNow();
    // 画面比画布小，必须完全留在画布内：|x| <= (3000-2000)/2
    expect(zoom.pan).toEqual({ x: 500, y: 200 });
    zoom.pan = { x: 900, y: 900 };
    zoom.clampNow();
    expect(zoom.pan).toEqual({ x: 500, y: 400 });
  });

  it("双击两次回到适应窗口", () => {
    const { zoom, changes } = make();
    zoom.toggle();
    zoom.toggle();
    expect(zoom.mode).toBe("fit");
    expect(changes).toEqual(["zoom", "fit"]);
  });

  it("换素材 / 关闭图层：reset 把倍率、平移、拖动全部归零", () => {
    const { zoom } = make({ content: { w: 2000, h: 1200 }, viewport: { w: 1000, h: 800 }, inset: 0 });
    zoom.onWheel(wheel(-100).e);
    zoom.onPointerDown(pointer(10, 10));
    zoom.onPointerMove(pointer(120, 90));
    zoom.reset();
    expect(zoom.mode).toBe("fit");
    expect(zoom.scale).toBe(1);
    expect(zoom.pan).toEqual({ x: 0, y: 0 });
    expect(zoom.dragging).toBe(false);
  });
});

describe("ViewerZoom：拖动与单击的区分", () => {
  it("适应窗口态不启动拖动，滚轮以外的手势一律放行", () => {
    const { zoom } = make();
    zoom.onPointerDown(pointer(10, 10));
    expect(zoom.dragging).toBe(false);
  });

  it("按下没移动不算拖动，放大态单击仍能触发播放", () => {
    const { zoom } = make({ content: { w: 2000, h: 1200 }, viewport: { w: 1000, h: 800 }, inset: 0 });
    zoom.setZoom100();
    zoom.onPointerDown(pointer(10, 10));
    zoom.onPointerMove(pointer(12, 11));
    zoom.onPointerUp(pointer(12, 11));
    expect(zoom.dragMoved).toBe(false);
  });

  it("真拖动过以后 dragMoved 置位，宿主可以吞掉这次 click", () => {
    const { zoom } = make({ content: { w: 2000, h: 1200 }, viewport: { w: 1000, h: 800 }, inset: 0 });
    zoom.setZoom100();
    zoom.onPointerDown(pointer(10, 10));
    expect(zoom.dragging).toBe(true);
    expect(zoom.transition).not.toContain("transform");
    zoom.onPointerMove(pointer(200, 150));
    expect(zoom.dragMoved).toBe(true);
    expect(zoom.dragging).toBe(true);
    zoom.onPointerUp(pointer(200, 150));
    expect(zoom.dragging).toBe(false);
    expect(zoom.transition).toContain("transform");
  });

  it("右键 / 中键不触发拖动", () => {
    const { zoom } = make({ content: { w: 2000, h: 1200 }, viewport: { w: 1000, h: 800 }, inset: 0 });
    zoom.setZoom100();
    const e = pointer(10, 10);
    (e as unknown as { button: number }).button = 2;
    zoom.onPointerDown(e);
    expect(zoom.dragging).toBe(false);
  });
});

describe("ViewerZoom：对比模式下整体让路", () => {
  it("enabled 返回 false 时滚轮、双击都不生效，也不回调", () => {
    let enabled = true;
    const { zoom, changes } = make({
      content: { w: 1000, h: 1000 },
      viewport: { w: 1000, h: 1000 },
      inset: 0,
      enabled: () => enabled,
    });
    enabled = false;
    zoom.onWheel(wheel(-100).e);
    zoom.toggle();
    expect(zoom.mode).toBe("fit");
    expect(changes).toEqual([]);
    enabled = true;
    zoom.toggle();
    expect(zoom.mode).toBe("zoom");
  });

  it("禁用时滚轮不吞默认动作，页面照常滚动", () => {
    const { zoom } = make({ enabled: () => false });
    const { e, wasPrevented } = wheel(-100);
    zoom.onWheel(e);
    expect(wasPrevented()).toBe(false);
  });
});

describe("底栏提示：图片与视频共用一句", () => {
  it("两种模式的提示都在共享常量里", () => {
    expect(ZOOM_HINT.fit).toBe("滚轮缩放 · 双击画面查看 100%");
    expect(ZOOM_HINT.zoom).toBe("滚轮缩放 · 拖动查看细节 · 双击适应窗口");
  });
});