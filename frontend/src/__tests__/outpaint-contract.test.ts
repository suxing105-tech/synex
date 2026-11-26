import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { slotKey, type CloneSlot, type CloneTemplate } from "../lib/clone";
import {
  OUTPAINT_EMPTY_REASON, OUTPAINT_FACTORY, OUTPAINT_MAX_EDGE,
  OUTPAINT_MAX_PAD, OUTPAINT_RATIOS, OUTPAINT_TINT, OUTPAINT_UNITS,
  boardIssue, boardPads, boardReadout, boardShown, dragBoard, isBoardEmpty,
  outpaintImageKey, outpaintSlots, outputGeometry, ratioPads, readBoard, sidePads,
  sideValues, slideBoard, writeBoard, type OutpaintBoardState, type OutpaintSides, type OutpaintSize,
} from "../lib/outpaint";

/**
 * 外补画板那套算术的契约：每个期望值都是照 ComfyUI 那台节点的源码手算出来的，不是「跑出来是多少就写多少」。
 *
 * 两处真源，各管哪一半写在 lib/outpaint.ts 顶上，这里只登记口径：
 * - 服务端 "custom_nodes/Goohaitools-comfyui/nodes/外补画板（可视化）.py"
 *   —— 成图补多少像素由它说了算（截断、双轴 ceil、最长边压回、floor(x+0.5)）。
 * - 节点自带前端 "web/js/goohai_outpaint_visual.js"
 *   —— 拖边框的手感（对侧钉死、Shift 同轴对称、像素换单位值用 round）。
 * 用例只读仓库里随包那份工作流对数，不去读用户机器上的 ComfyUI：那台机器不在测试的地盘里。
 */

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = resolve(srcRoot, "../../backend/app/bundled_workflows/qwen-single-image-outpaint.json");

interface Entry {
  slots: CloneSlot[];
  workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
}
const entry = JSON.parse(readFileSync(ENTRY, "utf8")) as Entry;

/** 只留画板那六颗，拼成一条前端读得到的模板（后端存进库的就是这个形状）。 */
function boardTemplate(drop?: string): CloneTemplate {
  const board = entry.slots.filter((slot) => slot.ui === "board");
  const kept = drop ? board.filter((slot) => slot.input !== drop) : board;
  return {
    id: 1,
    name: "闪寻扩展图片",
    slots: [...kept, entry.slots.find((slot) => slot.kind === "image")!],
    default_prompt: "",
    is_active: true,
    created_at: "",
    updated_at: "",
    node_count: 0,
    prompt_count: 0,
    reference_count: 0,
    control_count: 0,
  } as unknown as CloneTemplate;
}

const SIZE: OutpaintSize = { w: 1000, h: 1000 };
const zeros: OutpaintSides = { left: 0, right: 0, top: 0, bottom: 0 };
const state = (over: Partial<OutpaintBoardState> = {}): OutpaintBoardState => ({
  ...OUTPAINT_FACTORY,
  ...over,
  raw: { ...zeros, ...(over.raw ?? {}) },
});

it("随包那条扩图的六颗，前端认得出是要开画板", () => {
  const slots = outpaintSlots(boardTemplate());
  expect(slots).not.toBeNull();
  // 四边必须在同一台节点上，画板才写得到一处：随包那就是 48 号那颗外补画板
  expect(slots?.sides.left.node).toBe(slots?.sides.right.node);
  expect(slots?.sides.top.node).toBe(slots?.unit.node);
  expect(slots?.sides.left.input).toBe("左");
  expect(slots?.ratio.input).toBe("gh_visual_ratio");
  // 画板只吃一张底图：它画的那一格必须是这份工作流第一颗图片槽位
  expect(outpaintImageKey(boardTemplate())).toBe(
    slotKey(entry.slots.find((slot) => slot.kind === "image")!),
  );
});

it("六颗少一颗、或者拆到两台节点上，就当这不是画板", () => {
  // 宁可界面上连入口都不摆，也不摆一块拖不动的白板（后端 normalize_slots 同一道闸）
  expect(outpaintSlots(boardTemplate("单位"))).toBeNull();
  expect(outpaintSlots(boardTemplate("gh_visual_ratio"))).toBeNull();
  const split = boardTemplate();
  const slots = outpaintSlots(split);
  const moved: CloneTemplate = {
    ...split,
    slots: split.slots.map((slot) =>
      slot.input === "下" ? { ...slot, node: "99" } : slot,
    ),
  };
  expect(slots).not.toBeNull();
  expect(outpaintSlots(moved)).toBeNull();
});

