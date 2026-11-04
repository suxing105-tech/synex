import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import CloneModal from '../components/CloneModal.svelte';
import { comfyuiApi, imagesApi } from '../lib/api';
import { EMPTY_CLONE_JOB, applyCloneProgress, cloneJob } from '../lib/clone';
import { comfyuiStatus, overlayMuted } from '../lib/stores';

const TPL = {
  id: 1, name: 'Qwen 多图编辑', is_active: true, default_prompt: '工作流里写的那句',
  created_at: '', updated_at: '', node_count: 4, prompt_count: 2, reference_count: 1, control_count: 2,
  slots: [
    { kind: 'prompt', node: '582', input: 'prompt', label: '完整提示词' },
    { kind: 'image', node: '543', input: 'image', label: '人物参考' },
    { kind: 'select', node: '13', input: 'aspect_ratio', label: '比例', options: ['1:1', '16:9'], value: '1:1' },
    { kind: 'number', node: '13', input: 'megapixels', label: '百万像素', value: 1.4, min: 0.5, max: 4, step: 0.1 },
  ],
};
/** 生成方式不再是看得见的标签（小字删掉了），只剩参考图这一组的可访问名。 */
const modeNode = (label: string) => document.querySelector(`[aria-label="参考图（${label}）"]`);

const SOURCE = { id: 7, item_type: 'media', kind: 'image', filename: 'source.png', path: 'D:/source.png', original_url: '/api/images/7/file', width: 800, height: 600 } as any;

const http = vi.fn();
// vi.mock 的工厂会被提升，取不到上面声明的 TPL / http，所以路由表挂到 globalThis 由用例现填。
vi.mock('../lib/api', () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), import: vi.fn(async () => ({ saved: [], skipped: [] })) },
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

const NO_SOURCES = { references: [], template_id: null, source_image_id: null, dropped: 0 };

const baseRoutes = () => ({
  '/api/clone/templates': { items: [TPL] },
  '/api/clone/sources/7': NO_SOURCES,
  '/api/clone/jobs/current': EMPTY_CLONE_JOB,
  '/api/images/7/reverse-prompts': { items: [] },
  '/api/images/7': { id: 7, filename: 'source.png', positive_prompt: '' },
  // 开弹窗现在会读一次云端可用性：不预演它，每条用例都会甩一个「未预演的接口」异常。
  // 默认按「还没填云端 Key」回，要用云端的用例在自己的路由表里覆盖这一条。
  '/api/clone/cloud/status': {
    cloud_max_single_coins: 0, cloud_max_daily_coins: 0,
    availability: { available: false, reason: '还没有可用的云端账号' },
    accounts: [], presets: [], pending: [], seeded: true,
    spend: { today_coins: 0, month: '2026-11', counts: {}, month_coins: 0, recent: [] },
  },
});

/** 打开弹窗并等模板落地：模板没读回来之前，提示词框、参考位、生成按钮整块都不渲染。 */
async function ready(over: Record<string, unknown> = {}) {
  const screen = render(CloneModal, { open: true, image: SOURCE, onClose: () => {}, ...over });
  await screen.findByLabelText('提示词');
  return screen;
}

afterEach(() => {
  cleanup();
  http.mockReset();
  // 试听那几条用 spyOn 顶掉了 play/pause，不收干净会漏给后面的用例
  vi.restoreAllMocks();
  cloneJob.set(EMPTY_CLONE_JOB);
  comfyuiStatus.set({ running: true, enabled: true, url: 'http://127.0.0.1:8188', checked_at: 0 });
});

it('后端带回来的参考格清单是 snake_case：悬停标题不能是「undefined｜文件名」', async () => {
  // 真实接口发的是 slot_label（见 GET /api/clone/templates），这份预演就照它写。
  const wire = {
    ...TPL,
    media_kind: 'video',
    soundtracks: 0,
    reference_cells: [
      { key: '188.image', kind: 'image', ordinal: 1, label: '图片1', name: '', slot_label: '加载图像', tag: '<Picture 1>' },
      { key: '185.video', kind: 'video', ordinal: 1, label: '视频1', name: '', slot_label: 'Load Video (Upload)', tag: '<Video 1>' },
    ],
  };
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [wire] } });
  const screen = await ready();
  expect(screen.getByTitle(/^加载图像｜source\.png$/)).toBeTruthy();
  // 空着的视频位不占格子（合并行只画已填的 + 末尾一颗不绑族的「+ 参考」）
  expect(screen.queryByText('视频1')).toBeNull();
  expect(screen.getByRole('button', { name: '添加参考素材' })).toBeTruthy();
  expect(screen.container.querySelector('[title^="undefined"]')).toBeNull();
});

it('参考位显示成「图片N」并带节点标题，提示词先留空但一键能填回工作流内置那句', async () => {
  routes(baseRoutes());
  const screen = await ready();
  expect(screen.getByText('图片1')).toBeTruthy();
  expect(screen.getByTitle(/^人物参考｜/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '替换图片1' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '移除图片1' })).toBeTruthy();
  expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('');
  await fireEvent.click(screen.getByRole('button', { name: '载入工作流内置提示词' }));
  expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('工作流里写的那句');
});

it('提示词预填：图片自带的 ComfyUI 提示词优先', async () => {
  routes({ ...baseRoutes(), '/api/images/7': { id: 7, positive_prompt: '图里带的' } });
  const screen = await ready();
  await tick();
  expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('图里带的');
});

it('图片没带提示词时用最新一条中文反推提示词', async () => {
  routes({ ...baseRoutes(), '/api/images/7/reverse-prompts': { items: [{ prompt_zh: '' }, { prompt_zh: '反推出来的画面' }] } });
  const screen = await ready();
  await tick();
  expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('反推出来的画面');
});

it('比例与百万像素收进参数面板：默认值在面板里点得中，选完写回同一批槽位键', async () => {
  routes(baseRoutes());
  const screen = await ready();
  expect(screen.queryByRole('dialog', { name: '画面参数' })).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: '画面参数' }));
  expect(await screen.findByRole('dialog', { name: '画面参数' })).toBeTruthy();
  // 当前值以 aria-pressed 标出来，不再是一个看不出选了的 select
  expect(screen.getByRole('button', { name: '1:1' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: '1.4MP' }).getAttribute('aria-pressed')).toBe('true');
  const box = screen.getByRole('button', { name: '16:9' }).querySelector('.cm-ratio-box') as HTMLElement;
  expect(parseFloat(box.style.width)).toBeGreaterThan(parseFloat(box.style.height));
  await fireEvent.click(screen.getByRole('button', { name: '16:9' }));
  await fireEvent.click(screen.getByRole('button', { name: '2MP' }));
  expect((screen.getByLabelText('百万像素') as HTMLInputElement).value).toBe('2');
  // 底部那颗 pill 就是当前选择的汇总
  expect(screen.getByRole('button', { name: '画面参数' }).textContent).toContain('16:9 / 2MP');
});

it('Esc 只收起参数面板，不会把整个再次创作弹窗关掉', async () => {
  routes(baseRoutes());
  const onClose = vi.fn();
  const screen = await ready({ onClose });
  await fireEvent.click(screen.getByRole('button', { name: '画面参数' }));
  await screen.findByRole('dialog', { name: '画面参数' });
  await fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: '画面参数' })).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByLabelText('提示词')).toBeTruthy();
});

it('参考图能关掉，那个位置变成「+ 参考」，从图库挑一张又能接着生成', async () => {
  const PICKED = { id: 88, filename: 'ref.png', path: 'D:/ref.png', kind: 'image', original_url: '/api/images/88/file', thumbnail_url: '/api/images/88/file', width: 400, height: 900 } as any;
  (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [PICKED], total: 1 });
  routes(baseRoutes());
  const screen = await ready();
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '写点什么' } });
  await fireEvent.click(screen.getByRole('button', { name: '移除图片1' }));
  expect(screen.queryByRole('button', { name: '移除图片1' })).toBeNull();
  // 参考位没放满就不许生成，而不是提交后让后端报错
  expect((screen.getByRole('button', { name: '生成' }) as HTMLButtonElement).disabled).toBe(true);
  await fireEvent.click(screen.getByRole('button', { name: '添加图片1参考图' }));
  const picker = await screen.findByRole('dialog', { name: '选一张参考图' });
  await fireEvent.click(await screen.findByRole('button', { name: 'ref.png' }));
  expect(picker).toBeTruthy();
  expect(screen.getByTitle(/^人物参考｜ref\.png$/)).toBeTruthy();
  const generate = screen.getByRole('button', { name: '生成' }) as HTMLButtonElement;
  await vi.waitFor(() => expect(generate.disabled).toBe(false));
});

it('来源说当初喂了两张：参考位就摆两张，摆的是那两张而不是被点的这张', async () => {
  const REF = (id: number, name: string) => ({ id, filename: name, path: `D:/${name}`, kind: 'image', original_url: `/api/images/${id}/file`, thumbnail_url: `/api/images/${id}/file`, width: 400, height: 900 });
  const two = { ...TPL, reference_count: 2, slots: [...TPL.slots, { kind: 'image', node: '564', input: 'image', label: '背景参考' }] };
  routes({
    ...baseRoutes(),
    '/api/clone/templates': { items: [two] },
    '/api/clone/sources/7': {
      references: [REF(40, '猫.png'), REF(471, '帽子.png')],
      template_id: 3, source_image_id: null, dropped: 0, origin: 'file',
    },
  });
  const screen = await ready();
  expect(screen.getByTitle(/^人物参考｜猫\.png$/)).toBeTruthy();
  expect(screen.getByTitle(/^背景参考｜帽子\.png$/)).toBeTruthy();
  expect(screen.getByText('图片2')).toBeTruthy();
  // 成图自己不该再冒充参考图（那就是「我明明用了两张，重开只有一张」的由来）
  expect(screen.queryByTitle(/^人物参考｜source\.png$/)).toBeNull();
});

it('认不出当初的参考图时明说「先放了它自己」，换一张参考图这句就收回', async () => {
  const PICKED = { id: 88, filename: 'ref.png', path: 'D:/ref.png', kind: 'image', original_url: '/api/images/88/file', thumbnail_url: '/api/images/88/file', width: 400, height: 900 } as any;
  (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [PICKED], total: 1 });
  routes({
    ...baseRoutes(),
    '/api/clone/sources/7': { references: [], template_id: null, source_image_id: null, dropped: 0, origin: 'unrecorded' },
  });
  const screen = await ready();
  // 参考位里那是被点的这张成图自己，不说明就会让人以为当初只喂了这一张
  expect(screen.container.querySelector('.cm-composer')!.getAttribute('title')).toContain('先放了它自己当参考');
  await fireEvent.click(screen.getByRole('button', { name: '替换图片1' }));
  await fireEvent.click(await screen.findByRole('button', { name: 'ref.png' }));
  await vi.waitFor(() => expect(screen.getByTitle(/^人物参考｜ref\.png$/)).toBeTruthy());
  expect(screen.container.querySelector('.cm-composer')!.getAttribute('title')).not.toContain('先放了它自己当参考');
});

it('普通导入的图片不解释来源：没带 workflow 就不该冒出一句「当初没记下参考图」', async () => {
  routes(baseRoutes());
  const screen = await ready();
  expect(screen.container.querySelector('.cm-composer')!.getAttribute('title')).not.toContain('先放了它自己当参考');
  expect(screen.container.querySelector('.cm-composer')!.getAttribute('title')).not.toContain('已经不在图库里了');
});

it('还没有模板时不是一句空提示，而是直接把人带去设置导入', async () => {
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [] } });
  const onOpenSettings = vi.fn();
  const screen = render(CloneModal, { open: true, image: SOURCE, onClose: () => {}, onOpenSettings });
  await screen.findByText(/还没有工作流/);
  await fireEvent.click(screen.getByRole('button', { name: '去设置里看说明' }));
  expect(onOpenSettings).toHaveBeenCalledWith('再次创作');
});

it('ComfyUI 真没在跑时顶上有一条说得清的提示，点「重新探测」就换掉', async () => {
  routes(baseRoutes());
  // 开弹窗会自己补测一次，所以这里得让「确实没跑」这件事是真的，横幅才不是一闪而过
  let alive = false;
  const status = comfyuiApi.status as ReturnType<typeof vi.fn>;
  status.mockImplementation(async () => ({ running: alive, enabled: true, url: 'http://127.0.0.1:8188' }));
  comfyuiStatus.set({ running: false, enabled: true, url: 'http://127.0.0.1:8188', checked_at: 0 });
  const screen = await ready();
  expect(screen.getByText(/连不上 ComfyUI/)).toBeTruthy();
  alive = true;
  await fireEvent.click(screen.getByRole('button', { name: '重新探测' }));
  await vi.waitFor(() => expect(get(comfyuiStatus).running).toBe(true));
  expect(screen.queryByText(/连不上 ComfyUI/)).toBeNull();
  // 还原默认预演，别把这个 mock 留给后面的用例
  status.mockImplementation(async () => ({ running: true, enabled: true, url: 'http://127.0.0.1:8188' }));
});

it('提示词为空不许生成；提交的是模板声明过的槽位键', async () => {
  let submitted: Record<string, unknown> | null = null;
  routes({
    ...baseRoutes(),
    '/api/clone/generate': (init?: RequestInit) => {
      submitted = JSON.parse(String(init?.body));
      return { ...EMPTY_CLONE_JOB, active: true, job_id: 'j1', state: 'queued', running: true };
    },
  });
  const screen = await ready();
  const generate = screen.getByRole('button', { name: '生成' });
  expect((generate as HTMLButtonElement).disabled).toBe(true);
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '换一张同款的画面' } });
  await fireEvent.click(generate);
  await tick();
  expect(submitted).toMatchObject({
    template_id: 1,
    prompt: '换一张同款的画面',
    references: [{ slot: '543.image', image_id: 7 }],
    controls: { '13.aspect_ratio': '1:1', '13.megapixels': 1.4 },
    source_image_id: 7,
  });
});

it('生成中按钮变成状态并给出取消；弹窗重开还接得上同一个任务', async () => {
  const running = { active: true, job_id: 'j1', state: 'running', running: true, template_id: 1, image_ids: [] };
  routes({ ...baseRoutes(), '/api/clone/jobs/current': running });
  // 弹窗一开就先接住后端正在跑的任务，所以这里的初始态本身就是「生成中」
  const screen = await ready();
  expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
  // 按钮不消失，只是变成进度本身：用户随时知道现在卡在哪一步
  expect(screen.getByRole('button', { name: '生成中…' }).getAttribute('disabled')).not.toBeNull();
  cleanup();
  // 关掉再开：任务在后端内存里跑着，弹窗重建不该让它看起来被丢了
  const again = await ready();
  await again.findByRole('button', { name: '取消' });
});

it('生成完成后在弹窗里给出这次出的图，点它跳到图库里那张', async () => {
  routes({ ...baseRoutes(), '/api/clone/generate': { ...EMPTY_CLONE_JOB, active: true, job_id: 'j1', state: 'queued', running: true } });
  const onOpenImage = vi.fn();
  const screen = await ready({ onOpenImage });
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '写点什么' } });
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  applyCloneProgress({ active: true, job_id: 'j1', state: 'done', running: false, template_id: 1, image_ids: [41] });
  await tick();
  const chip = await screen.findByRole('button', { name: '打开生成的第 41 张' });
  await fireEvent.click(chip);
  // 带上 kind：图片进「原图 vs 产出图」对比，视频要进播放器，父组件靠这个分派
  expect(onOpenImage).toHaveBeenCalledWith(41, 'image');
});

it('后端那句中文错误原样显示，不糊成一句生成失败', async () => {
  routes({ ...baseRoutes(), '/api/clone/generate': () => { throw Object.assign(new Error('409'), { detail: '已有任务在生成，先等它跑完' }); } });
  const screen = await ready();
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '随便写点什么' } });
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  expect(await screen.findByText('已有任务在生成，先等它跑完')).toBeTruthy();
});

/** 工作流原生支持 16 张参考图（下游那个节点是 autogrow 输入组），只连了一台 LoadImage。 */
const TPL_MULTI = {
  ...TPL, id: 2, name: '多图编辑 16 位',
  slots: [
    { kind: 'prompt', node: '582', input: 'prompt', label: '完整提示词' },
    { kind: 'image', node: '543', input: 'image', label: '人物参考', grow: { node: '582', group: 'images', names: ['image_2', 'image_3'] } },
  ],
};
const PICKED_REF = { id: 88, filename: 'ref.png', path: 'D:/ref.png', kind: 'image', original_url: '/api/images/88/file', thumbnail_url: '/api/images/88/file', width: 400, height: 900 } as any;

it('工作流能吃多张图时说清最多吃几张，默认一张＝单图编辑', async () => {
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [TPL_MULTI] } });
  const screen = await ready();
  expect(screen.getByText('图片1')).toBeTruthy();
  expect(modeNode('单图编辑')).toBeTruthy();
  // 「最多吃几张」不再是段落小字，收在 + 参考的悬停提示里
  expect(screen.getByRole('button', { name: '添加图片2参考图' }).getAttribute('title')).toContain('最多吃 3 张');
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '写点什么' } });
  await vi.waitFor(() => expect((screen.getByRole('button', { name: '生成' }) as HTMLButtonElement).disabled).toBe(false));
});

it('续位填了就以 node.input::image_N 的键交回后端，真槽位那张还在', async () => {
  let submitted: { references: { slot: string; image_id: number }[] } | null = null;
  (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [PICKED_REF], total: 1 });
  routes({
    ...baseRoutes(),
    '/api/clone/templates': { items: [TPL_MULTI] },
    '/api/clone/generate': (init?: RequestInit) => {
      submitted = JSON.parse(String(init?.body));
      return { ...EMPTY_CLONE_JOB, active: true, job_id: 'j1', state: 'queued', running: true };
    },
  });
  const screen = await ready();
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '写点什么' } });
  await fireEvent.click(screen.getByRole('button', { name: '添加图片2参考图' }));
  await screen.findByRole('dialog', { name: '选一张参考图' });
  await fireEvent.click(await screen.findByRole('button', { name: 'ref.png' }));
  await vi.waitFor(() => expect(screen.getByTitle(/^人物参考｜ref\.png$/)).toBeTruthy());
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  await vi.waitFor(() => expect(submitted).toBeTruthy());
  expect(submitted!.references).toEqual([{ slot: '543.image', image_id: 7 }, { slot: '543.image::image_2', image_id: 88 }]);
});

it('底部那颗「工作流」按钮里能切到另一份工作流，参考位跟着重填', async () => {
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [TPL, TPL_MULTI] } });
  const screen = await ready();
  expect(screen.getByRole('heading', { name: 'Qwen 多图编辑' })).toBeTruthy();
  expect(screen.queryByRole('menuitemradio')).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  await screen.findByRole('menu', { name: '工作流' });
  await fireEvent.click(screen.getByRole('menuitemradio', { name: /多图编辑 16 位/ }));
  await vi.waitFor(() => expect(screen.getByRole('heading', { name: '多图编辑 16 位' })).toBeTruthy());
  // 换工作流 = 换一套槽位：回到「被点的那张图填第一位 + 两个空续位」，菜单也收起来
  expect(screen.getByRole('button', { name: '替换图片1' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '添加图片2参考图' })).toBeTruthy();
  expect(screen.queryByRole('menu', { name: '工作流' })).toBeNull();
});

