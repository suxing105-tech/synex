// 图片预览与视频播放器共用的「适应窗口 ⇄ 100%」缩放层。
//
// 为什么要有这个文件：
//   图片的缩放（模式 / 倍率 / 平移 / 抓手拖动 / 滚轮 / 双击）原本长在 Lightbox 里，
//   视频只有一句 object-contain 铺满。两边各写一遍必然开始漂移——按钮文案、上下限、
//   Esc 是"先退缩放再关图层"这类细节，一边改了另一边就会悄悄不一致。
//   所以状态和交互收在这里，两个宿主只负责提供"内容尺寸"和"视口尺寸"。
//
// 宿主契约（两个 getter，随时可读，允许还没量到 = 0）：
//   content()  —— 素材原始像素尺寸。图片给 EXIF 旋转校正后的视觉尺寸，视频给 videoWidth/Height。
//   viewport() —— 中间画布的实测尺寸（bind:clientWidth / clientHeight）。
//
// 几何计算继续用 lightbox-zoom.ts 的纯函数，那部分已有独立单测。

import {
  clampPan,
  panFromDrag,
  nextZoomMode,
  type PanOffset,
  type Size,
} from "./lightbox-zoom";

export type ZoomMode = "fit" | "zoom";

/** 底栏提示：图片与视频共用，避免两边各写一句然后开始漂移。 */
export const ZOOM_HINT = {
  fit: "滚轮缩放 · 双击画面查看 100%",
  zoom: "滚轮缩放 · 拖动查看细节 · 双击适应窗口",
} as const;

/** 滚轮缩放的边界与步进，与图片历史行为一致。 */
export const ZOOM_LIMITS = { min: 0.05, max: 8, step: 1.15 } as const;

export interface ViewerZoomOptions {
  /** 素材原始像素尺寸；未知时返回 0×0，此时不做任何缩放计算。 */
  content: () => Size;
  /** 画布实测尺寸；未量到时返回 0×0。 */
  viewport: () => Size;
  /** 适应窗口时四周留白（图片 48，视频 0：黑底画面本来就该铺满）。 */
  inset?: number;
  /** 适应窗口是否允许放大超过原始分辨率。视频 true，图片 false。 */
  upscaleToFit?: boolean;
  /** 模式变化回调：视频用它做"进缩放暂停、回适应续播"。 */
  onModeChange?: (mode: ZoomMode) => void;
  /** 缩放是否生效。对比模式、不可播兜底要返回 false，此时滚轮/双击一律放行给宿主。 */
  enabled?: () => boolean;
  /** 拖动起手时是否 preventDefault。图片要（挡掉原生拖拽幽灵），视频不要（挡掉就点不到原生控件、也点不亮暂停后继续播放）。 */
  preventDefaultDrag?: boolean;
}

export class ViewerZoom {
  mode = $state<ZoomMode>("fit");
  scale = $state(1);
  pan = $state<PanOffset>({ x: 0, y: 0 });
  dragging = $state(false);
  /** 这一次按下到底有没有真拖动过：视频靠它区分「拖动」和「单击播放/暂停」。 */
  dragMoved = $state(false);

  private opts: ViewerZoomOptions & { inset: number; upscaleToFit: boolean; preventDefaultDrag: boolean };
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartPanX = 0;
  private dragStartPanY = 0;
  private dragPointerId = -1;
  private dragEl: HTMLElement | null = null;

  constructor(opts: ViewerZoomOptions) {
    this.opts = { inset: 48, upscaleToFit: false, preventDefaultDrag: true, ...opts };
  }

  private get contentSize(): Size {
    return this.opts.content();
  }
  private get viewSize(): Size {
    return this.opts.viewport();
  }

  /** 适应窗口的倍率。图片封顶 1（永不放大糊图），视频按 upscaleToFit 放开。 */
  get fitRatio(): number {
    const c = this.contentSize;
    const v = this.viewSize;
    if (c.w <= 0 || c.h <= 0 || v.w <= 0 || v.h <= 0) return 1;
    const byW = Math.max(1, v.w - this.opts.inset) / c.w;
    const byH = Math.max(1, v.h - this.opts.inset) / c.h;
    return this.opts.upscaleToFit ? Math.min(byW, byH) : Math.min(1, byW, byH);
  }

  /** 当前真实倍率：适应窗口看 fitRatio，100% 态看滚轮改过的 scale。 */
  get ratio(): number {
    return this.mode === "fit" ? this.fitRatio : this.scale;
  }

  get displayW(): number {
    const c = this.contentSize;
    if (c.w <= 0) return 0;
    return this.mode === "zoom"
      ? c.w * this.scale
      : Math.max(1, Math.round(c.w * this.fitRatio));
  }

  get displayH(): number {
    const c = this.contentSize;
    if (c.h <= 0) return 0;
    return this.mode === "zoom"
      ? c.h * this.scale
      : Math.max(1, Math.round(c.h * this.fitRatio));
  }

  /** 尺寸已知才按显示框定尺寸；未知时交给宿主自己兜（图片靠 img 固有尺寸，视频靠 contain 铺满）。 */
  get sized(): boolean {
    return this.displayW > 0 && this.displayH > 0;
  }

  get percent(): number {
    return Math.round(this.ratio * 100);
  }

  get cursor(): string {
    return this.mode === "fit" ? "default" : this.dragging ? "grabbing" : "grab";
  }

