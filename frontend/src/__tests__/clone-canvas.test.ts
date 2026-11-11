import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import CloneCanvas from '../components/CloneCanvas.svelte';
import CloneModal from '../components/CloneModal.svelte';
import {
  applyCloneProgress, armCloneBatchAspect, clearCloneBatches, cloneBatches, cloneJob,
  CLONE_BATCH_LIMIT, EMPTY_CLONE_JOB,
  type CloneBatch,
} from '../lib/clone';
import {
  cameraForCard, cloneSourceUrl, layoutCloneBatches, neededPixels,
  CANVAS_GAP, CANVAS_INSET, CANVAS_PAD, CANVAS_ROW,
} from '../lib/clone-canvas';
import { ViewerZoom, ZOOM_LIMITS } from '../lib/viewer-zoom.svelte';
import { comfyuiStatus } from '../lib/stores';

/** 造一批：产出清单按 id 排，比例给 null 就是「提交时没认出比例」。 */
const batch = (key: string, ids: number[], aspect: { w: number; h: number } | null = { w: 1, h: 1 }): CloneBatch => ({
  key, jobId: key, aspect,
  outputs: ids.map((id) => ({ id, kind: 'image', filename: `${id}.png`, thumbnail_url: `/api/images/${id}/file?max=256` })),
});

/* ───────────────────────── 排布：一批一条横带 ───────────────────────── */

it('空画布的包围盒是 0，不是一个 padding 大小的空盒子', () => {
  expect(layoutCloneBatches([])).toEqual({ cards: [], width: 0, height: 0 });
});

it('一批四张排在同一条带里，位置、宽高和包围盒全算得出来', () => {
  const layout = layoutCloneBatches([batch('j1', [41, 42, 43, 44])]);
  expect(layout.cards).toHaveLength(4);
  expect(layout.cards.map((c) => c.y)).toEqual([CANVAS_PAD, CANVAS_PAD, CANVAS_PAD, CANVAS_PAD]);
  expect(layout.cards.map((c) => c.x)).toEqual([
    CANVAS_PAD,
    CANVAS_PAD + CANVAS_ROW + CANVAS_GAP,
    CANVAS_PAD + 2 * (CANVAS_ROW + CANVAS_GAP),
    CANVAS_PAD + 3 * (CANVAS_ROW + CANVAS_GAP),
  ].map((x) => Math.round(x)));
  const contentW = 4 * CANVAS_ROW + 3 * CANVAS_GAP;
  expect(layout.width).toBe(contentW + CANVAS_PAD * 2);
  expect(layout.height).toBe(CANVAS_ROW + CANVAS_PAD * 2);
});

it('两批叠两条带，旧那条标成 faded（画布上变淡的就是它）', () => {
  const layout = layoutCloneBatches([batch('j2', [51, 52]), batch('j1', [41, 42])]);
  const [first, second] = layout.cards;
  expect(first.faded).toBe(false);
  expect(first.latest).toBe(true);
  expect(layout.cards.filter((c) => c.faded).map((c) => c.batchKey)).toEqual(['j1', 'j1']);
  expect(second.y).toBe(CANVAS_PAD);
  // 旧批那条带排在下一条：新批永远在最上面，生成完眼睛落的地方就是它
  const oldBand = layout.cards.find((c) => c.batchKey === 'j1')!;
  expect(oldBand.y).toBe(CANVAS_PAD + CANVAS_ROW + CANVAS_GAP);
});

it('窄的那条带在自己那一行里居中，不许靠左顶出一块空白', () => {
  // 新批 1 张、旧批 3 张：包围盒宽由宽那条定，窄那条得居中
  const layout = layoutCloneBatches([batch('j2', [51]), batch('j1', [41, 42, 43])]);
  const wideW = 3 * CANVAS_ROW + 2 * CANVAS_GAP;
  expect(layout.width).toBe(wideW + CANVAS_PAD * 2);
  const lone = layout.cards.find((c) => c.batchKey === 'j2')!;
  const wide0 = layout.cards.find((c) => c.batchKey === 'j1')!;
  expect(lone.x).toBe(Math.round((layout.width - CANVAS_ROW) / 2));
  expect(wide0.x).toBe(CANVAS_PAD);
});