it('弹窗里直接加载本地工作流 JSON：解析槽位、落库、立刻切到新模板', async () => {
  const WF = { '582': { class_type: 'TextEncodeQwenImage21', inputs: { prompt: '新工作流里的那句' } } };
  const created = { ...TPL, id: 9, name: '新的工作流', slots: [{ kind: 'prompt', node: '582', input: 'prompt', label: '完整提示词' }] };
  const inspected: Record<string, unknown>[] = [];
  routes({
    // 路由表按插入顺序取第一个 startsWith，更具体的键必须排在 /api/clone/templates 前面
    '/api/clone/templates/inspect': (init?: RequestInit) => {
      inspected.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return { slots: created.slots, candidates: [], nodes: [], default_prompt: '新工作流里的那句', warnings: [], suggested_name: '新的工作流' };
    },
    '/api/clone/jobs/current': EMPTY_CLONE_JOB,
    '/api/clone/templates': (init?: RequestInit) => (init?.method === 'POST' ? created : { items: [TPL, created] }),
    '/api/images/7/reverse-prompts': { items: [] },
    '/api/images/7': { id: 7, filename: 'source.png', positive_prompt: '' },
  });
  const screen = await ready();
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  const input = (await screen.findByLabelText('选择本地工作流 JSON')) as HTMLInputElement;
  const file = new File([JSON.stringify(WF)], '我的多图.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => JSON.stringify(WF) });
  await fireEvent.change(input, { target: { files: [file] } });
  await vi.waitFor(() => expect(screen.getByRole('heading', { name: '新的工作流' })).toBeTruthy());
  expect(inspected[0].workflow).toEqual(WF);
  // 底部那颗按钮也跟着换名，用户随时知道自己在用哪一份
  expect(screen.getByRole('button', { name: '工作流' }).textContent).toContain('新的工作流');
});

it('选了个不是 JSON 的文件，说清楚原因而不是默默什么都不发生', async () => {
  routes(baseRoutes());
  const screen = await ready();
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  const input = (await screen.findByLabelText('选择本地工作流 JSON')) as HTMLInputElement;
  const file = new File(['{ 不是 json'], '坏了.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => '{ 不是 json' });
  await fireEvent.change(input, { target: { files: [file] } });
  expect(await screen.findByText(/不是合法的 JSON/)).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Qwen 多图编辑' })).toBeTruthy();
});

it('参考是左栏那一摞：栏宽固定、每张露出多少按张数算，十六格也不顶人', async () => {
  // 2026-11-04 苏醒第二轮：参考从「横向一条」改成「左栏一摞」。老约束没变——素材那一块不许把
  // 提示词框顶出弹窗，只是换个方向守：栏宽写死 84px，剩下的宽度全归提示词那一侧。
  const source = readFileSync("src/components/CloneModal.svelte", "utf8");
  expect(source).toMatch(/\.cm-input-row \{[^}]*display:\s*flex/);
  expect(source).toMatch(/\.cm-prompt-col \{[^}]*flex:\s*1 1 auto[^}]*min-width:\s*0/);
  expect(source).toMatch(/\.cm-ref-stack \{[^}]*flex:\s*none[^}]*width:\s*84px/);
  // 叠放靠负 margin（露出量 = --step），--z 顺着给（2026-11-04 苏醒：图片1 压在最底下，后挂的压在前面
  // 那张上头，加载参考那颗压在全摞最上面）→ 每张露的是上沿那一条，编号小牌跟着挪到左上角
  expect(source).toMatch(/\.cm-ref-stack \.cm-ref-cell \{[^}]*margin-top:\s*calc\(var\(--step\) - 84px\)/);
  expect(source).toMatch(/style="--z: \{i \+ 1\}"/);
  expect(source).toMatch(/style="--z: \{stackCount \+ 1\}"/);
  // 露出量上下限：46 是「一眼认得出是谁」，22 以下照片上沿那 20px 的编号就读不到了；
  // 186px 的总余量分给 n-1 张，整摞最多长到 ~270px，不会无限往下顶
  expect(source).toMatch(/const refStep = \$derived\(Math\.max\(22, Math\.min\(46,/);
  expect(source).toMatch(/186 \/ Math\.max\(stackCount - 1, 1\)/);
});

it('那一摞会动：整摞摊开、指到谁谁抬起来摆正，关动效的人那一摞是静止的', async () => {
  const source = readFileSync('src/components/CloneModal.svelte', 'utf8');
  // 鼠标碰到整摞 → 每张再多露 --spread（这个数同样按张数算，十六格那一档只剩 2px，不至于把卡撑得一跳一跳）
  expect(source).toMatch(/\.cm-ref-stack:hover, \.cm-ref-stack:focus-within \{ --step: calc\(var\(--step-base\) \+ var\(--spread\)\)/);
  expect(source).toMatch(/const refSpread = \$derived\(Math\.max\(2, Math\.min\(6,/);
  // 指到的那张从摞里抬出来摆正，并提到最前面（60 > 行内 --z），否则又被上面那张盖回去
  const lift = /\.cm-ref-stack \.cm-ref-cell:hover[\s\S]{0,160}?\}/.exec(source)?.[0] ?? '';
  expect(lift).toContain(':focus-within');
  expect(lift).toMatch(/z-index:\s*60/);
  expect(lift).toMatch(/rotate\(0deg\)/);
  // 抬起量 6px 小于两栏之间 14px 的缝：抬起来压不到提示词框
  expect(lift).toMatch(/translate\(6px, -3px\)/);
  // 指到谁，其余**照片**压暗；空格子与压在角上的那颗「+」不跟着退场（白圆钮压暗后在深色卡上糊成一块脏灰）
  const dim = /\.cm-ref-stack:hover \.cm-ref-cell:not\(:hover\)[^{]*\{/.exec(source)?.[0] ?? '';
  expect(dim).toContain('.cm-tile.media-chip');
  // 不写 prefers-reduced-motion 的动效等于强迫所有人看：关动效时整摞静止，叠放与编号照旧
  expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\.cm-ref-cell \{ transition:\s*none;/);
});

it('只有一张参考时那一摞摆两块：照片 + 压在右下角的「+」，可访问名不缩水', async () => {
  // 苏醒那张参考图就是这个版式：一张照片，加号压在照片角上，而不是旁边再摆一整格虚线框。
  const two = { ...TPL, reference_count: 2, slots: [...TPL.slots, { kind: 'image', node: '564', input: 'image', label: '背景参考' }] };
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [two] } });
  const screen = await ready();
  const stack = screen.container.querySelector('.cm-ref-stack') as HTMLElement;
  expect(stack.classList.contains('is-pair')).toBe(true);
  expect(stack.querySelectorAll('.cm-ref-cell')).toHaveLength(2);
  // 圆钮只剩一个加号：「图片2」改由 aria-label 念，格子本身仍在可访问树里
  expect(screen.getByRole('button', { name: '添加图片2参考图' })).toBeTruthy();
  expect(screen.getByRole('group', { name: '图片2' })).toBeTruthy();
  const css = readFileSync('src/components/CloneModal.svelte', 'utf8');
  // 圆钮自己 + 它那一格都缩到 32px：留 84px 整格会拿透明的那半截盖住照片下沿，抢走照片的悬停与点击
  const place = /\.cm-ref-stack\.is-pair \.cm-ref-cell:last-child,[\s\S]{0,220}?\}/.exec(css)?.[0] ?? '';
  expect(place).toMatch(/width:\s*32px/);
  expect(place).toMatch(/margin-left:\s*52px/);
  const badge = /\.cm-ref-stack\.is-pair \.cm-ref-cell:last-child \.cm-tile-add,[\s\S]{0,320}?\}/.exec(css)?.[0] ?? '';
  expect(badge).toMatch(/width:\s*32px/);
  expect(badge).toMatch(/border-radius:\s*50%/);
  expect(css).toMatch(/\.cm-ref-stack\.is-pair \.cm-ref-cell:last-child \.cm-ref-caption[\s\S]{0,80}?\{[^}]*display:\s*none/);
});

/** 后端说三档都跑得通的工作流：生成方式不再是开关，而是参考图数量的函数。 */
const TPL_MODES = { ...TPL_MULTI, id: 3, name: '三档工作流', modes: ['text', 'single', 'multi'] };

it('没有「生成方式」开关了：默认一张参考图就是单图编辑，方式只在可访问名里报一下', async () => {
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [TPL_MODES] } });
  const screen = await ready();
  expect(screen.queryByRole('group', { name: '生成方式' })).toBeNull();
  expect(screen.queryByRole('radio', { name: /文生图|单图编辑|多图编辑/ })).toBeNull();
  // 被点的那张图默认落在图片1 → 现在就是单图编辑，而且还能继续加
  expect(modeNode('单图编辑')).toBeTruthy();
  expect(screen.getByRole('button', { name: '替换图片1' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '添加图片2参考图' })).toBeTruthy();
});

it('关掉唯一的参考图就是切到文生图：只填提示词就能生成，且一张参考位都不交回后端', async () => {
  let submitted: any = null;
  routes({
    ...baseRoutes(),
    '/api/clone/templates': { items: [TPL_MODES] },
    '/api/clone/generate': (init?: RequestInit) => {
      submitted = JSON.parse(String(init?.body));
      return { ...EMPTY_CLONE_JOB, active: true, job_id: 'j1', state: 'queued', running: true };
    },
  });
  const screen = await ready();
  expect(modeNode('单图编辑')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: '移除图片1' }));
  await vi.waitFor(() => expect(modeNode('文生图')).toBeTruthy());
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '一座雪山' } });
  await vi.waitFor(() => expect((screen.getByRole('button', { name: '生成' }) as HTMLButtonElement).disabled).toBe(false));
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  await vi.waitFor(() => expect(submitted).toBeTruthy());
  expect(submitted).toMatchObject({ prompt: '一座雪山', references: [] });
  expect('mode' in submitted).toBe(false);
});

it('参考条永远只有一颗「+ 参考」，加一张就往后挪一格', async () => {
  (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [PICKED_REF], total: 1 });
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [TPL_MULTI] } });
  const screen = await ready();
  expect(screen.getByRole('button', { name: '添加图片2参考图' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '添加图片3参考图' })).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: '添加图片2参考图' }));
  await screen.findByRole('dialog', { name: '选一张参考图' });
  await fireEvent.click(await screen.findByRole('button', { name: 'ref.png' }));
  await vi.waitFor(() => expect(screen.getByRole('button', { name: '替换图片2' })).toBeTruthy());
  expect(screen.getByRole('button', { name: '添加图片3参考图' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '添加图片4参考图' })).toBeNull();
});

it('生成中那颗主按钮本身就是进度：换了状态文案也挂着动效类', async () => {
  const running = { active: true, job_id: 'j9', state: 'running', running: true, template_id: 1, image_ids: [] };
  routes({ ...baseRoutes(), '/api/clone/jobs/current': running });
  const screen = await ready();
  const go = screen.getByRole('button', { name: '生成中…' });
  expect(go.classList.contains('cm-go')).toBe(true);
  expect(go.classList.contains('is-busy')).toBe(true);
  expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
});

it('弹窗开着才藏背景里的分割线与箭头，关掉或卸载就还原', async () => {
  routes(baseRoutes());
  const screen = await ready();
  expect(get(overlayMuted)).toBe(true);
  screen.rerender({ open: false });
  await tick();
  expect(get(overlayMuted)).toBe(false);
  await ready();
  expect(get(overlayMuted)).toBe(true);
  // 还开着就被整棵树换掉：不能把「藏起来」留在背景上
  cleanup();
  expect(get(overlayMuted)).toBe(false);
});

it('虚化背景要干净：右侧详情栏整块内容也要藏掉，不只是藏分割线', () => {
  // 真机被指出来的是详情栏空态那支 36px 的 arrow-left：blur 之后就是幽灵箭头。
  const css = readFileSync('src/App.svelte', 'utf8');
  expect(css).toMatch(/\.overlay-muted \.app-grid > aside:last-child > \*\s*\{[^}]*visibility:\s*hidden/);
  expect(css).toMatch(/\.overlay-muted \.splitter::before\s*\{[^}]*opacity:\s*0/);
});

it('生成中的按钮还是那颗 CTA：压暗的渐变 + 扫光 + 转圈，不是灰掉的禁用键', () => {
  const css = readFileSync('src/components/CloneModal.svelte', 'utf8');
  const busy = css.slice(css.indexOf('.cm-go.is-busy {'));
  expect(busy).toMatch(/background:\s*linear-gradient/);
  expect(busy).toMatch(/color:\s*#fff/);
  expect(css).toMatch(/\.cm-go\.is-busy \.cm-go-shine\s*\{[^}]*animation:/);
});

it('缓存说 ComfyUI 没在跑时，开弹窗自己补测一次，并且不盯着状态反复重跑', async () => {
  comfyuiStatus.set({ running: false, enabled: true, url: 'http://127.0.0.1:8188', checked_at: 0 });
  routes(baseRoutes());
  const screen = await ready();
  await vi.waitFor(() => expect(get(comfyuiStatus).running).toBe(true));
  expect(screen.queryByText(/连不上 ComfyUI/)).toBeNull();
  const afterOpen = (comfyuiApi.status as ReturnType<typeof vi.fn>).mock.calls.length;
  // 状态变了不许把这条 effect 再点着：否则每次轮询都会把提示词冲回预填值
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '自己写的提示词' } });
  comfyuiStatus.set({ running: true, enabled: true, url: 'http://127.0.0.1:8188', checked_at: 1 });
  await tick();
  await tick();
  expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('自己写的提示词');
  expect((comfyuiApi.status as ReturnType<typeof vi.fn>).mock.calls.length).toBe(afterOpen);
});

it('生成中不显示状态行：按钮就是进度，提示词下面不再重复「生成中…（N 秒）」', async () => {
  const running = {
    active: true, job_id: 'j1', state: 'running', running: true, template_id: 1, image_ids: [],
    message: '上传参考图…', elapsed: 12,
  };
  routes({ ...baseRoutes(), '/api/clone/jobs/current': running });
  const screen = await ready();
  const foot = document.querySelector('.cm-foot');
  expect(foot).toBeTruthy();
  // 状态文案一旦进了 .cm-foot，就会把取消 / 生成挤到第二行（苏醒在真机上指出的错位）
  expect(foot!.querySelector('.cm-status')).toBeNull();
  // 整行也不要：按钮已经在转、文案写着「生成中…」，下面再摆一句是纯重复（苏醒 Round 12 截图点名）
  expect(document.querySelector('.cm-foot-note.cm-status')).toBeNull();
  expect(document.querySelector('.cm-foot-note')).toBeNull();
  // 按钮文案不跟随后端逐句进度，宽度才不会一边跑一边抖
  expect(screen.getByRole('button', { name: '生成中…' }).textContent?.trim()).toBe('生成中…');
  // 工作流那颗胶囊留在原地：一藏，这一排就空出一块，还看不出正在用哪一份出图（苏醒 Round 13 点名）
  const pill = screen.getByRole('button', { name: '工作流' }) as HTMLButtonElement;
  expect(pill.closest('.cm-hidden')).toBeNull();
  expect(pill.disabled).toBe(true);
  expect(pill.getAttribute('title')).toContain('生成中');
  // 生成中这颗点不开，箭头就收掉：既不说假话，也给名字让出宽度
  expect(pill.classList.contains('is-busy')).toBe(true);
  // 取消退成安静胶囊，别和生成挤成一坨
  expect(screen.getByRole('button', { name: '取消' }).className).toContain('cm-btn-quiet');
});