it("量程、单位、比例、那片灰：那几个数不许谁顺手改一个", () => {
  for (const input of ["左", "右", "上", "下"]) {
    const slot = entry.slots.find((one) => one.input === input)!;
    expect(slot.min).toBe(0);
    expect(slot.max).toBe(OUTPAINT_MAX_PAD); // 节点 INT 的 max 是 3000
  }
  expect(entry.slots.find((one) => one.input === "单位")!.options).toEqual([...OUTPAINT_UNITS]);
  expect(entry.slots.find((one) => one.input === "gh_visual_ratio")!.options).toEqual(OUTPAINT_RATIOS);
  const board = entry.workflow["48"];
  // 主指令叫模型移除的那片灰，必须就是画板补出来的那片
  expect(board.inputs["外补颜色"]).toBe(OUTPAINT_TINT);
  expect(board.inputs["最大输出长边"]).toBe(OUTPAINT_MAX_EDGE);
  // 整除数是 0：outputGeometry 里那段「对齐」分支整个跳过，这层才算得简单。
  // 哪天随包把它调成 8/16，本文件的 outputGeometry 三条就全部作废，必须在这儿先响。
  expect(board.inputs["整除数"]).toBe(0);
});

it("百分比换像素是截断：30% 落在 736 宽的图上是 220 不是 221", () => {
  // 节点原话 int(v * 边长 / 100)；四舍五入的话画板会比成图多画一位
  expect(sidePads("百分比", { ...zeros, left: 30 }, { w: 736, h: 1000 }).left).toBe(220);
  expect(sidePads("百分比", { ...zeros, left: 30 }, { w: 737, h: 1000 }).left).toBe(221);
  expect(sidePads("百分比", { ...zeros, left: 1 }, { w: 50, h: 100 }).left).toBe(0);
  // 像素那档不动数
  expect(sidePads("像素", { ...zeros, left: 220 }, { w: 736, h: 736 }).left).toBe(220);
});

it("像素写回单位值会掉几位，画板必须画掉完那位的那个数", () => {
  // 拖到 221px → 写成 30% → 节点现算 int(30*736/100) = 220：屏幕上从来就不该画 221
  expect(sideValues("百分比", { ...zeros, right: 221 }, { w: 736, h: 736 }).right).toBe(30);
  expect(sidePads("百分比", { ...zeros, right: 30 }, { w: 736, h: 736 }).right).toBe(220);
});

it("boardPads 走服务端那条双轴：只填左边 10%、选 1:1，四边是这么配的", () => {
  // size 800×600：左 10% → trunc(80)=80；倍率 ceil(max(880, 880))=880
  // 横轴补 80（已有 80，按现比例全给左）；竖轴补 280（一条没拖过 → 280//2，上下各 140）
  const pads = boardPads(state({ ratio: "1:1", raw: { ...zeros, left: 10 } }), { w: 800, h: 600 });
  expect(pads).toEqual({ left: 80, right: 0, top: 140, bottom: 140 });
  const geometry = outputGeometry(pads, { w: 800, h: 600 });
  expect([geometry.w, geometry.h]).toEqual([880, 880]);
  expect(geometry.scaled).toBe(false);
});

