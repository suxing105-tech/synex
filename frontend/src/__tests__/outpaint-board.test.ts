import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/svelte';
import CloneModal from '../components/CloneModal.svelte';
import { EMPTY_CLONE_JOB, cloneJob, controlSummary, defaultControlValues } from '../lib/clone';
import { comfyuiStatus } from '../lib/stores';
import { clearToasts } from '../lib/toast';
import { resetPromptSkills } from '../lib/prompt-skills';
import {
  OUTPAINT_EMPTY_REASON, OUTPAINT_ZOOM_MAX, OUTPAINT_ZOOM_MIN, boardPads, clampPan, outpaintSlots,
  panAfterZoom, readBoard, zoomStep,
} from '../lib/outpaint';

/**
 * 「闪寻扩展图片」挂进再次创作之后，画板那套和弹窗的接缝。
 *
 * 算术本身不在这里测（那是 outpaint-contract.test.ts 的活，逐条对着节点源码手算）。
 * 这儿只测接线：那六颗该藏的地方藏住了没有、入口摆对没有、四边全空拦不拦、
 * 画板填的数最后有没有原样进提交体。少一条就是「画板画得对但提交的是另一份」那种最难查的坏。
 *
 * 这份槽位不是编的：跑 backend 的 clone_bundled._prepare 把随包那条的槽位原样导出来抄的，
 * 改了随包正文就该在这儿红。
 */
const OUTPAINT = {
  id: 9,
  name: '闪寻扩展图片',
  is_active: true,
  default_prompt: '',
  created_at: '',
  updated_at: '',
  node_count: 26,
  prompt_count: 1,
  reference_count: 1,
  control_count: 7,
  slots: [
    {
      kind: 'prompt', node: '51', input: 'value', label: '补充提示词', allow_empty: true,
      empty_hint: '留空就按默认那句「移除灰色区域、无缝自然延展」出图，这里只写额外的要求。',
    },
    { kind: 'image', node: '1', input: 'image', label: '图片1' },
    { kind: 'number', node: '48', input: '左', label: '向左扩', value: 0, min: 0, max: 3000, step: 1, ui: 'board' },
    { kind: 'number', node: '48', input: '右', label: '向右扩', value: 0, min: 0, max: 3000, step: 1, ui: 'board' },
    { kind: 'number', node: '48', input: '上', label: '向上扩', value: 0, min: 0, max: 3000, step: 1, ui: 'board' },
    { kind: 'number', node: '48', input: '下', label: '向下扩', value: 0, min: 0, max: 3000, step: 1, ui: 'board' },
    { kind: 'select', node: '48', input: '单位', label: '外补单位', options: ['百分比', '像素'], value: '百分比', ui: 'board' },
    {
      kind: 'select', node: '48', input: 'gh_visual_ratio', label: '目标比例',
      options: ['自由比例', '1:1', '2:3', '3:2', '3:4', '4:3', '5:7', '9:16', '16:9', '21:9', '1:2', '2:1'],
      value: '自由比例', ui: 'board',
    },
    { kind: 'number', node: '27', input: '值', label: '最大采样尺寸', value: 2048, min: 1024, max: 3840, step: 128, slider: true },
  ],
};

const SOURCE = {
  id: 7, item_type: 'media', kind: 'image', filename: 'source.png', path: 'D:/source.png',
  original_url: '/api/images/7/file', width: 800, height: 600,
} as any;

const http = vi.fn();
vi.mock('../lib/api', () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: {
    list: vi.fn(async () => ({ items: [], total: 0 })),
    import: vi.fn(async () => ({ saved: [], skipped: [] })),
    copyFiles: vi.fn(async () => ({ saved: [], skipped: [] })),
  },
  comfyuiApi: { status: vi.fn(async () => ({ running: true, enabled: true, url: 'http://127.0.0.1:8188' })) },
  http: (path: string, init?: RequestInit) => (globalThis as any).__http(path, init),
}));
(globalThis as any).__http = http;