it('定宽优先：名字长短不许决定这一排的几何，取消和生成更不许被压', () => {
  // happy-dom 不跑布局，只能把让位公式锁在源码里：右边那组不参与压缩、还画在胶囊之上，
  // 左边每一格 min-width:0 可被压缩，实在放不下时整排换行 —— 让位的永远是胶囊，不是按钮。
  const css = readFileSync('src/components/CloneModal.svelte', 'utf8');
  expect(css).toMatch(/\.cm-foot\s*\{[^}]*flex-wrap:\s*wrap/);

  // flex-basis 定死，不许回到 auto：auto 的基准＝内容宽度，工作流名字一长整排就换行，
  // 「生成」跟着掉到第二行——苏醒这轮指的错位就是这么来的。定死之后换行只跟容器宽度有关。
  expect(css).toMatch(/\.cm-foot-left\s*\{[^}]*flex:\s*1 1 240px/);
  expect(css).not.toMatch(/\.cm-foot-left\s*\{[^}]*flex:\s*1 1 auto/);
  // 工作流那一格跟着名字收缩，不再摊薄成整行宽；整排的基准宽度仍由上面那 240px 定死，
  // 所以名字再长也只是在胶囊里截断，不会把「生成」顶到第二行。
  expect(css).toMatch(/\.cm-foot-left > \.cm-fill\s*\{[^}]*flex:\s*0 1 auto/);
  expect(css).toMatch(/\.cm-fill \.cm-pill\s*\{[^}]*width:\s*auto/);
  // 胶囊只包到名字那么宽（Round 26「工作流按钮右边空太多」）；整排靠左，与上面正文同一左边线
  // （Round 28：靠右 packing 时参数胶囊前面空出一截，读着像漏了一块）。
  expect(css).toMatch(/\.cm-fill \.cm-pill\s*\{[^}]*max-width:\s*100%/);
  expect(css).toMatch(/\.cm-foot-left\s*\{[^}]*justify-content:\s*flex-start/);
  // 弹层锚点跟着胶囊在这一排里的位置走：竖排（上下结构）之后这颗恒在行首，
  // 所以宽窄窗口一律贴左往右长。横排时代它贴着右栏右边缘，才有 right:0 那条——
  // 谁再把锚点翻回 right:0，1478×902 实测会顶穿面板左边界。
  expect(css).toMatch(/\.cm-pop-wf\s*\{[^}]*left:\s*0/);
  expect(css).toMatch(/\.cm-pop-wf\s*\{[^}]*right:\s*auto/);
  expect(css).not.toMatch(/\.cm-pop-wf\s*\{[^}]*right:\s*0/);
  const at = css.indexOf('@media (max-width: 900px)');
  expect(at).toBeGreaterThan(0);
  expect(css.slice(at)).not.toMatch(/\.cm-pop-wf\s*\{[^}]*right:\s*0/);
  expect(css).toMatch(/\.cm-actions\s*\{[^}]*flex:\s*none/);
  expect(css).toMatch(/\.cm-actions\s*\{[^}]*z-index:\s*6/);
  expect(css).toMatch(/\.cm-pop-wrap\s*\{[^}]*min-width:\s*0/);
  expect(css).toMatch(/\.cm-pill\s*\{[^}]*flex:\s*0 1 auto;[^}]*min-width:\s*0/);
  expect(css).toMatch(/\.cm-pill-text\s*\{[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis/);
  expect(css).toMatch(/\.cm-chevron\s*\{[^}]*flex:\s*none/);
  // 生成中收箭头只收画面：位置留着，胶囊宽度不随状态抖
  expect(css).toMatch(/\.cm-pill\.is-busy \.cm-chevron\s*\{[^}]*visibility:\s*hidden/);
  // 静止时也提前占好「取消」那一格：按下生成不该把左边挤得重排一次
  expect(css).toMatch(/\.cm-cancel-slot\s*\{[^}]*visibility:\s*hidden/);
  expect(css).toMatch(/class="cm-btn cm-btn-quiet cm-cancel-slot" aria-hidden="true"/);
  // 胶囊自己不能再写 flex:none —— 那正是长名字把「取消」顶穿的原因（苏醒 Round 15 截图）
  expect(css).not.toMatch(/\.cm-pill\s*\{[^}]*flex:\s*none/);
});

it('上下结构 + 卡内左右两栏：预览在上、参考在左、话在右，操作那一坞钉在弹窗最底下', async () => {
  // 2026-11-04 苏醒：像即梦那个 composer——先看素材，再写提示词，最后一排挑来源/参数并按生成。
  // happy-dom 不跑布局，所以这里压的是「谁在谁前面、谁包住谁」；钉住那条 bottom:0 的 CSS 由下面那条守卫看着。
  routes(baseRoutes());
  const screen = await ready();
  const all = Array.from(screen.container.querySelectorAll('*'));
  const at = ['.cm-hero', '.cm-ref-stack', '.cm-textarea', '.cm-dock'].map((sel) => {
    const el = screen.container.querySelector(sel);
    expect(el, sel).toBeTruthy();
    return all.indexOf(el as Element);
  });
  expect(at).toEqual([...at].sort((a, b) => a - b));
  // 卡内那一行是左右两栏（2026-11-04 苏醒第二轮）：素材在左、话在右，两个是同一行的兄弟，
  // 摞排在前——DOM 顺序与视觉顺序一致，键盘 Tab 才会先过素材再进提示词框。
  const stack = screen.container.querySelector('.cm-ref-stack') as HTMLElement;
  const row = stack.parentElement as HTMLElement;
  expect(row.classList.contains('cm-input-row')).toBe(true);
  expect(row.firstElementChild).toBe(stack);
  const col = (screen.container.querySelector('textarea.cm-textarea') as HTMLElement).closest('.cm-prompt-col') as HTMLElement;
  expect(col.parentElement).toBe(row);
  expect(Array.from(row.children).indexOf(stack)).toBeLessThan(Array.from(row.children).indexOf(col));
  // 操作行、状态与价格说明一起装进坞：钉住的是整坞，不是只有按钮那一行
  const dock = screen.container.querySelector('.cm-dock') as HTMLElement;
  expect(dock.querySelector('.cm-foot')).toBeTruthy();
  expect(dock.querySelector('[aria-label="工作流"]')).toBeTruthy();
  expect(dock.querySelector('[aria-label="画面参数"]')).toBeTruthy();
  // 坞必须是它那一格的最后一块：sticky bottom:0 靠这一点才不会被内容顶上去
  expect(dock.parentElement?.lastElementChild).toBe(dock);
});

it('竖排不回到左右两栏：弹窗收窄、预览按高度定大小、卡底那条 sticky 在可视区下沿', () => {
  const css = readFileSync('src/components/CloneModal.svelte', 'utf8');
  // nth 是第几次出现：.cm-hero 有基类和窄窗口两条，别把窄窗口那条当成基类改了
  const rule = (sel: string, nth = 0) => {
    let from = -1;
    for (let k = 0; k <= nth; k++) {
      from = css.indexOf(sel, from + 1);
      expect(from, sel).toBeGreaterThan(-1);
    }
    return css.slice(from, css.indexOf('}', from));
  };
  // 宽度不再是预览图的需求（820：读提示词的行宽 + 452 那屏仍放得下）
  expect(rule('.cm-panel {')).toMatch(/width:\s*min\(820px/);
  const body = rule('.cm-body {');
  expect(body).toMatch(/flex-direction:\s*column/);
  expect(body).not.toMatch(/grid-template-columns/);
  // 预览图由高度定大小：宽图不摊满整行，竖图不冲出弹窗
  expect(rule('.cm-hero {')).toMatch(/max-height:\s*min\(/);
  const dock = rule('.cm-dock {');
  expect(dock).toMatch(/position:\s*sticky/);
  // 钉住时这条的下边界要压在弹窗可视区的下沿上。Chrome 量 sticky 偏移用的是滚动容器的
  // content box，而弹窗那 20px 下内边距是可视的（滚动内容画得进去）——bottom 写 0 就露出
  // 20px，长提示词从这条下面露出来（538x682 实测）。所以 bottom 必须吃掉那 20px。
  expect(dock).toMatch(/bottom:\s*-20px/);
  // 左右负 margin 只吃**卡片**的内边距（12px）：这一排住在卡里，不再横到弹窗整宽。
  // -22px 是这条还挂在框外、要横到弹窗整宽那个时代的数，回来一次就露一次「框里挂了块板」。
  expect(dock).toMatch(/margin:\s*2px -12px 0/);
  expect(dock).not.toMatch(/margin:[^;]*-22px/);
  // 卡自己的下内边距必须是 0：留着的这几 px 会留在钉住的条下面，字从缝里露出来。
  expect(rule(".cm-composer {")).toMatch(/padding:\s*12px 12px 0/);
  // 卡不能 overflow:hidden（工作流弹层要往卡外冒），下圆角只能这条自己带：18px 卡圆角减 1px 边框。
  expect(dock).toMatch(/border-radius:\s*0 0 17px 17px/);
  // 这条不再自己画框：上面加一条分隔线就把「一次输入」劈成两块（苏醒要的是一个圆角矩形）。
  expect(dock).not.toMatch(/border-top/);
  // 不透明底：滚动时提示词从这条底下过去，不许透出字来
  expect(dock).toMatch(/background:/);
  // 上沿那 14px 渐隐：滚上来的字在这里淡掉，而不是被这条的上沿切一刀
  const fade = /\.cm-dock::before\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
  expect(fade).toMatch(/top:\s*-14px/);
  expect(fade).toMatch(/pointer-events:\s*none/);
  // 「创作类型」那层与「工作流」那层同宽：窄一档的话，正在用的那行末尾多个勾，
  // 行末的数把「图片生成」挤成「图…」。
  expect(rule(".cm-pop-kind {")).toMatch(/width:\s*268px/);
  expect(css).toMatch(/\.cm-pop-kind\s*\{\s*width:\s*min\(268px,\s*78vw\)/);
});

it('参考做进 composer 那张卡里：素材与话共用一张卡，卡里不摆灰字小注', async () => {
  // 2026-11-04 苏醒：「把参考做进框里做交互」＋「这种小字提示也删掉」——素材、话、按钮是同一次
  // 表达，拆成两块就看不出「这几张就是要用的参考」；而说明性的小字一律不占版面。
  routes(baseRoutes());
  const screen = await ready();
  const card = screen.container.querySelector('.cm-composer');
  expect(card, '.cm-composer').toBeTruthy();
  expect(card!.querySelector('.cm-ref-stack')).toBeTruthy();
  expect(card!.querySelector('textarea.cm-textarea')).toBeTruthy();
  // 卡外不挂小标题：槽位名不占版面，附框上方自己有名字
  expect(card!.previousElementSibling?.className ?? '').not.toContain('cm-block-title');
  const css = readFileSync('src/components/CloneModal.svelte', 'utf8');
  expect(css).not.toContain('<p class="cm-block-title">{promptBlockTitle');
});

it('提示词框下面不摆灰字小注：来源那句挂到框的悬停提示上', async () => {
  // 2026-11-04 苏醒（圈掉「完整提示词 · 已带上这张图自己的提示词」）：「这种小字提示也删掉」
  routes({
    ...baseRoutes(),
    // 只用图片自带那句：工作流没有内置提示词，右上角那颗不该出现，来源才轮得到图片自带
    '/api/clone/templates': { items: [{ ...TPL, default_prompt: '' }] },
    '/api/images/7': { id: 7, filename: 'source.png', positive_prompt: '图里自带的那句' },
  });
  const screen = await ready();
  const card = screen.container.querySelector('.cm-composer')!;
  expect(card.querySelector('.cm-field-foot'), '提示词框下面不该再有那一行').toBeNull();
  expect(card.querySelectorAll('.cm-note').length, 'composer 卡里不该有灰字小注').toBe(0);
  const box = screen.getByLabelText('提示词') as HTMLTextAreaElement;
  expect(box.getAttribute('title')).toBe('已带上这张图自己的提示词');
});

it('载入模板收成圆角框右上角那颗半透明图标：用得上才出现，点一下填进提示词框', async () => {
  // 2026-11-04 苏醒（圈掉「填入工作流内置提示词」那颗文字按钮）：「做成半透明图标，鼠标滑过展示，
  // 功能变成加载提示词模板，放在矩形圆框右上角」
  routes(baseRoutes());
  const screen = await ready();
  const wand = screen.getByRole('button', { name: '载入工作流内置提示词' }) as HTMLButtonElement;
  expect(wand.textContent?.trim()).toBe('');
  expect(wand.querySelector('svg'), '图标本身要画出来').toBeTruthy();
  await fireEvent.click(wand);
  expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('工作流里写的那句');
  // 填上之后没有下一级模板可填了就该收掉，别留一颗点了没反应的钮
  expect(screen.queryByRole('button', { name: '载入工作流内置提示词' })).toBeNull();
  // 工作流没有内置提示词 → 根本不摆这颗
  cleanup();
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [{ ...TPL, default_prompt: '' }] } });
  const s2 = await ready();
  expect(s2.queryByRole('button', { name: '载入工作流内置提示词' })).toBeNull();
  // 挂在圆角框右上角：绝对定位 + 上/右贴边、静止时半透明，且压得过左边那一摞参考
  const css = readFileSync('src/components/CloneModal.svelte', 'utf8');
  const rule = css.slice(css.indexOf('.cm-wand {'), css.indexOf('.cm-wand:hover'));
  expect(rule).toMatch(/position:\s*absolute/);
  expect(rule).toMatch(/top:\s*10px/);
  expect(rule).toMatch(/right:\s*10px/);
  expect(rule).toMatch(/opacity:\s*\.55/);
  const stack = css.slice(css.indexOf('.cm-ref-stack {'), css.indexOf('.cm-ref-stack:hover'));
  const zc = Number((stack.match(/z-index:\s*(\d+)/) ?? [0, '0'])[1]);
  expect(Number((rule.match(/z-index:\s*(\d+)/) ?? [0, '0'])[1])).toBeGreaterThan(zc);
});

it('版面里一条小字提示都不剩：丢参考、混族、不吃参考全收进悬停提示', async () => {
  // 2026-11-04 苏醒（圈掉「这张图当初还用了 1 张参考图，已经不在图库里了」）：「这种小字提示也删掉」
  routes({
    ...baseRoutes(),
    '/api/clone/sources/7': { references: [], template_id: null, source_image_id: null, dropped: 1, origin: "db" },
  });
  const screen = await ready();
  const card = screen.container.querySelector('.cm-composer')!;
  expect(card.querySelectorAll('.cm-note').length).toBe(0);
  expect(card.querySelector('.cm-composer-note')).toBeNull();
  expect(screen.container.textContent ?? '').not.toContain('已经不在图库里了');
  expect(card.getAttribute('title')).toContain('当初还用了 1 张参考图');
});

it('菜单、提示词、参考收进同一个圆角框：卡底那条是卡的一部分，状态行跟它钉在一起', async () => {
  // 2026-11-04 苏醒（照图一）：「把菜单、提示词、参考都和图一一样收进一个圆角矩形框里」。
  // 框外再摆一条深色的坞，等于把一次输入拆成两件事。happy-dom 不跑布局，这里压的是
  // 「谁包住谁、谁在最后」；贴边用的 bottom / margin 由上面那条 CSS 守卫看着。
  routes({
    ...baseRoutes(),
    '/api/clone/cloud/status': cloudOn(),
    '/api/clone/generate': {
      active: true, job_id: 'j1', state: 'error', running: false, message: '生成失败',
      error: '云端那边等到超时了', engine: 'cloud', media_kind: 'image',
      recoverable: true, task_row_id: 77, task_id: 'task-77', image_ids: [], outputs: [],
    },
    '/api/clone/cloud/tasks/77/refetch': {
      task_id: 77, image_ids: [88], count: 1, cost_coins: 12,
      outputs: [{ id: 88, kind: 'image', filename: 'a.png', thumbnail_url: '/api/images/88/file?max=256' }],
    },
  });
  const screen = await ready();
  const card = screen.container.querySelector('.cm-composer') as HTMLElement;
  expect(card, '.cm-composer').toBeTruthy();
  // 框只有这一个：卡外不许再挂着第二条操作排
  expect(screen.container.querySelectorAll('.cm-dock')).toHaveLength(1);
  const dock = screen.container.querySelector('.cm-dock') as HTMLElement;
  expect(dock.closest('.cm-composer')).toBe(card);
  // 参考、话、三颗胶囊、生成全在这一张卡里
  expect(card.querySelector('.cm-ref-stack')).toBeTruthy();
  expect(card.querySelector('textarea.cm-textarea')).toBeTruthy();
  expect(card.querySelector('[aria-label="画面参数"]')).toBeTruthy();
  expect(dock.querySelector('[aria-label="创作类型"]')).toBeTruthy();
  expect(dock.querySelector('.cm-go')).toBeTruthy();
  // 钉住这条必须是卡的最后一块，否则内容会从它下面冒出来，sticky 就成了假话
  expect(card.lastElementChild).toBe(dock);
  // 报错与「取回结果」跟着这条一起钉着：说的是这一次生成，要滚动才看见等于没说
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '把这套视觉搬过来' } });
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  const retry = await screen.findByRole('button', { name: '取回结果' });
  expect(retry.closest('.cm-dock')).toBeTruthy();
  const err = screen.container.querySelector('.cm-foot-note.cm-error') as HTMLElement;
  expect(err && err.closest('.cm-dock')).toBeTruthy();
  await fireEvent.click(retry);
  // 产出缩略图也在卡里，且排在钉住那条上面：跑完先看结果，不用先滚过一排按钮
  const results = await screen.findByText('本次产出');
  expect(results.closest('.cm-composer')).toBe(card);
  const inside = Array.from(card.querySelectorAll('*'));
  expect(inside.indexOf(results as Element)).toBeLessThan(inside.indexOf(dock as Element));
});

it('输入区按内容长高：空着只有两行，不再写死一格 224px', async () => {
  routes(baseRoutes());
  const screen = await ready();
  const ta = screen.getByLabelText('提示词') as HTMLTextAreaElement;
  // 量 auto 之前必须收成一行，否则 auto 量到的是 rows 撑出来的高度，永远缩不回去
  expect(ta.getAttribute('rows')).toBe('1');
  // 无头环境没有真实排版（scrollHeight=0）→ 正好落在下限，这条同时证明 autosize 真的在跑
  await vi.waitFor(() => expect(ta.style.height).toBe('46px'));
  expect(ta.style.overflowY).toBe('hidden');
  const css = readFileSync('src/components/CloneModal.svelte', 'utf8');
  expect(css).toMatch(/\.cm-textarea\s*\{[^}]*min-height:\s*46px/);
  expect(css).not.toMatch(/\.cm-textarea\s*\{[^}]*height:\s*clamp\(/);
  // 高度归 JS 管，留着竖向拉伸手柄等于给自己使绊子：一打字就把拖出来的高度冲掉
  expect(css).toMatch(/\.cm-composer \.cm-textarea\s*\{[^}]*resize:\s*none/);
});

it('编号压在照片上；空的绑定位不再重复写一遍「参考」', async () => {
  // 得挑一条有两个图片位的模板，否则第一个位被成图自己填上以后没有空格子，藏字那条就没得压
  const two = { ...TPL, reference_count: 2, slots: [...TPL.slots, { kind: 'image', node: '564', input: 'image', label: '背景参考' }] };
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [two] } });
  const screen = await ready();
  const cap = screen.getByText('图片1') as HTMLElement;
  expect(cap.parentElement?.classList.contains('cm-ref-cell')).toBe(true);
  // 空格子靠小牌说「图片2」，中间那行「参考」是重复的；藏字之后可访问名必须还在
  expect(screen.getByRole('button', { name: '添加图片2参考图' })).toBeTruthy();
  const css = readFileSync('src/components/CloneModal.svelte', 'utf8');
  expect(css).toMatch(/\.cm-ref-caption\s*\{[^}]*position:\s*absolute/);
  expect(css).toMatch(/\.cm-ref-cell \.cm-tile-add span\s*\{[^}]*display:\s*none/);
  // 编号在**左上角**：那一摞是后挂的压在前挂的上头，每张只露上沿，编号留在下沿就全被后面那张盖掉
  expect(css).toMatch(/\.cm-ref-caption\s*\{[^}]*top:\s*5px/);
  expect(css).not.toMatch(/\.cm-ref-caption\s*\{[^}]*bottom:/);
});

it('悬停放大的那一张按素材自己的比例摆：不是一条黑边裱一张小图', async () => {
  routes(baseRoutes());
  const screen = await ready();
  const img = screen.container.querySelector('.cm-ref-cell .cm-tile-pick img') as HTMLImageElement;
  expect(img).toBeTruthy();
  Object.defineProperty(img, 'naturalWidth', { value: 600, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: 1200, configurable: true });
  await fireEvent.mouseEnter(img.closest('.cm-ref-cell') as Element);
  const zoom = screen.container.querySelector('.cm-ref-zoom') as HTMLElement;
  expect(zoom).toBeTruthy();
  const w = parseFloat(zoom.style.width);
  const h = parseFloat(zoom.style.height);
  expect(h).toBeGreaterThan(0);
  expect(Math.abs(w / h - 0.5)).toBeLessThan(0.01);
  expect(zoom.querySelector('.cm-ref-zoom-cap')).toBeTruthy();
  await fireEvent.mouseLeave(img.closest('.cm-ref-cell') as Element);
  expect(screen.container.querySelector('.cm-ref-zoom')).toBeNull();
  const css = readFileSync('src/components/CloneModal.svelte', 'utf8');
  // 不接点击：否则鼠标一移过去就把格子的离开事件吃掉、放大图赖着不走
  expect(css).toMatch(/\.cm-ref-zoom\s*\{[^}]*pointer-events:\s*none/);
  expect(css).toMatch(/\.cm-ref-zoom-img\s*\{[^}]*object-fit:\s*cover/);
});

it('钉住那条坞不许透字；窗口一矮先给预览图砍一档', () => {
  const css = readFileSync('src/components/CloneModal.svelte', 'utf8');
  const at = css.indexOf('.cm-dock {');
  const dock = css.slice(at, css.indexOf('}', at));
  // 0.98/0.9 那版实测会透出底下那行字压在按钮上，所以只许实心色
  expect(dock).toMatch(/background:\s*#[0-9a-fA-F]{6}/);
  expect(dock).not.toMatch(/background:[^;]*rgba?\(/);
  // 又矮又窄时按矮处理：矮那一档必须写在窄那一档之后
  const shortAt = css.indexOf('@media (max-height: 720px)');
  expect(shortAt).toBeGreaterThan(css.indexOf('@media (max-width: 900px)'));
  expect(css.slice(shortAt)).toMatch(/\.cm-hero\s*\{[^}]*max-height:\s*17vh/);
});

it("窄窗口那一屏不许再撑 452px：面板放不下，两列上下叠、宽度回到 268 那一档", () => {
  // 538px 实测：452px 的弹层贴在胶囊边上，往左长顶穿左边界（左列标题只剩残字），
  // 换成贴右长又顶穿右边界（197..639 > 面板右 518）。这一档的面板内容宽只有 vw-84，
  // 两列怎么放都出屏，所以窄窗口只留一列：宽度沿用量过的 268px 那一档，服务商在上、模型在下。
  const css = readFileSync('src/components/CloneModal.svelte', 'utf8');
  const at = css.indexOf('@media (max-width: 900px)');
  expect(at).toBeGreaterThan(0);
  const narrow = css.slice(at);
  expect(narrow).toMatch(/\.cm-pop-wf\.is-api\s*\{[^}]*width:\s*min\(268px/);
  expect(narrow).toMatch(/\.cm-api\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  // 叠成一列后那道竖分隔得撤了，不然横线头上还挂着一截竖线
  expect(narrow).toMatch(/\.cm-api-side\s*\{[^}]*border-right:\s*0/);
  // 宽屏那两列不受影响：452px 那条还在，只是被 media query 覆盖
  expect(css).toMatch(/\.cm-pop-wf\.is-api\s*\{[^}]*width:\s*min\(452px/);
});

it('静止时先占好「取消」那一格：按下生成，左边那一排不重排', async () => {
  routes(baseRoutes());
  const screen = await ready();
  // 占位是隐形 span，不是第二颗按钮：静止时 a11y 树里压根没有「取消」
  const slot = document.querySelector('.cm-cancel-slot');
  expect(slot?.textContent?.trim()).toBe('取消');
  expect(slot?.getAttribute('aria-hidden')).toBe('true');
  expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
  // 生成中：占位换成真按钮，同一格位置、同一格宽度
  applyCloneProgress({ active: true, job_id: 'j1', state: 'running', running: true, template_id: 1, image_ids: [] });
  await tick();
  expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
  expect(document.querySelector('.cm-cancel-slot')).toBeNull();
});

it('跑完之后状态行才回来：已取消要有交代，不能一声不吭', async () => {
  routes({ ...baseRoutes(), '/api/clone/generate': { ...EMPTY_CLONE_JOB, active: true, job_id: 'j1', state: 'queued', running: true } });
  const screen = await ready();
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '写点什么' } });
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  applyCloneProgress({ active: true, job_id: 'j1', state: 'cancelled', running: false, template_id: 1, image_ids: [] });
  await tick();
  const note = document.querySelector('.cm-foot-note.cm-status');
  expect(note?.textContent).toContain('已取消');
});

it('生成与取消都是全圆角胶囊（苏醒明确点名的形状）', () => {
  const source = readFileSync('src/components/CloneModal.svelte', 'utf8');
  for (const selector of ['.cm-btn {', '.cm-go {']) {
    const block = source.slice(source.indexOf(selector), source.indexOf('}', source.indexOf(selector)));
    expect(block).toContain('border-radius: 999px');
  }
});

/** 参考位多于一个：图片1 默认挂着被点击的图，图片2 空着，正好测「再挂一张」。 */
const TWO_SLOTS = {
  ...TPL,
  slots: [
    { kind: "prompt", node: "582", input: "prompt", label: "完整提示词" },
    { kind: "image", node: "543", input: "image", label: "人物参考" },
    { kind: "image", node: "564", input: "image", label: "背景参考" },
  ],
};
const PICKED = {
  id: 21, item_type: "media", kind: "image", filename: "bg.png", path: "D:/bg.png",
  original_url: "/api/images/21/file", thumbnail_url: "/api/images/21/file", width: 512, height: 512,
} as any;

const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>(".cm-mention-item")];

it("提示词里打 @ 弹出「引用素材」，点一条把 @图片1 插回正文", async () => {
  routes(baseRoutes());
  const screen = await ready();
  const box = screen.getByLabelText("提示词") as HTMLTextAreaElement;
  await fireEvent.input(box, { target: { value: "把 @" } });
  await tick();
  const menu = document.querySelector(".cm-mention");
  expect(menu).toBeTruthy();
  expect(menu!.textContent).toContain("引用素材");
  expect(menu!.textContent).toContain("图片1");
  expect(menu!.textContent).toContain("source");
  await fireEvent.click(menuItems()[0]);
  await tick();
  expect(box.value).toBe("把 @图片1 ");
  expect(document.querySelector(".cm-mention")).toBeNull();
});

it("@ 后面接着打可以过滤：@图2 只剩「再挂一张」，挑完图自动写回 @图片2", async () => {
  (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [PICKED], total: 1 });
  routes({ ...baseRoutes(), "/api/clone/templates": { items: [TWO_SLOTS] } });
  const screen = await ready();
  const box = screen.getByLabelText("提示词") as HTMLTextAreaElement;
  await fireEvent.input(box, { target: { value: "@图2" } });
  await tick();
  const items = menuItems();
  expect(items).toHaveLength(1);
  expect(items[0].className).toContain("cm-mention-add");
  await fireEvent.click(items[0]);
  await fireEvent.click(await screen.findByRole("button", { name: "bg.png" }));
  await tick();
  expect(box.value).toBe("@图片2 ");
  expect(document.querySelector(".cm-mention")).toBeNull();
});

it("@ 菜单里上下键移动选中，回车是选中而不是换行", async () => {
  (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [PICKED], total: 1 });
  routes({ ...baseRoutes(), "/api/clone/templates": { items: [TWO_SLOTS] } });
  const screen = await ready();
  const box = screen.getByLabelText("提示词") as HTMLTextAreaElement;
  await fireEvent.input(box, { target: { value: "@" } });
  await tick();
  expect(menuItems().map((el) => el.getAttribute("aria-selected"))).toEqual(["true", "false"]);
  await fireEvent.keyDown(box, { key: "ArrowDown" });
  await tick();
  expect(menuItems().map((el) => el.getAttribute("aria-selected"))).toEqual(["false", "true"]);
  await fireEvent.keyDown(box, { key: "Enter" });
  expect(box.value).toBe("@");
  await fireEvent.click(await screen.findByRole("button", { name: "bg.png" }));
  await tick();
  expect(box.value).toBe("@图片2 ");
});

it("菜单开着时按 Esc 只收菜单，不把整层弹窗一起关掉", async () => {
  routes(baseRoutes());
  const close = vi.fn();
  const screen = render(CloneModal, { open: true, image: SOURCE, onClose: close });
  await screen.findByLabelText("提示词");
  const box = screen.getByLabelText("提示词") as HTMLTextAreaElement;
  await fireEvent.input(box, { target: { value: "@" } });
  await tick();
  expect(document.querySelector(".cm-mention")).toBeTruthy();
  await fireEvent.keyDown(box, { key: "Escape" });
  await tick();
  expect(document.querySelector(".cm-mention")).toBeNull();
  expect(close).not.toHaveBeenCalled();
});

it("工作流没有参考位时打 @ 不弹菜单（文生图工作流不该看到参考图）", async () => {
  routes({ ...baseRoutes(), "/api/clone/templates": { items: [{ ...TPL, slots: [TPL.slots[0], ...TPL.slots.slice(2)] }] } });
  const screen = await ready();
  const box = screen.getByLabelText("提示词") as HTMLTextAreaElement;
  await fireEvent.input(box, { target: { value: "@" } });
  await tick();
  expect(document.querySelector(".cm-mention")).toBeNull();
});