it('卡片尺寸照提交时挑的比例算，认不出比例才按方的排', () => {
  const portrait = layoutCloneBatches([batch('j1', [41], { w: 9, h: 16 })]);
  expect(portrait.cards[0].w).toBe(Math.round((CANVAS_ROW * 9) / 16));
  expect(portrait.cards[0].h).toBe(CANVAS_ROW);
  const unknown = layoutCloneBatches([batch('j1', [41], null)]);
  expect(unknown.cards[0].w).toBe(CANVAS_ROW);
});

/* ───────────────────────── 相机：点哪张看哪张 ───────────────────────── */

it('相机把某一张挪到视口中心：偏移是它在包围盒里的位置乘上倍率', () => {
  const layout = layoutCloneBatches([batch('j1', [41, 42])]);
  const second = layout.cards[1];
  const cam = cameraForCard(second, layout, { w: 800, h: 600 }, ZOOM_LIMITS);
  const expected = Math.min((800 - CANVAS_INSET * 2) / second.w, (600 - CANVAS_INSET * 2) / second.h);
  expect(cam.scale).toBeCloseTo(expected, 6);
  // 第二张在包围盒中心的右边，要把它挪回中心就得往左推
  expect(cam.pan.x).toBeCloseTo(-(second.x + second.w / 2 - layout.width / 2) * cam.scale, 6);
  expect(cam.pan.y).toBeCloseTo(0, 6);
});

it('相机不吃 ZOOM_LIMITS 以外的倍率；视口还没量到时给一个不动的相机', () => {
  const layout = layoutCloneBatches([batch('j1', [41])]);
  const card = layout.cards[0];
  const huge = cameraForCard(card, layout, { w: 100000, h: 100000 }, ZOOM_LIMITS);
  expect(huge.scale).toBe(ZOOM_LIMITS.max);
  const unmeasured = cameraForCard(card, layout, { w: 0, h: 0 }, ZOOM_LIMITS);
  // 单测环境里 rect 全 0：宁可倍率 1、不平移，也不能吐 NaN 把样式带坏
  expect(unmeasured).toEqual({ scale: 1, pan: { x: 0, y: 0 } });
});

it('整批永远不许超出视口——fit 的定义就是这样，画布自己因此不许出滚动条', () => {
  const zoom = new ViewerZoom({
    content: () => ({ w: 2000, h: 1200 }),
    viewport: () => ({ w: 800, h: 400 }),
    inset: CANVAS_INSET,
    upscaleToFit: true,
  });
  expect(zoom.displayW).toBeLessThanOrEqual(800);
  expect(zoom.displayH).toBeLessThanOrEqual(400);
});

it('整批比那一格还小时放大坐满：只出一张不许在正中留一张 240 的小图', () => {
  // 实拍采到的观感账（1440 窗口、视口 748x369）：卡片那 240px 是排布设计档、不是素材分辨率，
  // fit 卡在 1.0× 时 1 批 1 张只填了 65% 高 / 18% 宽，四周全是空的——原来那一格是铺满的。
  const zoom = new ViewerZoom({
    content: () => ({ w: 175, h: 280 }),
    viewport: () => ({ w: 748, h: 369 }),
    inset: CANVAS_INSET,
    upscaleToFit: true,
  });
  expect(zoom.fitRatio).toBeGreaterThan(1);
  expect(zoom.displayH).toBe(345); // 369 - inset：竖向坐满
  expect(zoom.displayW).toBeLessThanOrEqual(748);
});

/* ───────────────────────── 图源：放大不许糊 ───────────────────────── */

it('图源按「这张要在屏幕上占多少物理像素」往上报档，一路到原图', () => {
  const out = { id: 41, kind: 'image', filename: '', thumbnail_url: '' };
  expect(cloneSourceUrl(out, 500)).toBe('/api/images/41/file?max=1024');
  expect(cloneSourceUrl(out, 1500)).toBe('/api/images/41/file?max=2048');
  expect(cloneSourceUrl(out, 4000)).toBe('/api/images/41/file?max=4096');
  expect(cloneSourceUrl(out, 9000)).toBe('/api/images/41/file');
});

it('要多少像素由卡片自然宽 × 当前倍率 × dpr 算，倍率上去档才跟着上去', () => {
  const layout = layoutCloneBatches([batch('j1', [41])]);
  expect(neededPixels(layout.cards[0], 1, 1)).toBe(CANVAS_ROW);
  expect(neededPixels(layout.cards[0], 3, 2)).toBe(CANVAS_ROW * 6);
});