  /** 拖动时不能带 transform 过渡，否则画面永远慢半拍跟不上手。 */
  get transition(): string {
    return this.dragging
      ? "width 0.28s ease, height 0.28s ease"
      : "width 0.28s ease, height 0.28s ease, transform 0.28s ease";
  }

  private get enabled(): boolean {
    return this.opts.enabled ? this.opts.enabled() : true;
  }

  isZooming(): boolean {
    return this.mode === "zoom";
  }

  /** 切素材 / 关闭图层 / 进对比：一律回到适应窗口，别把上一张的 100% 带过去。 */
  reset(): void {
    this.mode = "fit";
    this.scale = 1;
    this.pan = { x: 0, y: 0 };
    this.dragging = false;
    this.releaseCapture();
    this.emit();
  }

  setFit(): void {
    this.mode = "fit";
    this.scale = 1;
    this.pan = { x: 0, y: 0 };
    this.dragging = false;
    this.releaseCapture();
    this.emit();
  }

  setZoom100(): void {
    this.mode = "zoom";
    this.scale = 1;
    this.pan = { x: 0, y: 0 };
    this.emit();
  }

  /** 双击画面：fit ⇄ zoom。 */
  toggle(): void {
    if (!this.enabled) return;
    const r = nextZoomMode(this.mode);
    this.scale = 1;
    this.mode = r.mode;
    this.pan = r.pan;
    this.emit();
  }

  /** 滚轮缩放：从当前真实倍率起算，缩放焦点保持在光标所在处。 */
  onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    const c = this.contentSize;
    if (!c.w || !e.deltaY) return;
    e.preventDefault();
    const previous = this.ratio;
    const min = Math.min(ZOOM_LIMITS.min, this.fitRatio);
    const next = Math.max(min, Math.min(ZOOM_LIMITS.max, previous * (e.deltaY < 0 ? ZOOM_LIMITS.step : 1 / ZOOM_LIMITS.step)));
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Number.isFinite(e.clientX) ? e.clientX - rect.left - rect.width / 2 : 0;
    const y = Number.isFinite(e.clientY) ? e.clientY - rect.top - rect.height / 2 : 0;
    this.pan = { x: x - (x - this.pan.x) * next / previous, y: y - (y - this.pan.y) * next / previous };
    this.scale = next;
    if (this.mode !== "zoom") {
      this.mode = "zoom";
      this.emit();
    }
  };

  /**
   * 抓手拖动：pointer events + setPointerCapture。
   * 光标移出画面（甚至移出窗口）事件仍会送到同一元素，缩放溢出时不会拖丢。
   */
  onPointerDown = (e: PointerEvent): void => {
    if (this.mode !== "zoom" || !this.enabled) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (this.opts.preventDefaultDrag) e.preventDefault();
    e.stopPropagation();
    this.dragMoved = false;
    const target = e.currentTarget as HTMLElement;
    this.dragging = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.dragStartPanX = this.pan.x;
    this.dragStartPanY = this.pan.y;
    this.dragPointerId = e.pointerId;
    this.dragEl = target;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* 宿主不支持指针捕获时照常拖动，只是移出画面可能丢事件 */
    }
  };

  onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging || this.dragPointerId !== e.pointerId) return;
    const next = panFromDrag(
      e.clientX,
      e.clientY,
      this.dragStartX,
      this.dragStartY,
      { x: this.dragStartPanX, y: this.dragStartPanY },
    );
    // 就地 clamp + guard 写入，避免和 clamp effect 互相触发形成死循环
    if (Math.abs(e.clientX - this.dragStartX) + Math.abs(e.clientY - this.dragStartY) > 4) this.dragMoved = true;
    const clamped = clampPan(next, { w: this.displayW, h: this.displayH }, this.viewSize, 0);
    if (clamped.x !== this.pan.x || clamped.y !== this.pan.y) this.pan = clamped;
  };

  onPointerUp = (e: PointerEvent): void => {
    if (this.dragPointerId !== e.pointerId) return;
    this.dragging = false;
    this.dragPointerId = -1;
    this.releaseCapture();
  };

  /** 画布尺寸变了（拖侧栏、最大化）要把越界的平移拉回来。 */
  clampNow(): void {
    if (this.mode !== "zoom") return;
    const bounded = clampPan(this.pan, { w: this.displayW, h: this.displayH }, this.viewSize, 0);
    if (bounded.x !== this.pan.x || bounded.y !== this.pan.y) this.pan = bounded;
  }

  private releaseCapture(): void {
    if (this.dragEl && this.dragPointerId >= 0) {
      try {
        this.dragEl.releasePointerCapture(this.dragPointerId);
      } catch {
        /* 指针已经自然结束，没什么可收尾的 */
      }
    }
    this.dragPointerId = -1;
    this.dragEl = null;
  }

  private emit(): void {
    this.opts.onModeChange?.(this.mode);
  }
}

/**
 * 滚轮动作：挂画布，不是挂画面。
 * 必须 passive:false，否则 preventDefault 无效，滚轮缩放会连带滚走背后的网格。
 */
export function viewerZoomWheel(node: HTMLElement, zoom: ViewerZoom) {
  const handler = (e: WheelEvent) => zoom.onWheel(e);
  node.addEventListener("wheel", handler, { passive: false });
  return {
    destroy: () => node.removeEventListener("wheel", handler),
  };
}