it("生成按钮静止时不挂那颗圆点，文案居中（真机上圆点把「生成」顶偏了）", () => {
  const source = readFileSync("src/components/CloneModal.svelte", "utf8");
  expect(source).toMatch(/\.cm-go:not\(\.is-busy\) \.cm-go-dot\s*\{\s*display: none;/);
  expect(/\.cm-go \{[^}]*justify-content: center/.test(source)).toBe(true);
});

it("引用标签按品牌色高亮：textarea 涂透明，字画在背后的遮罩上", async () => {
  routes(baseRoutes());
  const screen = await ready();
  const box = screen.getByLabelText("提示词") as HTMLTextAreaElement;
  await fireEvent.input(box, { target: { value: "人物外貌参考 @图片1，一镜到底" } });
  await tick();
  const bg = document.querySelector(".cm-prompt-bg");
  expect(bg).toBeTruthy();
  // 遮罩必须逐字镜像输入框，否则滚动 / 折行会飘
  expect(bg!.textContent).toBe("人物外貌参考 @图片1，一镜到底");
  const hl = bg!.querySelector(".cm-mention-hl");
  expect(hl?.textContent).toBe("@图片1");
  // happy-dom 不注入 Svelte 的 scoped <style>，样式只能读源码断言
  const source = readFileSync("src/components/CloneModal.svelte", "utf8");
  const mirror = /\.cm-textarea-mirror\s*\{[^}]*\}/.exec(source)?.[0] ?? "";
  expect(mirror).toMatch(/color: transparent/);
  expect(mirror).toMatch(/caret-color: #f24e4e/);
  // 透明字只许挂在带镜像层的主框上，不能挂回 .cm-textarea 本体
  const base = [...source.matchAll(/\.cm-textarea\s*\{[^}]*\}/g)].map((m) => m[0]).join("\n");
  expect(base).not.toMatch(/color:\s*transparent/);
  expect(/\.cm-textarea::placeholder\s*\{[^}]*color: #62626a/.test(source)).toBe(true);
});

it("高亮样式不许动盒模型（padding / border / font-weight 都会让高亮和光标错位）", () => {
  const source = readFileSync("src/components/CloneModal.svelte", "utf8");
  const rule = /\.cm-mention-hl\s*\{[^}]*\}/.exec(source)?.[0] ?? "";
  expect(rule).toContain("color: #ff6a4d");
  expect(rule).not.toMatch(/(^|[;{\s])padding/);
  expect(rule).not.toMatch(/(^|[;{\s])border(?!-radius|-color|-width)/);
  expect(rule).not.toMatch(/font-weight/);
  // 遮罩和输入框共用同一条排版规则，这是对齐的前提
  expect(source).toMatch(/\.cm-prompt-bg,\s*\.cm-textarea\s*\{[^}]*white-space: pre-wrap/);
});

/** 弹层里的第二条工作流：删除按钮的目标，正好不是当前那条。 */
const OTHER_WF = { ...TPL, id: 2, name: "单图编辑", is_active: false };
const deleteCalls = () => http.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE").map(([path]) => path);

it("点 X 直接删掉那条工作流，不再多问一遍「确认删除」", async () => {
  let left = [TPL, OTHER_WF];
  routes({
    // 具体键要排在 /api/clone/templates 前面，否则 DELETE 会被列表路由吃掉
    "/api/clone/templates/2": () => {
      left = [TPL];
      return { ok: true, deleted: 2 };
    },
    ...baseRoutes(),
    "/api/clone/templates": () => ({ items: left }),
  });
  const screen = await ready();
  await fireEvent.click(screen.getByRole("button", { name: "工作流" }));
  await screen.findByRole("menu", { name: "工作流" });
  expect(screen.getByRole("button", { name: "删除工作流 Qwen 多图编辑" })).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "删除工作流 单图编辑" }));
  await vi.waitFor(() => expect(deleteCalls()).toEqual(["/api/clone/templates/2"]));
  // 确认态整条链路没了：既不出现「确认删除」，也没有「取消」可点
  expect(screen.queryByRole("button", { name: "确认删除" })).toBeNull();
  expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  // 删的是剩下那条，当前这条不动
  expect(screen.getByRole("menuitemradio", { name: /Qwen 多图编辑/ }).getAttribute("aria-checked")).toBe("true");
  // 弹层不收起：清工作流是连着清好几条的事，收起等于逼人多点一次
  expect(screen.getByRole("menu", { name: "工作流" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "删除工作流 单图编辑" })).toBeNull();
});

it("删掉当前这条后自动切到剩下那份，弹层保持打开，能接着删下一条", async () => {
  let left = [TPL, OTHER_WF];
  routes({
    "/api/clone/templates/1": () => {
      left = [OTHER_WF];
      return { ok: true, deleted: 1 };
    },
    ...baseRoutes(),
    "/api/clone/templates": () => ({ items: left }),
  });
  const screen = await ready();
  await fireEvent.click(screen.getByRole("button", { name: "工作流" }));
  await fireEvent.click(await screen.findByRole("button", { name: "删除工作流 Qwen 多图编辑" }));
  await vi.waitFor(() => expect(screen.getByRole("heading", { name: "单图编辑" })).toBeTruthy());
  expect(deleteCalls()).toEqual(["/api/clone/templates/1"]);
  // 标题已经换成剩下那条，弹层却没关，下一条的 X 就地可用
  expect(screen.getByRole("menu", { name: "工作流" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "删除工作流 Qwen 多图编辑" })).toBeNull();
  // 换模板 = 换一套槽位：参考位按新模板重摆，被点的那张图回到图片1
  expect((screen.getByRole("button", { name: "替换图片1" }) as HTMLButtonElement).disabled).toBe(false);
});

it("最后一条删光后弹层收起，回到「还没有工作流」空态", async () => {
  let left = [TPL];
  routes({
    "/api/clone/templates/1": () => {
      left = [];
      return { ok: true, deleted: 1 };
    },
    ...baseRoutes(),
    "/api/clone/templates": () => ({ items: left }),
  });
  const screen = await ready();
  await fireEvent.click(screen.getByRole("button", { name: "工作流" }));
  await fireEvent.click(await screen.findByRole("button", { name: "删除工作流 Qwen 多图编辑" }));
  await vi.waitFor(() => expect(screen.getByText(/还没有工作流/)).toBeTruthy());
  // 空态里那颗 pill 已经不在页面上，弹层必须跟着收干净，别留个开着的 wfOpen
  expect(screen.queryByRole("menu", { name: "工作流" })).toBeNull();
  expect(screen.queryByRole("button", { name: "工作流" })).toBeNull();
});

it("删除请求在飞的时候连点只发一次 DELETE", async () => {
  let release: () => void = () => {};
  let left = [TPL, OTHER_WF];
  routes({
    "/api/clone/templates/2": () =>
      new Promise<{ ok: boolean; deleted: number }>((resolve) => {
        left = [TPL];
        release = () => resolve({ ok: true, deleted: 2 });
      }),
    ...baseRoutes(),
    "/api/clone/templates": () => ({ items: left }),
  });
  const screen = await ready();
  await fireEvent.click(screen.getByRole("button", { name: "工作流" }));
  const del = await screen.findByRole("button", { name: "删除工作流 单图编辑" });
  await fireEvent.click(del);
  await fireEvent.click(del);
  await fireEvent.click(del);
  expect(deleteCalls()).toEqual(["/api/clone/templates/2"]);
  release();
  await vi.waitFor(() => expect(screen.queryByRole("button", { name: "删除工作流 单图编辑" })).toBeNull());
});

it("X 平时不抢视觉，悬停或键盘聚焦才露出来；名字和 X 在同一个悬停亮面里", async () => {
  routes({ ...baseRoutes(), "/api/clone/templates": { items: [TPL, OTHER_WF] } });
  const screen = await ready();
  const pill = screen.getByRole("button", { name: "工作流" });
  await fireEvent.click(pill);
  await fireEvent.click(pill);
  await fireEvent.click(pill);
  await screen.findByRole("menu", { name: "工作流" });
  expect(screen.getByRole("button", { name: "删除工作流 单图编辑" })).toBeTruthy();
  // happy-dom 不注入 scoped <style>，样式只能读源码
  const source = readFileSync("src/components/CloneModal.svelte", "utf8");
  const rule = /\.cm-wf-del\s*\{[\s\S]*?\n  \}/.exec(source)?.[0] ?? "";
  expect(rule).toContain("opacity: 0");
  expect(rule).toContain("visibility: hidden");
  expect(source).toMatch(/\.cm-wf-row:hover \.cm-wf-del, \.cm-wf-del:focus-visible \{ opacity: 1; visibility: visible; \}/);
  // button 不能嵌 button：删除靠行容器，不是塞进那条 radio 里
  expect(source).toMatch(/<div class="cm-wf-row">\s*\n\s*<button class="cm-wf"/);
  // 亮面画在行上、名字自己不再画底：分成两块底就是原来「X 和名字分开」的观感来源
  expect(source).toMatch(/\.cm-wf-row:hover \{ background: rgb\(255 255 255 \/ 7%\); \}/);
  expect(source).toMatch(/\.cm-wf-row > \.cm-wf:hover:not\(:disabled\) \{ background: transparent; \}/);
  // 两步确认整套拿掉，连状态和样式都不许留在文件里
  for (const gone of ["cm-wf-ask", "cm-wf-yes", "cm-wf-no", "wfDelete"]) {
    expect(source).not.toContain(gone);
  }
});

it("删除是一颗 X 图标而不是红字：中性灰，悬停只提亮，不碰品牌色", async () => {
  routes({ ...baseRoutes(), "/api/clone/templates": { items: [TPL, OTHER_WF] } });
  const screen = await ready();
  await fireEvent.click(screen.getByRole("button", { name: "工作流" }));
  const del = await screen.findByRole("button", { name: "删除工作流 单图编辑" });
  expect(del.querySelector("svg")).toBeTruthy();
  expect(del.textContent?.trim()).toBe("");

  const source = readFileSync("src/components/CloneModal.svelte", "utf8");
  const rule = /\.cm-wf-del\s*\{[\s\S]*?\n  \}/.exec(source)?.[0] ?? "";
  const hover = /\.cm-wf-del:hover:not\(:disabled\)\s*\{[^}]*\}/.exec(source)?.[0] ?? "";
  for (const brand of ["#f87171", "#f24e4e", "#ff6a4d"]) {
    expect(rule).not.toContain(brand);
    expect(hover).not.toContain(brand);
  }
  expect(hover).toMatch(/color: #fafafa/);
  expect(hover).toMatch(/background: rgb\(255 255 255 \/ 10%\)/);
});

/* ── 再次创作生成的图：参考位摆的是当初那几张参考图 ───────────────────── */

const REF_A = { id: 11, item_type: 'media', kind: 'image', filename: '甲.png', path: 'D:/甲.png', original_url: '/api/images/11/file', thumbnail_url: '/api/images/11/file?max=256', width: 512, height: 512 } as any;
const REF_B = { id: 12, item_type: 'media', kind: 'image', filename: '乙.png', path: 'D:/乙.png', original_url: '/api/images/12/file', thumbnail_url: '/api/images/12/file?max=256', width: 512, height: 512 } as any;
const sourcesOf = (refs: any[], dropped = 0) => ({ references: refs, template_id: 1, source_image_id: refs[0]?.id ?? null, dropped });

it('这张图当初用了两张参考：参考位摆两张，生成方式跟着变成多图编辑', async () => {
  routes({
    ...baseRoutes(),
    '/api/clone/templates': { items: [TPL_MULTI] },
    '/api/clone/sources/7': sourcesOf([REF_A, REF_B]),
  });
  const screen = await ready();
  await vi.waitFor(() => expect(modeNode('多图编辑')).toBeTruthy());
  // 两张都是同一条 LoadImage 的（续）位，所以 slotLabel 相同、文件名各认各的
  expect(screen.getByTitle(/^人物参考｜甲\.png$/)).toBeTruthy();
  expect(screen.getByTitle(/^人物参考｜乙\.png$/)).toBeTruthy();
  expect(screen.getByText('图片2')).toBeTruthy();
  // 还剩一格可补：「+ 参考」没被来源挤掉
  expect(screen.getByRole('button', { name: '添加图片3参考图' })).toBeTruthy();
});

it('参考位只有一格：来源里装不下的那张不硬塞', async () => {
  routes({ ...baseRoutes(), '/api/clone/sources/7': sourcesOf([REF_A, REF_B]) });
  const screen = await ready();
  await vi.waitFor(() => expect(screen.getByTitle(/^人物参考｜甲\.png$/)).toBeTruthy());
  expect(screen.queryByText('图片2')).toBeNull();
  expect(modeNode('单图编辑')).toBeTruthy();
});

it('没有来源记录（在 ComfyUI 里手动出的图）：还是只摆被点的这一张', async () => {
  routes(baseRoutes());
  const screen = await ready();
  await tick();
  expect(screen.getByTitle(/^人物参考｜source\.png$/)).toBeTruthy();
  expect(modeNode('单图编辑')).toBeTruthy();
});

it('来源里那张已经不在了：明说还缺一张，不能默默少摆', async () => {
  routes({ ...baseRoutes(), '/api/clone/sources/7': sourcesOf([REF_A], 1) });
  const screen = await ready();
  expect(screen.getByTitle(/^人物参考｜甲\.png$/)).toBeTruthy();
  // 那句「还用了 1 张参考图」不再摆成一行灰字，挂在卡的悬停提示上（2026-11-04 苏醒：小字提示删掉）
  const card = screen.container.querySelector('.cm-composer')!;
  expect(card.getAttribute('title')).toContain('还用了 1 张参考图');
});

it('提交时按当初的顺序把两张参考图交回去', async () => {
  let submitted: { references: { slot: string; image_id: number }[]; source_image_id: number } | null = null;
  routes({
    ...baseRoutes(),
    '/api/clone/templates': { items: [TPL_MULTI] },
    '/api/clone/sources/7': sourcesOf([REF_A, REF_B]),
    '/api/clone/generate': (init?: RequestInit) => {
      submitted = JSON.parse(String(init?.body));
      return { ...EMPTY_CLONE_JOB, active: true, job_id: 'j1', state: 'queued', running: true };
    },
  });
  const screen = await ready();
  await vi.waitFor(() => expect(modeNode('多图编辑')).toBeTruthy());
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '换一张同款的画面' } });
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  await vi.waitFor(() => expect(submitted).toBeTruthy());
  expect(submitted!.references).toEqual([
    { slot: '543.image', image_id: 11 },
    { slot: '543.image::image_2', image_id: 12 },
  ]);
  expect(submitted!.source_image_id).toBe(7);
});

it('来源读失败也照常开弹窗：参考位退回被点的这一张', async () => {
  routes({ ...baseRoutes(), '/api/clone/sources/7': () => { throw new Error('500'); } });
  const screen = await ready();
  await vi.waitFor(() => expect(screen.getByTitle(/^人物参考｜source\.png$/)).toBeTruthy());
  expect(screen.queryByText(/还用了/)).toBeNull();
});

/* ── 工作流名字：本地导入那份的文件后缀不是名字的一部分 ───────────────── */

it('工作流名字不显示 .json 后缀：标题、胶囊、切换列表、删除按钮一起', async () => {
  routes({
    ...baseRoutes(),
    '/api/clone/templates': {
      items: [{ ...TPL, name: '视频创作者-1024 x 576_参考生视频_.json' },
              { ...TPL, id: 2, name: '单图编辑.JSON' }],
    },
  });
  const screen = await ready();
  expect(screen.getByRole('heading', { name: '视频创作者-1024 x 576_参考生视频_' })).toBeTruthy();
  const pill = screen.getByRole('button', { name: '工作流' });
  expect(pill.textContent).toContain('视频创作者-1024 x 576_参考生视频_');
  expect(pill.textContent).not.toMatch(/\.json/i);
  await fireEvent.click(pill);
  await screen.findByRole('menu', { name: '工作流' });
  expect(screen.getByRole('menuitemradio', { name: /单图编辑/ }).textContent).not.toMatch(/\.json/i);
  expect(screen.getByRole('button', { name: '删除工作流 单图编辑' })).toBeTruthy();
});

it('本地导入时就把后缀摘掉，并且不和已有那条重名', async () => {
  const created: Record<string, unknown> = { id: 9, name: '', slots: TPL.slots, is_active: true, default_prompt: '', created_at: '', updated_at: '', node_count: 4, prompt_count: 1, reference_count: 1, control_count: 0 };
  const names: string[] = [];
  routes({
    '/api/clone/templates/inspect': () => ({ slots: TPL.slots, candidates: [], nodes: [], default_prompt: '', warnings: [], suggested_name: '' }),
    '/api/clone/jobs/current': EMPTY_CLONE_JOB,
    '/api/clone/sources/7': NO_SOURCES,
    '/api/clone/templates': (init?: RequestInit) => {
      if (init?.method !== 'POST') return { items: [{ ...TPL, name: '我的多图.json' }, created] };
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      names.push(body.name);
      Object.assign(created, { name: body.name });
      return created;
    },
    '/api/images/7/reverse-prompts': { items: [] },
    '/api/images/7': { id: 7, filename: 'source.png', positive_prompt: '' },
  });
  const screen = await ready();
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  const input = (await screen.findByLabelText('选择本地工作流 JSON')) as HTMLInputElement;
  const raw = JSON.stringify({ '1': { class_type: 'KSampler' } });
  const file = new File([raw], '我的多图.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => raw });
  await fireEvent.change(input, { target: { files: [file] } });
  // 库里躺着的「我的多图.json」显示出来就是「我的多图」，新导入这条得让位加序号
  await vi.waitFor(() => expect(names).toEqual(['我的多图 (2)']));
});

it('胶囊定宽时长名字会被截断，全名必须另有落点：顶部标题 + 悬浮提示', async () => {
  const long = { ...TPL, name: 'Qwen-image-2.1多图编辑.json' };
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [long] } });
  const screen = await ready();
  const pill = screen.getByRole('button', { name: '工作流' }) as HTMLButtonElement;
  // 胶囊宽度是定死的（.cm-fill），名字长在这儿只能截断——所以全名不许只活在胶囊里：
  // 顶部标题（17px）报当前用的是哪一份，悬浮提示给完整名字（含「生成中」那句前缀）。
  expect(pill.getAttribute('title')).toBe('Qwen-image-2.1多图编辑');
  expect(document.querySelector('.cm-title')?.textContent).toBe('Qwen-image-2.1多图编辑');
});

/* ── 视频再次创作（H3 参考生视频）────────────────────────────────────── */

/** 真机那份 H3 参考生视频的形状：三族参考位 + 比例 + 时长，产出是片子。名字末尾的空格照抄导出文件。 */
const H3 = {
  ...TPL, id: 9, name: 'H3参考视频 ', media_kind: 'video', soundtracks: 0,
  modes: ['text', 'single', 'multi'], node_count: 14, control_count: 2,
  slots: [
    { kind: 'prompt', node: '265', input: 'value', label: '完整提示词' },
    { kind: 'image', node: '188', input: 'image', label: '参考图片', grow: { node: '136', group: 'ref_images', names: ['ref_image_1'], type: 'IMAGE' } },
    { kind: 'audio', node: '182', input: 'audio', label: '参考音频' },
    { kind: 'video', node: '185', input: 'video', label: '参考视频' },
    { kind: 'select', node: '228', input: 'aspect_ratio', label: '比例', options: ['16:9', '9:16'], value: '16:9' },
    { kind: 'number', node: '227', input: 'value', label: '视频时长（秒）', value: 8, min: 1, max: 60, unit: '秒', presets: [5, 8, 10, 12, 15] },
  ],
};
const VIDEO_CARD = {
  id: 31, item_type: 'media', kind: 'video', filename: 'shot.mp4', path: 'D:/shot.mp4',
  original_url: null, thumbnail_url: '/api/videos/31/thumb', play_url: '/api/videos/31/file',
  playable: true, width: 1280, height: 720,
} as any;
const AUDIO = {
  id: 22, item_type: 'media', kind: 'audio', filename: 'bgm.mp3', path: 'D:/bgm.mp3',
  original_url: '/api/audio/22/file', thumbnail_url: '/api/audio/22/waveform', play_url: '/api/audio/22/file',
} as any;

const videoRoutes = () => ({
  ...baseRoutes(),
  '/api/clone/sources/31': NO_SOURCES,
  '/api/images/31/reverse-prompts': { items: [] },
  '/api/images/31': { id: 31, filename: 'shot.mp4', positive_prompt: '' },
});

it('视频卡点开默认吃出片那条工作流；这一族没有就退回库里现有的', async () => {
  routes({ ...videoRoutes(), '/api/clone/templates': { items: [TPL, { ...H3, is_active: false }] } });
  const screen = await ready({ image: VIDEO_CARD });
  expect(screen.getByRole('heading', { name: 'H3参考视频' })).toBeTruthy();
  cleanup();
  // 库里只导过图片工作流：视频卡也要开得出弹窗，别给一片空白
  routes({ ...videoRoutes(), '/api/clone/templates': { items: [TPL] } });
  const again = await ready({ image: VIDEO_CARD });
  expect(again.getByRole('heading', { name: 'Qwen 多图编辑' })).toBeTruthy();
});

it('三族参考合成一摞：已填的按 图片→视频→音频 排，末尾只有一颗「+ 参考」', async () => {
  routes({ ...videoRoutes(), '/api/clone/templates': { items: [H3] } });
  const screen = await ready({ image: VIDEO_CARD });
  // 一摞，不是一族一摞：参考就是一个列表，加素材不必先判断「这算哪一块」
  expect(document.querySelectorAll('.cm-ref-stack')).toHaveLength(1);
  expect(screen.getByRole('group', { name: '参考素材（图生视频）' })).toBeTruthy();
  expect(screen.getByTitle(/^参考视频｜shot\.mp4$/)).toBeTruthy();
  // 空格子不再替每一族各摆一颗：整行末尾就这一颗，而且它不绑族
  expect(document.querySelectorAll('.cm-ref-add')).toHaveLength(1);
  expect(screen.getByRole('button', { name: '添加参考素材' }).getAttribute('title'))
    .toContain('最多吃 2 张图片 / 1 条视频 / 1 段音频');
  expect(screen.queryByRole('button', { name: '添加图片1参考图' })).toBeNull();
  expect(screen.queryByRole('button', { name: '添加音频1' })).toBeNull();
  // 移除之后一份素材都不放——「文生视频」这个档位照样点得动
  await fireEvent.click(screen.getByRole('button', { name: '移除视频1' }));
  await tick();
  expect(document.querySelector('[aria-label="参考素材（文生视频）"]')).toBeTruthy();
});