it('视频与音频只认后端给的地址，一次都不硬拼 /api/images', () => {
  const clip = { id: 41, kind: 'video', filename: 'a.mp4', thumbnail_url: '/api/videos/41/thumb' };
  expect(cloneSourceUrl(clip, 9000)).toBe('/api/videos/41/thumb');
  const wave = { id: 88, kind: 'audio', filename: 'v.wav', thumbnail_url: '/api/audio/88/waveform' };
  expect(cloneSourceUrl(wave, 9000)).toBe('/api/audio/88/waveform');
});

/* ───────────────────────── 批次：多轮累积 ───────────────────────── */

const TPL = {
  id: 1, name: 'Qwen 多图编辑', is_active: true, default_prompt: '',
  created_at: '', updated_at: '', node_count: 4, prompt_count: 1, reference_count: 1, control_count: 1,
  slots: [
    { kind: 'prompt', node: '582', input: 'prompt', label: '完整提示词' },
    { kind: 'image', node: '543', input: 'image', label: '人物参考' },
    { kind: 'select', node: '13', input: 'aspect_ratio', label: '比例', options: ['1:1', '9:16'], value: '1:1' },
  ],
};
const SOURCE = { id: 7, item_type: 'media', kind: 'image', filename: 'source.png', path: 'D:/source.png', original_url: '/api/images/7/file', width: 800, height: 600 } as any;

// 收尾之后仍可能有请求在飞（loadPrompt 这类），默认实现必须回一个 rejected promise：
// 交回 undefined 会让组件里那句 .catch() 炸成未处理的 rejection。
const http = vi.fn(
  async (_path: string, _init?: RequestInit): Promise<unknown> => { throw new Error('未预演的接口'); },
);
vi.mock('../lib/api', () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), import: vi.fn(async () => ({ saved: [], skipped: [] })) },
  comfyuiApi: { status: vi.fn(async () => ({ running: true, enabled: true, url: 'http://127.0.0.1:8188' })) },
  http: (path: string, init?: RequestInit) => (globalThis as any).__http(path, init),
}));
(globalThis as any).__http = http;

const NO_SOURCES = { references: [], template_id: null, source_image_id: null, dropped: 0 };
function routes(map: Record<string, unknown>) {
  http.mockImplementation(async (path: string, init?: RequestInit) => {
    const key = Object.keys(map).find((k) => path.startsWith(k));
    if (!key) throw new Error(`未预演的接口：${path}`);
    const value = map[key];
    return typeof value === 'function' ? (value as (i?: RequestInit) => unknown)(init) : value;
  });
}
const baseRoutes = () => ({
  '/api/clone/templates': { items: [TPL] },
  '/api/clone/sources/7': NO_SOURCES,
  '/api/clone/jobs/current': EMPTY_CLONE_JOB,
  '/api/images/7/reverse-prompts': { items: [] },
  '/api/images/7': { id: 7, filename: 'source.png', positive_prompt: '' },
  '/api/clone/cloud/status': {
    cloud_max_single_coins: 0, cloud_max_daily_coins: 0,
    availability: { available: false, reason: '还没有可用的云端账号' },
    accounts: [], presets: [], pending: [], seeded: true,
    spend: { today_coins: 0, month: '2026-11', counts: {}, month_coins: 0, recent: [] },
  },
  // 每点一次生成换一条 job：弹窗只认自己提交过的那条 job_id，
  // 第二轮不真的再点一次生成，那条新 job 对它就是不存在的。
  '/api/clone/generate': () => {
    generateSeq += 1;
    return { ...EMPTY_CLONE_JOB, active: true, job_id: `j${generateSeq}`, state: 'queued', running: true };
  },
});
let generateSeq = 0;

async function ready(over: Record<string, unknown> = {}) {
  const screen = render(CloneModal, { open: true, image: SOURCE, onClose: () => {}, canvasPrototype: true, ...over });
  await screen.findByLabelText('提示词');
  return screen;
}

/**
 * 点生成之后先等那条响应落进 store，再把 job 推到 done。
 * 反着来会被晚到的 queued 盖掉——state 一回 queued，画布那一分支就不挂载了。
 * 等 job_id 落地就够了：queued 是终点之前的常态，等到它消失是等不到的。
 */