function routes(map: Record<string, unknown>) {
  http.mockImplementation(async (path: string, init?: RequestInit) => {
    const key = Object.keys(map).find((k) => path.startsWith(k));
    if (!key) throw new Error(`未预演的接口：${path}`);
    const value = map[key];
    return typeof value === 'function' ? (value as (i?: RequestInit) => unknown)(init) : value;
  });
}

const baseRoutes = () => ({
  '/api/clone/templates': { items: [OUTPAINT] },
  '/api/clone/sources/7': { references: [], template_id: null, source_image_id: null, dropped: 0 },
  '/api/clone/jobs/current': EMPTY_CLONE_JOB,
  '/api/images/7/reverse-prompts': { items: [] },
  '/api/images/7': { id: 7, filename: 'source.png', positive_prompt: '' },
  '/api/clone/cloud/status': {
    cloud_max_single_coins: 0, cloud_max_daily_coins: 0,
    availability: { available: false, reason: '还没有可用的云端账号' },
    accounts: [], presets: [], pending: [], seeded: true,
    spend: { today_coins: 0, month: '2026-11', counts: {}, month_coins: 0, recent: [] },
  },
});

async function ready() {
  routes(baseRoutes());
  const screen = render(CloneModal, { open: true, image: SOURCE, onClose: () => {} });
  await screen.findByLabelText('提示词');
  return screen;
}

/** 开画板：左上角那颗按钮点下去 */
async function openBoard(screen: Awaited<ReturnType<typeof ready>>) {
  await fireEvent.click(screen.getByRole('button', { name: /扩图画板/ }));
  return screen.findByRole('dialog', { name: /扩图画板/ });
}

const goDisabled = (screen: Awaited<ReturnType<typeof ready>>) =>
  (screen.getByRole('button', { name: '生成' }) as HTMLButtonElement).disabled;
/** 钉在生成钮下面那一行 */
const footNote = () => document.querySelector('.cm-foot-note')?.textContent ?? '';
/** 画板底部那四个方向框，顺序就是左、右、上、下 */
const sideInputs = () => Array.from(document.querySelectorAll('.ob-side input')) as HTMLInputElement[];

afterEach(() => {
  cleanup();
  http.mockReset();
  vi.restoreAllMocks();
  localStorage.removeItem('suxing.clonePromptH');
  clearToasts();
  resetPromptSkills();
  cloneJob.set(EMPTY_CLONE_JOB);
  comfyuiStatus.set({ running: true, enabled: true, url: 'http://127.0.0.1:8188', checked_at: 0 });
});

it('画板那六颗不进参数弹层，也不上胶囊：扩图的面板里只剩最大采样尺寸', async () => {
  const screen = await ready();
  const pill = screen.getByRole('button', { name: /^(画面参数|音频参数)$/ });
  // 胶囊是「这一趟的出图参数」，报四个 0 和一个「百分比」既读不出方向也是噪声
  expect(pill.textContent ?? '').not.toContain('百分比');
  expect(pill.textContent ?? '').not.toContain('自由比例');
  await fireEvent.click(pill);
  expect(screen.getByText('最大采样尺寸')).toBeTruthy();
  for (const label of ['向左扩', '向右扩', '向上扩', '向下扩', '外补单位', '目标比例']) {
    expect(screen.queryByText(label)).toBeNull();
  }
});

it('同一件事在 controlSummary 那儿也只挡一次不算完：整份槽位汇总里也不许有那六颗', () => {
  const template = OUTPAINT as never;
  const summary = controlSummary(template, defaultControlValues(template));
  expect(summary).not.toContain('百分比');
  expect(summary).not.toContain('自由比例');
  // 最大采样尺寸照报：它是真会改画面的旋钮
  expect(summary).toContain('2048');
});

it('大图左上角那颗是「扩图画板」，这一族不给画遮罩入口', async () => {
  const screen = await ready();
  expect(screen.getByRole('button', { name: /扩图画板/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /画遮罩/ })).toBeNull();
});

