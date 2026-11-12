import { describe, expect, it } from "vitest";
import {
  MASK_EDGE_LIMIT, MASK_EMPTY_PIXELS, cellAcceptsMask, countMaskPixels, isMaskEmpty, maskBadgeText,
  maskCanvasSize, maskEntryLabel, maskHeroKey, maskMode, maskModeLabel, maskPromptSummary,
  maskRequestPayload, maskableCellKeys, paintedMaskCount, promptEmptyHint, promptMayBeEmpty,
  stripDataUrl, strokePoints, templateAcceptsMask, type MaskEdit,
} from "../lib/mask";
import { referenceCells, type CloneSlot, type CloneTemplate } from "../lib/clone";

/**
 * 遮罩编辑的规则层（lib/mask.ts）。
 *
 * 画布与指针事件在 happy-dom 里跑不动，所以规则全抽在这个模块里测：
 * 「哪一格能画遮罩」「留空算不算一个模式」「画了几个点算没画」「提交的请求体长什么样」
 * 这三件事直接决定点生成之后出去的是不是用户圈的那一块，不能只靠肉眼验收。
 */

const tpl = (slots: CloneSlot[], over: Partial<CloneTemplate> = {}): CloneTemplate => ({
  id: 1, name: "闪寻遮罩编辑", slots, default_prompt: "", is_active: true,
  created_at: "", updated_at: "", node_count: 35, prompt_count: 2, reference_count: 1, control_count: 3, ...over,
});

const promptSlot: CloneSlot = {
  kind: "prompt", node: "307", input: "value", label: "完整提示词", allow_empty: true,
  empty_hint: "留空＝把涂绿的地方移除",
};
const removeSlot: CloneSlot = { kind: "prompt", node: "118", input: "prompt", label: "移除指令", value: "移除图像中的绿色区域" };
const maskSlot: CloneSlot = { kind: "image", node: "193", input: "image", label: "图片1", mask: "alpha" };
const plainSlot: CloneSlot = { kind: "image", node: "200", input: "image", label: "图片2" };
const maskEdit = (over: Partial<MaskEdit> = {}): MaskEdit => ({
  coverage: "data:image/png;base64,YWJj", png: "YWJj", tint: "data:image/png;base64,ZA==",
  pixels: 500, imageId: 7, ...over,
});

describe("画布尺寸与笔迹", () => {
  it("没超上限就照原图大小画，别无缘无故糊一遍", () => {
    expect(maskCanvasSize(1328, 1328)).toEqual({ width: 1328, height: 1328 });
    expect(maskCanvasSize(4096, 2048)).toEqual({ width: 4096, height: 2048 });
  });

  it("长边超过后端上限才等比降下来（超了后端直接拒收）", () => {
    const got = maskCanvasSize(8192, 4096);
    expect(got).toEqual({ width: MASK_EDGE_LIMIT, height: 2048 });
    expect(Math.max(got.width, got.height)).toBeLessThanOrEqual(MASK_EDGE_LIMIT);
  });

  it("脏数据（0 或负数）不许长成 0 像素画布，不然画笔点了没反应", () => {
    expect(maskCanvasSize(0, 0).width).toBeGreaterThanOrEqual(1);
    expect(maskCanvasSize(-5, 10).height).toBeGreaterThanOrEqual(1);
  });

  it("两个位置之间补点：快速拖动画出来的是线，不是虚线", () => {
    const pts = strokePoints({ x: 0, y: 0 }, { x: 300, y: 0 }, 20);
    expect(pts.length).toBeGreaterThan(10);
    expect(pts[pts.length - 1]).toEqual({ x: 300, y: 0 });
    const steps = pts.map((p, i) => {
      const prev = i ? pts[i - 1] : { x: 0, y: 0 };
      return Math.hypot(p.x - prev.x, p.y - prev.y);
    });
    // 相邻两点的间距不许超过笔刷半径：超过就会露出没涂到的缝
    expect(Math.max(...steps)).toBeLessThanOrEqual(20);
  });

  it("原地不动也要落一个点，单击得涂出一个圆", () => {
    expect(strokePoints({ x: 5, y: 5 }, { x: 5, y: 5 }, 30)).toEqual([{ x: 5, y: 5 }]);
  });

  it("斜着拖同样连得上", () => {
    const pts = strokePoints({ x: 0, y: 0 }, { x: 210, y: 210 }, 24);
    expect(pts[pts.length - 1].x).toBeCloseTo(210);
    expect(pts.every((p) => Math.abs(p.x - p.y) < 1e-6)).toBe(true);
  });
});

describe("涂了多少像素", () => {
  const rgba = (alphas: number[]) => {
    const out = new Uint8ClampedArray(alphas.length * 4);
    alphas.forEach((a, i) => { out[i * 4 + 3] = a; });
    return out;
  };

  it("按 alpha 数，涂的是什么颜色不算数", () => {
    expect(countMaskPixels(rgba([255, 0, 12, 1]))).toBe(2);
  });

  it("半透明的边不算涂到（阈值挡掉抗锯齿的毛边）", () => {
    expect(countMaskPixels(rgba([0, 6, 8, 200]))).toBe(1);
  });

  it("涂到 9 个像素算没画：孤海那台节点把 10 像素以下当空遮罩强制成全白", () => {
    expect(isMaskEmpty(MASK_EMPTY_PIXELS - 1)).toBe(true);
    expect(isMaskEmpty(MASK_EMPTY_PIXELS)).toBe(false);
  });
});