it('图片工作流仍只有一摞参考位，分组名一个字没改', async () => {
  routes(baseRoutes());
  await ready();
  expect(document.querySelectorAll('.cm-ref-stack')).toHaveLength(1);
  expect(modeNode('单图编辑')).toBeTruthy();
});

it('「+ 参考」不绑族：选择器出族 tab，挑到哪一族落哪一族的第一个空位', async () => {
  (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [PICKED, AUDIO], total: 2 });
  routes({ ...videoRoutes(), '/api/clone/templates': { items: [H3] } });
  const screen = await ready({ image: VIDEO_CARD });
  await fireEvent.click(screen.getByRole('button', { name: '添加参考素材' }));
  // 视频位已经被被点的片子占了，tab 只给还有空位的两族，顺序仍按展示序（图片 → 音频）
  const dialog = await screen.findByRole('dialog', { name: '从图库选一张图片' });
  expect([...dialog.querySelectorAll('.mp-tab')].map((el) => el.textContent?.trim())).toEqual(['图片', '音频']);
  expect(imagesApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'image' }));
  // 切族＝换一批素材：重新按族读一次，标题与量词跟着换
  await fireEvent.click(screen.getByRole('button', { name: '音频' }));
  await vi.waitFor(() => expect(imagesApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'audio' })));
  expect(dialog.getAttribute('aria-label')).toBe('从图库选一段音频');
  await fireEvent.click(screen.getByRole('button', { name: 'bgm.mp3' }));
  await vi.waitFor(() => expect(screen.getByTitle(/^参考音频｜bgm\.mp3$/)).toBeTruthy());
  const tile = screen.getByTitle(/^参考音频｜bgm\.mp3$/);
  expect(tile.className).toContain('cm-tile-audio');
  expect(tile.querySelector('img')?.getAttribute('src')).toContain('/api/audio/22/waveform');
  // 合并行的编号顺序＝H3 摆参考的顺序：图片 → 视频 → 音频
  expect([...document.querySelectorAll('.cm-ref-caption')].map((el) => el.textContent)).toEqual(['视频1', '音频1']);
});

it('时长是滑块：3–15 秒拖到几秒就是几秒，数字框与胶囊跟着同步', async () => {
  routes({ ...videoRoutes(), '/api/clone/templates': { items: [H3] } });
  const screen = await ready({ image: VIDEO_CARD });
  await fireEvent.click(screen.getByRole('button', { name: '画面参数' }));
  const pop = await screen.findByRole('dialog', { name: '画面参数' });
  expect(pop.textContent).toContain('视频时长（秒）');
  const slider = screen.getByLabelText('视频时长（秒）滑块') as HTMLInputElement;
  // 区间 3–15 秒（苏醒点名）；工作流自己给的 min/max 只收紧不放宽
  expect([slider.min, slider.max, slider.step]).toEqual(['3', '15', '1']);
  expect(slider.value).toBe('8');
  slider.value = '12';
  await fireEvent.input(slider);
  await tick();
  expect((screen.getByLabelText('视频时长（秒）') as HTMLInputElement).value).toBe('12');
  expect(screen.getByRole('button', { name: '画面参数' }).textContent).toContain('16:9 / 12秒');
  // 档位按钮不再管时长：整段区间滑块都能到，摆五颗反而像只有这五档
  expect(pop.querySelector('[aria-label="视频时长（秒）档位"]')).toBeNull();
});

it('视频工作流里 @ 出来的是 H3 原生标签 <Picture 1>，遮罩把它当引用高亮', async () => {
  (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [PICKED], total: 1 });
  routes({ ...videoRoutes(), '/api/clone/templates': { items: [H3] } });
  const screen = await ready({ image: VIDEO_CARD });
  await fireEvent.click(screen.getByRole('button', { name: '添加参考素材' }));
  await fireEvent.click(await screen.findByRole('button', { name: 'bg.png' }));
  await tick();
  const box = screen.getByLabelText('提示词') as HTMLTextAreaElement;
  await fireEvent.input(box, { target: { value: '让 @' } });
  await tick();
  // 菜单只列挂上参考位的素材：音频位还空着，所以出现的是图片1与视频1
  expect(document.querySelector('.cm-mention')?.textContent).toContain('视频1');
  // 末尾那颗「再去挂一份」指向第一个空格：这儿图片位还有空，所以仍是「一张参考图」
  expect(document.querySelector('.cm-mention-add')?.textContent).toContain('从图库再挂一张参考图');
  await fireEvent.click(menuItems()[0]);
  await tick();
  expect(box.value).toBe('让 <Picture 1> ');
  expect(document.querySelector('.cm-prompt-bg .cm-mention-hl')?.textContent).toBe('<Picture 1>');
});

it('出片之后的产出按 kind 取缩略图，点它是「第 N 条」并把 kind 交回父组件', async () => {
  routes({ ...videoRoutes(), '/api/clone/templates': { items: [H3] }, '/api/clone/generate': { ...EMPTY_CLONE_JOB, active: true, job_id: 'j1', state: 'queued', running: true } });
  const onOpenImage = vi.fn();
  const screen = await ready({ image: VIDEO_CARD, onOpenImage });
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '一镜到底' } });
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  applyCloneProgress({
    active: true, job_id: 'j1', state: 'done', running: false, template_id: 9, media_kind: 'video',
    outputs: [{ id: 41, kind: 'video', filename: 'out.mp4', thumbnail_url: '/api/videos/41/thumb' }],
  });
  await tick();
  expect(screen.getByText('已生成 1 条')).toBeTruthy();
  const chip = await screen.findByRole('button', { name: '打开生成的第 41 条' });
  // 视频的海报帧不是 /api/images/{id}/file，前端硬拼必然拼错
  expect(chip.querySelector('img')?.getAttribute('src')).toContain('/api/videos/41/thumb');
  expect(chip.className).toContain('cm-chip-video');
  await fireEvent.click(chip);
  expect(onOpenImage).toHaveBeenCalledWith(41, 'video');
});

it('先选创作类型：图片卡这一屏只列图片族，视频那条要切了类型才露脸', async () => {
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [TPL, H3] } });
  const screen = await ready();
  // 那颗报的是这一屏真正在产出的族，不是又一个会跟实际跑偏的开关
  expect(screen.getByRole('button', { name: '创作类型' }).textContent).toContain('图片生成');
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  await screen.findByRole('menu', { name: '工作流' });
  expect([...document.querySelectorAll('.cm-wf-kind')].map((el) => el.textContent)).toEqual(['图片']);
  // 徽标钉在名字前面：挂在名字后面时它会随名字长短左右漂移，两行的名字对不齐
  const rows = [...document.querySelectorAll('.cm-wf-row > .cm-wf')];
  expect(rows).toHaveLength(1);
  for (const row of rows) {
    const kids = [...row.children];
    expect(kids[0]?.className).toContain('cm-wf-kind');
    expect(kids[1]?.className).toContain('cm-wf-name');
  }
  // 换类型 = 换这一族：清单跟着换，挂上的工作流也落到这一族库里标的那条
  await fireEvent.click(screen.getByRole('button', { name: '创作类型' }));
  await fireEvent.click(await screen.findByRole('menuitemradio', { name: /视频生成/ }));
  await vi.waitFor(() => expect(
    screen.getByRole('button', { name: '工作流' }).textContent).toContain('H3'),
  );
  expect(screen.getByRole('button', { name: '创作类型' }).textContent).toContain('视频生成');
});

it('往已经填好的音频位拖一张图片：说清是哪一格要音频，不默默吞掉', async () => {
  routes({
    ...videoRoutes(),
    '/api/clone/templates': { items: [H3] },
    '/api/clone/sources/31': {
      references: [{ ...AUDIO, slot: '182.audio' }],
      template_id: 9, source_image_id: null, dropped: 0, origin: 'db',
    },
  });
  const screen = await ready({ image: VIDEO_CARD });
  const cell = screen.getByRole('group', { name: '音频1' });
  const file = new File(['x'], 'picture.png', { type: 'image/png' });
  await fireEvent.drop(cell, { dataTransfer: { files: [file] } });
  await tick();
  expect(await screen.findByRole('status')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('音频1要的是音频');
  expect(imagesApi.import).not.toHaveBeenCalled();
});


/* ── 参考区合并成一行 + 视频可播（苏醒 2026-10-29 三条要求）────────────── */

it('视频卡左侧是能播的播放器：再次创作要抄的是片子里的节奏，不是一张首帧', async () => {
  routes({ ...videoRoutes(), '/api/clone/templates': { items: [H3] } });
  await ready({ image: VIDEO_CARD });
  const player = document.querySelector('video.cm-hero') as HTMLVideoElement;
  expect(player.getAttribute('src')).toContain('/api/videos/31/file');
  expect(player.getAttribute('poster')).toContain('/api/videos/31/thumb');
  expect(player.hasAttribute('controls')).toBe(true);
  cleanup();
  // 图片卡仍是 <img>：给视频准备的播放器不该冒出来
  routes(baseRoutes());
  await ready();
  expect(document.querySelector('video.cm-hero')).toBeNull();
  expect(document.querySelector('img.cm-hero')).toBeTruthy();
});

it('放不出来的容器（playable=false）退回海报帧，不给一个点了没反应的播放器', async () => {
  routes({ ...videoRoutes(), '/api/clone/templates': { items: [H3] } });
  await ready({ image: { ...VIDEO_CARD, playable: false } });
  expect(document.querySelector('video.cm-hero')).toBeNull();
  expect(document.querySelector('img.cm-hero')).toBeTruthy();
});

it('拖文件到「+ 参考」上：不指定格子也按文件自己的族落位', async () => {
  (imagesApi.import as ReturnType<typeof vi.fn>).mockResolvedValue({
    saved: [{ id: 22, filename: 'bgm.mp3', path: 'D:/bgm.mp3' }], skipped: [],
  });
  routes({ ...videoRoutes(), '/api/clone/templates': { items: [H3] } });
  const screen = await ready({ image: VIDEO_CARD });
  await fireEvent.drop(screen.getByRole('button', { name: '添加参考素材' }), {
    dataTransfer: { files: [new File(['x'], 'bgm.mp3', { type: 'audio/mpeg' })] },
  });
  await vi.waitFor(() => expect(screen.getByTitle(/^参考音频｜bgm\.mp3$/)).toBeTruthy());
});

it('往已经放满的那一族再拖一份：说清是哪一族满了，不默默吞掉', async () => {
  // afterEach 不清 imagesApi 的调用记录，不清零就会拿到上一条用例留下那次调用
  (imagesApi.import as ReturnType<typeof vi.fn>).mockClear().mockResolvedValue({ saved: [], skipped: [] });
  routes({
    ...videoRoutes(),
    '/api/clone/templates': { items: [H3] },
    '/api/clone/sources/31': {
      references: [{ ...AUDIO, slot: '182.audio' }],
      template_id: 9, source_image_id: null, dropped: 0, origin: 'db',
    },
  });
  const screen = await ready({ image: VIDEO_CARD });
  const add = screen.getByRole('button', { name: '添加参考素材' });
  // tab 只剩还有空位的那一族：音频唯一一格已经满了，图片族还有空
  await fireEvent.drop(add, { dataTransfer: { files: [new File(['x'], 'song.mp3', { type: 'audio/mpeg' })] } });
  await tick();
  expect(await screen.findByRole('status')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('音频参考位已经放满了');
  expect(imagesApi.import).not.toHaveBeenCalled();
});

/* ── 音频再次创作（Qwen3 音色克隆）────────────────────────────────────── */

/** 真机那条音色克隆的形状：两个提示词位（要说的话 + 参考音频的原话）+ 一台 LoadAudio + 语言下拉。 */
const TTS = {
  ...TPL, id: 12, name: '闪寻音频克隆', media_kind: 'audio', modes: ['single', 'multi'],
  prompt_count: 2, reference_count: 1, control_count: 1,
  slots: [
    { kind: 'prompt', node: '45', input: 'ref_text', label: '参考音频的文本', value: '参考音频里说的原话' },
    { kind: 'prompt', node: '45', input: 'text', label: '完整提示词', value: '你好，我是一条声音样本。' },
    { kind: 'audio', node: '44', input: 'audio', label: '加载音频' },
    { kind: 'select', node: '45', input: 'language', label: '语言', options: ['Auto', 'Chinese'], value: 'Auto' },
  ],
};

const audioRoutes = () => ({
  ...baseRoutes(),
  '/api/clone/sources/22': NO_SOURCES,
  '/api/images/22/reverse-prompts': { items: [] },
  '/api/images/22': { id: 22, filename: 'bgm.mp3', positive_prompt: '' },
});

it('音频卡点开默认吃出声音那条；这一族没有就退回库里现有的', async () => {
  routes({ ...audioRoutes(), '/api/clone/templates': { items: [TPL, { ...TTS, is_active: false }] } });
  const screen = await ready({ image: AUDIO });
  expect(screen.getByRole('heading', { name: '闪寻音频克隆' })).toBeTruthy();
  cleanup();
  routes({ ...audioRoutes(), '/api/clone/templates': { items: [TPL] } });
  const again = await ready({ image: AUDIO });
  expect(again.getByRole('heading', { name: 'Qwen 多图编辑' })).toBeTruthy();
});

it('音频卡的左边是波形加一条播放器：写词的时候能就地听这段音色', async () => {
  routes({ ...audioRoutes(), '/api/clone/templates': { items: [TTS] } });
  const screen = await ready({ image: AUDIO });
  const wave = screen.container.querySelector('img.cm-hero-wave') as HTMLImageElement;
  expect(wave).toBeTruthy();
  expect(wave.getAttribute('src')).toContain('/api/audio/22/waveform');
  const player = screen.container.querySelector('audio.cm-hero-audio') as HTMLAudioElement;
  expect(player).toBeTruthy();
  expect(player.getAttribute('controls')).not.toBeNull();
  expect(player.getAttribute('src')).toContain('/api/audio/22/file');
});

it('音频工作流的参考那一摞只有一格「音频1」，被点的那段自己站在里面', async () => {
  routes({ ...audioRoutes(), '/api/clone/templates': { items: [TTS] } });
  const screen = await ready({ image: AUDIO });
  expect(document.querySelectorAll('.cm-ref-stack')).toHaveLength(1);
  expect(document.querySelector('[aria-label="参考音频（参考音色克隆）"]')).toBeTruthy();
  expect(screen.getByTitle(/｜bgm\.mp3$/)).toBeTruthy();
  // 量词与称呼都跟着族走，不冒出「这张图」
  expect(screen.queryByText(/这张图/)).toBeNull();
});

it('清单里只剩一族，所以族徽从「分得清」降级成「报到」：这一屏的行全是这一族', async () => {
  routes({ ...audioRoutes(), '/api/clone/templates': { items: [{ ...TPL, is_active: true }, { ...TTS, is_active: true }] } });
  const screen = await ready({ image: AUDIO });
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  const options = await screen.findAllByRole('menuitemradio');
  // 音频卡 → 这一屏只有出声音的那条。以前这里并列着图片和音频，靠族徽分家；
  // 现在族徽仍然留着（同一族里将来可能既有本机配方也有云端模型），但它不再是唯一的防线。
  expect(options.map((el) => el.querySelector('.cm-wf-kind')?.textContent)).toEqual(['音频']);
  expect(options[0].querySelector('.cm-wf-kind')?.classList.contains('cm-wf-kind-audio')).toBe(true);
  // 图片那条要切了类型才看得见
  await fireEvent.click(screen.getByRole('button', { name: '创作类型' }));
  await fireEvent.click(await screen.findByRole('menuitemradio', { name: /图片生成/ }));
  await vi.waitFor(() => expect(screen.getByRole('button', { name: '工作流' }).textContent).toContain('Qwen 多图编辑'));
});

it('产出是音频时 chip 上挂播放角标，点它就地播而不是进图片对比', async () => {
  routes({
    ...audioRoutes(),
    '/api/clone/templates': { items: [TTS] },
    '/api/clone/generate': { ...EMPTY_CLONE_JOB, active: true, job_id: 'j1', state: 'queued', running: true },
  });
  const onOpen = vi.fn();
  const screen = await ready({ image: AUDIO, onOpenImage: onOpen });
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '换一段台词' } });
  const go = screen.getByRole('button', { name: '生成' }) as HTMLButtonElement;
  await vi.waitFor(() => expect(go.disabled).toBe(false));
  await fireEvent.click(go);
  applyCloneProgress({
    active: true, job_id: 'j1', state: 'done', running: false, template_id: 12, media_kind: 'audio',
    outputs: [{ id: 88, kind: 'audio', filename: '闪寻音频克隆_00001.flac', thumbnail_url: '/api/audio/88/waveform' }],
  });
  await tick();
  const chip = screen.getByRole('button', { name: '打开生成的第 88 条' });
  expect(chip.querySelector('img')?.getAttribute('src')).toContain('/api/audio/88/waveform');
  // 产出是音频：chip 上挂着播放角标，点下去交给父组件就地播，不是进图片对比
  expect(chip.classList.contains('cm-chip-video')).toBe(true);
  expect(chip.querySelector('.cm-chip-play')).toBeTruthy();
  await fireEvent.click(chip);
  expect(onOpen).toHaveBeenCalledWith(88, 'audio');
});

it('音色克隆的台词与原话分两格：附框预填工作流里那句原话', async () => {
  routes({ ...audioRoutes(), '/api/clone/templates': { items: [TTS] } });
  const screen = await ready({ image: AUDIO });
  const sub = await screen.findByLabelText('参考音频的文本');
  expect((sub as HTMLTextAreaElement).value).toBe('参考音频里说的原话');
  // 主框还是台词，不能被原话顶掉；出声音的工作流也不该问「要生成什么画面」
  expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('');
  expect(screen.getByLabelText('提示词').getAttribute('placeholder')).toContain('念');
  // 那句「填错了音色会跑偏」不再摆成一行灰字，挂在这个框的悬停提示上（2026-11-04 苏醒：小字提示删掉）
  expect((screen.getByLabelText('参考音频的文本') as HTMLTextAreaElement).getAttribute('title')).toContain('音色会明显跑偏');
});

it('改附框不碰台词，提交时两段各交各的', async () => {
  let sent: any = null;
  routes({
    ...audioRoutes(),
    '/api/clone/templates': { items: [TTS] },
    '/api/clone/generate': (init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return { ...EMPTY_CLONE_JOB, active: true, job_id: 'j9', state: 'queued', running: true };
    },
  });
  const screen = await ready({ image: AUDIO });
  const sub = await screen.findByLabelText('参考音频的文本');
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '换一段台词' } });
  await fireEvent.input(sub, { target: { value: '原话其实说的是这句' } });
  const go = screen.getByRole('button', { name: '生成' }) as HTMLButtonElement;
  await vi.waitFor(() => expect(go.disabled).toBe(false));
  await fireEvent.click(go);
  expect(sent.prompt).toBe('换一段台词');
  expect(sent.slot_prompts).toEqual({ '45.ref_text': '原话其实说的是这句' });
});

it('只有一格文字位的工作流不摆附框，请求体也不多出 slot_prompts', async () => {
  let sent: any = null;
  routes({
    ...baseRoutes(),
    '/api/clone/generate': (init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return { ...EMPTY_CLONE_JOB, active: true, job_id: 'j8', state: 'queued', running: true };
    },
  });
  const screen = await ready();
  expect(document.querySelectorAll('textarea.cm-textarea-sub')).toHaveLength(0);
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '一句话' } });
  const go = screen.getByRole('button', { name: '生成' }) as HTMLButtonElement;
  await vi.waitFor(() => expect(go.disabled).toBe(false));
  await fireEvent.click(go);
  expect(sent.slot_prompts).toBeUndefined();
});

it('附框没有镜像层，文字色不能继承主框的 transparent', () => {
  const source = readFileSync('src/components/CloneModal.svelte', 'utf8');
  const rule = /^\s*\.cm-textarea-sub\s*\{[^}]*\}/m.exec(source)?.[0] ?? '';
  expect(rule).toContain('color: #e4e4e7');
  expect(rule).toContain('background: rgba(0, 0, 0, 0.35)');
  expect(rule).not.toMatch(/color:\s*transparent/);
  // 附框搬进卡里之后，卡里那句「框一律透明」先按 .cm-textarea 抓到它，聚焦态权重还更高一档：
  // 不点名 .cm-textarea-sub（含 :focus），台词和原话就糊成同一片，一焦点框整个消失。
  const scoped = /\.cm-composer \.cm-textarea-sub[\s\S]{0,120}?\}/.exec(source)?.[0] ?? '';
  expect(scoped).toContain('.cm-composer .cm-textarea-sub:focus');
  expect(scoped).toContain('background: rgba(0, 0, 0, 0.35)');
  // 附框不带镜像类，靠自身颜色可见
  expect(source).toContain('class="cm-textarea cm-textarea-sub"');
  expect(source).toContain('class="cm-textarea cm-textarea-mirror"');
});

it('音频带不走提示词：台词与原话从来源记录里回到各自的框', async () => {
  routes({
    ...audioRoutes(),
    '/api/clone/templates': { items: [TTS] },
    '/api/clone/sources/22': {
      references: [{ ...AUDIO, slot: '44.audio' }],
      template_id: 12, source_image_id: 22, dropped: 0, origin: 'db',
      prompt: '当初要念的那句',
      slot_prompts: { '45.ref_text': '当初样本里的原话' },
    },
  });
  const screen = await ready({ image: AUDIO });
  await vi.waitFor(() => expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('当初要念的那句'));
  expect((screen.getByLabelText('参考音频的文本') as HTMLTextAreaElement).value).toBe('当初样本里的原话');
  // 说清这句是从哪来的：不是「这张图自带的」，也不是「工作流里内置的」
  expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).getAttribute('title')).toBe('已带上当初生成时用的提示词');
});