it('四边全空时生成钮按不下去，那句话和画板底部完全同一句', async () => {
  const screen = await ready();
  expect(goDisabled(screen)).toBe(true);
  expect(footNote()).toContain('四个方向都还是 0');
  expect(footNote()).toBe(OUTPAINT_EMPTY_REASON);
});

it('开画板：12 档比例、两档单位、四个方向框、成图读数都在', async () => {
  const screen = await ready();
  const board = await openBoard(screen);
  for (const option of ['自由比例', '1:1', '2:3', '3:2', '3:4', '4:3', '5:7', '9:16', '16:9', '21:9', '1:2', '2:1']) {
    expect(within(board).getByRole('button', { name: option })).toBeTruthy();
  }
  expect(within(board).getByRole('button', { name: '百分比' })).toBeTruthy();
  expect(within(board).getByRole('button', { name: '像素' })).toBeTruthy();
  expect(sideInputs()).toHaveLength(4);
  expect(within(board).getByText(/成图 800×600/)).toBeTruthy();
  expect(within(board).getByRole('button', { name: '按住看原图' })).toBeTruthy();
  expect(within(board).getByRole('button', { name: '保存画板' })).toBeTruthy();
});

it('画板上填一个方向、保存：脚注报读数与成图，生成钮放开', async () => {
  const screen = await ready();
  const board = await openBoard(screen);
  await fireEvent.change(sideInputs()[1], { target: { value: '25' } });
  await fireEvent.click(within(board).getByRole('button', { name: '保存画板' }));
  // 800 宽的图向右 25% = 200 像素（截断，不是 400），成图 1000×600
  expect(footNote()).toContain('向右 25%');
  expect(footNote()).toContain('成图 1000×600');
  expect(goDisabled(screen)).toBe(false);
});

it('提交时那六颗原样进 controls：单位、比例、四条边一颗都不落', async () => {
  let submitted: { controls: Record<string, string | number> } | null = null;
  routes({
    ...baseRoutes(),
    '/api/clone/generate': (init?: RequestInit) => {
      submitted = JSON.parse(String(init?.body));
      return { ...EMPTY_CLONE_JOB, active: true, job_id: 'j1', state: 'queued', running: true };
    },
  });
  const screen = render(CloneModal, { open: true, image: SOURCE, onClose: () => {} });
  await screen.findByLabelText('提示词');
  const board = await openBoard(screen);
  await fireEvent.change(sideInputs()[2], { target: { value: '10' } });
  await fireEvent.click(within(board).getByRole('button', { name: '1:1' }));
  await fireEvent.click(within(board).getByRole('button', { name: '保存画板' }));
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  await vi.waitFor(() => expect(submitted).toBeTruthy());
  const controls = submitted!.controls;
  expect(controls['48.上']).toBe(10);
  expect(controls['48.单位']).toBe('百分比');
  expect(controls['48.gh_visual_ratio']).toBe('1:1');
  // 提交的是单位值，不是画板上换算出来的像素
  expect(controls['48.左']).not.toBe(90);
  expect(controls['27.值']).toBe(2048);
});

it('取消画板就是把这次拖的丢掉：controls 一个字都不动，闸还在', async () => {
  const screen = await ready();
  const board = await openBoard(screen);
  await fireEvent.change(sideInputs()[0], { target: { value: '40' } });
  await fireEvent.click(within(board).getByRole('button', { name: '取消' }));
  expect(document.querySelector('.ob')).toBeNull();
  expect(footNote()).toBe(OUTPAINT_EMPTY_REASON);
  expect(goDisabled(screen)).toBe(true);
});

it('换单位保画面：25% 换成像素还是同一条边界，读数跟着换读法', async () => {
  const screen = await ready();
  const board = await openBoard(screen);
  await fireEvent.change(sideInputs()[1], { target: { value: '25' } });
  await fireEvent.click(within(board).getByRole('button', { name: '像素' }));
  expect(sideInputs()[1].value).toBe('200');
  expect(board.textContent).toContain('向右 200px');
  // 换算完还要能存下来：存的也是像素那份值
  await fireEvent.click(within(board).getByRole('button', { name: '保存画板' }));
  expect(footNote()).toContain('向右 200px');
  expect(footNote()).toContain('成图 1000×600');
});