describe("data URL 与提交体", () => {
  it("前缀剥掉，后端两种都收但请求体小一成", () => {
    expect(stripDataUrl("data:image/png;base64,YWJj")).toBe("YWJj");
    expect(stripDataUrl("YWJj")).toBe("YWJj");
  });

  it("一张遮罩都没画就不许凭空多出 masks 键", () => {
    expect(maskRequestPayload({})).toEqual({});
    expect(maskRequestPayload({ "193.image": undefined })).toEqual({});
    expect(maskRequestPayload({ "193.image": maskEdit() })).toEqual({ "193.image": "YWJj" });
  });

  it("空遮罩（用户全擦干净了）不进请求体，但格子上的标记该跟着没了", () => {
    const wiped = maskEdit({ pixels: 3, png: "" });
    expect(maskRequestPayload({ "193.image": wiped })).toEqual({});
    expect(maskBadgeText(wiped)).toBe("");
    expect(paintedMaskCount({ "193.image": wiped })).toBe(0);
    expect(paintedMaskCount({ "193.image": maskEdit(), "200.image": undefined })).toBe(1);
  });
});

describe("哪一格能画遮罩", () => {
  it("只看后端给的标记", () => {
    expect(cellAcceptsMask({ key: "193.image", label: "图片1", slotLabel: "加载图像", mask: "alpha" })).toBe(true);
    expect(cellAcceptsMask({ key: "200.image", label: "图片2", slotLabel: "加载图像" })).toBe(false);
    expect(cellAcceptsMask({ key: "9.audio", label: "音频1", slotLabel: "加载音频", kind: "audio", mask: "alpha" })).toBe(false);
    expect(cellAcceptsMask(undefined)).toBe(false);
  });

  it("后端带了参考格清单就照它认，扩位也跟着母槽走", () => {
    const template = tpl([promptSlot, maskSlot], {
      reference_cells: [
        { key: "193.image", kind: "image", ordinal: 1, label: "图片1", slot_label: "加载图像", mask: "alpha" },
        { key: "193.image::image_2", kind: "image", ordinal: 2, label: "图片2", slot_label: "加载图像", mask: "alpha" },
      ],
    });
    expect(maskableCellKeys(template)).toEqual(["193.image", "193.image::image_2"]);
    expect(maskHeroKey(template)).toBe("193.image");
    expect(templateAcceptsMask(template)).toBe(true);
  });

  it("后端没带清单时前端按槽位现算，也得和后端同一口径（扩位继承母槽的遮罩能力）", () => {
    const grown: CloneSlot = {
      ...maskSlot,
      grow: { node: "582", group: "images", names: ["image_2"] },
    };
    const template = tpl([promptSlot, grown, plainSlot]);
    expect(referenceCells(template).map((cell) => [cell.key, cell.mask])).toEqual([
      ["193.image", "alpha"],
      ["200.image", ""],
      ["193.image::image_2", "alpha"],
    ]);
    expect(maskableCellKeys(template)).toEqual(["193.image", "193.image::image_2"]);
  });

  it("MASK 没接出去的工作流：一份都认不出来，也不许发画笔", () => {
    const template = tpl([promptSlot, plainSlot]);
    expect(maskableCellKeys(template)).toEqual([]);
    expect(maskHeroKey(template)).toBe("");
    expect(templateAcceptsMask(template)).toBe(false);
  });
});

describe("提示词留空是一个模式", () => {
  it("只有工作流自己声明了 allow_empty 才算，别的照旧得填", () => {
    expect(promptMayBeEmpty(tpl([promptSlot, maskSlot]))).toBe(true);
    expect(promptMayBeEmpty(tpl([{ ...promptSlot, allow_empty: undefined }, maskSlot]))).toBe(false);
    expect(promptMayBeEmpty(tpl([removeSlot, maskSlot]))).toBe(false);
    expect(promptMayBeEmpty(null)).toBe(false);
  });

  it("留空时说什么由工作流自己写，前端不替它编", () => {
    expect(promptEmptyHint(tpl([promptSlot, maskSlot]))).toBe("留空＝把涂绿的地方移除");
    expect(promptEmptyHint(tpl([removeSlot]))).toBe("");
  });

  it("填了就是局部重绘，留空就是移除，两处回显只认这一个判据", () => {
    expect(maskMode("把背景换成雪地")).toBe("repaint");
    expect(maskMode("   ")).toBe("remove");
    expect(maskModeLabel("")).toContain("移除");
    expect(maskModeLabel("换雪地")).toContain("局部重绘");
  });
});

describe("编辑层的只读回显", () => {
  it("提示词摘要截一句就够认出来，不留空时不许显示成空白", () => {
    expect(maskPromptSummary("")).toBe("（提示词留空）");
    expect(maskPromptSummary("  \n ")).toBe("（提示词留空）");
    expect(maskPromptSummary("一只  橘猫\n坐在窗台")).toBe("一只 橘猫 坐在窗台");
    const long = "长".repeat(60);
    expect(maskPromptSummary(long).length).toBeLessThanOrEqual(41);
    expect(maskPromptSummary(long).endsWith("…")).toBe(true);
  });

  it("左上角那颗：画过说「改遮罩」，没画说「画遮罩」", () => {
    expect(maskEntryLabel(undefined)).toBe("画遮罩");
    expect(maskEntryLabel(maskEdit({ pixels: 2 }))).toBe("画遮罩");
    expect(maskEntryLabel(maskEdit())).toBe("改遮罩");
  });
});