it('来源那句还在路上，用户先打了字：迟到那句不许盖掉用户敲的', async () => {
  let release: (value: unknown) => void = () => {};
  const pending = new Promise((resolve) => { release = resolve; });
  routes({
    ...audioRoutes(),
    '/api/clone/templates': { items: [TTS] },
    '/api/clone/sources/22': () => pending,
  });
  const screen = await ready({ image: AUDIO });
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '我自己打的那句' } });
  release({
    references: [], template_id: 12, source_image_id: 22, dropped: 0, origin: 'db',
    prompt: '当初要念的那句', slot_prompts: { '45.ref_text': '当初样本里的原话' },
  });
  await tick();
  await vi.waitFor(() => expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('我自己打的那句'));
});

it('换成别的工作流：当初那句原话不跟着搬过去（搬了后端要 400）', async () => {
  let sent: any = null;
  routes({
    ...audioRoutes(),
    '/api/clone/templates': { items: [TTS, { ...TPL, id: 13, name: '图片编辑', media_kind: 'image', is_active: false }] },
    '/api/clone/sources/22': {
      references: [], template_id: 12, source_image_id: 22, dropped: 0, origin: 'db',
      prompt: '当初要念的那句', slot_prompts: { '45.ref_text': '当初样本里的原话' },
    },
    '/api/clone/generate': (init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return { ...EMPTY_CLONE_JOB, active: true, job_id: 'j7', state: 'queued', running: true };
    },
  });
  const screen = await ready({ image: AUDIO });
  await vi.waitFor(() => expect((screen.getByLabelText('参考音频的文本') as HTMLTextAreaElement).value).toBe('当初样本里的原话'));
  // 跨族切换现在只有这一个入口：底部那颗「创作类型」
  await fireEvent.click(screen.getByRole('button', { name: '创作类型' }));
  await fireEvent.click(await screen.findByRole('menuitemradio', { name: /图片生成/ }));
  await vi.waitFor(() => expect(screen.getByRole('button', { name: '工作流' }).textContent).toContain('图片编辑'));
  // 图片工作流只有一个文字位：附框整个消失，请求体里也不许留着 45.ref_text
  expect(document.querySelectorAll('textarea.cm-textarea-sub')).toHaveLength(0);
  const go = screen.getByRole('button', { name: '生成' }) as HTMLButtonElement;
  await vi.waitFor(() => expect(go.disabled).toBe(false));
  await fireEvent.click(go);
  expect(sent.prompt).toBe('当初要念的那句');
  expect(sent.slot_prompts).toBeUndefined();
});

it('整块缩略图就是「换一份」的入口，不再要求点中悬停才亮的那颗小圆钮', async () => {
  // 真机反馈：整格缩略图只有一枚 30px 的圆钮接得住点击，点画面别处毫无反应，
  // 用户读到的结论是「参考音频换不了」。热区该是整块缩略图，圆钮只留个提示作用。
  routes(baseRoutes());
  const screen = await ready();
  const pick = screen.getByRole('button', { name: '替换图片1' });
  expect(pick.querySelector('.cm-tile-img')).toBeTruthy();
  // 圆钮降级成提示：它不再自己接点击，否则会把整块按钮的点击吃掉
  expect(pick.querySelector('.cm-tile-swap')?.tagName).toBe('SPAN');
  // 移除仍是单独一颗，点它不会顺手打开选择器
  expect(screen.getByRole('button', { name: '移除图片1' })).toBeTruthy();
  const css = readFileSync('src/components/CloneModal.svelte', 'utf8');
  expect(css).toMatch(/\.cm-tile-pick\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0[^}]*cursor:\s*pointer/);
  expect(css).toMatch(/\.cm-tile-swap\s*\{[^}]*pointer-events:\s*none/);
  await fireEvent.click(pick);
  expect(await screen.findByRole('dialog', { name: '选一张参考图' })).toBeTruthy();
});

it('语种这类选项在面板上念中文，交回后端的仍是工作流里的原值', async () => {
  const langTpl = {
    ...TPL,
    control_count: 1,
    slots: [
      { kind: 'prompt', node: '582', input: 'prompt', label: '完整提示词' },
      { kind: 'select', node: '45', input: 'language', label: '语言', options: ['Auto', 'Chinese', 'Portuguese'], value: 'Auto' },
    ],
  };
  let submitted: Record<string, unknown> | null = null;
  routes({
    ...baseRoutes(),
    '/api/clone/templates': { items: [langTpl] },
    '/api/clone/generate': (init?: RequestInit) => {
      submitted = JSON.parse(String(init?.body));
      return { ...EMPTY_CLONE_JOB, active: true, job_id: 'j1', state: 'queued', running: true };
    },
  });
  const screen = await ready();
  const pill = screen.getByRole('button', { name: '画面参数' });
  expect(pill.textContent).toContain('自动');
  await fireEvent.click(pill);
  const pop = await screen.findByRole('dialog', { name: '画面参数' });
  expect([...pop.querySelectorAll('.cm-ratio-label')].map((el) => el.textContent)).toEqual(['自动', '中文', '葡萄牙文']);
  // 可访问名与 title 保留工作流原值：界面说中文，不该把选项本来的名字弄丢
  const chinese = screen.getByRole('button', { name: 'Chinese' });
  expect(chinese.getAttribute('title')).toBe('Chinese');
  await fireEvent.click(chinese);
  expect(pill.textContent).toContain('中文');
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '换一句台词' } });
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  await tick();
  expect(submitted).toMatchObject({ controls: { '45.language': 'Chinese' } });
});


// ---------- 音频的三种出声方式：一排模式按钮 ----------

const AUDIO_CARD = {
  id: 7, item_type: 'media', kind: 'audio', filename: '参考音色.flac', path: 'D:/a.flac',
  original_url: '/api/images/7/file', thumbnail_url: '/api/audio/7/waveform',
} as any;

const audioTpl = (over: Record<string, unknown>) => ({
  created_at: '', updated_at: '', node_count: 3, prompt_count: 1, reference_count: 0, control_count: 1,
  default_prompt: '', is_active: false, media_kind: 'audio', ...over,
});
const A_CLONE = audioTpl({
  id: 11, name: '闪寻参考音色', is_active: true, prompt_count: 2, reference_count: 1,
  slots: [
    { kind: 'prompt', node: '45', input: 'ref_text', label: '参考音频的文本' },
    { kind: 'prompt', node: '45', input: 'text', label: '完整提示词' },
    { kind: 'audio', node: '44', input: 'audio', label: '加载音频' },
    { kind: 'select', node: '45', input: 'language', label: '语言', options: ['Auto', 'Chinese'], value: 'Auto' },
  ],
  reference_cells: [{ key: '44.audio', kind: 'audio', ordinal: 1, label: '音频1', slot_label: '加载音频', tag: '<Audio 1>' }],
});
const A_DESIGN = audioTpl({
  id: 12, name: '闪寻音色描述',
  slots: [
    { kind: 'prompt', node: '38', input: 'text', label: '完整提示词' },
    { kind: 'prompt', node: '38', input: 'instruct', label: '音色描述', value: '年轻女性，温柔' },
    { kind: 'select', node: '38', input: 'language', label: '语言', options: ['Auto', 'Chinese'], value: 'Auto' },
  ],
  reference_cells: [],
});
const A_CUSTOM = audioTpl({
  id: 13, name: '闪寻指定音色',
  slots: [
    { kind: 'prompt', node: '37', input: 'text', label: '完整提示词' },
    { kind: 'prompt', node: '37', input: 'instruct', label: '语气与风格', value: '' },
    { kind: 'select', node: '37', input: 'speaker', label: '音色', options: ['Vivian', 'Uncle_Fu'], value: 'Vivian' },
    { kind: 'select', node: '37', input: 'language', label: '语言', options: ['Auto', 'Chinese'], value: 'Auto' },
  ],
  reference_cells: [],
});
const modeRoutes = () => ({ ...baseRoutes(), '/api/clone/templates': { items: [TPL, A_CLONE, A_DESIGN, A_CUSTOM] } });

it('音频弹窗顶上那排模式按钮：三种出声方式各一颗，当前那颗亮着', async () => {
  routes(modeRoutes());
  const screen = await ready({ image: AUDIO_CARD });
  const group = await screen.findByRole('radiogroup', { name: '音频模式' });
  const buttons = [...group.querySelectorAll('button')];
  // 按钮上的字说的是「怎么出声」，不是「哪份 JSON」：品牌前缀在三颗按钮里是重复信息
  expect(buttons.map((b) => b.textContent)).toEqual(['参考音色', '音色描述', '指定音色']);
  expect(buttons.map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
  // 参考音色要吃一段参考音频，所以参考区还在
  expect(screen.getByRole('group', { name: /^参考音频/ })).toBeTruthy();
});

it('点「音色描述」换到那条工作流：参考那一整块消失、附框换成音色描述、台词原样留着', async () => {
  routes(modeRoutes());
  const screen = await ready({ image: AUDIO_CARD });
  const group = await screen.findByRole('radiogroup', { name: '音频模式' });
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '这句台词三种方式都要用' } });
  await fireEvent.click(group.querySelectorAll('button')[1]);
  await tick();
  // 这份工作流一个参考位都没有：空参考区 + 一颗点了不会出东西的「+ 参考」比不摆更糟
  expect(screen.queryByRole('group', { name: /参考/ })).toBeNull();
  expect(screen.container.querySelector('.cm-composer')!.getAttribute('title')).toContain('这一种不用参考音频');
  const box = (await screen.findByLabelText('音色描述')) as HTMLTextAreaElement;
  expect(box.value).toBe('年轻女性，温柔');
  expect(box.getAttribute('placeholder')).toContain('必填');
  // 换出声方式不是重开弹窗：用户刚敲的台词不许被冲掉
  expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('这句台词三种方式都要用');
  // 换过去之后当前那颗跟着挪
  const buttons = [...(await screen.findByRole('radiogroup', { name: '音频模式' })).querySelectorAll('button')];
  expect(buttons.map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
});

it('指定音色那条：参数面板里挑音色，选项读着不像代码名，交回后端的仍是原值', async () => {
  let submitted: Record<string, unknown> | null = null;
  routes({
    ...baseRoutes(),
    '/api/clone/templates': { items: [A_CUSTOM] },
    '/api/clone/generate': (init?: RequestInit) => {
      submitted = JSON.parse(String(init?.body));
      return { ...EMPTY_CLONE_JOB, active: true, job_id: 'j1', state: 'queued', running: true };
    },
  });
  const screen = await ready({ image: AUDIO_CARD });
  await fireEvent.click(screen.getByRole('button', { name: '画面参数' }));
  const pop = await screen.findByRole('dialog', { name: '画面参数' });
  expect([...pop.querySelectorAll('.cm-pop-title')].map((el) => el.textContent)).toEqual(['音色', '语言']);
  const fu = screen.getByRole('button', { name: 'Uncle_Fu' });
  expect(fu.textContent).toContain('Uncle Fu');
  await fireEvent.click(fu);
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '换个音色念一句' } });
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  await tick();
  expect(submitted).toMatchObject({ controls: { '37.speaker': 'Uncle_Fu' } });
  // 两种附框都是空的，就不该往 slot_prompts 里塞空字符串
  expect(JSON.stringify(submitted ?? {})).not.toContain('slot_prompts');
});

it('图片工作流挂图片卡时不摆这排按钮，哪怕库里躺着三条音频工作流', async () => {
  routes(modeRoutes());
  const screen = await ready();
  expect(screen.queryByRole('radiogroup', { name: '音频模式' })).toBeNull();
  // 音频族只有一条时也不摆：一颗按钮的开关不是模式选择
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [A_CLONE] } });
  cleanup();
  const again = await ready({ image: AUDIO_CARD });
  expect(again.queryByRole('radiogroup', { name: '音频模式' })).toBeNull();
  expect(again.getByRole('group', { name: /^参考音频/ })).toBeTruthy();
});


// ---------- 「切换工作流」清单：音频那三条收成一条「闪寻音频」 ----------

it("清单里音频只占一行「闪寻音频」：三种出声方式由弹窗顶上那排按钮负责", async () => {
  routes(modeRoutes());
  const screen = await ready({ image: AUDIO_CARD });
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  await screen.findByRole('menu', { name: '工作流' });
  const rows = [...document.querySelectorAll('.cm-wf-row > .cm-wf')];
  // 音频卡这一屏只有音频族：三条出声方式折成一行，不是三行流水账
  expect(rows.map((r) => r.querySelector('.cm-wf-name')?.textContent)).toEqual(['闪寻音频']);
  // 正在用参考音色 ⇒ 这一行就是「当前」
  expect(rows[0].querySelector('.cm-wf-tag')?.textContent).toBe('当前');
  expect(rows[0].getAttribute('aria-checked')).toBe('true');
  // 折叠行不给删除按钮（背后是三条工作流，删哪条不该由这颗 X 决定）
  expect(document.querySelectorAll('.cm-wf-row > .cm-wf-del')).toHaveLength(0);
  expect(rows[0].getAttribute('title')).toContain('三种出声方式在弹窗顶上切换');
  expect(rows[0].getAttribute('title')).toContain('参考音色 / 音色描述 / 指定音色');
  // 切回图片族才看得见本机那条和它的删除 X
  await fireEvent.click(screen.getByRole('button', { name: '创作类型' }));
  await fireEvent.click(await screen.findByRole('menuitemradio', { name: /图片生成/ }));
  await vi.waitFor(() => expect(
    screen.getByRole('button', { name: '工作流' }).textContent).toContain('Qwen 多图编辑'),
  );
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  await vi.waitFor(() => expect([...document.querySelectorAll('.cm-wf-row > .cm-wf-del')]).toHaveLength(1));
  expect(document.querySelector('.cm-wf-del')?.getAttribute('aria-label')).toBe('删除工作流 Qwen 多图编辑');
});

it("已经在出声音时再点「闪寻音频」：只收起弹层，不把人从当前那种模式踢回默认", async () => {
  routes(modeRoutes());
  const screen = await ready({ image: AUDIO_CARD });
  const group = await screen.findByRole('radiogroup', { name: '音频模式' });
  // 清单里 is_active 的是 A_CLONE，音频族顺序是 参考音色 / 指定音色 / 音色描述
  await fireEvent.click(group.querySelectorAll('button')[1]);
  await tick();
  expect(await screen.findByLabelText('音色描述')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  const rows = await screen.findAllByRole('menuitemradio');
  await fireEvent.click(rows[rows.length - 1]);
  await tick();
  // 还是那条「音色描述」：点族名不是「回到第一种」
  expect(screen.queryByRole('menu', { name: '工作流' })).toBeNull();
  expect(await screen.findByLabelText('音色描述')).toBeTruthy();
  const again = await screen.findByRole('radiogroup', { name: '音频模式' });
  expect([...again.querySelectorAll('button')].map((b) => b.getAttribute('aria-checked'))).toEqual([
    'false', 'true', 'false',
  ]);
});

it("从图片卡切到「音频生成」：换到音频族库里标的那条，不是随便挑一条", async () => {
  routes(modeRoutes());
  const screen = await ready();
  await fireEvent.click(screen.getByRole('button', { name: '创作类型' }));
  await fireEvent.click(await screen.findByRole('menuitemradio', { name: /音频生成/ }));
  await tick();
  // modeRoutes 里 is_active 的是 A_CLONE——音频族里唯一吃参考音频的那条
  expect(screen.getByRole('group', { name: /^参考音频/ })).toBeTruthy();
  const group = await screen.findByRole('radiogroup', { name: '音频模式' });
  expect([...group.querySelectorAll('button')].map((b) => b.getAttribute('aria-checked'))).toEqual([
    'true', 'false', 'false',
  ]);
});

it("只有一条音频工作流时不折叠：那时候顶上根本没有模式按钮，藏名字就是让人认错工作流", async () => {
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [TPL, A_CLONE] } });
  const screen = await ready();
  await fireEvent.click(screen.getByRole('button', { name: '创作类型' }));
  await fireEvent.click(await screen.findByRole('menuitemradio', { name: /音频生成/ }));
  await vi.waitFor(() => expect(
    screen.getByRole('button', { name: '工作流' }).textContent).toContain('闪寻参考音色'),
  );
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  const rows = await screen.findAllByRole('menuitemradio');
  // 这一族只有一条 → 按名字摆出来，不折成「闪寻音频」那种族名
  expect(rows.map((r) => r.querySelector('.cm-wf-name')?.textContent)).toEqual(['闪寻参考音色']);
});

/* 跨族/同族换卡时工作流该跟谁。弹窗常驻在 Feed 里，关掉不销毁组件，templateId 会一路带下去。 */
const AUDIO_CARD2 = { ...AUDIO_CARD, id: 9, filename: '另一段.flac' };

it("音频卡用完再点图片卡：工作流要回到图片族，不能把出声音那条带过去", async () => {
  routes(modeRoutes());
  const screen = await ready({ image: AUDIO_CARD });
  expect(screen.getByRole('group', { name: /^参考音频/ })).toBeTruthy();

  screen.rerender({ image: SOURCE });
  // 模板重挑要等一次接口回来，中间那一瞬音频模式按钮已经没了、工作流那颗还没回来
  await vi.waitFor(() => expect(
    screen.getByRole('button', { name: '工作流' }).textContent).toContain('Qwen 多图编辑'),
  );
  expect(screen.queryByRole('radiogroup', { name: '音频模式' })).toBeNull();
  expect(screen.getByRole('group', { name: /^参考图/ })).toBeTruthy();
});

it("同族换卡：还留着用户挑的那种出声方式，不每次开弹窗都跳回库里标的那条", async () => {
  routes({
    ...modeRoutes(),
    '/api/clone/sources/9': NO_SOURCES,
    '/api/images/9/reverse-prompts': { items: [] },
    '/api/images/9': { id: 9, filename: '另一段.flac', positive_prompt: '' },
  });
  const screen = await ready({ image: AUDIO_CARD });
  const group = await screen.findByRole('radiogroup', { name: '音频模式' });
  await fireEvent.click(group.querySelectorAll('button')[1]);
  await vi.waitFor(() => expect(screen.queryByLabelText('音色描述')).toBeTruthy());

  screen.rerender({ image: AUDIO_CARD2 });
  await vi.waitFor(() => expect(screen.getAllByRole('radiogroup', { name: '音频模式' }).length).toBe(1));
  expect(screen.queryByLabelText('音色描述')).toBeTruthy();
  const again = screen.getByRole('radiogroup', { name: '音频模式' });
  expect([...again.querySelectorAll('button')].map((b) => b.getAttribute('aria-checked'))).toEqual([
    'false', 'true', 'false',
  ]);
});

it("三种出声方式底下那颗都写「闪寻音频」：与切换清单那一行同一个叫法，全名进悬浮提示", async () => {
  routes(modeRoutes());
  const screen = await ready({ image: AUDIO_CARD });
  const pill = () => screen.getByRole('button', { name: '工作流' });
  expect(pill().textContent?.trim()).toBe('闪寻音频');
  expect(document.querySelector('.cm-title')?.textContent).toBe('闪寻音频');
  // 具体是哪一条没丢：悬浮提示里报到，设置页里也各占一行
  expect(pill().getAttribute('title')).toContain('闪寻参考音色');

  const group = await screen.findByRole('radiogroup', { name: '音频模式' });
  await fireEvent.click(group.querySelectorAll('button')[1]);
  await vi.waitFor(() => expect(pill().getAttribute('title')).toContain('音色描述'));
  expect(pill().textContent?.trim()).toBe('闪寻音频');
  expect(document.querySelector('.cm-title')?.textContent).toBe('闪寻音频');
});

it("图片工作流不该被折名：底部那颗仍是这份工作流自己的名字，悬浮提示不多余一句", async () => {
  routes(modeRoutes());
  const screen = await ready();
  const pill = screen.getByRole('button', { name: '工作流' });
  expect(pill.textContent?.trim()).toBe('Qwen 多图编辑');
  expect(pill.getAttribute('title')).toBe('Qwen 多图编辑');
});

const A_CUSTOM9 = audioTpl({
  id: 14, name: '闪寻指定音色',
  slots: [
    { kind: 'prompt', node: '37', input: 'text', label: '完整提示词' },
    { kind: 'select', node: '37', input: 'speaker', label: '音色',
      options: ['Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Ono_Anna', 'Sohee'], value: 'Vivian' },
    { kind: 'select', node: '37', input: 'language', label: '语言', options: ['Auto', 'Chinese'], value: 'Auto' },
  ],
  reference_cells: [],
});

it('指定音色那一格是九张脸：认得出的选项摆头像，语言格照旧是小圆点', async () => {
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [A_CUSTOM9] } });
  const screen = await ready({ image: AUDIO_CARD });
  // 选中谁，底部那颗胶囊就带上谁的脸——不用点开面板也知道现在用的是哪个音色
  const pillFace = screen.container.querySelector('.cm-pill-face') as HTMLImageElement | null;
  expect(pillFace?.getAttribute('src')).toBe('/voices/vivian.webp');
  await fireEvent.click(screen.getByRole('button', { name: '画面参数' }));
  const pop = await screen.findByRole('dialog', { name: '画面参数' });
  const grids = [...pop.querySelectorAll('.cm-ratio-grid')];
  const faces = [...grids[0].querySelectorAll('img.cm-ratio-face')];
  expect(faces.map((img) => img.getAttribute('src'))).toEqual([
    '/voices/vivian.webp', '/voices/serena.webp', '/voices/uncle-fu.webp',
    '/voices/dylan.webp', '/voices/eric.webp', '/voices/ryan.webp',
    '/voices/aiden.webp', '/voices/ono-anna.webp', '/voices/sohee.webp',
  ]);
  // 脸是装饰，名字才是可读的那一份：alt 必须空，字必须还在
  expect(faces.every((img) => img.getAttribute('alt') === '')).toBe(true);
  expect([...grids[0].querySelectorAll('.cm-ratio-label')].map((el) => el.textContent)).toEqual([
    'Vivian', 'Serena', 'Uncle Fu', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Ono Anna', 'Sohee',
  ]);
  // 语种那一格没有脸，仍然走那颗小圆点
  expect(grids[1].querySelectorAll('img.cm-ratio-face').length).toBe(0);
  expect(grids[1].querySelectorAll('.cm-ratio-flat').length).toBe(2);
  // 点到第三个人：胶囊上的脸跟着换
  await fireEvent.click(screen.getByRole('button', { name: 'Uncle_Fu' }));
  await tick();
  expect((screen.container.querySelector('.cm-pill-face') as HTMLImageElement).getAttribute('src')).toBe('/voices/uncle-fu.webp');
});