it('第一下 Esc 只退画板，弹窗还开着（和画遮罩同一套交代）', async () => {
  const screen = await ready();
  await openBoard(screen);
  await fireEvent.keyDown(window, { key: 'Escape' });
  expect(document.querySelector('.ob')).toBeNull();
  expect(screen.getByLabelText('提示词')).toBeTruthy();
  expect(goDisabled(screen)).toBe(true);
});

it('认不出画板键的工作流不受牵连：那几颗还是普通数字框，也不会有画板入口', async () => {
  const plain = {
    ...OUTPAINT,
    slots: OUTPAINT.slots.map((slot) => ({ ...slot, ui: undefined })),
  };
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [plain] } });
  const screen = render(CloneModal, { open: true, image: SOURCE, onClose: () => {} });
  await screen.findByLabelText('提示词');
  expect(outpaintSlots(plain as never)).toBeNull();
  expect(screen.queryByRole('button', { name: /扩图画板/ })).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: /^(画面参数|音频参数)$/ }));
  expect(screen.getByText('向左扩')).toBeTruthy();
  // 四边全空也不再拦生成：那道闸是画板特有的，普通数字框的工作流照旧能直接跑
  expect(goDisabled(screen)).toBe(false);
});

it('画板画的是这份工作流第一颗图片槽位那份：outpaintImageKey 与槽位对得上', () => {
  const template = OUTPAINT as never;
  const slots = outpaintSlots(template)!;
  const state = readBoard(slots, defaultControlValues(template));
  expect(state.unit).toBe('百分比');
  expect(state.ratio).toBe('自由比例');
  // 出厂四边 0 → 换算成像素还是全 0，这就是拦生成认的那份
  expect(boardPads(state, { w: 800, h: 600 })).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
});

/* ==================== 滚轮缩放与拖灰底挪视图 ====================
 * 缩放改的是「屏幕上看着多大」，改不了「这一趟补多少」。所以每条用例都同时盯两头：
 * 画面确实按倍数长大了，而四个方向框里的数、成图读数一个字都不动。
 * 只盯前一头的测试，护不住后面有人把缩放接去动 controls。
 */

const boardView = () => document.querySelector('.ob-view') as HTMLElement;
const stage = () => document.querySelector('.ob-stage') as HTMLElement;
const stageWidth = () => Number(String(stage().style.width).replace('px', ''));
const zoomChip = () => (document.querySelector('.ob-zoom') as HTMLElement).textContent;
const edgeRight = () => document.querySelector('.ob-edge.is-right') as HTMLElement;
/** 拖一条边的完整一趟：按下、移到目标屏幕坐标、松手 */
async function dragTo(node: HTMLElement, toX: number) {
  await fireEvent.pointerDown(node, { clientX: 0, clientY: 0, button: 0 });
  await fireEvent.pointerMove(window, { clientX: toX, clientY: 0 });
  await fireEvent.pointerUp(window, {});
}

