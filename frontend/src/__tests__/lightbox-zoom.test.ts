import { describe, it, expect } from "vitest";
import { clampPan, panFromDrag, nextZoomMode } from "../lib/lightbox-zoom";

describe("Lightbox 100% 放大 + 抓手拖动（纯函数）", () => {
  describe("clampPan", () => {
    it("小图（<= 视口）：不允许移出视口，pan 范围 = ±(viewport - image)/2", () => {
      // 500x400 图，1000x800 视口
      // boundX = (1000-500)/2 = 250，boundY = (800-400)/2 = 200
      const r1 = clampPan({ x: 9999, y: 9999 }, { w: 500, h: 400 }, { w: 1000, h: 800 });
      expect(r1).toEqual({ x: 250, y: 200 });

      const r2 = clampPan({ x: -9999, y: -9999 }, { w: 500, h: 400 }, { w: 1000, h: 800 });
      expect(r2).toEqual({ x: -250, y: -200 });

      // 边界值（恰好到 bound）
      const r3 = clampPan({ x: 250, y: 200 }, { w: 500, h: 400 }, { w: 1000, h: 800 });
      expect(r3.x).toBeCloseTo(250);
      expect(r3.y).toBeCloseTo(200);
    });

    it("小图刚好填满视口：pan 必须为 0", () => {
      const r = clampPan({ x: 50, y: -50 }, { w: 1000, h: 800 }, { w: 1000, h: 800 });
      expect(r.x).toBe(0);
      expect(r.y).toBe(0);
    });

    it("大图（> 视口）：至少保留 margin 像素贴住视口边缘", () => {
      // 2000x1500 图，1000x800 视口，margin=80
      // boundX = (2000-1000)/2 - 80 = 420
      // boundY = (1500-800)/2 - 80 = 270
      const r1 = clampPan({ x: 9999, y: 9999 }, { w: 2000, h: 1500 }, { w: 1000, h: 800 });
      expect(r1).toEqual({ x: 420, y: 270 });

      const r2 = clampPan({ x: -9999, y: -9999 }, { w: 2000, h: 1500 }, { w: 1000, h: 800 });
      expect(r2).toEqual({ x: -420, y: -270 });
    });

    it("自定义 margin 生效", () => {
      // 2000x1500 图，1000x800 视口，margin=200
      // boundX = 500 - 200 = 300
      // boundY = 350 - 200 = 150
      const r = clampPan({ x: 9999, y: 9999 }, { w: 2000, h: 1500 }, { w: 1000, h: 800 }, 200);
      expect(r).toEqual({ x: 300, y: 150 });
    });

    it("X 和 Y 独立 clamp（横长竖短 / 竖长横短）", () => {
      // 横长：image.w 大，image.h 小
      const r1 = clampPan({ x: 9999, y: -9999 }, { w: 3000, h: 200 }, { w: 1000, h: 800 });
      // boundX = (3000-1000)/2 - 80 = 920
      // boundY = (800-200)/2 = 300（小图限制）
      expect(r1).toEqual({ x: 920, y: -300 });

      // 竖长
      const r2 = clampPan({ x: 9999, y: 9999 }, { w: 200, h: 3000 }, { w: 1000, h: 800 });
      // boundX = (1000-200)/2 = 400
      // boundY = (3000-800)/2 - 80 = 1020
      expect(r2).toEqual({ x: 400, y: 1020 });
    });

    it("pan 已经在范围内就原样返回", () => {
      const r = clampPan({ x: 50, y: -30 }, { w: 2000, h: 1500 }, { w: 1000, h: 800 });
      expect(r).toEqual({ x: 50, y: -30 });
    });
  });

  describe("panFromDrag", () => {
    it("鼠标没动：pan 不变", () => {
      const r = panFromDrag(100, 200, 100, 200, { x: 30, y: 40 });
      expect(r).toEqual({ x: 30, y: 40 });
    });

    it("鼠标移动 (dx, dy)：pan 跟着移动 (dx, dy)", () => {
      const r = panFromDrag(150, 250, 100, 200, { x: 30, y: 40 });
      expect(r).toEqual({ x: 80, y: 90 });
    });

    it("负方向拖动（向左上）", () => {
      const r = panFromDrag(50, 100, 100, 200, { x: 30, y: 40 });
      expect(r).toEqual({ x: -20, y: -60 });
    });

    it("dragStartPan 为 {0,0}：pan 直接等于鼠标偏移", () => {
      const r = panFromDrag(80, 120, 30, 50, { x: 0, y: 0 });
      expect(r).toEqual({ x: 50, y: 70 });
    });
  });

  describe("nextZoomMode", () => {
    it("fit → zoom：pan 重置为 0（让 flex 居中）", () => {
      const r = nextZoomMode("fit");
      expect(r.mode).toBe("zoom");
      expect(r.pan).toEqual({ x: 0, y: 0 });
    });

    it("zoom → fit：pan 重置为 0", () => {
      const r = nextZoomMode("zoom");
      expect(r.mode).toBe("fit");
      expect(r.pan).toEqual({ x: 0, y: 0 });
    });
  });
});