it("松手那一刻按双轴重算必须不动：画板上的数就是成图要用的数", () => {
  // 起点是「已经凑好 16:9」那一份（1000×1000 补成 1792×1008）：拖边框的位移一律按
  // 指针按下那一帧的那份像素算，所以这条链得从画板上真摆着的数起步，不是从四个 0 起步。
  const start = state({ unit: "像素", ratio: "16:9", raw: { left: 792, right: 0, top: 4, bottom: 4 } });
  expect(boardPads(start, SIZE)).toEqual(start.raw); // 这一步就是「不动」本身
  // 再往外拖 200：横轴 992 → 倍率 ceil(max(1992/16, 1008/9))=125 → 横轴补 1000（对侧钉死，全给左）
  // 竖轴补 125，按本来 4:4 那份摊回去 → 上 63 下 62（nearest(125×4/8)=63）。只增不减，画框只会变大。
  const after = dragBoard(start, SIZE, ["left"], -200, 0);
  expect(after.raw).toEqual({ left: 1000, right: 0, top: 63, bottom: 62 });
  expect(boardPads(after, SIZE)).toEqual(after.raw);
  expect(outputGeometry(after.raw, SIZE)).toMatchObject({ w: 2000, h: 1125 });
  // 再拖 0 像素也必须原样不动：自己算自己飘，是比抖一下更难看的一种错
  expect(dragBoard(after, SIZE, ["left"], 0, 0).raw).toEqual(after.raw);
});

it("百分比模式拖 220 像素，写回的是 30 不是 220", () => {
  // 这条钉的是这层最容易犯的错：把手感算出的像素当百分数写回 controls
  // —— 736 宽的图上 220% 就是 1619 像素，成图会大到没法看
  const after = dragBoard(state({ unit: "百分比" }), { w: 736, h: 736 }, ["right"], 220, 0);
  expect(after.raw.right).toBe(30);
  expect(boardPads(after, { w: 736, h: 736 }).right).toBe(220);
});

it("按住源图在框里挪，只在左右之间重分配，顶到头上也不越界", () => {
  const start = state({ unit: "像素", raw: { ...zeros, left: 200, right: 100 } });
  expect(slideBoard(start, SIZE, 50, 0).raw).toEqual({ ...zeros, left: 250, right: 50 });
  // 一直往右拖，最后左边界顶到 300 就停：四个方向的总量不许被挪动改掉
  expect(slideBoard(start, SIZE, 1000, 0).raw).toEqual({ ...zeros, left: 300, right: 0 });
});

it("四边全空这道闸认的是像素：填了 1% 但截断成 0，也算没扩", () => {
  const tiny = state({ raw: { ...zeros, left: 1 } });
  const size: OutpaintSize = { w: 50, h: 100 }; // 1% × 50 = 0.5 → 截断 0
  expect(boardPads(tiny, size).left).toBe(0);
  expect(isBoardEmpty(boardPads(tiny, size))).toBe(true);
  expect(boardIssue(tiny, size)).toBe(OUTPAINT_EMPTY_REASON);
  // 挪到 2% 才真的有 1 像素可补，闸就放开
  const ok = state({ raw: { ...zeros, left: 2 } });
  expect(boardIssue(ok, size)).toBeNull();
  // 量不到底图尺寸时不在这儿拦：那是参考区那套问题该说的话，别在这儿报个没根据的错
  expect(boardIssue(tiny, { w: 0, h: 0 })).toBeNull();
});

it("成图最长边撞上 5120 就整张等比压回来", () => {
  const pads = { ...zeros, left: 2000 };
  const big = outputGeometry(pads, { w: 4000, h: 3000 }); // 6000×3000 → ×0.8533
  expect([big.w, big.h]).toEqual([5120, 2560]);
  expect([big.totalW, big.totalH]).toEqual([6000, 3000]);
  expect(big.scaled).toBe(true);
  const small = outputGeometry({ ...zeros, left: 200, right: 200 }, SIZE);
  expect([small.w, small.h]).toEqual([1400, 1000]);
  expect(small.scaled).toBe(false);
});

it("凑比例只增不减：换回自由比例，多补的那部分不退回去", () => {
  const fit = ratioPads({ ...zeros, left: 100 }, { w: 800, h: 600 }, "1:1");
  expect(fit).toEqual({ left: 100, right: 0, top: 150, bottom: 150 });
  expect(ratioPads(fit, { w: 800, h: 600 }, "自由比例")).toEqual(fit);
});

it("一条边都没拖过时，凑比例多出的那 1 像素给右和下", () => {
  // 节点原话 first = total // 2：767 宽要凑到 1000 补 233，左 116 右 117
  expect(ratioPads(zeros, { w: 767, h: 1000 }, "1:1")).toEqual({
    left: 116, right: 117, top: 0, bottom: 0,
  });
});