async function settled(jobId = 'j1') {
  await vi.waitFor(() => {
    expect(get(cloneJob).job_id).toBe(jobId);
  });
}

/** 把这条 job 推到 done：封存点就在 applyCloneProgress 上，弹窗里读的就是这份状态。 */
async function runOnce(ids: number[], jobId = 'j1') {
  applyCloneProgress({
    active: true, job_id: jobId, state: 'done', running: false, template_id: 1, image_ids: ids,
  });
  await tick();
}

/** 真跑第二轮：点生成 → 等响应落地（新的 job_id 才算「我这条」）→ 推到 done。 */
async function secondRound(screen: Awaited<ReturnType<typeof ready>>, ids: number[]) {
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '第二轮' } });
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  await settled('j2');
  await runOnce(ids, 'j2');
}

afterEach(() => {
  cleanup();
  http.mockReset();
  vi.restoreAllMocks();
  cloneJob.set(EMPTY_CLONE_JOB);
  clearCloneBatches();
  generateSeq = 0;
  comfyuiStatus.set({ running: true, enabled: true, url: 'http://127.0.0.1:8188', checked_at: 0 });
});

it('跑完一批就在画布上铺开：两张是两张卡片，不再是一张图加两颗箭头', async () => {
  routes(baseRoutes());
  const screen = await ready();
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '出两张' } });
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  await settled();
  applyCloneProgress({
    active: true, job_id: 'j1', state: 'done', running: false, template_id: 1,
    outputs: [
      { id: 41, kind: 'image', filename: 'a.png', thumbnail_url: '/api/images/41/file?max=256' },
      { id: 42, kind: 'image', filename: 'b.png', thumbnail_url: '/api/images/42/file?max=256' },
    ],
  });
  await tick();
  expect(screen.container.querySelectorAll('.cc-card')).toHaveLength(2);
  // 翻页那两颗箭头是这一轮要撤的东西，画布分支里不该再有它们
  expect(screen.queryByRole('button', { name: '看下一份产出' })).toBeNull();
  expect(screen.container.querySelector('.cm-hero-pager')).toBeNull();
  // 计数与播报留着：不看画面的人也该知道自己停在哪一份
  expect(screen.container.querySelector('.cc-count')?.textContent).toBe('第 1 / 2 份');
  expect(screen.container.querySelector('.cc-count')?.getAttribute('aria-live')).toBe('polite');
});

it('提交时挑的比例跟着批次封存下来，画布按它排卡', async () => {
  routes(baseRoutes());
  const screen = await ready();
  await fireEvent.click(screen.getByRole('button', { name: '画面参数' }));
  await fireEvent.click(screen.getByRole('button', { name: '9:16' }));
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '竖图' } });
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  await settled();
  await runOnce([41]);
  expect(get(cloneBatches).map((b) => b.aspect)).toEqual([{ w: 9, h: 16 }]);
  const card = screen.container.querySelector('.cc-card') as HTMLElement;
  expect(card.style.width).toBe(`${Math.round((CANVAS_ROW * 9) / 16)}px`);
});

it('第二轮结果坐在最上面，上一轮变淡留在同一个平面上', async () => {
  routes(baseRoutes());
  const screen = await ready();
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '第一轮' } });
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  await settled();
  await runOnce([41]);
  await secondRound(screen, [51]);
  const cards = [...screen.container.querySelectorAll<HTMLElement>('.cc-card')];
  expect(cards).toHaveLength(2);
  expect(cards[0].className).not.toContain('is-faded');
  expect(cards[0].getAttribute('style')).toContain(`top: ${CANVAS_PAD}px`);
  expect(cards[1].className).toContain('is-faded');
  // 「刚生成的」只对最新那批成立，旧批说这句话就是假话
  expect(screen.queryByRole('button', { name: '在图库中打开刚生成的第 41 张' })).toBeNull();
  expect(screen.getByRole('button', { name: '在图库中打开第 41 张' })).toBeTruthy();
});

