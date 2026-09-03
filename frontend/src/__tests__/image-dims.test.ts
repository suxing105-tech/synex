import { describe, it, expect } from "vitest";
import { safeOrientedSize } from "../lib/image-dims";

describe("safeOrientedSize（Lightbox 防御性尺寸选择）", () => {
  it("两个尺寸都不可用（全 0）：返回 {0,0}", () => {
    expect(safeOrientedSize({ w: 0, h: 0 }, { w: 0, h: 0 })).toEqual({ w: 0, h: 0 });
  });

  it("oriented 为 0 / 失败：fallback 到 natural", () => {
    expect(safeOrientedSize({ w: 2880, h: 1616 }, { w: 0, h: 0 })).toEqual({ w: 2880, h: 1616 });
  });

  it("natural 为 0（图像未加载完）：用 oriented", () => {
    // 切图瞬间 <img> 还未拿到像素，但 visualW/H 已经 fetch 回来了 → 用 oriented
    expect(safeOrientedSize({ w: 0, h: 0 }, { w: 2880, h: 1616 })).toEqual({ w: 2880, h: 1616 });
  });

  it("PNG 无 EXIF（natural == oriented）：用 natural（默认）", () => {
    // 场景_00079_ 这类正常图：naturalW/H 与 visualW/H 完全一致
    const nat = { w: 2064, h: 1152 };
    const ort = { w: 2064, h: 1152 };
    expect(safeOrientedSize(nat, ort)).toEqual(nat);
  });

  it("大横图切图瞬间：natural 是新图、oriented 仍是旧图（小 aspect 差异）：用 natural（防御旧值污染）", () => {
    // 这就是场景_00002_ 变形的根因：
    //   新图 2880×1616 (aspect 1.782)，
    //   旧 visualW/H 留在 2064×1152 (aspect 1.792)，
    //   差异只 ~0.56%，远小于 20% 阈值，必须用 natural 杜绝变形。
    const nat = { w: 2880, h: 1616 };
    const ort = { w: 2064, h: 1152 };
    expect(safeOrientedSize(nat, ort)).toEqual(nat);
  });

  it("90° EXIF 旋转：natural 和 oriented 是 w/h 互换 → 用 oriented", () => {
    // iPhone 竖拍照存成横置 (4000x3000)，视觉是 3000x4000
    // Chrome 的 naturalWidth=4000（存储像素），createImageBitmap 返回 3000x4000（视觉像素）
    const nat = { w: 4000, h: 3000 };
    const ort = { w: 3000, h: 4000 };
    expect(safeOrientedSize(nat, ort)).toEqual(ort);
  });

  it("270° EXIF 旋转：仍然是 w/h 互换 → 用 oriented", () => {
    const nat = { w: 3000, h: 4000 };
    const ort = { w: 4000, h: 3000 };
    expect(safeOrientedSize(nat, ort)).toEqual(ort);
  });

  it("180° EXIF 旋转：w/h 不变，aspect 一致，按 natural 处理（不影响视觉尺寸）", () => {
    // 180° 旋转是同尺寸，浏览器会自动回正；createImageBitmap 也返回同尺寸
    const nat = { w: 3000, h: 2000 };
    const ort = { w: 3000, h: 2000 };
    expect(safeOrientedSize(nat, ort)).toEqual(nat);
  });

  it("aspect 严重不一致（>20%，兜底）：用 oriented", () => {
    // 不是标准的 90° 互换，但 oriented 真的反映旋转了（罕见 orientation）
    const nat = { w: 3000, h: 2000 }; // aspect 1.5
    const ort = { w: 2400, h: 1800 }; // aspect 1.333
    // diff = |1.5 - 1.333| / 1.5 = 0.111 (11.1%) < 20% → 还是用 natural
    expect(safeOrientedSize(nat, ort)).toEqual(nat);

    // 差异 > 20% 时切到 oriented
    const nat2 = { w: 4000, h: 1000 }; // aspect 4.0
    const ort2 = { w: 1200, h: 1800 }; // aspect 0.667
    // diff = |4.0 - 0.667| / 4.0 = 0.833 = 83.3% > 20% → oriented
    expect(safeOrientedSize(nat2, ort2)).toEqual(ort2);
  });

  it("跨图：两张大横图 aspect 几乎一致（差异 ~0.56%）：用 natural（这不是 EXIF）", () => {
    // 场景_00002_ (2880x1616) vs 场景_00079_ (2064x1152)
    // aspect 差异只 0.56%，远小于 20% 也不是 w/h 互换，所以走 natural = 不会被旧值拐骗
    expect(
      safeOrientedSize({ w: 2880, h: 1616 }, { w: 2064, h: 1152 })
    ).toEqual({ w: 2880, h: 1616 });
  });

  it("不会修改入参（immutability）", () => {
    const nat = { w: 4000, h: 3000 };
    const ort = { w: 3000, h: 4000 };
    safeOrientedSize(nat, ort);
    expect(nat).toEqual({ w: 4000, h: 3000 });
    expect(ort).toEqual({ w: 3000, h: 4000 });
  });
});