it('模型自带的其它音色（用户自己练的）不许乱配脸，仍走小圆点', async () => {
  routes({
    ...baseRoutes(),
    '/api/clone/templates': {
      items: [audioTpl({
        id: 15, name: '闪寻指定音色',
        slots: [{ kind: 'select', node: '37', input: 'speaker', label: '音色', options: ['my_voice'], value: 'my_voice' }],
        reference_cells: [],
      })],
    },
  });
  const screen = await ready({ image: AUDIO_CARD });
  expect(screen.container.querySelector('.cm-pill-face')).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: '画面参数' }));
  const pop = await screen.findByRole('dialog', { name: '画面参数' });
  expect(pop.querySelectorAll('img.cm-ratio-face').length).toBe(0);
  expect(pop.querySelectorAll('.cm-ratio-flat').length).toBe(1);
});

// ---------- 点人物就试听那一段音色 ----------

/**
 * 盯住某一条 <audio>。不顶 HTMLMediaElement.prototype：弹窗里有两条（左边卡片自己那条 +
 * 试听这条），数原型会把「让路的那次暂停」算到试听头上，测出来的是个说不清的数。
 */
function watch(el: HTMLAudioElement) {
  return {
    play: vi.spyOn(el, 'play').mockImplementation(() => Promise.resolve()),
    pause: vi.spyOn(el, 'pause').mockImplementation(() => {}),
  };
}

/** 打开底部那颗胶囊上面的参数面板。 */
async function openPop(screen: Awaited<ReturnType<typeof ready>>) {
  await fireEvent.click(screen.getByRole('button', { name: '画面参数' }));
  return screen.findByRole('dialog', { name: '画面参数' });
}

const sampleOf = (screen: Awaited<ReturnType<typeof ready>>) =>
  screen.container.querySelector('audio.cm-voice-sample') as HTMLAudioElement;
const heroOf = (screen: Awaited<ReturnType<typeof ready>>) =>
  screen.container.querySelector('audio.cm-hero-audio') as HTMLAudioElement;
const voiceCell = (screen: Awaited<ReturnType<typeof ready>>, name: string) =>
  screen.getByRole('button', { name }) as HTMLElement;
const nineVoices = () =>
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [A_CUSTOM9] } });

it('点一个音色：选中他、马上播他那一段，头像右上角挂上三条跳动的窄条', async () => {
  nineVoices();
  const screen = await ready({ image: AUDIO_CARD });
  const pop = await openPop(screen);
  const grids = [...pop.querySelectorAll('.cm-ratio-grid')];
  // 九个音色格全都算「音色格」，语种那一格不算（它照旧用灰底当选中）
  expect([...grids[0].querySelectorAll('.cm-ratio.is-voice')]).toHaveLength(9);
  expect(grids[1].querySelectorAll('.cm-ratio.is-voice')).toHaveLength(0);

  const cell = voiceCell(screen, 'Eric');
  expect(cell.querySelector('.cm-voice-eq')).toBeNull(); // 没在放的时候不许先亮窄条
  expect(sampleOf(screen).getAttribute('src')).toBeNull();

  const sample = watch(sampleOf(screen));
  const hero = watch(heroOf(screen));
  await fireEvent.click(cell);
  await tick();
  expect(sampleOf(screen).src).toContain('/voices/eric.flac');
  expect(sample.play).toHaveBeenCalledTimes(1);
  expect(sample.pause).not.toHaveBeenCalled();
  // 左边那张音频卡正在放的话得让路：同一时刻只准一个声音在响
  expect(hero.pause).toHaveBeenCalledTimes(1);
  expect(cell.classList.contains('is-hearing')).toBe(true);
  expect(cell.classList.contains('is-on')).toBe(true); // 选中照旧跟着点走，只是不铺底色
  expect(cell.querySelectorAll('.cm-voice-eq i')).toHaveLength(3);
  // 悬浮提示说清这一笔点下去会发生什么；语种那格没有样本，标题还是选项原值
  expect(cell.getAttribute('title')).toBe('试听并选用：Eric');
  expect(voiceCell(screen, 'Chinese').getAttribute('title')).toBe('Chinese');
});

it('同一个人再点一下就是停下：窄条收掉，暂停落到试听那条上', async () => {
  nineVoices();
  const screen = await ready({ image: AUDIO_CARD });
  await openPop(screen);
  const cell = voiceCell(screen, 'Eric');
  const sample = watch(sampleOf(screen));
  await fireEvent.click(cell);
  await tick();
  await fireEvent.click(cell);
  await tick();
  expect(sample.play).toHaveBeenCalledTimes(1);
  expect(sample.pause).toHaveBeenCalledTimes(1);
  expect(cell.classList.contains('is-hearing')).toBe(false);
  expect(cell.querySelector('.cm-voice-eq')).toBeNull();
  // 停下不等于取消选中：他还是这次要用的音色
  expect(cell.classList.contains('is-on')).toBe(true);
});

it('换人听就换源：窄条只挂在正在放的那一位头上', async () => {
  nineVoices();
  const screen = await ready({ image: AUDIO_CARD });
  await openPop(screen);
  const sample = watch(sampleOf(screen));
  const eric = voiceCell(screen, 'Eric');
  const ryan = voiceCell(screen, 'Ryan');
  await fireEvent.click(eric);
  await tick();
  await fireEvent.click(ryan);
  await tick();
  expect(sampleOf(screen).src).toContain('/voices/ryan.flac');
  expect(sample.play).toHaveBeenCalledTimes(2);
  expect(eric.classList.contains('is-hearing')).toBe(false);
  expect(eric.querySelector('.cm-voice-eq')).toBeNull();
  expect(ryan.classList.contains('is-hearing')).toBe(true);
});

it('收起参数面板必须停音：重开面板不许还有人挂着在放', async () => {
  nineVoices();
  const screen = await ready({ image: AUDIO_CARD });
  await openPop(screen);
  const sample = watch(sampleOf(screen));
  await fireEvent.click(voiceCell(screen, 'Eric'));
  await tick();
  await fireEvent.click(screen.getByRole('button', { name: '画面参数' }));
  await tick();
  expect(sample.pause).toHaveBeenCalledTimes(1);
  const pop = await openPop(screen);
  expect(pop.querySelector('.cm-ratio.is-hearing')).toBeNull();
  expect(screen.container.querySelectorAll('.cm-voice-eq')).toHaveLength(0);
});

it('卡片自己那段开始放的时候试听先让路：一屏只准一个声音', async () => {
  nineVoices();
  const screen = await ready({ image: AUDIO_CARD });
  await openPop(screen);
  const cell = voiceCell(screen, 'Eric');
  const sample = watch(sampleOf(screen));
  await fireEvent.click(cell);
  await tick();
  await fireEvent.play(heroOf(screen));
  await tick();
  expect(sample.pause).toHaveBeenCalledTimes(1);
  expect(cell.classList.contains('is-hearing')).toBe(false);
});

it('试听途中去改语种：声音不许被掐掉——听的是人，不是语种', async () => {
  nineVoices();
  const screen = await ready({ image: AUDIO_CARD });
  await openPop(screen);
  const cell = voiceCell(screen, 'Eric');
  const sample = watch(sampleOf(screen));
  await fireEvent.click(cell);
  await tick();
  await fireEvent.click(voiceCell(screen, 'Chinese'));
  await tick();
  expect(sample.pause).not.toHaveBeenCalled();
  expect(sample.play).toHaveBeenCalledTimes(1);
  expect(cell.classList.contains('is-hearing')).toBe(true);
  expect(voiceCell(screen, 'Chinese').classList.contains('is-on')).toBe(true);
});

it('模型里的其它音色没有样本：只选中，不出声，也不许挂窄条', async () => {
  routes({
    ...baseRoutes(),
    '/api/clone/templates': {
      items: [audioTpl({
        id: 16, name: '闪寻指定音色',
        slots: [{
          kind: 'select', node: '37', input: 'speaker', label: '音色',
          options: ['Vivian', 'my_voice'], value: 'Vivian',
        }],
        reference_cells: [],
      })],
    },
  });
  const screen = await ready({ image: AUDIO_CARD });
  await openPop(screen);
  const sample = watch(sampleOf(screen));
  await fireEvent.click(voiceCell(screen, 'Vivian'));
  await tick();
  expect(sample.play).toHaveBeenCalledTimes(1);
  await fireEvent.click(voiceCell(screen, 'my_voice'));
  await tick();
  // 换到没有样本的那一格：先把上一段停下，再保持安静，src 也不许乱指
  expect(sample.pause).toHaveBeenCalledTimes(1);
  expect(sample.play).toHaveBeenCalledTimes(1);
  expect(sampleOf(screen).src).toContain('/voices/vivian.flac');
  expect(voiceCell(screen, 'my_voice').classList.contains('is-hearing')).toBe(false);
});

it('音色格不许拿底色当指示：悬停、选中、试听三态都 transparent，名字才是品牌色', () => {
  const raw = readFileSync('src/components/CloneModal.svelte', 'utf8');
  const css = raw.slice(raw.indexOf('<style>')); // 判样式要看 style 块，整份源码里有同名类名
  expect(css).toMatch(/\.cm-ratio\.is-voice,\s*\.cm-ratio\.is-voice:hover,\s*\.cm-ratio\.is-voice\.is-on\s*\{\s*background:\s*transparent;\s*\}/);
  expect(css).toMatch(/\.cm-ratio\.is-voice\.is-on \.cm-ratio-label,\s*\.cm-ratio\.is-hearing \.cm-ratio-label\s*\{\s*color:\s*#f24e4e;/);
  expect(css).toMatch(/\.cm-ratio-face-wrap \{ position: relative/);
  // 右上角那三条是裸条：贴在头像右上角，但没有圆圈底（用户给的参考图就是三根裸条）
  const eq = /\.cm-voice-eq \{[^}]*\}/.exec(css)?.[0] ?? "";
  expect(eq).toContain("position: absolute");
  expect(eq).not.toMatch(/border-radius:\s*50%|width:\s*\d+px|background:\s*#1|box-shadow/);
  const bar = /\.cm-voice-eq i \{[^}]*\}/.exec(css)?.[0] ?? "";
  expect(bar).toMatch(/background:\s*#f24e4e/);
  expect(bar).toMatch(/border-radius:\s*999px/);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.cm-voice-eq i \{ animation: none;/);
});

// ---------- 选了人，语种跟着换成他的母语 ----------

/** 语种那一格有没有被选中：aria-pressed 是唯一口径，显示出来的是中文。 */
const pressed = (screen: Awaited<ReturnType<typeof ready>>, name: string) =>
  screen.getByRole('button', { name }).getAttribute('aria-pressed');

/** 语言选项齐全的九人工作流：官方表里的母语全都点得到。 */
const A_NINE_LANG = audioTpl({
  id: 17, name: '闪寻指定音色',
  slots: [
    { kind: 'prompt', node: '37', input: 'text', label: '完整提示词' },
    {
      kind: 'select', node: '37', input: 'speaker', label: '音色',
      options: ['Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Ono_Anna', 'Sohee', 'my_voice'],
      value: 'Vivian',
    },
    {
      kind: 'select', node: '37', input: 'language', label: '语言',
      options: ['Auto', 'Chinese', 'English', 'Japanese', 'Korean'], value: 'Auto',
    },
  ],
  reference_cells: [],
});
const nineLang = () => routes({ ...baseRoutes(), '/api/clone/templates': { items: [A_NINE_LANG] } });

it('点 Ryan 就把语种换成英文：官方表里他 native 就是 English', async () => {
  nineLang();
  const screen = await ready({ image: AUDIO_CARD });
  const pill = screen.getByRole('button', { name: '画面参数' });
  await openPop(screen);
  watch(sampleOf(screen));
  // 载入时已经落在默认那位（Vivian）的母语上，不再是工作流自带那份「自动」
  expect(pressed(screen, 'Chinese')).toBe('true');
  expect(pressed(screen, 'Auto')).toBe('false');
  await fireEvent.click(voiceCell(screen, 'Ryan'));
  await tick();
  expect(pressed(screen, 'Auto')).toBe('false');
  expect(pressed(screen, 'English')).toBe('true');
  // 胶囊上那行字跟着变，不点开面板也知道这次要说什么语种
  expect(pill.textContent).toContain('Ryan / 英文');
});

it('母语跟着人走：Sohee 韩文、Ono_Anna 日文、Uncle Fu 中文', async () => {
  nineLang();
  const screen = await ready({ image: AUDIO_CARD });
  await openPop(screen);
  watch(sampleOf(screen));
  for (const [who, lang] of [['Sohee', 'Korean'], ['Ono_Anna', 'Japanese'], ['Uncle_Fu', 'Chinese']] as const) {
    await fireEvent.click(voiceCell(screen, who));
    await tick();
    expect(pressed(screen, lang), who).toBe('true');
  }
});

it('语种那一格没有英文就不动：宁可留在中文，也不发明一个工作流不认的值', async () => {
  nineVoices(); // 这份工作流的语言只有 Auto / Chinese
  const screen = await ready({ image: AUDIO_CARD });
  await openPop(screen);
  watch(sampleOf(screen));
  expect(pressed(screen, 'Chinese')).toBe('true'); // 开局是 Vivian 的母语
  await fireEvent.click(voiceCell(screen, 'Ryan'));
  await tick();
  expect(pressed(screen, 'Chinese')).toBe('true'); // 换人到 Ryan：这一格没英文，原样不动
  expect(pressed(screen, 'Auto')).toBe('false'); // 也没被悄悄退回「自动」
  // 这一格里根本没有「英文」这一项，不是没找到语种格（语种格找没找到上一条已钉死）
  expect(screen.queryByRole('button', { name: 'English' })).toBeNull();
});

it('手动改过语种之后，再点同一个人不许刷回去：那是用户自己挑的', async () => {
  nineLang();
  const screen = await ready({ image: AUDIO_CARD });
  await openPop(screen);
  watch(sampleOf(screen));
  const ryan = voiceCell(screen, 'Ryan');
  await fireEvent.click(ryan);
  await tick();
  expect(pressed(screen, 'English')).toBe('true');
  await fireEvent.click(voiceCell(screen, 'Auto'));
  await tick();
  await fireEvent.click(ryan); // 同一个人再点一下是停/放试听，不是重选
  await tick();
  expect(pressed(screen, 'Auto')).toBe('true');
  expect(pressed(screen, 'English')).toBe('false');
});

it('模型里的其它音色（自己练的）没有母语可对：语种保持不动', async () => {
  nineLang();
  const screen = await ready({ image: AUDIO_CARD });
  await openPop(screen);
  watch(sampleOf(screen));
  await fireEvent.click(voiceCell(screen, 'Ryan'));
  await tick();
  expect(pressed(screen, 'English')).toBe('true');
  await fireEvent.click(voiceCell(screen, 'my_voice'));
  await tick();
  expect(pressed(screen, 'English')).toBe('true'); // 不猜、也不回滚成自动
  expect(pressed(screen, 'Auto')).toBe('false');
});

// ---------- 载入工作流那一刻就把语种对上母语 ----------

/** 随包那条「指定音色」的形状，只把默认音色换成 Ryan：打开就该是他的母语。 */
const loadRyanWith = (languageOptions: string[], speaker = 'Ryan') =>
  routes({
    ...baseRoutes(),
    '/api/clone/templates': {
      items: [audioTpl({
        id: 18, name: '闪寻指定音色·默认Ryan',
        slots: [
          { kind: 'prompt', node: '37', input: 'text', label: '完整提示词' },
          { kind: 'select', node: '37', input: 'speaker', label: '音色', options: ['Vivian', 'Ryan', 'Sohee', 'my_voice'], value: speaker },
          { kind: 'select', node: '37', input: 'language', label: '语言', options: languageOptions, value: 'Auto' },
        ],
        reference_cells: [],
      })],
    },
  });

it('载入默认就是 Ryan 的工作流：语种已经是英文，不用先点一下人', async () => {
  loadRyanWith(['Auto', 'Chinese', 'English', 'Korean']);
  const screen = await ready({ image: AUDIO_CARD });
  await openPop(screen);
  expect(pressed(screen, 'English')).toBe('true');
  expect(pressed(screen, 'Auto')).toBe('false');
  // 胶囊那行字跟着母语走，不点开面板也知道这次说什么语种
  expect(screen.getByRole('button', { name: '画面参数' }).textContent).toContain('Ryan / 英文');
});

it('载入时语种格里没有英文就不动：还是工作流自带那份自动', async () => {
  loadRyanWith(['Auto', 'Chinese']);
  const screen = await ready({ image: AUDIO_CARD });
  await openPop(screen);
  expect(pressed(screen, 'Auto')).toBe('true');
});

it('载入的工作流默认是自己练的音色：语种保持自动，不猜', async () => {
  loadRyanWith(['Auto', 'Chinese', 'English'], 'my_voice');
  const screen = await ready({ image: AUDIO_CARD });
  await openPop(screen);
  expect(pressed(screen, 'Auto')).toBe('true');
});

it('载入已经对齐了母语，之后手动改回自动，再点同一个人不许刷回去', async () => {
  loadRyanWith(['Auto', 'Chinese', 'English', 'Korean']);
  const screen = await ready({ image: AUDIO_CARD });
  await openPop(screen);
  expect(pressed(screen, 'English')).toBe('true');
  await fireEvent.click(voiceCell(screen, 'Auto'));
  await tick();
  const sample = watch(sampleOf(screen));
  await fireEvent.click(voiceCell(screen, 'Ryan')); // 同一个人再点一下是停/放试听，不是重选
  await tick();
  expect(pressed(screen, 'Auto')).toBe('true');
  expect(sample.play).toHaveBeenCalledTimes(1);
});

it('换到另一条工作流：语种按那条自己的默认音色重算，不留上一条的英文', async () => {
  // 两条都是音频工作流，会折成「闪寻音频」一族，切换走弹窗顶上那排出声方式按钮。
  const plan = (id: number, name: string, value: string) => audioTpl({
    id, name,
    slots: [
      { kind: 'select', node: '37', input: 'speaker', label: '音色', options: ['Vivian', 'Ryan'], value },
      { kind: 'select', node: '37', input: 'language', label: '语言', options: ['Auto', 'Chinese', 'English'], value: 'Auto' },
    ],
    reference_cells: [],
  });
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [plan(18, '甲号试听', 'Ryan'), plan(19, '乙号试听', 'Vivian')] } });
  const screen = await ready({ image: AUDIO_CARD });
  await openPop(screen);
  expect(pressed(screen, 'English')).toBe('true');
  const group = await screen.findByRole('radiogroup', { name: '音频模式' });
  await fireEvent.click(group.querySelectorAll('button')[1]); // 换成乙号试听（默认 Vivian）
  await tick();
  const after = await screen.findByRole('radiogroup', { name: '音频模式' });
  expect([...after.querySelectorAll('button')].map((b) => b.getAttribute('aria-checked'))).toEqual(["false", "true"]);
  await openPop(screen);
  expect(pressed(screen, 'Chinese')).toBe('true');
  expect(pressed(screen, 'English')).toBe('false');
});

/* ── 云端那三条 API ───────────────────────────────────────────────────
   这一族是要扣 RH币的，所以规矩和本机工作流不一样：没人认领时不许当默认、不许悄悄折起来、
   没实测过的必须写明、价格取不到就宁可不写。用例钉的是这些规矩，不是样式。 */

const CLOUD_IMG = {
  id: 91, name: '图片API', is_active: false, media_kind: 'image',
  engine: 'cloud', is_cloud: true, provider: 'runninghub', model: 'image',
  created_at: '', updated_at: '', node_count: 0, prompt_count: 1, reference_count: 1, control_count: 0,
  default_prompt: '',
  slots: [{ kind: 'prompt', node: 'model', input: 'prompt', label: '完整提示词' }],
  reference_cells: [
    { key: 'model.imageUrls#1', kind: 'image', ordinal: 1, label: '图1', name: '', slot_label: '参考图', tag: '图1' },
  ],
  cloud: { model_label: 'Seedream v5', provider_label: 'RunningHub', verified: false, notes: [], ref_limits: { image: 4 } },
};

const cloudOn = (over: Record<string, unknown> = {}) => ({
  cloud_max_single_coins: 0, cloud_max_daily_coins: 0,
  availability: { available: true, reason: '' },
  accounts: [], presets: [], pending: [], seeded: true,
  spend: { today_coins: 0, month: '2026-11', counts: {}, month_coins: 0, recent: [] },
  ...over,
});

it('云端那条要扣钱：没有「当前」时开弹窗仍走本机那条，不替用户把钱花了', async () => {
  // 库里云端那条排在前面也白搭——默认走它等于「用户什么也没点就产生了费用」
  routes({ ...baseRoutes(), '/api/clone/cloud/status': cloudOn(), '/api/clone/templates': { items: [CLOUD_IMG, TPL] } });
  const screen = await ready();
  expect(screen.getByRole('heading', { name: 'Qwen 多图编辑' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '工作流' }).textContent).toContain('Qwen 多图编辑');
});