it('同一条 job 反复推 done 只占一批；第六批进来丢最旧那条', () => {
  armCloneBatchAspect('1:1');
  for (let i = 0; i < 3; i++) applyCloneProgress({ active: true, job_id: 'j1', state: 'done', running: false, image_ids: [41] });
  expect(get(cloneBatches).map((b) => b.key)).toEqual(['j1']);
  for (let n = 2; n <= CLONE_BATCH_LIMIT + 1; n++) {
    applyCloneProgress({ active: true, job_id: `j${n}`, state: 'done', running: false, image_ids: [40 + n] });
  }
  const keys = get(cloneBatches).map((b) => b.key);
  expect(keys).toHaveLength(CLONE_BATCH_LIMIT);
  expect(keys).toEqual(['j6', 'j5', 'j4', 'j3', 'j2']);
});

it('接手读带 seal:false：那条 job 的状态照收，画布不收', () => {
  armCloneBatchAspect('1:1');
  applyCloneProgress(
    { active: true, job_id: 'j1', state: 'done', running: false, image_ids: [41] },
    { seal: false },
  );
  expect(get(cloneJob).state).toBe('done');
  expect(get(cloneBatches)).toEqual([]);
});

it('云端「取回来」那条通路也入批：error 直接翻成 done 也算跑完一批', () => {
  armCloneBatchAspect('1:1');
  applyCloneProgress({ active: true, job_id: 'j1', state: 'error', running: false, error: '没接住' });
  expect(get(cloneBatches)).toHaveLength(0);
  applyCloneProgress({ active: true, job_id: 'j1', state: 'done', running: false, image_ids: [41] });
  expect(get(cloneBatches).map((b) => b.key)).toEqual(['j1']);
});

it('换一张卡或者收了弹窗，这一轮的批次跟着清掉', async () => {
  routes(baseRoutes());
  const screen = await ready();
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '出一张' } });
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  await settled();
  await runOnce([41]);
  expect(get(cloneBatches)).toHaveLength(1);
  screen.rerender({ open: false, image: SOURCE, onClose: () => {}, canvasPrototype: true });
  await tick();
  expect(get(cloneBatches)).toEqual([]);
});

it('重开弹窗接手上一轮那条 job：界面不显示它，画布也不许把它请回来', async () => {
  routes(baseRoutes());
  const screen = await ready();
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '出一张' } });
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  await settled();
  await runOnce([41]);
  screen.rerender({ open: false, image: SOURCE, onClose: () => {}, canvasPrototype: true });
  await tick();
  expect(get(cloneBatches)).toEqual([]);
  // 后端内存里那条 job 还挂着，而且已经是 done：界面那条 derived 不认它（只认 running），
  // 画布要是照单全收，关窗重开就会让上一批自己复活成「旧批」（实拍采到过）。
  routes({
    ...baseRoutes(),
    '/api/clone/jobs/current': { active: true, job_id: 'j1', state: 'done', running: false, template_id: 1, image_ids: [41] },
  });
  screen.rerender({ open: true, image: SOURCE, onClose: () => {}, canvasPrototype: true });
  await vi.waitFor(() => { expect(get(cloneJob).job_id).toBe('j1'); });
  expect(get(cloneBatches)).toEqual([]);
  expect(screen.container.querySelector('.cc-root')).toBeNull();
});

/* ───────────────────────── 点击与键盘 ───────────────────────── */

async function canvasWith(ids: number[], over: Record<string, unknown> = {}) {
  routes(baseRoutes());
  const screen = await ready({ onClose: () => {}, ...over });
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '出一批' } });
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  await settled();
  applyCloneProgress({
    active: true, job_id: 'j1', state: 'done', running: false, template_id: 1,
    outputs: ids.map((id) => ({ id, kind: 'image', filename: `${id}.png`, thumbnail_url: `/api/images/${id}/file?max=256` })),
  });
  await tick();
  return screen;
}

it('点一张把它放大、再点同一张退回全览；去图库是另一颗按钮', async () => {
  const onOpenImage = vi.fn();
  const screen = await canvasWith([41, 42], { onOpenImage });
  const cards = () => [...screen.container.querySelectorAll<HTMLElement>('.cc-card')];
  expect(cards()[1].className).not.toContain('is-focused');
  await fireEvent.click(within(cards()[1], '.cc-zoom'));
  expect(cards()[1].className).toContain('is-focused');
  expect(screen.container.querySelector('.cc-count')?.textContent).toBe('第 2 / 2 份');
  // 放大态下画布上有一颗真空按钮兜空白：点它退回全览
  expect(screen.container.querySelector('.cc-backdrop')).toBeTruthy();
  await fireEvent.click(within(cards()[1], '.cc-zoom'));
  expect(cards()[1].className).not.toContain('is-focused');
  expect(screen.container.querySelector('.cc-backdrop')).toBeNull();
  // 放大与去图库是两件事：整块图一点就跳走，是连着看四张的人最烦的事
  await fireEvent.click(within(cards()[0], '.cc-open'));
  expect(onOpenImage).toHaveBeenCalledWith(41, 'image');
});