it('缩放那几颗纯函数：认三种 deltaMode、缩不过适应、放大封顶、光标底下那一点不动', () => {
  expect(zoomStep(1, -100)).toBeCloseTo(1.246, 3);
  // 行模式（Firefox 的滚轮每格只给 3）按 33px/行折算，否则同样的手势在两个浏览器上快慢差十倍
  expect(zoomStep(1, -3, 1)).toBeCloseTo(1.243, 3);
  // 页模式一次能甩出 400，单次幅度不封顶就是一跳到底
  expect(zoomStep(1, -1, 2)).toBeCloseTo(1.696, 3);
  expect(zoomStep(2, 100)).toBeLessThan(2);
  expect(zoomStep(1, 100)).toBeCloseTo(0.8025, 3); // 往下要真能缩过适应窗口，不然就是苏醒报的那个数
  // 底是每一格算完再卡的，所以拿「已经贴着底附近」那一格验：再滚也只是顶在 25%
  expect(zoomStep(0.3, 240)).toBe(OUTPAINT_ZOOM_MIN);
  expect(zoomStep(8, -2400)).toBe(OUTPAINT_ZOOM_MAX);
  expect(clampPan(50, 400, 800)).toBe(0); // 缩到比窗口还小（或没放大）：钉死居中，压根挪不动
  expect(clampPan(9999, 1200, 800)).toBe(200);
  expect(clampPan(-9999, 1200, 800)).toBe(-200);
  // 视图还没量到（测试环境里 clientWidth 就是 undefined）时不许吐 NaN：
  // transform 里出现 NaN 会让整条声明静默作废，画板跳回没定位的样子
  expect(clampPan(NaN, 800, 400)).toBe(0);
  expect(clampPan(50, 800, undefined as never)).toBe(50);
  // 光标在中心右 100px、比例从 1 翻到 2：平移得走 -100，那点才还在光标底下
  expect(panAfterZoom(100, 0, 1, 2)).toBe(-100);
});

it('滚轮往上滚是放大：画面按倍数长大，方向框和成图读数一个字都不动', async () => {
  const screen = await ready();
  await openBoard(screen);
  await fireEvent.change(sideInputs()[1], { target: { value: '25' } });
  const before = stageWidth(); // 视图在 happy-dom 里量出来是 0，所以适应比例就是 1：800 + 200 = 1000
  await fireEvent.wheel(boardView(), { deltaY: -100, clientX: 0, clientY: 0 });
  expect(stageWidth()).toBe(Math.round(before * Math.exp(0.22)));
  expect(sideInputs()[1].value).toBe('25');
  expect(document.querySelector('.ob-size')?.textContent).toContain('成图 1000×600');
  expect(zoomChip()).toBe('125%');
});

it('缩放两头都封住：往下能一路缩到适应窗口的 25%（缩不过去就是苏醒报的那个坏），往上一路到 8 倍', async () => {
  const screen = await ready();
  await openBoard(screen);
  const fit = stageWidth();
  expect(zoomChip()).toBe('适应');
  await fireEvent.wheel(boardView(), { deltaY: 100 });
  expect(stageWidth()).toBe(Math.round(fit * 0.8025)); // 一格就把画面缩到适应窗口以下
  expect(zoomChip()).toBe('80%'); // 缩下去就不许再报「适应」，那是骗读数
  for (let i = 0; i < 10; i += 1) await fireEvent.wheel(boardView(), { deltaY: 240 });
  expect(stageWidth()).toBe(Math.round(fit * OUTPAINT_ZOOM_MIN));
  expect(zoomChip()).toBe('25%');
  // 缩到底画板比窗口还小，这时候没有可挪的范围，双击必须能回适应窗口
  await fireEvent.dblClick(boardView());
  expect(stageWidth()).toBe(fit);
  expect(zoomChip()).toBe('适应');
  for (let i = 0; i < 40; i += 1) await fireEvent.wheel(boardView(), { deltaY: -240 });
  expect(stageWidth()).toBe(fit * OUTPAINT_ZOOM_MAX);
  expect(zoomChip()).toBe('800%');
});

it('双击画面回到适应窗口，平移也一起归零', async () => {
  const screen = await ready();
  await openBoard(screen);
  await fireEvent.wheel(boardView(), { deltaY: -240 });
  await fireEvent.pointerDown(boardView(), { clientX: 300, clientY: 200, button: 0 });
  await fireEvent.pointerMove(window, { clientX: 380, clientY: 200 });
  await fireEvent.pointerUp(window, {});
  expect(stage().style.transform).not.toBe('translate(0px,0px)');
  await fireEvent.dblClick(boardView());
  expect(stage().style.transform).toBe('translate(0px,0px)');
  expect(zoomChip()).toBe('适应');
});