it('底部那一排的顺序就是决策顺序：先定出什么，再定用谁，最后定它怎么出', async () => {
  // 参数是这份工作流自己的参数——先设完参数再换工作流，参数就得重来；
  // 工作流是这一族里的某一份——所以族必须在它左边（2026-11-04 苏醒）。
  routes(baseRoutes());
  const screen = await ready();
  const pills = [...screen.container.querySelectorAll('.cm-foot-left .cm-pill')] as HTMLElement[];
  expect(pills.map((x) => x.getAttribute('aria-label'))).toEqual(['创作类型', '工作流', '画面参数']);
  // 生成和取消仍钉在这一排最右，不参与压缩（上面那条「定宽优先」压的是几何，这里压的是左右次序）
  const actions = screen.container.querySelector('.cm-actions') as HTMLElement;
  expect(pills[1].compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('用户在设置页把云端那条设成「当前」之后，弹窗就开在它上面', async () => {
  // 「不拿云端当默认」不等于「不许用户选云端」：is_active 是他自己点的，照它开。
  const cloudActive = { ...CLOUD_IMG, is_active: true };
  routes({
    ...baseRoutes(), '/api/clone/cloud/status': cloudOn(),
    '/api/clone/templates': { items: [cloudActive, TPL] },
    '/api/clone/cloud/estimate': { coins: 3, mode: 'image' },
  });
  const screen = await ready();
  expect(screen.getByRole('button', { name: '工作流' }).textContent).toContain('Seedream v5');
});

it('API 那一屏两列级联：左列一家服务商一行，右列摆它报的模型；差 Key 时灰掉并说出差哪一步', async () => {
  routes({
    ...baseRoutes(),
    '/api/clone/cloud/status': cloudOn({ availability: { available: false, reason: '还没填 RunningHub 的 API Key' } }),
    '/api/clone/templates': { items: [TPL, CLOUD_IMG] },
  });
  const screen = await ready();
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  await tick();
  // 两屏各摆各的（苏醒要的）：本机这一屏不该出现要扣 RH币的那一条
  expect(screen.getByRole('button', { name: '本地工作流' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('menuitemradio', { name: /Seedream v5/ })).toBeNull();
  // 两屏各画各的，不许同时挂在 DOM 里（{:else if} 挂错块时实测过会两块一起出来）
  expect(screen.container.querySelector('.cm-api')).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: /^云端API服务/ }));
  // 左列：一行一家，名字下面写它能干什么；指针停在那一家就报 aria-current
  const vendor = screen.container.querySelector('.cm-api-vendor') as HTMLElement;
  expect(vendor.textContent).toContain('RunningHub');
  expect(vendor.textContent).toContain('出图');
  expect(vendor.getAttribute('aria-current')).toBe('true');
  // 右列：那一行叫模型名，不叫「图片API」。差 Key 是整条云端路的事，所以灰掉的是行、说的是「需配置」。
  // 换到 API 屏之后，本机那一屏那一列必须整块撤掉，不是藏起来
  expect(screen.container.querySelector('.cm-pop-list')).toBeNull();
  const row = (await screen.findByRole('menuitemradio', { name: /Seedream v5/ })) as HTMLButtonElement;
  expect(row.textContent).toContain('待实测');
  expect(row.textContent).toContain('需配置');
  expect(row.disabled).toBe(true);
  expect(row.getAttribute('title')).toContain('还没填 RunningHub 的 API Key');
  // 左下角那一格「现在挂的是哪一条」被苏醒圈掉了：右列那一条自己挂着「当前」，
  // 底部那颗胶囊也一直在报同一个名字，172px 的窄列里再挤一份只会截成「即梦 …」。
  expect(screen.container.querySelector('.cm-api-cur')).toBeNull();
  // 本机那一行也不跟着跑到 API 屏上
  expect(screen.queryByRole('menuitemradio', { name: /Qwen 多图编辑/ })).toBeNull();
});

it('两屏切着换工作流：API 屏点云端那条就换过去，回本机屏点回原来那条', async () => {
  routes({
    ...baseRoutes(), '/api/clone/cloud/status': cloudOn(),
    '/api/clone/templates': { items: [TPL, CLOUD_IMG] },
    '/api/clone/cloud/estimate': { coins: 3, mode: 'image' },
  });
  const screen = await ready();
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  await fireEvent.click(await screen.findByRole('button', { name: /^云端API服务/ }));
  await fireEvent.click(await screen.findByRole('menuitemradio', { name: /Seedream v5/ }));
  await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Seedream v5' })).toBeTruthy());
  // 现在挂在云端：再开弹层该直接开在 API 屏，不用人再点一次
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  await tick();
  expect(screen.getByRole('button', { name: /^云端API服务/ }).getAttribute('aria-pressed')).toBe('true');
  await fireEvent.click(screen.getByRole('button', { name: '本地工作流' }));
  await fireEvent.click(await screen.findByRole('menuitemradio', { name: /Qwen 多图编辑/ }));
  await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Qwen 多图编辑' })).toBeTruthy());
});

/** 另一家出片模型：verified=true，用来钉「已实测」这一态。 */
const CLOUD_VIDEO = {
  id: 92, name: '视频API', is_active: false, media_kind: 'video',
  engine: 'cloud', is_cloud: true, provider: 'runninghub', model: 'video',
  created_at: '', updated_at: '', node_count: 0, prompt_count: 1, reference_count: 1, control_count: 0,
  default_prompt: '',
  slots: [{ kind: 'prompt', node: 'model', input: 'prompt', label: '完整提示词' }],
  cloud: { model_label: 'Seedance 2.0', provider_label: 'RunningHub', verified: true, notes: [] },
};
/** 第二家服务商：级联左列不能把服务商写死成只有 RunningHub。 */
const CLOUD_OTHER = {
  id: 93, name: '图片API·别家', is_active: false, media_kind: 'image',
  engine: 'cloud', is_cloud: true, provider: 'grsai', model: 'grs-image',
  created_at: '', updated_at: '', node_count: 0, prompt_count: 1, reference_count: 0, control_count: 0,
  default_prompt: '',
  slots: [{ kind: 'prompt', node: 'model', input: 'prompt', label: '完整提示词' }],
  cloud: { model_label: '别家出图 1.0', provider_label: 'GRSAI', verified: false, notes: [] },
};

const modelRows = (screen: any) =>
  screen.getAllByRole('menuitemradio').map((row: HTMLElement) => row.textContent ?? '').join('|');

it('左列一家服务商一行：点另一家只换右列那份模型清单，不把两家的模型摊在一起', async () => {
  routes({
    ...baseRoutes(), '/api/clone/cloud/status': cloudOn(),
    '/api/clone/templates': { items: [TPL, CLOUD_IMG, CLOUD_VIDEO, CLOUD_OTHER] },
    '/api/clone/cloud/estimate': { coins: 3, mode: 'image' },
  });
  const screen = await ready();
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  await fireEvent.click(await screen.findByRole('button', { name: /^云端API服务/ }));
  const vendors = screen.container.querySelectorAll('.cm-api-vendor');
  expect([...vendors].map((v) => (v as HTMLElement).textContent)).toEqual(
    expect.arrayContaining([expect.stringContaining('RunningHub'), expect.stringContaining('GRSAI')]),
  );
  expect(vendors[0].getAttribute('aria-current')).toBe('true');
  expect(vendors[1].getAttribute('aria-current')).toBe('false');
  await vi.waitFor(() => expect(modelRows(screen)).toContain('Seedream v5'));
  // 视频模型不摊在这一列：先定了族，右列只摆这一族能出的（2026-11-04 苏醒）
  expect(modelRows(screen)).not.toContain('Seedance 2.0');
  expect(modelRows(screen)).not.toContain('别家出图');
  await fireEvent.click(vendors[1]);
  await tick();
  expect(modelRows(screen)).toContain('别家出图 1.0');
  expect(modelRows(screen)).not.toContain('Seedream v5');
  expect(screen.container.querySelectorAll('.cm-api-vendor')[1].getAttribute('aria-current')).toBe('true');
  // 换看的这一家不等于换用哪一条：没点模型之前，挂着的还是原来那条
  expect(screen.getByRole('button', { name: '工作流' }).textContent).toContain('Qwen 多图编辑');
});

it('行末三态说实话：没验过的挂「待实测」，后端明说验过的挂「已实测」，Key 齐了不再喊「需配置」', async () => {
  routes({
    ...baseRoutes(), '/api/clone/cloud/status': cloudOn(),
    '/api/clone/templates': { items: [TPL, CLOUD_IMG, CLOUD_VIDEO] },
    '/api/clone/cloud/estimate': { coins: 3, mode: 'image' },
  });
  const screen = await ready();
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  await fireEvent.click(await screen.findByRole('button', { name: /^云端API服务/ }));
  const rows = await screen.findAllByRole('menuitemradio');
  const text = rows.map((row: HTMLElement) => row.textContent ?? '');
  expect(text.some((t) => /Seedream v5.*待实测/.test(t))).toBe(true);
  expect(text.every((t) => !t.includes('需配置'))).toBe(true);
  // 这一屏整屏都是云端，再挂一枚「云端」是重复四个字，不省也占位
  expect(text.every((t) => !t.includes('云端'))).toBe(true);

  // 「已实测」那条是视频模型：切到视频生成才看得见，不用把三族摊在同一屏里找
  await fireEvent.click(screen.getByRole('button', { name: '创作类型' }));
  await fireEvent.click(await screen.findByRole('menuitemradio', { name: /视频生成/ }));
  await vi.waitFor(() => expect(
    screen.getByRole('button', { name: '工作流' }).textContent).toContain('Seedance 2.0'),
  );
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  await fireEvent.click(await screen.findByRole('button', { name: /^云端API服务/ }));
  const videoRows = (await screen.findAllByRole('menuitemradio')).map((row: HTMLElement) => row.textContent ?? '');
  expect(videoRows.some((t) => /Seedance 2\.0.*已实测/.test(t))).toBe(true);
  expect(videoRows.every((t) => !t.includes('Seedream'))).toBe(true);
});

it('换创作类型，云端那一屏跟着换族；这一族本机没配方时说得下去', async () => {
  routes({
    ...baseRoutes(), '/api/clone/cloud/status': cloudOn(),
    '/api/clone/templates': { items: [TPL, CLOUD_IMG, CLOUD_VIDEO] },
    '/api/clone/cloud/estimate': { coins: 3, mode: 'image' },
  });
  const screen = await ready();
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  await fireEvent.click(await screen.findByRole('button', { name: /^云端API服务/ }));
  await vi.waitFor(() => expect(modelRows(screen)).toContain('Seedream v5'));
  expect(modelRows(screen)).not.toContain('Seedance 2.0');
  // tab 上那个数是这一族的条数，不是全部云端的——写着 2 却只摆 1 行比不写更糟
  expect(screen.getByRole('button', { name: /^云端API服务/ }).textContent).toContain('1');

  await fireEvent.click(screen.getByRole('button', { name: '创作类型' }));
  await fireEvent.click(await screen.findByRole('menuitemradio', { name: /视频生成/ }));
  await vi.waitFor(() => expect(
    screen.getByRole('button', { name: '工作流' }).textContent).toContain('Seedance 2.0'),
  );
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  // 挂上的是云端那条，弹层因此开在云端屏——本机这一屏得点回去看
  await fireEvent.click(await screen.findByRole('button', { name: /^本地工作流/ }));
  // 这一族本机没配方：说一句并把出路留在屏上，不摆一块让人以为坏了的空白
  expect(await screen.findByText(/这一族还没有本机工作流/)).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: /加载本地工作流 JSON/ })).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: /^云端API服务/ }));
  await vi.waitFor(() => expect(modelRows(screen)).toContain('Seedance 2.0'));
  expect(modelRows(screen)).not.toContain('Seedream');
});

it('某一族一条都没铺：类型菜单里先说「还没铺路」，点它也不把人切进一份空清单', async () => {
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [TPL] } });
  const screen = await ready();
  await fireEvent.click(screen.getByRole('button', { name: '创作类型' }));
  const video = await screen.findByRole('menuitemradio', { name: /视频生成/ });
  expect(video.textContent).toContain('还没铺路');
  expect(video.getAttribute('aria-checked')).toBe('false');
  expect(video.getAttribute('title')).toContain('先加载一份这一族的工作流 JSON');
  await fireEvent.click(video);
  await tick();
  // 没切走：挂着的还是图片那条，理由写在弹窗下面那句里
  expect(screen.getByRole('button', { name: '创作类型' }).textContent).toContain('图片生成');
  expect(await screen.findByText(/视频生成这一族还没铺路/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '工作流' }).textContent).toContain('Qwen 多图编辑');
});

it('API 那一屏一条都没装时只给一句话，底部不再挂那颗「设置 Key」', async () => {
  routes({ ...baseRoutes(), '/api/clone/cloud/status': cloudOn() });
  const screen = await ready();
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  await fireEvent.click(await screen.findByRole('button', { name: /^云端API服务/ }));
  expect(await screen.findByText(/云端这一屏还空着/)).toBeTruthy();
  // 那颗按钮整颗撤了（2026-11-04 苏醒圈的第二个框）：API 这屏既不给「加载本地工作流 JSON」，
  // 也不给「设置 RunningHub 的 API Key」——Key 在设置 → 模型API配置里填，那句话就写在空态里。
  expect(screen.queryByRole('menuitem', { name: /加载本地工作流 JSON/ })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: /API Key/ })).toBeNull();
});

it('两屏的名字报的是里面装的东西：本地工作流 / 云端API服务', async () => {
  routes({
    ...baseRoutes(), '/api/clone/cloud/status': cloudOn(),
    '/api/clone/templates': { items: [TPL, CLOUD_IMG] },
  });
  const screen = await ready();
  await fireEvent.click(screen.getByRole('button', { name: '工作流' }));
  const tabs = screen.container.querySelectorAll('.cm-pop-tab');
  expect(tabs.length).toBe(2);
  expect(tabs[0].textContent?.trim()).toBe('本地工作流');
  // 云端那颗后面还挂着条数，所以只看开头
  expect((tabs[1].textContent ?? '').trim().startsWith('云端API服务')).toBe(true);
  // 旧名「切换工作流」是句动词，读不出这一屏装的是本机的还是云端的，不许以任何形式留着
  expect(screen.container.textContent ?? '').not.toContain('切换工作流');
});

it('音频卡点开一条只吃图的云端 API：不把音频硬塞进「图1」，并说清为什么没放', async () => {
  routes({ ...baseRoutes(), '/api/clone/cloud/status': cloudOn(), '/api/clone/templates': { items: [CLOUD_IMG] } });
  const screen = await ready({ image: AUDIO_CARD });
  expect(screen.container.querySelector('.cm-composer')!.getAttribute('title')).toContain('不吃音频参考');
  // 没放进去 = 那一格根本没有素材，不该出现「替换图1」
  expect(screen.queryByRole('button', { name: '替换图1' })).toBeNull();
});

it('云端跑挂了但产物还取得回来：给一颗「取回结果」，点它只重查任务、不重新生成', async () => {
  routes({
    ...baseRoutes(),
    '/api/clone/cloud/status': cloudOn(),
    '/api/clone/generate': {
      active: true, job_id: 'j1', state: 'error', running: false, message: '生成失败',
      error: '云端那边等到超时了', engine: 'cloud', media_kind: 'image',
      recoverable: true, task_row_id: 77, task_id: 'task-77', image_ids: [], outputs: [],
    },
    '/api/clone/cloud/tasks/77/refetch': {
      task_id: 77, image_ids: [88], count: 1, cost_coins: 12,
      outputs: [{ id: 88, kind: 'image', filename: 'a.png', thumbnail_url: '/api/images/88/file?max=256' }],
    },
  });
  const screen = await ready();
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '把这套视觉搬过来' } });
  await fireEvent.click(screen.getByRole('button', { name: '生成' }));
  await fireEvent.click(await screen.findByRole('button', { name: '取回结果' }));
  await vi.waitFor(() => expect(screen.getByText('本次产出')).toBeTruthy());
  expect(http.mock.calls.some(([path]) => String(path) === '/api/clone/cloud/tasks/77/refetch')).toBe(true);
  // 取回绝不重新提交：那是在同一件事上扣第二次钱
  expect(http.mock.calls.filter(([path]) => String(path) === '/api/clone/generate')).toHaveLength(1);
});

it('云端这一条的价只报官方预估给的数，取不到就说没取到', async () => {
  routes({
    ...baseRoutes(), '/api/clone/cloud/status': cloudOn(),
    '/api/clone/templates': { items: [CLOUD_IMG] },
    '/api/clone/cloud/estimate': { coins: 12, mode: 'image' },
  });
  const screen = await ready();
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '出一张竖版' } });
  expect(screen.queryByText(/云端出一次预计/)).toBeNull();  // 问价在防抖里，不该抢跑
  await new Promise((resolve) => setTimeout(resolve, 560));
  expect((await screen.findByText(/云端出一次预计/)).textContent).toContain('12 RH币');
});

it('官方预估没回数时宁可不说价：只说没取到，不出现任何金额', async () => {
  routes({
    ...baseRoutes(), '/api/clone/cloud/status': cloudOn(),
    '/api/clone/templates': { items: [CLOUD_IMG] },
    '/api/clone/cloud/estimate': { coins: null, mode: 'image' },
  });
  const screen = await ready();
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '出一张竖版' } });
  await new Promise((resolve) => setTimeout(resolve, 560));
  const line = await screen.findByText(/价格没取到/);
  expect(line.textContent).not.toMatch(/RH币/);
});

it('本机工作流不问云端价：一次 /cloud/estimate 都不发', async () => {
  routes(baseRoutes());
  const screen = await ready();
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '本机这条不用问价' } });
  await new Promise((resolve) => setTimeout(resolve, 560));
  expect(http.mock.calls.some(([path]) => String(path) === '/api/clone/cloud/estimate')).toBe(false);
  expect(screen.queryByText(/云端出一次预计/)).toBeNull();
});


it('那一摞是后挂的压在前挂的上头，加载参考那颗压在全摞最上面', async () => {
  // 苏醒 2026-11-04：图片1 压在最底下，图片2 压住它，依次类推，「加载参考」那一格在最上面。
  // 叠放靠的是负 margin（摆放顺序一个字没动），压叠关系全在行内那道 --z 上，所以这里量的就是 --z。
  const ref = (id: number, name: string) => ({
    id, filename: name, path: `D:/${name}`, kind: 'image',
    original_url: `/api/images/${id}/file`, thumbnail_url: `/api/images/${id}/file`, width: 400, height: 900,
  });
  const three = {
    ...TPL, reference_count: 3,
    slots: [...TPL.slots,
      { kind: 'image', node: '564', input: 'image', label: '背景参考' },
      { kind: 'image', node: '565', input: 'image', label: '构图参考' }],
  };
  routes({
    ...baseRoutes(),
    '/api/clone/templates': { items: [three] },
    '/api/clone/sources/7': {
      references: [ref(40, '猫.png'), ref(471, '帽子.png'), ref(472, '尾巴.png')],
      template_id: 3, source_image_id: null, dropped: 0, origin: 'file',
    },
  });
  const screen = await ready();
  const stackEl = screen.container.querySelector('.cm-ref-stack') as HTMLElement;
  const cells = [...stackEl.querySelectorAll('.cm-ref-cell')] as HTMLElement[];
  expect(cells.map((el) => el.getAttribute('aria-label'))).toEqual(['图片1', '图片2', '图片3']);
  const zs = cells.map((el) => Number(el.style.getPropertyValue('--z')));
  expect(zs).toEqual([1, 2, 3]);      // 越靠后越大 → 后挂的那张压在前面那张上头，图片1 在最底下
  expect(Math.max(...zs)).toBe(3);    // 最后一格是下一个要动的地方，它露得最完整

  // 多族那一摞：末尾那颗不绑族的「+ 参考」比所有格子都高，它是全摞的最上面一张
  cleanup();
  routes({ ...videoRoutes(), '/api/clone/templates': { items: [H3] } });
  const mixed = await ready({ image: VIDEO_CARD });
  const anyAdd = mixed.container.querySelector('.cm-ref-add') as HTMLElement;
  const cellZs = [...mixed.container.querySelectorAll('.cm-ref-cell')]
    .map((el) => Number((el as HTMLElement).style.getPropertyValue('--z')));
  expect(Number(anyAdd.style.getPropertyValue('--z'))).toBeGreaterThan(Math.max(...cellZs));

  const css = readFileSync('src/components/CloneModal.svelte', 'utf8');
  // 那颗自己得吃 --z：不写的话它是 z-index:auto，正 z 的格子全压它上头
  expect(css).toMatch(/\.cm-tile\.cm-ref-add\s*\{[^}]*z-index:\s*var\(--z/);
  // 但整摞必须关在自己的层里（z-index:0）：格子是 1..n，卡底条与它上面的弹层只有 3——
  // 不关掉的话「+ 参考」那颗压在全摞最上面，正好糊在展开的菜单左半截上，菜单行首的字看不见（2026-11-04 实拍）
  expect(css).toMatch(/\.cm-ref-stack\s*\{[\s\S]*?position:\s*relative;\s*z-index:\s*0;/);
  expect(css).toMatch(/\.cm-dock\s*\{[\s\S]*?position:\s*sticky;[^}]*z-index:\s*3;/);   // 卡底条那层在摞之上
  // 压在最上面的那一格不能是半透的，否则下面那张照片会透上来，空位看着像已经放了东西
  const tiles = [...css.matchAll(/\.cm-tile-add\s*\{[^}]*\}/g)].map((m) => m[0]);
  expect(tiles.some((r) => /background:\s*#1a1a1e/.test(r))).toBe(true);
  expect(tiles[tiles.length - 1]).not.toMatch(/background:/);
});