it('键盘左右键在产出间移焦；画布没拿到焦点时不许抢方向键', async () => {
  const screen = await canvasWith([41, 42, 43]);
  const cards = () => [...screen.container.querySelectorAll<HTMLElement>('.cc-card')];
  const count = () => screen.container.querySelector('.cc-count')?.textContent;
  // 方向键挂在卡片那颗按钮上：Tab 停在卡片上，左右就在卡片之间挪
  await fireEvent.keyDown(within(cards()[0], '.cc-zoom'), { key: 'ArrowRight' });
  expect(count()).toBe('第 2 / 3 份');
  // 焦点跟着画面上放大那一张走，不然按两下就把键盘用户留在原地
  expect(document.activeElement).toBe(within(cards()[1], '.cc-zoom'));
  await fireEvent.keyDown(within(cards()[1], '.cc-zoom'), { key: 'ArrowLeft' });
  expect(count()).toBe('第 1 / 3 份');
  // 提示词框里的方向键归光标，不归画布
  const ta = screen.getByLabelText('提示词') as HTMLTextAreaElement;
  await fireEvent.keyDown(ta, { key: 'ArrowRight' });
  expect(count()).toBe('第 1 / 3 份');
});

it('放大态下第一下 Esc 退回全览，第二下才关弹窗', async () => {
  routes(baseRoutes());
  const onClose = vi.fn();
  const screen = await ready({ onClose });
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '出一张' } });
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  await settled();
  await runOnce([41]);
  await fireEvent.click(within(screen.container.querySelector('.cc-card') as HTMLElement, '.cc-zoom'));
  await fireEvent.keyDown(window, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.container.querySelector('.cc-backdrop')).toBeNull();
  await fireEvent.keyDown(window, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('视频与音频产出点它是交给父组件分派，不进画布的 100%', async () => {
  routes(baseRoutes());
  const onOpenImage = vi.fn();
  const screen = await ready({ onOpenImage });
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '出条片子' } });
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  await settled();
  applyCloneProgress({
    active: true, job_id: 'j1', state: 'done', running: false, template_id: 1,
    outputs: [
      { id: 41, kind: 'video', filename: 'a.mp4', thumbnail_url: '/api/videos/41/thumb' },
      { id: 88, kind: 'audio', filename: 'v.wav', thumbnail_url: '/api/audio/88/waveform' },
    ],
  });
  await tick();
  const cards = [...screen.container.querySelectorAll<HTMLElement>('.cc-card')];
  expect(cards).toHaveLength(2);
  // 没有那颗「放大」按钮：它们的缩放语义属于各自的播放器
  expect(screen.queryAllByRole('button', { name: /^放大第/ })).toHaveLength(0);
  expect(cards[0].querySelector('.cc-play')).toBeTruthy();
  expect((cards[0].querySelector('img') as HTMLImageElement).getAttribute('src')).toContain('/api/videos/41/thumb');
  await fireEvent.click(within(cards[0], '.cc-plain'));
  await fireEvent.click(within(cards[1], '.cc-plain'));
  expect(onOpenImage).toHaveBeenNthCalledWith(1, 41, 'video');
  expect(onOpenImage).toHaveBeenNthCalledWith(2, 88, 'audio');
});

it('开关没开还是现在这一格：没有画布，只有那张图和一颗去图库', async () => {
  routes(baseRoutes());
  const screen = await ready({ canvasPrototype: false });
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '出一张' } });
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  await settled();
  await runOnce([41]);
  expect(screen.container.querySelector('.cc-root')).toBeNull();
  expect(screen.getByRole('button', { name: '在图库中打开刚生成的第 41 张' })).toBeTruthy();
});

