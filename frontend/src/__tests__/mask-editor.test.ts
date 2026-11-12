import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MASK_EDGE_LIMIT, MASK_EMPTY_PIXELS, cellAcceptsMask, countMaskPixels, isMaskEmpty, maskBadgeText,
  maskBaseImageUrl, maskBrushRadius, maskCanvasScale, maskCanvasSize, maskEntryLabel, maskHeroKey, maskMode, maskModeLabel,
  MASK_CLICK_SLOP, MASK_INK_DEFAULT, MASK_INK_RGB, MASK_RECT_MIN, MASK_TINTS, MASK_TINT_DEFAULT,
  maskIsClick, maskPixelsInSource, maskPromptSummary, maskRectContains, maskRectIsReal, maskRectMove,
  maskRectOp, maskRectSelect, maskSquareSelect, maskTintRgb,
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

/**
 * 框选（2026-11-12 苏醒要加的，第二次补了减选区）：圈一整块要的是硬边界，
 * 用画笔涂「这台机器整个」永远涂不整齐；圈多了再 Alt 拖一框挖掉，不必擦干净重画。
 * 规则同样全在这里测，画布那部分只能读源文件。
 */
describe("框选（Shift 加 / Alt 减）", () => {
  it("Shift=加当前工具那一块，Alt=减一块，两个键都没按就不算框选", () => {
    expect(maskRectOp({ shiftKey: true }, "paint")).toBe("paint");
    // 橡皮状态下 Shift 拖出来的那一框是减，与画笔拖出来是加对称
    expect(maskRectOp({ shiftKey: true }, "erase")).toBe("erase");
    // Alt 抢在橡皮之前：手里是画笔也能直接挖一块，不必先按 E 换工具
    expect(maskRectOp({ altKey: true }, "paint")).toBe("erase");
    expect(maskRectOp({ altKey: true, shiftKey: true }, "paint")).toBe("erase");
    expect(maskRectOp({}, "paint")).toBeNull();
  });

  it("两个对角不管往哪个方向拖，都归一成正放的同一块", () => {
    const down = maskRectSelect({ x: 10, y: 20 }, { x: 60, y: 90 }, 1000, 1000);
    const back = maskRectSelect({ x: 60, y: 90 }, { x: 10, y: 20 }, 1000, 1000);
    expect(down).toEqual({ x: 10, y: 20, width: 50, height: 70 });
    expect(back).toEqual(down);
  });

  it("拖出画面外的部分裁进画布，不许长出负宽度的框", () => {
    expect(maskRectSelect({ x: 900, y: 900 }, { x: 2000, y: -500 }, 1000, 800))
      .toEqual({ x: 900, y: 0, width: 100, height: 800 });
  });

  it("手抖拖出一两个像素不算一次操作（不占撤销，也不送出四个像素的遮罩）", () => {
    expect(maskRectIsReal(maskRectSelect({ x: 50, y: 50 }, { x: 50, y: 50 }, 100, 100))).toBe(false);
    expect(maskRectIsReal({ x: 0, y: 0, width: MASK_RECT_MIN, height: MASK_RECT_MIN })).toBe(true);
    expect(maskRectIsReal(null)).toBe(false);
  });

  it("坐标算出 NaN 就当没拖，不许把整张画布涂掉", () => {
    expect(maskRectSelect({ x: 0, y: 0 }, { x: NaN, y: NaN }, 100, 100))
      .toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(maskRectIsReal(maskRectSelect({ x: 0, y: 0 }, { x: NaN, y: NaN }, 100, 100))).toBe(false);
  });

  it("拖动中只画预览层，松手才落进遮罩；撤销重放也认得这种笔迹", () => {
    const src = componentSource("MaskEditor.svelte");
    expect(src).toContain('class="me-live"');
    const move = src.slice(src.indexOf("function onMove"), src.indexOf("function onUp"));
    // 只看框选那一段：画笔那段本来就要一路 apply 下去，别拿它当反例
    const rectBranch = move.slice(move.indexOf("if (rectDrag) {"), move.indexOf("trackCursor(e);"));
    expect(rectBranch).toContain("drawPreview(");
    expect(rectBranch).not.toMatch(/\bapply\(|\bblock\(|\bcommitRect\(/);
    const up = src.slice(src.indexOf("function onUp"), src.indexOf("function undo"));
    expect(up).toContain("maskRectIsReal(rect)");
    // 加/减按拖的那一刻定下的算，不按松手时的工具或修饰键
    expect(up).toContain("drag.op");
    // 选框工具：松手先悬着（可挪可取消）；画笔态的 Shift/Alt 框：松手即落进遮罩层
    expect(up).toContain("pending = { rect, op: drag.op };");
    expect(up).toContain("commitRect(rect, drag.op)");
    const applyFn = src.slice(src.indexOf("function apply("), src.indexOf("function drawSeed"));
    expect(applyFn).toContain("if (s.rect)");
  });

  it("起笔那一下的加/减交给 maskRectOp 判，别在组件里另写一套修饰键", () => {
    const down = componentSource("MaskEditor.svelte");
    expect(down).toContain("maskRectOp(e, tool)");
    expect(down).toContain("op: rectOp");
  });

  it("提示里要说出 Shift 加、Alt 减，别让人自己猜", () => {
    const hint = componentSource("MaskEditor.svelte");
    expect(hint).toContain("Shift+左键");
    expect(hint).toContain("Alt+左键");
  });
});
const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const componentSource = (name: string): string =>
  readFileSync(resolve(srcRoot, "components", name), "utf8");

/**
 * 层序护栏（2026-11-12 真机走查后补）。
 *
 * happy-dom 不注入 Svelte 的 scoped CSS，computed style 里压根拿不到 z-index，
 * 所以只能照 type-scale.test.ts 的路子读源文件比数值。写法是丑了点，但被底栏挡住的那颗
 * 红色「生成」是误点就真跑一次本地生成的脚枪，值得钉死在测试里。
 */



/** 取某个选择器那条规则里的第一个 z-index；没写 z-index 返回 null。 */
function zIndexOf(css: string, selector: string): number | null {
  const at = css.indexOf("\n  " + selector + " {");
  if (at < 0) throw new Error("样式里找不到 " + selector + "（改了写法就顺手更新这条测试）");
  const matched = css.slice(at, css.indexOf("}", at)).match(/z-index:\s*(\d+)/);
  return matched ? Number(matched[1]) : null;
}

describe("遮罩编辑层的层序", () => {
  const maskEditor = componentSource("MaskEditor.svelte");
  const cloneModal = componentSource("CloneModal.svelte");

  it(".me 压得住弹窗里每一件还点得着的东西", () => {
    const editor = zIndexOf(maskEditor, ".me");
    expect(editor).not.toBeNull();
    // sticky 底栏、工作流那颗 pill 和它的弹层、生成钮：画遮罩时一件都不许透出来
    for (const sel of [".cm-dock", ".cm-pill", ".cm-pop-scrim", ".cm-pop", ".cm-actions"]) {
      const z = zIndexOf(cloneModal, sel);
      expect(z, sel + " 现在没有 z-index，这条测试的口径要重新想").not.toBeNull();
      expect(editor, ".me(" + editor + ") 压不住 " + sel + "(" + z + ")：画遮罩时它会露在编辑层上面，看着像在画遮罩，点下去是真跑图")
        .toBeGreaterThan(z as number);
    }
  });

  it(".cm-panel 还是不写 z-index（写了就把底栏关进自己的 layer，上面那场的比较口径作废）", () => {
    expect(zIndexOf(cloneModal, ".cm-panel")).toBeNull();
  });

  it("编辑层待在 .cm-backdrop 那一层里面，不往外层跑", () => {
    expect(zIndexOf(maskEditor, ".me") as number)
      .toBeLessThan(zIndexOf(cloneModal, ".cm-backdrop") as number);
  });
});

/**
 * Svelte 5 runes 的坑：模板里读到的普通 `let` 不参与更新（编译器直接给
 * `non_reactive_update` 警告，svelte-check 只算 warning、门禁拦不住）。
 * 「重做」那颗按钮的 disabled 就踩过一次——画完一笔再撤销，它还是灰的，重做这个功能等于没做。
 * 画布在 happy-dom 里跑不动，测不了「撤销之后重做变亮」，那就把这类变量本身钉住。
 */
it("编辑层里没有假装是状态的普通变量", () => {
  const src = readFileSync(resolve(srcRoot, "components", "MaskEditor.svelte"), "utf8");
  const scriptEnd = src.indexOf("</script>");
  const styleStart = src.indexOf("<style>");
  if (scriptEnd < 0 || styleStart < 0) throw new Error("MaskEditor.svelte 的结构和这条测试想的不一样");

  const script = src.slice(0, scriptEnd);
  // 属性值和字符串里的中文不参与匹配：class="me-canvas" 会让 \bcanvas\b 误报
  const markup = src.slice(scriptEnd, styleStart).replace(/"[^"]*"/g, '""');
  const plainLets = [...script.matchAll(/^ {2}let (\w+)(.*)$/gm)]
    .filter((m) => !m[2].includes("$state"))
    .map((m) => m[1]);

  expect(plainLets.length).toBeGreaterThan(0);
  const offenders = plainLets.filter((name) => new RegExp("\\b" + name + "\\b").test(markup));
  expect(offenders, "这些普通 let 被模板读到了，改成 $state：" + offenders.join(", ")).toEqual([]);
});

/**
 * 底图档位与「按源图说话」的两个数——这两条都是真跑一次本机 ComfyUI 量出来的。
 *
 * 列表给的 original_url 是 feed 用的 ?max=1024 预览，曾经就拿它当编辑器底图：一张
 * 1136×2016 的图进画布只剩 577×1024，画布跟着小图走，导出后后端又把遮罩拉回原图尺寸贴上去，
 * 于是「直径 60」的笔画出 124 宽的一条，编辑器说已涂 62290、送进 ComfyUI 的那张实际 252182。
 * 修法是两件事：底图按参考图真实分辨率要；真降过档（源图超 4096）时笔刷与计数换算回源图口径。
 */
describe("底图档位与源图口径", () => {
  it("上限以内直接要原图，别拿 ?max=1024 那张预览画遮罩", () => {
    expect(maskBaseImageUrl("/api/images/1478/file?max=1024&v=2-1794448268-abc", 1136, 2016))
      .toBe("/api/images/1478/file?v=2-1794448268-abc");
  });

  it("超过画布上限的按上限要，PSD 的 fit 去掉、cache-bust 的 v 留着", () => {
    expect(MASK_EDGE_LIMIT).toBe(4096);
    expect(maskBaseImageUrl("/api/images/9/file?max=1024&fit=psd-portrait&v=7", 6000, 4000))
      .toBe("/api/images/9/file?max=4096&v=7");
  });

  it("地址空的就交回空串，本来就没降档的就原样还回去", () => {
    expect(maskBaseImageUrl("", 1136, 2016)).toBe("");
    expect(maskBaseImageUrl("/api/images/3/file", 100, 100)).toBe("/api/images/3/file");
  });

  it("画布没缩算 1，缩过按比例，源图尺寸不知道也别乱缩", () => {
    expect(maskCanvasScale(1136, 1136)).toBe(1);
    expect(maskCanvasScale(1136, 0)).toBe(1);
    expect(maskCanvasScale(500, 1000)).toBe(0.5);
  });

  it("笔刷直径按源图说话，落到缩过的画布上半径跟着缩", () => {
    expect(maskBrushRadius(60, 1136, 1136)).toBe(30);
    expect(maskBrushRadius(60, 500, 1000)).toBe(15);
    expect(maskBrushRadius(0, 500, 1000)).toBe(0.5);
  });

  it("已涂多少像素按源图报：画布线性缩一半，面积差四倍", () => {
    expect(maskPixelsInSource(62290, 1136, 1136)).toBe(62290);
    expect(maskPixelsInSource(62290, 500, 1000)).toBe(249160);
    expect(maskPixelsInSource(1, 500, 1000)).toBe(4);
  });

  it("编辑器别再把直径乘成两倍画圈，下笔也别绕过换算直接 brush/2", () => {
    const src = componentSource("MaskEditor.svelte");
    expect(src).toContain("const unitScale = $derived(maskCanvasScale(size.width, sourceWidth));");
    expect(src).toContain("r: maskBrushRadius(brush, size.width, sourceWidth)");
    expect(src).toContain("已涂 ${paintedSource.toLocaleString(\"zh-CN\")} 处像素");
    expect(src).not.toMatch(/brush\s*\*\s*[^\n]*\*\s*2/);
    expect(src).not.toMatch(/r:\s*brush\s*\/\s*2/);
  });

  it("再次创作把底图交给 maskBaseImageUrl，并把参考图的真实宽度告诉编辑器", () => {
    const src = componentSource("CloneModal.svelte");
    expect(src).toContain("maskBaseImageUrl(");
    expect(src).toContain("sourceWidth={maskRef?.width ?? 0}");
    expect(src).not.toMatch(/const maskSrc = \$derived\(maskRef \? backendUrl\(maskRef\.original_url/);
  });
});

/**
 * 显示层的一致性（2026-11-12 第二轮）。
 *
 * 苏醒指出「画笔颜色、画框颜色、遮罩区域得到的颜色不一致」：其实是同一个色、三种浓度，
 * 因为显示层是一路累加 alpha 叠出来的——画笔那一笔里圆点互相叠，0.4 叠几层就成实心，
 * 框选只叠一层。修法是显示层不再自己叠，每次从遮罩层现染。happy-dom 不放画布，
 * 只能读源文件钉这条口径，但它钉的是「别再退回累加」这个真实的回退风险。
 */
describe("给人看的那一层是遮罩层的派生副本", () => {
  const editor = componentSource("MaskEditor.svelte");

  it("重染一次成型：整层拷过去压一次浓度，再 source-in 换成遮罩色", () => {
    const at = editor.indexOf("function paintInk()");
    expect(at, "显示层必须由 paintInk() 从遮罩层派生，不能每笔往它上面叠").toBeGreaterThan(-1);
    const paint = editor.slice(at, editor.indexOf("function syncInk"));
    expect(paint).toContain("k.clearRect(0, 0, size.width, size.height)");
    expect(paint).toContain("k.globalAlpha = ink");
    expect(paint).toContain('k.globalCompositeOperation = "source-in"');
    // 颜色来自色板，但色板第一颗必须还是工作流盖给模型的那个绿（下面那条契约钉着）
    expect(paint).toContain("`rgb(${tintRgb})`");
  });

  it("画笔与框都不再往显示层叠色（叠了就等于把三种浓度那个 bug 请回来）", () => {
    for (const fn of ["function dab(", "function block("]) {
      const body = editor.slice(editor.indexOf(fn), editor.indexOf("\n  }\n", editor.indexOf(fn)));
      expect(body, fn + " 不该再收显示层的颜色").not.toContain("MASK_INK_RGB");
    }
    const apply = editor.slice(editor.indexOf("function apply("), editor.indexOf("function drawSeed"));
    expect(apply).not.toContain("MASK_INK_RGB");
    // 全组件只许 paintInk 一处拿遮罩色去 fill 画布；别处再填一次，就是绕过派生层自己叠色去了。
    const filled = [...editor.matchAll(/fillStyle = `rgb\(\$\{tintRgb\}\)`/g)].map((m) => m.index);
    expect(filled.length).toBe(1);
    const at = filled[0];
    expect(at > editor.indexOf("function paintInk") && at < editor.indexOf("function syncInk"),
      "遮罩色的 fillStyle 只许出现在 paintInk 里").toBe(true);
  });

  it("那一框只画框、不填充（图2 就是虚线框；填充会让人分不清哪块已经算了）", () => {
    const preview = editor.slice(editor.indexOf("function drawPreview"), editor.indexOf("function selection"));
    expect(preview).not.toContain("fillRect");
    expect(preview).not.toContain("fillStyle");
    expect(preview).toContain("setLineDash");
    expect(preview).toContain("strokeRect");
    // 一亮一暗两条线叠着画，压在白墙和夜空上都看得见
    expect(preview).toContain("rgb(255, 255, 255)");
    expect(preview).toContain("rgb(20, 20, 24)");
  });

  it("默认叠色对齐工作流盖给模型看的那一层（204 透明度 0.4）", () => {
    expect(MASK_INK_DEFAULT).toBe(0.4);
  });

  it("编辑器显示的那个绿，就是随包工作流盖给模型看的那个绿、也是移除指令说的那个颜色", () => {
    // 这条钉的是苏醒连着两轮撞上的同一件事：屏幕上涂红、模型收到绿
    const wf = resolve(srcRoot, "../../backend/app/bundled_workflows/qwen-single-mask-edit.json");
    const doc = JSON.parse(readFileSync(wf, "utf8")) as {
      workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    };
    const painted = Object.values(doc.workflow)
      .find((n) => n.class_type === "LayerUtility: ColorImage");
    const line = Object.values(doc.workflow)
      .find((n) => typeof n.inputs?.prompt === "string" && String(n.inputs.prompt).includes("区域"));
    expect(painted, "随包工作流里没有那颗纯色图像节点").toBeTruthy();
    const hex = String(painted!.inputs.color).replace("#", "").toLowerCase();
    expect(hex.length).toBe(6);
    const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ");
    expect(MASK_INK_RGB, "编辑器显示色与工作流染色节点不同色").toBe(rgb);
    // 用户一进来没点色板时真正用的那支笔，也得是这颗绿
    expect(maskTintRgb(MASK_TINT_DEFAULT), "色板默认那颗不是工作流盖给模型的颜色").toBe(rgb);
    expect(MASK_TINTS[0].rgb).toBe(rgb);
    // 那句移除指令里的颜色名也要对得上（后端还有一条同色的测试，两头都钉）
    const names: Record<string, string> = {
      "00ff00": "绿", ff0000: "红", "0000ff": "蓝", ffffff: "白", "000000": "黑",
    };
    const named = names[hex];
    expect(named, `颜色名对照表里没有 #${hex}，加上它，别放过这条契约`).toBeTruthy();
    expect(String(line!.inputs.prompt)).toContain(named + "色");
  });
});

/**
 * 选框工具的键位与几何（2026-11-12 照孤海那台编辑器的说明行做）：
 * Shift=1:1／加选区 · Alt=减选区 · 框内拖动移动 · 外部单击取消。
 * 四件全在规则层测，组件那半只能读源文件。
 */
describe("选框工具（图2 那套键位）", () => {
  it("选框工具下左键就画框；Alt 变减；画笔/橡皮下不按修饰键不画框", () => {
    expect(maskRectOp({}, "select")).toBe("paint");
    expect(maskRectOp({ altKey: true }, "select")).toBe("erase");
    expect(maskRectOp({ shiftKey: true }, "select")).toBe("paint"); // Shift 给 1:1，不改加减
    expect(maskRectOp({}, "paint")).toBeNull();
    expect(maskRectOp({}, "erase")).toBeNull();
    expect(maskRectOp({ shiftKey: true }, "erase")).toBe("erase");
  });

  it("Shift 锁 1:1：边长取短的那边，四个方向都保方向", () => {
    expect(maskSquareSelect({ x: 0, y: 0 }, { x: 100, y: 40 }, 1000, 1000))
      .toEqual({ x: 0, y: 0, width: 40, height: 40 });
    expect(maskSquareSelect({ x: 100, y: 100 }, { x: 40, y: 60 }, 1000, 1000))
      .toEqual({ x: 60, y: 60, width: 40, height: 40 });
    expect(maskSquareSelect({ x: 100, y: 20 }, { x: 20, y: 60 }, 1000, 1000))
      .toEqual({ x: 60, y: 20, width: 40, height: 40 });
  });

  it("1:1 也照样钳进画面，不许长出负宽度的框", () => {
    const r = maskSquareSelect({ x: 980, y: 980 }, { x: 3000, y: 3000 }, 1000, 1000);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(1000);
    expect(r.y + r.height).toBeLessThanOrEqual(1000);
  });

  it("框内/框外判定与挪框钳位（框内拖动移动）", () => {
    const box = { x: 10, y: 20, width: 30, height: 40 };
    expect(maskRectContains(box, { x: 25, y: 30 })).toBe(true);
    expect(maskRectContains(box, { x: 40, y: 60 })).toBe(true); // 边上算在里面
    expect(maskRectContains(box, { x: 9, y: 30 })).toBe(false);
    expect(maskRectMove(box, 5, 5, 100, 100)).toEqual({ x: 15, y: 25, width: 30, height: 40 });
    // 往左上死拽也只贴在 (0,0)，尺寸不许被拽变形
    expect(maskRectMove(box, -9999, -9999, 100, 100)).toEqual({ x: 0, y: 0, width: 30, height: 40 });
    expect(maskRectMove(box, 9999, 9999, 100, 100)).toEqual({ x: 70, y: 60, width: 30, height: 40 });
  });

  it("按下与松开差几个像素算单击，不算拖框（外部单击取消靠它认）", () => {
    expect(maskIsClick({ x: 50, y: 50 }, { x: 50, y: 50 })).toBe(true);
    expect(maskIsClick({ x: 50, y: 50 }, { x: 50 + MASK_CLICK_SLOP, y: 50 })).toBe(true);
    expect(maskIsClick({ x: 50, y: 50 }, { x: 51 + MASK_CLICK_SLOP, y: 50 })).toBe(false);
    expect(maskIsClick({ x: 50, y: 50 }, { x: 400, y: 300 })).toBe(false);
  });

  it("色板只换显示色：认不出来回默认，不许画出全透明", () => {
    expect(MASK_TINTS.length).toBeGreaterThanOrEqual(3);
    expect(maskTintRgb("green")).toBe(MASK_INK_RGB);
    expect(maskTintRgb("没有这个色")).toBe(maskTintRgb(MASK_TINT_DEFAULT));
    expect(maskTintRgb(undefined)).toBe(maskTintRgb(MASK_TINT_DEFAULT));
    for (const t of MASK_TINTS) expect(t.rgb).toMatch(/^\d{1,3}, \d{1,3}, \d{1,3}$/);
  });
});

/**
 * 图2 那套版式与「悬着一框」的生命周期：happy-dom 不放画布，只能读源文件钉。
 * 钉的是「别退回一松手就焊死、别把工具按钮弄丢」这类真实回退。
 */
describe("图2 版式与悬框生命周期", () => {
  const editor = componentSource("MaskEditor.svelte");

  it("三件工具都在顶栏上，选框是一件工具不是一个修饰键", () => {
    const bar = editor.slice(editor.indexOf('aria-label="工具"'), editor.indexOf('aria-label="遮罩显示色"'));
    expect(bar).toContain(">画笔</button>");
    expect(bar).toContain(">橡皮擦</button>");
    expect(bar).toContain(">选框</button>");
    expect(bar).toContain('pickTool("select")');
  });

  it("说明行照图2 那四个键位写，别让人自己猜", () => {
    for (const s of ["Shift=1:1", "Alt=减选区", "框内拖动移动", "外部单击取消"]) {
      expect(editor, "说明行少了「" + s + "」").toContain(s);
    }
  });

  it("反转、清空、取消、保存遮罩四颗按钮齐（图2 右侧那一排）", () => {
    for (const s of [">反转</button>", ">清空</button>", ">取消</button>", ">保存遮罩</button>"]) {
      expect(editor, "少了按钮 " + s).toContain(s);
    }
    expect(editor).toContain("onclick={invertMask}");
  });

  it("反转进笔迹栈并重放，撤销一次退回反转之前", () => {
    expect(editor).toContain("invert: true");
    const redraw = editor.slice(editor.indexOf("function redraw()"), editor.indexOf("function recount"));
    expect(redraw).toContain("if (s.invert) invertLayer(m);");
    const invert = editor.slice(editor.indexOf("function invertMask"), editor.indexOf("function redraw()"));
    // 先落定手上那一框，再反；空遮罩不给反（反完等于整图都要改，是误触）
    expect(invert).toContain("if (emptyMask) return;");
    expect(invert).toContain("commitPending();");
  });

  it("悬着那一框：换工具/开始涂画/保存都先落定，撤销先撤掉它，清空丢掉它", () => {
    const pick = editor.slice(editor.indexOf("function pickTool"), editor.indexOf("function fitView"));
    expect(pick).toContain("commitPending();");
    const up = editor.slice(editor.indexOf("function onUp"), editor.indexOf("function undo"));
    expect(up).toContain("cancelPending();"); // 外部单击取消
    const undo = editor.slice(editor.indexOf("function undo()"), editor.indexOf("function redo"));
    expect(undo).toContain("cancelPending();");
    const clear = editor.slice(editor.indexOf("function clearAll"), editor.indexOf("function onWheel"));
    expect(clear).toContain("pending = null;");
    const finish = editor.slice(editor.indexOf("function finish"), editor.indexOf("onMount("));
    expect(finish).toContain("commitPending();");
  });

  it("界面读的是 hasPending，不是普通 let pending（模板读普通 let 这个仓库有护栏）", () => {
    const markup = editor.slice(editor.indexOf("<header"));
    expect(markup).toContain("hasPending");
    expect(markup).not.toMatch(/!pending\b/);
  });
});
