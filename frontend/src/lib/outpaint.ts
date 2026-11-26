import { slotKey, type CloneSlot, type CloneTemplate } from "./clone";

/**
 * 外补画板的算术：四边那几个数 ↔ 像素 ↔ 最后出多大一张图。
 *
 * 全部对着 ComfyUI 那台「外补画板（可视化）」抄，一行都不许自己发明。真源有两处，分工先写清楚：
 * - 服务端 custom_nodes/Goohaitools-comfyui/nodes/外补画板（可视化）.py：成图到底补了多少像素由它说了算
 *   （百分比截断、比例 ceil 配平、最长边压回、floor(x + 0.5) 取整）。
 * - 它自带的前端 web/js/goohai_outpaint_visual.js：拖边框的手感（拖一边时对侧钉死、Shift 同轴对称、
 *   像素换单位值用 round）照它抄。
 * 为什么两处都要抄、又不拿前端当真源：节点前端会把自己算出的像素写进 gh_visual_layout 那颗缓存，
 * 而随包这条工作流里那颗缓存是空的（后端用例钉住提交时一个都不写），弹窗提交也不写它——所以真跑起来
 * 用的是服务端按「单位 + 四边」现算的那一份。画板画给人看的必须就是这份数，否则屏幕上拖到 221、
 * 成图却是 220：人按屏幕理解，模型按数字干活。
 *
 * 两处本来就对不上的那一处，必须记下：拖单边 + 选了比例时，节点前端按单轴取倍率
 * （goohai_outpaint_visual.js 里的 constrain），服务端永远按双轴 max（.py 里那句 factor = ceil(max(...))）。
 * 在 ComfyUI 里它俩不打架，因为前端把精确像素塞进了那颗缓存；我们不写缓存，所以服务端说了算。
 * 于是这一层的规矩定死：拖动过程按前端的手感走，松手把值写回 controls，画面上的数再由 boardPads 现算一次。
 * 读数会跳一下——跳完那个数才是成图真会用的数。宁可跳，不要骗眼睛。
 *
 * 三处最容易抄错的，留在当注释：
 * 1. 百分比换像素是 int(v × 边长 / 100)——截断，不是四舍五入（sidePads 用 Math.trunc）。
 * 2. 凑比例时只增不减：factor = ceil(max(...))，所以选完比例四边只会变大，不会缩掉刚拖出来的量。
 * 3. 成图最长边超过 OUTPAINT_MAX_EDGE 时整张等比压回来，压完还要 floor(x + 0.5) 取整。
 *
 * **单位口径只有一条规矩**：controls 里那四颗是「单位值」（百分比模式下就是百分数），画画面、
 * 算尺寸一律走 boardPads 换算出来的「像素」。函数名字就是说这件事的：带 Pads 的吃/吐像素，
 * 带 Board 的吃/吐 controls 那份单位值（中间那步换算它自己做）。别在某一步把 220 像素当 220% 写回去
 * ——736 宽的图上那一下就是 1619 像素，是这一层最容易犯、也最难看出来的一次错。
 *
 * 这里一个 DOM 都不碰：happy-dom 量不到元素尺寸，几何放在这层才测得动（同 lib/clone-canvas.ts）。
 */