it('新批落地先退回全览：放大着上一批的时候不许停在旧的那张上', async () => {
  const screen = await canvasWith([41]);
  await fireEvent.click(within(screen.container.querySelector('.cc-card') as HTMLElement, '.cc-zoom'));
  expect(screen.container.querySelector('.cc-backdrop')).toBeTruthy();
  await secondRound(screen, [51]);
  await tick();
  expect(screen.container.querySelector('.cc-backdrop')).toBeNull();
  expect(screen.container.querySelectorAll('.cc-card')).toHaveLength(2);
});

/* ───────────────────────── 安全边界：坐标孤岛 ───────────────────────── */

it('画布内部不许出现 fixed / sticky：transform 会把它们带错位', () => {
  const css = readFileSync('src/components/CloneCanvas.svelte', 'utf8').slice(
    readFileSync('src/components/CloneCanvas.svelte', 'utf8').indexOf('<style>'),
  );
  expect(css).not.toMatch(/position:\s*fixed/);
  expect(css).not.toMatch(/position:\s*sticky/);
});

it('弹窗里那两条 fixed 不许搬进画布：它们一旦成了 transform 的后代就错位', async () => {
  const screen = await canvasWith([41]);
  const root = screen.container.querySelector('.cc-root') as HTMLElement;
  expect(root.querySelector('.cm-ref-zoom')).toBeNull();
  expect(root.querySelector('.cm-pop-scrim')).toBeNull();
  // 输入卡与底部那排胶囊也不能是画布的后代
  expect(root.querySelector('.cm-composer')).toBeNull();
  expect(root.querySelector('.cm-dock')).toBeNull();
});

it('画布的高度只读弹窗那一个来源，自己不写数也不写断点', () => {
  const canvas = readFileSync('src/components/CloneCanvas.svelte', 'utf8');
  const modal = readFileSync('src/components/CloneModal.svelte', 'utf8');
  // 画布读的是继承下来的 --cm-hero-h：弹窗改值它自动跟，窄窗口与矮窗口两档也因此不必自己写断点
  expect(canvas).toMatch(/\.cc-viewport\s*\{[\s\S]*?height:\s*var\(--cm-hero-h/);
  expect(canvas).not.toMatch(/\.cc-viewport\s*\{[\s\S]*?height:\s*(min|max|clamp)\(/);
  // 兜底那个数必须是弹窗的基类值：万一这层落在没写变量的地方，也不能变成零高
  expect(canvas).toMatch(/height:\s*var\(--cm-hero-h,\s*min\(46vh,\s*480px\)\)/);
  // 写数的地方只有弹窗那一侧：基类 + 两栏 + 窄窗口 + 矮窗口，四处各一次
  expect((modal.match(/--cm-hero-h:\s*[^;]+;/g) ?? []).length).toBe(4);
  // 展示图与等待台都只是读它——同一格轮流占，谁抄一份数就会在换状态时把输入卡顶来顶去
  expect((modal.match(/(?:max-)?height:\s*var\(--cm-hero-h\)/g) ?? []).length).toBe(2);
});

it('关动效的人画布是静止的：两层过渡都得撤干净', async () => {
  const css = readFileSync('src/components/CloneCanvas.svelte', 'utf8');
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  expect(block).toMatch(/\.cc-content[\s\S]{0,80}transition:\s*none/);
  // 平移那一层的 transition 是 ViewerZoom 给的 inline style，样式表里的 none 压不过内联。
  // 实拍实测过：媒体查询只压住了缩放那层，平移那层还是 0.28s——所以组件必须自己认一次系统偏好。
  vi.spyOn(window, 'matchMedia').mockReturnValue({
    matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  } as unknown as MediaQueryList);
  const screen = render(CloneCanvas, { batches: [batch('j1', [41])] });
  await tick();
  const stage = screen.container.querySelector('.cc-stage') as HTMLElement;
  expect(stage.style.transition).toBe('none');
});

it('组件单独挂也不炸：没有批次时不画卡片也不画计数', () => {
  const screen = render(CloneCanvas, { batches: [] });
  expect(screen.container.querySelectorAll('.cc-card')).toHaveLength(0);
  expect(screen.container.querySelector('.cc-count')).toBeNull();
});

/** testing-library 的 within 在 happy-dom 里对 div 好用，但不认 scoped 类名，这里只取一个直接子匹配。 */
function within(root: HTMLElement, selector: string): HTMLElement {
  const el = root.querySelector(selector) as HTMLElement | null;
  if (!el) throw new Error(`画布里找不到 ${selector}`);
  return el;
}