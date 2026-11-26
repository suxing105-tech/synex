import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/svelte';
import CloneModal from '../components/CloneModal.svelte';
import { EMPTY_CLONE_JOB, cloneJob, controlSummary, defaultControlValues } from '../lib/clone';
import { comfyuiStatus } from '../lib/stores';
import { clearToasts } from '../lib/toast';
import { resetPromptSkills } from '../lib/prompt-skills';
import { OUTPAINT_EMPTY_REASON, boardPads, outpaintSlots, readBoard } from '../lib/outpaint';

/**
 * 「闪寻扩图」挂进再次创作之后，画板那套和弹窗的接缝。
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
  name: '闪寻扩图',
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