it("拖一边时对侧钉死、按住 Shift 才同轴对称（这条照的是节点自带前端）", () => {
  const size: OutpaintSize = { w: 999, h: 999 };
  const pads: OutpaintSides = { ...zeros, top: 100 };
  // 只拖上边：下边保持 100 不动，补的量全给上边；横轴没人拖 → 那 1 像素照旧落右
  expect(ratioPads(pads, size, "2:3", ["top"])).toEqual({
    left: 0, right: 1, top: 501, bottom: 0,
  });
  // 同样拖上边但按住 Shift：上下一起给，凑出来那 501 平分不掉，多的 1 像素给下
  expect(ratioPads(pads, size, "2:3", ["top"], true)).toEqual({
    left: 0, right: 1, top: 250, bottom: 251,
  });
});


it("画板那六颗读写都走 controls 那份键，值取整并卡进量程", () => {
  const slots = outpaintSlots(boardTemplate())!;
  const controls: Record<string, string | number> = {};
  writeBoard(slots, controls, state({ unit: "像素", ratio: "16:9", raw: { ...zeros, top: 120.7 } }));
  expect(controls[slotKey(slots.sides.top)]).toBe(120); // INT，小数直接不要
  expect(controls[slotKey(slots.unit)]).toBe("像素");
  expect(controls[slotKey(slots.ratio)]).toBe("16:9");
  // 拖出天际也顶到 3000 为止：那颗输入的量程就是它的天花板
  writeBoard(slots, controls, state({ unit: "像素", ratio: "16:9", raw: { left: 99999, right: 0, top: 120.7, bottom: 0 } }));
  expect(controls[slotKey(slots.sides.left)]).toBe(OUTPAINT_MAX_PAD);
  expect(readBoard(slots, controls)).toEqual(
    state({ unit: "像素", ratio: "16:9", raw: { ...zeros, left: OUTPAINT_MAX_PAD, top: 120 } }),
  );
});

it("底部那行读数跟着单位走，百分比模式不许报像素", () => {
  expect(boardReadout("百分比", { ...zeros, left: 10, top: 4 })).toBe(
    "向左 10% · 向右 0% · 向上 4% · 向下 0%",
  );
  expect(boardReadout("像素", { ...zeros, right: 220 })).toBe(
    "向左 0px · 向右 220px · 向上 0px · 向下 0px",
  );
});

it("屏幕上那四个框显示的是配平后的数，不是刚填进去的那颗", () => {
  // 同一条 800×600、左 10%、选 1:1：真会补的是 左80/上140/下140（上面那条已按源码算过）。
  // controls 里上下那两颗还是 0，框里必须写 23——写 0 就是让人按一个不会发生的构图点生成。
  const board = state({ ratio: "1:1", raw: { ...zeros, left: 10 } });
  expect(board.raw.top).toBe(0);
  expect(boardShown(board, { w: 800, h: 600 })).toEqual({ left: 10, right: 0, top: 23, bottom: 23 });
  // 23 是 trunc 之后又 round 回来的：round(140×100/600) = 23，成图真按 140 补，读数按 23% 说
  expect(boardReadout("百分比", boardShown(board, { w: 800, h: 600 }))).toBe(
    "向左 10% · 向右 0% · 向上 23% · 向下 23%",
  );
});

it("换单位保画面：25% 与 200px 在 800 宽的图上是同一条边界", () => {
  const percent = state({ raw: { ...zeros, right: 25 } });
  expect(boardPads(percent, { w: 800, h: 600 }).right).toBe(200);
  // 切到像素那一档要写的值：拿旧那份算成像素、再按新单位记。写成
  // boardShown({...percent, unit:"像素"}) 就是拿新单位去读 25 这个百分数，边界当场缩回 25px
  expect(sideValues("像素", boardPads(percent, { w: 800, h: 600 }), { w: 800, h: 600 }).right).toBe(200);
  // 切回百分比也是同一条边界：round(200×100/800) = 25（同一个方向，先算像素再记新单位）
  const pixel = state({ unit: "像素", raw: { ...zeros, right: 200 } });
  expect(boardPads(pixel, { w: 800, h: 600 }).right).toBe(200);
  expect(sideValues("百分比", boardPads(pixel, { w: 800, h: 600 }), { w: 800, h: 600 }).right).toBe(25);
});