/** 画板补出来那片灰：写死的主指令叫模型「移除图像中的灰色区域」，两处必须同一个灰 */
export const OUTPAINT_TINT = "#808080";
/** 成图最长边上限。随包正文里「最大输出长边」写的就是这个数，节点量程本身到 8192。 */
export const OUTPAINT_MAX_EDGE = 5120;
/** 四边那颗输入的量程（节点 INT 的 max），拖过这个数只能顶到头上 */
export const OUTPAINT_MAX_PAD = 3000;
/** 两条单位，与节点下拉给的二字面量一致 */
export const OUTPAINT_UNIT_PERCENT = "百分比";
export const OUTPAINT_UNIT_PIXEL = "像素";
export const OUTPAINT_UNITS = [OUTPAINT_UNIT_PERCENT, OUTPAINT_UNIT_PIXEL] as const;
export type OutpaintUnit = (typeof OUTPAINT_UNITS)[number];
/** 不凑比例那一档 */
export const OUTPAINT_FREE_RATIO = "自由比例";
/** 节点自己给的 12 档，顺序也照它：画板上那一排档位与在 ComfyUI 里打开的下拉是同一个列法 */
export const OUTPAINT_RATIOS = [
  OUTPAINT_FREE_RATIO, "1:1", "2:3", "3:2", "3:4", "4:3", "5:7",
  "9:16", "16:9", "21:9", "1:2", "2:1",
];
export const OUTPAINT_SIDE_KEYS = ["left", "right", "top", "bottom"] as const;
export type OutpaintSide = (typeof OUTPAINT_SIDE_KEYS)[number];
/** 四边在节点上的输入名，也就是槽位的 input */
export const OUTPAINT_SIDE_INPUTS: Record<OutpaintSide, string> = {
  left: "左", right: "右", top: "上", bottom: "下",
};
export const OUTPAINT_UNIT_INPUT = "单位";
export const OUTPAINT_RATIO_INPUT = "gh_visual_ratio";
/** 画板六颗：四边 + 按什么单位记 + 凑哪个比例。缺一颗画板就画不出来（后端同一道闸）。 */
export const OUTPAINT_BOARD_INPUTS = [
  ...OUTPAINT_SIDE_KEYS.map((side) => OUTPAINT_SIDE_INPUTS[side]),
  OUTPAINT_UNIT_INPUT, OUTPAINT_RATIO_INPUT,
];

export interface OutpaintSize {
  w: number;
  h: number;
}
/** 四个方向的量。同一套字段既装单位值也装像素，靠函数名前缀区分，不靠记忆区分。 */
export type OutpaintSides = Record<OutpaintSide, number>;
export type OutpaintEdges = OutpaintSide[];

/** 画板要写的六颗槽位，按名字取好了给界面用 */
export interface OutpaintSlots {
  sides: Record<OutpaintSide, CloneSlot>;
  unit: CloneSlot;
  ratio: CloneSlot;
}

/**
 * 画板那份状态，口径与 controls 完全一致：四边是**单位值**，不是像素。
 * 它就是要写回弹窗那份 controls 的东西，所以谁改它都别往里塞像素。
 */
export interface OutpaintBoardState {
  unit: OutpaintUnit;
  ratio: string;
  raw: OutpaintSides;
}

const EMPTY_SIDES: OutpaintSides = { left: 0, right: 0, top: 0, bottom: 0 };

/** 出厂那份：四边 0、按百分比、不凑比例。随包正文写的就是这一份，回到它等于没动过。 */
export const OUTPAINT_FACTORY: OutpaintBoardState = {
  unit: OUTPAINT_UNIT_PERCENT,
  ratio: OUTPAINT_FREE_RATIO,
  raw: { ...EMPTY_SIDES },
};

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

/**
 * 节点里那个 _nearest：floor(x + 0.5)。别顺手换成 Math.round——四边不会为负所以这批数算出来一样，
 * 但两者在负数上方向不同，换个地方用就不一定了。要跟人源码对账的时候，照抄最省事。
 */
function nearest(value: number): number {
  return Math.floor(value + 0.5);
}