it('放大之后拖灰底只挪视图：位移进 transform，四个方向框一个都不动，松手就不再跟', async () => {
  const screen = await ready();
  await openBoard(screen);
  await fireEvent.change(sideInputs()[1], { target: { value: '25' } });
  await fireEvent.wheel(boardView(), { deltaY: -100 });
  await fireEvent.pointerDown(boardView(), { clientX: 300, clientY: 200, button: 0 });
  await fireEvent.pointerMove(window, { clientX: 350, clientY: 240 });
  expect(stage().style.transform).toBe('translate(50px,40px)');
  expect(sideInputs()[1].value).toBe('25');
  await fireEvent.pointerUp(window, {});
  await fireEvent.pointerMove(window, { clientX: 900, clientY: 900 });
  expect(stage().style.transform).toBe('translate(50px,40px)');
});

it('拖源图还是挪源图位置，不会被当成挪视图：transform 不动、左右此消彼长', async () => {
  const screen = await ready();
  await openBoard(screen);
  await fireEvent.change(sideInputs()[0], { target: { value: '25' } });
  await fireEvent.change(sideInputs()[1], { target: { value: '25' } });
  await fireEvent.wheel(boardView(), { deltaY: -100 });
  await dragTo(document.querySelector('.ob-src') as HTMLElement, 100);
  // 屏幕拖了 100，源图口径只有 100 / 倍数：向右挪 → 左边的量变大、右边的量变小，左右总量不变
  expect(Number(sideInputs()[0].value)).toBeGreaterThan(25);
  expect(Number(sideInputs()[1].value)).toBeLessThan(25);
  expect(stage().style.transform).toBe('translate(0px,0px)');
});

it('放大之后拖边吃的还是源图口径的位移：按倍数补偿屏幕距离，结果和没放大时同一档', async () => {
  const screen = await ready();
  await openBoard(screen);
  // 每一段都得从「四边 25% + 适应窗口」起跑：回出厂只管四边不管缩放，
  // 不复位的话第二段就是 1.246^2 倍，屏幕位移摊回源图的量也跟着变，那条 37% 就成了假期望
  const fill = async () => {
    await fireEvent.click(within(document.querySelector('.ob') as HTMLElement).getByRole('button', { name: '回出厂' }));
    await fireEvent.dblClick(boardView());
    await fireEvent.change(sideInputs()[1], { target: { value: '25' } });
  };
  await fill();
  await dragTo(edgeRight(), 120);
  expect(sideInputs()[1].value).toBe('40'); // 200 + 120 = 320 → 40%
  await fill();
  await fireEvent.wheel(boardView(), { deltaY: -100 });
  const scale = stageWidth() / 1000; // 画布自己量出来的倍数，不写死，免得用例跟着实现抖
  await dragTo(edgeRight(), 120 * scale);
  expect(sideInputs()[1].value).toBe('40');
  // 不补偿的话只会拖出 120 / 1.246 ≈ 96 像素那一档，成图差 24 像素就是这么来的
  await fill();
  await fireEvent.wheel(boardView(), { deltaY: -100 });
  await dragTo(edgeRight(), 120);
  expect(sideInputs()[1].value).toBe('37');
});

it('拖灰底拖到一半画板被收掉：window 上那三个监听得跟着收掉（和拖边同一笔账）', async () => {
  const screen = await ready();
  const board = await openBoard(screen);
  await fireEvent.wheel(boardView(), { deltaY: -240 });
  await fireEvent.pointerDown(boardView(), { clientX: 300, clientY: 200, button: 0 });
  await fireEvent.pointerMove(window, { clientX: 340, clientY: 200 });
  const spy = vi.spyOn(window, 'removeEventListener');
  const dragging = () => spy.mock.calls.filter((c) => ['pointermove', 'pointerup', 'pointercancel'].includes(String(c[0]))).length;
  expect(dragging()).toBe(0); // 还没松手，一个都不该收
  await fireEvent.click(within(board).getByRole('button', { name: '取消' }));
  expect(dragging()).toBe(3); // 整层被拆掉：挪视图那三颗一起摘，少一颗就是漏着的那笔账
});