function whole(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

/** 某一边按的是源图的哪条边：左右看宽，上下看高。 */
export function sideEdge(side: OutpaintSide, size: OutpaintSize): number {
  return side === "left" || side === "right" ? size.w : size.h;
}


/**
 * 这份工作流能不能开画板，以及画板要写哪六颗槽位。
 *
 * 只认后端点名的 ui === "board"，而且要六颗齐、都在同一台节点上才认（和后端 normalize_slots
 * 那道闸同一口径）。少一颗就当这不是画板工作流：宁可界面上一颗入口都不摆，也不摆一块拖不动的白板。
 * 用户自己导入、重新检测过槽位的工作流拿不到这个键，于是照常按普通数字框用——那才是它认得出的东西。
 */
export function outpaintSlots(template: CloneTemplate | null | undefined): OutpaintSlots | null {
  const slots = (template?.slots ?? []).filter((slot) => slot.ui === "board");
  if (slots.length !== OUTPAINT_BOARD_INPUTS.length) return null;
  const node = slots[0]?.node;
  if (!node || !slots.every((slot) => slot.node === node)) return null;
  const byInput = new Map(slots.map((slot) => [String(slot.input), slot]));
  if (byInput.size !== slots.length) return null;
  const sides = {} as Record<OutpaintSide, CloneSlot>;
  for (const side of OUTPAINT_SIDE_KEYS) {
    const slot = byInput.get(OUTPAINT_SIDE_INPUTS[side]);
    if (!slot) return null;
    sides[side] = slot;
  }
  const unit = byInput.get(OUTPAINT_UNIT_INPUT);
  const ratio = byInput.get(OUTPAINT_RATIO_INPUT);
  if (!unit || !ratio) return null;
  return { sides, unit, ratio };
}

export function isOutpaintTemplate(template: CloneTemplate | null | undefined): boolean {
  return outpaintSlots(template) !== null;
}

/**
 * 画板画的是哪一格的图：这份工作流第一颗图片槽位的键（扩图只吃一张底图）。
 * 大图那一格和画板必须摆同一份，否则拖的是这张、补的是那张。
 */
export function outpaintImageKey(template: CloneTemplate | null | undefined): string {
  const slot = (template?.slots ?? []).find((one) => one.kind === "image");
  return slot ? slotKey(slot) : "";
}

/** 六颗槽位现在的值，从弹窗那份 controls 里读（键就是「节点.输入」）。出来的是单位值。 */
export function readBoard(
  slots: OutpaintSlots,
  controls: Record<string, string | number>,
): OutpaintBoardState {
  const unitText = String(controls[slotKey(slots.unit)] ?? slots.unit.value ?? OUTPAINT_UNIT_PERCENT);
  const raw = { ...EMPTY_SIDES };
  for (const side of OUTPAINT_SIDE_KEYS) {
    const slot = slots.sides[side];
    raw[side] = whole(controls[slotKey(slot)] ?? slot.value ?? 0);
  }
  return {
    unit: unitText === OUTPAINT_UNIT_PIXEL ? OUTPAINT_UNIT_PIXEL : OUTPAINT_UNIT_PERCENT,
    ratio: String(controls[slotKey(slots.ratio)] ?? slots.ratio.value ?? OUTPAINT_FREE_RATIO),
    raw,
  };
}

/** 把六颗值写回弹窗那份 controls。四边一律取整并卡进那颗输入的量程：那几颗都是 INT。 */
export function writeBoard(
  slots: OutpaintSlots,
  controls: Record<string, string | number>,
  board: OutpaintBoardState,
): void {
  controls[slotKey(slots.unit)] = board.unit;
  controls[slotKey(slots.ratio)] = board.ratio;
  for (const side of OUTPAINT_SIDE_KEYS) {
    controls[slotKey(slots.sides[side])] = clamp(whole(board.raw[side]), 0, OUTPAINT_MAX_PAD);
  }
}

/**
 * 单位值 → 像素。节点原话：max(0, int(v * 边长 / 100))，像素那档 int(v)。
 * 截断意味着 30% 落在 736 宽的图上是 220 而不是 221，百分比模式因此在源头就掉几位。
 */
export function sidePads(unit: OutpaintUnit, raw: OutpaintSides, size: OutpaintSize): OutpaintSides {
  const pads = { ...EMPTY_SIDES };
  for (const side of OUTPAINT_SIDE_KEYS) {
    const value = whole(raw[side]);
    pads[side] = Math.max(0, unit === OUTPAINT_UNIT_PERCENT
      ? Math.trunc((value * sideEdge(side, size)) / 100)
      : value);
  }
  return pads;
}

/**
 * 像素 → 单位值。节点自带前端那句原话：Math.round(pixels * 100 / base)（像素那档直接取整），
 * 再卡进那颗输入的量程。
 *
 * 这一步是有损的（百分比只有整数档），所以画完一定要拿 sidePads 换算回像素、按换算回来的那份画——
 * 那才是节点真正会做的事。跳过去就会画出屏幕上看得到、成图里却没有的量。
 */
export function sideValues(unit: OutpaintUnit, pads: OutpaintSides, size: OutpaintSize): OutpaintSides {
  const raw = { ...EMPTY_SIDES };
  for (const side of OUTPAINT_SIDE_KEYS) {
    const px = Math.max(0, whole(pads[side]));
    const value = unit === OUTPAINT_UNIT_PERCENT
      ? Math.round((px * 100) / Math.max(1, sideEdge(side, size)))
      : px;
    raw[side] = clamp(value, 0, OUTPAINT_MAX_PAD);
  }
  return raw;
}

/** 「16:9」→ {w:16,h:9}；认不出（含「自由比例」）返回 null。 */
export function ratioValue(option: string): { w: number; h: number } | null {
  const matched = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(String(option || "").trim());
  if (!matched) return null;
  const w = Number(matched[1]);
  const h = Number(matched[2]);
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  return { w, h };
}

/** 那一档现在是不是「凑满整个画框」：只增不减，四边只会变大。 */
export function isRatioOn(option: string): boolean {
  return ratioValue(option) !== null;
}

/**
 * 按选中的比例配平四边（像素进、像素出）。
 *
 * edges 说这次是哪几边在动：只拖了左边时右边钉住不动（total - values.right），拖上边时下边同理——
 * 这是拖边框的手感来源，照节点自带前端的 constrain 抄。symmetric 是同轴对称（按住 Shift）：
 * 左右一起给同样的量，并优先挑让四边都是偶数的那一档倍率。
 * **edges 留空 = 服务端那条路**（换比例、换单位、松手后重算都走这条）：同轴两边按现有比例分摊，
 * 倍率取双轴 max——那才是 .py 会做的事，画面上摆的数只有走这条路才和成图一致。
 *
 * 只增不减这条要记住：选完比例再换回「自由比例」，多出来的那部分不会退回去。
 */
export function ratioPads(
  pads: OutpaintSides,
  size: OutpaintSize,
  option: string,
  edges: OutpaintEdges = [],
  symmetric = false,
): OutpaintSides {
  const values: OutpaintSides = { ...pads };
  if (symmetric) {
    for (const [start, end] of [["left", "right"], ["top", "bottom"]] as const) {
      if (edges.includes(start)) values[end] = values[start];
      else if (edges.includes(end)) values[start] = values[end];
    }
  }
  const parsed = ratioValue(option);
  if (!parsed) return { ...values };
  const divisor = gcd(parsed.w, parsed.h);
  const rw = parsed.w / divisor;
  const rh = parsed.h / divisor;
  const horizontal = edges.some((key) => key === "left" || key === "right");
  const vertical = edges.some((key) => key === "top" || key === "bottom");
  const widthFactor = (size.w + values.left + values.right) / rw;
  const heightFactor = (size.h + values.top + values.bottom) / rh;
  const desired = horizontal && !vertical
    ? widthFactor
    : vertical && !horizontal
      ? heightFactor
      : Math.max(widthFactor, heightFactor);
  // 那两项 base 恒 ≤ desired（四边不会是负数），留着只为逐字照抄两处源码，不改结论。
  let factor = Math.ceil(Math.max(size.w / rw, size.h / rh, desired));
  if (symmetric) {
    // 对称时优先挑四边都能平分的那一档倍率，否则左右永远差一个像素
    const evenPads = (value: number) =>
      (value * rw - size.w) % 2 === 0 && (value * rh - size.h) % 2 === 0;
    if (!evenPads(factor) && evenPads(factor + 1)) factor += 1;
  }
  const result: OutpaintSides = { ...values };
  const axes: [OutpaintSide, OutpaintSide, number][] = [
    ["left", "right", factor * rw - size.w],
    ["top", "bottom", factor * rh - size.h],
  ];
  for (const [start, end, total] of axes) {
    const sum = values[start] + values[end];
    // 同轴只动一边时对侧钉死；两边都没动过就按现有比例分摊，一条都没拖过时那 1 像素给右/下
    let first = symmetric
      ? Math.floor(total / 2)
      : edges.includes(start) && !edges.includes(end)
        ? total - values[end]
        : edges.includes(end) && !edges.includes(start)
          ? values[start]
          : sum
            ? nearest((total * values[start]) / sum)
            : Math.floor(total / 2);
    first = clamp(Math.round(first), 0, total);
    result[start] = first;
    result[end] = total - first;
  }
  return result;
}

/**
 * 画板该画的那四边像素：单位值 → 截断成像素 → 按选中的比例配平（双轴那条服务端路）。
 *
 * 这是这层唯一一句「成图真会用的四边」。画灰、画边界、算成图尺寸、判四边是不是还全空，
 * 全从这里取；直接拿 controls 里那四颗当像素画是错的，百分比模式下差得离谱。
 */
export function boardPads(state: OutpaintBoardState, size: OutpaintSize): OutpaintSides {
  return ratioPads(sidePads(state.unit, state.raw, size), size, state.ratio);
}

/**
 * 屏幕上该显示的那四边单位值：先按服务端算成像素，再换回单位值。
 *
 * 画板上那四个输入框、底部那行读数、弹窗脚注都必须走它，不许直接显示 controls 里那四颗：
 * 选了比例之后那四颗是「拖之前填的数」，凑完比例真会补的是另一份（只增不减、对侧还会跟着给）。
 * 于是数字会跟着跳——跳完那个数才是成图真会用的数。宁可跳，不要骗眼睛（口径见文件顶）。
 *
 * 它只管「这一档单位下该显示多少」，不负责换单位：换单位要拿**旧**那份状态换算成像素、
 * 再按新单位记一次，也就是 sideValues(新单位, boardPads(旧状态, size), size)。别写成
 * boardShown({...旧状态, unit: 新单位})——那等于拿新单位去读旧单位那四颗，25% 会被当成
 * 25 像素，画板边界当场缩回去。这一条在 outpaint-contract.test.ts 里有用例钉着。
 */
export function boardShown(state: OutpaintBoardState, size: OutpaintSize): OutpaintSides {
  return sideValues(state.unit, boardPads(state, size), size);
}

/**
 * 拖某一条边（像素进、像素出）：dx/dy 是「源图像素」口径的位移（右为正、下为正）。
 * 先按这一次拖动改被拖的那几边，再按选中的比例配平。量程那一步不在这里——sideValues 卡，
 * 因为能写进 controls 的只有单位值。要改 controls 用 dragBoard，别直接拿这个返回值。
 */
export function dragPads(
  origin: OutpaintSides,
  size: OutpaintSize,
  option: string,
  edges: OutpaintEdges,
  dx: number,
  dy: number,
  symmetric = false,
): OutpaintSides {
  const values: OutpaintSides = { ...origin };
  if (edges.includes("left")) values.left = Math.max(0, Math.round(origin.left - dx));
  if (edges.includes("right")) values.right = Math.max(0, Math.round(origin.right + dx));
  if (edges.includes("top")) values.top = Math.max(0, Math.round(origin.top - dy));
  if (edges.includes("bottom")) values.bottom = Math.max(0, Math.round(origin.bottom + dy));
  return ratioPads(values, size, option, edges, symmetric);
}

/**
 * 在输出框不动的前提下挪源图（像素进、像素出）：四个方向的总量不变，只在左右之间、上下之间
 * 重分配。这是「画框已经定了，画面里的东西想靠左一点」那件事，和拖边框是两回事。
 */
export function slidePads(origin: OutpaintSides, dx: number, dy: number): OutpaintSides {
  const horizontal = Math.max(0, origin.left + origin.right);
  const vertical = Math.max(0, origin.top + origin.bottom);
  const left = clamp(Math.round(origin.left + dx), 0, horizontal);
  const top = clamp(Math.round(origin.top + dy), 0, vertical);
  return { left, right: horizontal - left, top, bottom: vertical - top };
}

/**
 * 把手感算出的像素换成可以写回 controls 的单位值（并卡量程）。
 *
 * 单独留着是给「先要像素、再决定怎么写」的场合用的。画板正常拖动一律走 dragBoard / slideBoard，
 * 那两颗已经把这一步接好了——少接一次就是百分比模式把 220 像素当 220% 写回去。
 */
export function commitPads(unit: OutpaintUnit, pads: OutpaintSides, size: OutpaintSize): OutpaintSides {
  return sideValues(unit, pads, size);
}

/** 拖一条边，产出可以直接写回 controls 的那份状态（单位值）。 */
export function dragBoard(
  state: OutpaintBoardState,
  size: OutpaintSize,
  edges: OutpaintEdges,
  dx: number,
  dy: number,
  symmetric = false,
): OutpaintBoardState {
  const pads = dragPads(boardPads(state, size), size, state.ratio, edges, dx, dy, symmetric);
  return { ...state, raw: sideValues(state.unit, pads, size) };
}

/** 按住源图挪：产出可以直接写回 controls 的那份状态（单位值）。 */
export function slideBoard(
  state: OutpaintBoardState,
  size: OutpaintSize,
  dx: number,
  dy: number,
): OutpaintBoardState {
  return { ...state, raw: sideValues(state.unit, slidePads(boardPads(state, size), dx, dy), size) };
}

export interface OutpaintGeometry extends OutpaintSize {
  /** 未缩放的画板尺寸（源图 + 四边） */
  totalW: number;
  totalH: number;
  /** 最长边撞上 OUTPAINT_MAX_EDGE，整张被等比压小了 */
  scaled: boolean;
}

/**
 * 这一趟真会出多大（吃 boardPads 那份像素）。随包那版把「整除数」定成 0，节点里那一大段
 * 对齐分支整个跳过，于是只剩一条：画板尺寸按 min(1, 上限 / 最长边) 等比压，再 floor(x + 0.5) 取整。
 * 成图尺寸就是画板尺寸——后面那台还原节点按画板给的接缝贴回原图，没人再改过一次。
 */
export function outputGeometry(pads: OutpaintSides, size: OutpaintSize): OutpaintGeometry {
  const totalW = Math.max(1, whole(size.w) + whole(pads.left) + whole(pads.right));
  const totalH = Math.max(1, whole(size.h) + whole(pads.top) + whole(pads.bottom));
  const long = Math.max(totalW, totalH);
  const scale = OUTPAINT_MAX_EDGE > 0 && long > 0 ? Math.min(1, OUTPAINT_MAX_EDGE / long) : 1;
  return {
    w: Math.max(1, nearest(totalW * scale)),
    h: Math.max(1, nearest(totalH * scale)),
    totalW,
    totalH,
    scaled: scale < 1,
  };
}

/**
 * 这一趟到底有没有要补的画面。
 *
 * 认的是 boardPads 那份**像素**，不是 controls 里那四颗数：1% 落在 50 像素宽的图上截断完就是 0，
 * 那样点生成等于没扩，ComfyUI 会直接报错（遮罩全黑 → 下游裁剪取到空数组）。按单位值判会以为
 * 「她填了 1 就有 1」，报错还压在生成之后才响，那是最没用的一次失败。
 */
export function isBoardEmpty(pads: OutpaintSides): boolean {
  return OUTPAINT_SIDE_KEYS.every((side) => !(whole(pads[side]) > 0));
}

/** 拦下生成时说的那句话：先说后果、再说怎么办，别只说「不能生成」。 */
export const OUTPAINT_EMPTY_REASON =
  "四个方向都还是 0：这一步没有要补的画面，ComfyUI 会直接报错。先在画板上把某一个方向拖开一点。";

/** 画板空着时那句拦人的话（认的是像素）；量不到底图尺寸时不拦，交给参考区那套问题去说。 */
export function boardIssue(state: OutpaintBoardState, size: OutpaintSize): string | null {
  if (!state || !(size.w > 0) || !(size.h > 0)) return null;
  return isBoardEmpty(boardPads(state, size)) ? OUTPAINT_EMPTY_REASON : null;
}

/** 顶部那颗「按住看原图」按下去时该说的话，和画板上那条边界是同一件事 */
export const OUTPAINT_COMPARE_HINT = "按住看原图：松手回到画板";

/** 画板上的读数单位：跟着那档单位走，别让百分比模式报像素。 */
export function sideSuffix(unit: OutpaintUnit): string {
  return unit === OUTPAINT_UNIT_PIXEL ? "px" : "%";
}

/** 四边的中文方向名，画板与底部那行读数共用一套说法。 */
export const OUTPAINT_SIDE_WORDS: Record<OutpaintSide, string> = {
  left: "向左", right: "向右", top: "向上", bottom: "向下",
};

/** 底部那一行四边读数：向左 10% · 向右 10% · 向上 0% · 向下 0% */
export function boardReadout(unit: OutpaintUnit, raw: OutpaintSides): string {
  const suffix = sideSuffix(unit);
  return OUTPAINT_SIDE_KEYS
    .map((side) => OUTPAINT_SIDE_WORDS[side] + " " + whole(raw[side]) + suffix)
    .join(" · ");
}

/* ---------- 画板的「看」：滚轮缩放与挪视图 ----------
 * 下面这几颗只改屏幕上那一份，不改四边、不改成图、不改提交体。之所以还是写进算术层：
 * 组件里不许长算术（见文件顶），而这几颗一旦被手抄进组件，就成了没人测过的那一份。
 */

/** 最多放大到适应窗口的 8 倍。再大就是在数像素点，对「这一趟补多少」没有任何判断价值。 */
export const OUTPAINT_ZOOM_MAX = 8;

/**
 * 一次滚轮事件放缩多少倍。三种 deltaMode 都认（0 像素、1 行、2 页）：只认像素的话，
 * Firefox 那档每格只给 3，同样的手势在那里慢十倍；单次幅度也要封顶，触摸板一次能甩出上千。
 * 缩不过 1（= 适应窗口）：比适应还小只会剩一圈灰。
 */
export function zoomStep(zoom: number, deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const step = clamp(Number.isFinite(px) ? px : 0, -240, 240);
  return clamp(zoom * Math.exp(-step * 0.0022), 1, OUTPAINT_ZOOM_MAX);
}

/** 屏幕上真正在用的比例 = 适应窗口 x 放大倍数。拖动时冻住的那一份也是它。 */
export function viewScale(fit: number, zoom: number): number {
  return (fit > 0 ? fit : 1) * clamp(zoom, 1, OUTPAINT_ZOOM_MAX);
}

/**
 * 挪视图的范围：画面比窗口小就钉死居中（range 是 0），比窗口大才许挪到两头齐平，不许推出边去。
 *
 * 两个数只要有一个量不到（还没挂载、测试环境里 clientWidth 是 undefined），就当没有范围：
 * 让它穿过 NaN 是会出人命的——transform 里出现 NaN，整条声明静默作废，画板直接跳回没定位的样子，
 * 比「挪不动」难查十倍。value 自己不是数就干脆回 0。
 */
export function clampPan(value: number, stageSize: number, viewSize: number): number {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(stageSize) || !Number.isFinite(viewSize)) return value;
  const range = Math.max(0, (stageSize - viewSize) / 2);
  return clamp(value, -range, range);
}

/**
 * 缩放要留在光标底下那一点。画板靠 flex 居中，所以 transform 的原点是视图中心：
 * 光标相对中心 c、当前平移 t、当前比例 s，那点在画面上的坐标 p = (c - t) / s，
 * 换到新比例 s 之后平移取 t' = c - p * s，它就还在光标底下。省掉这一步，一滚画面就整体跑掉。
 */
export function panAfterZoom(cursor: number, pan: number, scale: number, nextScale: number): number {
  if (!(scale > 0)) return pan;
  return cursor - ((cursor - pan) / scale) * nextScale;
}
