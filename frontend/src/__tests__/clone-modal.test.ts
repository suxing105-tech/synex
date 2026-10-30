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
  await fireEvent.click(screen.getByRole('button', { name: '填入工作流内置提示词' }));
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

it('Esc 只收起参数面板，不会把整个一键同款弹窗关掉', async () => {
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
  expect(screen.getByText(/没找到这张图当初用的参考图/)).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: '替换图片1' }));
  await fireEvent.click(await screen.findByRole('button', { name: 'ref.png' }));
  await vi.waitFor(() => expect(screen.getByTitle(/^人物参考｜ref\.png$/)).toBeTruthy());
  expect(screen.queryByText(/没找到这张图当初用的参考图/)).toBeNull();
});

it('普通导入的图片不解释来源：没带 workflow 就不该冒出一句「当初没记下参考图」', async () => {
  routes(baseRoutes());
  const screen = await ready();
  expect(screen.queryByText(/没找到这张图当初用的参考图/)).toBeNull();
  expect(screen.queryByText(/已经不在图库里了/)).toBeNull();
});

it('还没有模板时不是一句空提示，而是直接把人带去设置导入', async () => {
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [] } });
  const onOpenSettings = vi.fn();
  const screen = render(CloneModal, { open: true, image: SOURCE, onClose: () => {}, onOpenSettings });
  await screen.findByText(/还没有同款工作流/);
  await fireEvent.click(screen.getByRole('button', { name: '去设置里看说明' }));
  expect(onOpenSettings).toHaveBeenCalledWith('一键同款');
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
  await fireEvent.click(screen.getByRole('button', { name: '同款工作流' }));
  await screen.findByRole('menu', { name: '同款工作流' });
  await fireEvent.click(screen.getByRole('menuitemradio', { name: /多图编辑 16 位/ }));
  await vi.waitFor(() => expect(screen.getByRole('heading', { name: '多图编辑 16 位' })).toBeTruthy());
  // 换工作流 = 换一套槽位：回到「被点的那张图填第一位 + 两个空续位」，菜单也收起来
  expect(screen.getByRole('button', { name: '替换图片1' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '添加图片2参考图' })).toBeTruthy();
  expect(screen.queryByRole('menu', { name: '同款工作流' })).toBeNull();
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
  await fireEvent.click(screen.getByRole('button', { name: '同款工作流' }));
  const input = (await screen.findByLabelText('选择本地工作流 JSON')) as HTMLInputElement;
  const file = new File([JSON.stringify(WF)], '我的多图.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => JSON.stringify(WF) });
  await fireEvent.change(input, { target: { files: [file] } });
  await vi.waitFor(() => expect(screen.getByRole('heading', { name: '新的工作流' })).toBeTruthy());
  expect(inspected[0].workflow).toEqual(WF);
  // 底部那颗按钮也跟着换名，用户随时知道自己在用哪一份
  expect(screen.getByRole('button', { name: '同款工作流' }).textContent).toContain('新的工作流');
});

it('选了个不是 JSON 的文件，说清楚原因而不是默默什么都不发生', async () => {
  routes(baseRoutes());
  const screen = await ready();
  await fireEvent.click(screen.getByRole('button', { name: '同款工作流' }));
  const input = (await screen.findByLabelText('选择本地工作流 JSON')) as HTMLInputElement;
  const file = new File(['{ 不是 json'], '坏了.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => '{ 不是 json' });
  await fireEvent.change(input, { target: { files: [file] } });
  expect(await screen.findByText(/不是合法的 JSON/)).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Qwen 多图编辑' })).toBeTruthy();
});

it('参考条是一条横向素材带：多图工作流铺 16 格也不该把提示词框顶出弹窗', async () => {
  const source = readFileSync("src/components/CloneModal.svelte", "utf8");
  const block = source.slice(source.indexOf(".cm-ref-row"), source.indexOf(".cm-tile {"));
  expect(block).toContain("flex-wrap: nowrap");
  expect(block).toContain("overflow-x: auto");
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
  const pill = screen.getByRole('button', { name: '同款工作流' }) as HTMLButtonElement;
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
  // 弹层贴着胶囊右边往左长：左对齐的弹层在窄窗口会被顶出弹窗
  expect(css).toMatch(/\.cm-pop-wf\s*\{[^}]*left:\s*auto/);
  expect(css).toMatch(/\.cm-pop-wf\s*\{[^}]*right:\s*0/);
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
  await fireEvent.click(screen.getByRole("button", { name: "同款工作流" }));
  await screen.findByRole("menu", { name: "同款工作流" });
  expect(screen.getByRole("button", { name: "删除工作流 Qwen 多图编辑" })).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "删除工作流 单图编辑" }));
  await vi.waitFor(() => expect(deleteCalls()).toEqual(["/api/clone/templates/2"]));
  // 确认态整条链路没了：既不出现「确认删除」，也没有「取消」可点
  expect(screen.queryByRole("button", { name: "确认删除" })).toBeNull();
  expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  // 删的是剩下那条，当前这条不动
  expect(screen.getByRole("menuitemradio", { name: /Qwen 多图编辑/ }).getAttribute("aria-checked")).toBe("true");
  // 弹层不收起：清工作流是连着清好几条的事，收起等于逼人多点一次
  expect(screen.getByRole("menu", { name: "同款工作流" })).toBeTruthy();
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
  await fireEvent.click(screen.getByRole("button", { name: "同款工作流" }));
  await fireEvent.click(await screen.findByRole("button", { name: "删除工作流 Qwen 多图编辑" }));
  await vi.waitFor(() => expect(screen.getByRole("heading", { name: "单图编辑" })).toBeTruthy());
  expect(deleteCalls()).toEqual(["/api/clone/templates/1"]);
  // 标题已经换成剩下那条，弹层却没关，下一条的 X 就地可用
  expect(screen.getByRole("menu", { name: "同款工作流" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "删除工作流 Qwen 多图编辑" })).toBeNull();
  // 换模板 = 换一套槽位：参考位按新模板重摆，被点的那张图回到图片1
  expect((screen.getByRole("button", { name: "替换图片1" }) as HTMLButtonElement).disabled).toBe(false);
});

it("最后一条删光后弹层收起，回到「还没有同款工作流」空态", async () => {
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
  await fireEvent.click(screen.getByRole("button", { name: "同款工作流" }));
  await fireEvent.click(await screen.findByRole("button", { name: "删除工作流 Qwen 多图编辑" }));
  await vi.waitFor(() => expect(screen.getByText(/还没有同款工作流/)).toBeTruthy());
  // 空态里那颗 pill 已经不在页面上，弹层必须跟着收干净，别留个开着的 wfOpen
  expect(screen.queryByRole("menu", { name: "同款工作流" })).toBeNull();
  expect(screen.queryByRole("button", { name: "同款工作流" })).toBeNull();
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
  await fireEvent.click(screen.getByRole("button", { name: "同款工作流" }));
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
  const pill = screen.getByRole("button", { name: "同款工作流" });
  await fireEvent.click(pill);
  await fireEvent.click(pill);
  await fireEvent.click(pill);
  await screen.findByRole("menu", { name: "同款工作流" });
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
  await fireEvent.click(screen.getByRole("button", { name: "同款工作流" }));
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

/* ── 一键同款生成的图：参考位摆的是当初那几张参考图 ───────────────────── */

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
  expect(await screen.findByText(/还用了 1 张参考图/)).toBeTruthy();
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
  const pill = screen.getByRole('button', { name: '同款工作流' });
  expect(pill.textContent).toContain('视频创作者-1024 x 576_参考生视频_');
  expect(pill.textContent).not.toMatch(/\.json/i);
  await fireEvent.click(pill);
  await screen.findByRole('menu', { name: '同款工作流' });
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
  await fireEvent.click(screen.getByRole('button', { name: '同款工作流' }));
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
  const pill = screen.getByRole('button', { name: '同款工作流' }) as HTMLButtonElement;
  // 胶囊宽度是定死的（.cm-fill），名字长在这儿只能截断——所以全名不许只活在胶囊里：
  // 顶部标题（17px）报当前用的是哪一份，悬浮提示给完整名字（含「生成中」那句前缀）。
  expect(pill.getAttribute('title')).toBe('Qwen-image-2.1多图编辑');
  expect(document.querySelector('.cm-title')?.textContent).toBe('Qwen-image-2.1多图编辑');
});

/* ── 视频一键同款（H3 参考生视频）────────────────────────────────────── */

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

it('三族参考合成一行：已填的按 图片→视频→音频 排，末尾只有一颗「+ 参考」', async () => {
  routes({ ...videoRoutes(), '/api/clone/templates': { items: [H3] } });
  const screen = await ready({ image: VIDEO_CARD });
  // 一行，不是一族一行：参考就是一个列表，加素材不必先判断「这算哪一块」
  expect(document.querySelectorAll('.cm-ref-row')).toHaveLength(1);
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

it('图片工作流仍只有一行参考位，分组名一个字没改', async () => {
  routes(baseRoutes());
  await ready();
  expect(document.querySelectorAll('.cm-ref-row')).toHaveLength(1);
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

it('工作流清单不分家：图片与视频的工作流一起列，各带一个标识', async () => {
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [TPL, H3] } });
  const screen = await ready();
  await fireEvent.click(screen.getByRole('button', { name: '同款工作流' }));
  await screen.findByRole('menu', { name: '同款工作流' });
  expect([...document.querySelectorAll('.cm-wf-kind')].map((el) => el.textContent)).toEqual(['图片', '视频']);
  // 徽标钉在名字前面：挂在名字后面时它会随名字长短左右漂移，两行的名字对不齐
  const rows = [...document.querySelectorAll('.cm-wf-row > .cm-wf')];
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    const kids = [...row.children];
    expect(kids[0]?.className).toContain('cm-wf-kind');
    expect(kids[1]?.className).toContain('cm-wf-name');
  }
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

it('视频卡左侧是能播的播放器：一键同款要抄的是片子里的节奏，不是一张首帧', async () => {
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

/* ── 音频一键同款（Qwen3 音色克隆）────────────────────────────────────── */

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

it('音频工作流的参考行只有一格「音频1」，被点的那段自己站在里面', async () => {
  routes({ ...audioRoutes(), '/api/clone/templates': { items: [TTS] } });
  const screen = await ready({ image: AUDIO });
  expect(document.querySelectorAll('.cm-ref-row')).toHaveLength(1);
  expect(document.querySelector('[aria-label="参考音频（参考音色克隆）"]')).toBeTruthy();
  expect(screen.getByTitle(/｜bgm\.mp3$/)).toBeTruthy();
  // 量词与称呼都跟着族走，不冒出「这张图」
  expect(screen.queryByText(/这张图/)).toBeNull();
});

it('工作流菜单三族并列：徽标是图片/视频/音频，选哪条就换哪条', async () => {
  routes({ ...audioRoutes(), '/api/clone/templates': { items: [{ ...TPL, is_active: true }, { ...TTS, is_active: true }] } });
  const screen = await ready({ image: AUDIO });
  await fireEvent.click(screen.getByRole('button', { name: '同款工作流' }));
  const options = await screen.findAllByRole('menuitemradio');
  // 一张清单不分家，但族徽必须一眼分得清：图片卡挂上出声音的那条，等半天才知道选错
  expect(options.map((el) => el.querySelector('.cm-wf-kind')?.textContent)).toEqual(['图片', '音频']);
  expect(options[1].querySelector('.cm-wf-kind')?.classList.contains('cm-wf-kind-audio')).toBe(true);
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
  expect(screen.getByText(/音色会明显跑偏/)).toBeTruthy();
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
  const rule = /\.cm-textarea-sub\s*\{[^}]*\}/.exec(source)?.[0] ?? '';
  expect(rule).toContain('color: #e4e4e7');
  expect(rule).toContain('background: rgba(0, 0, 0, 0.35)');
  expect(rule).not.toMatch(/color:\s*transparent/);
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
  expect(screen.getByText('已带上当初生成时用的提示词')).toBeTruthy();
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
  await fireEvent.click(screen.getByRole('button', { name: '同款工作流' }));
  await screen.findByRole('menu', { name: '同款工作流' });
  await fireEvent.click(screen.getByRole('menuitemradio', { name: /图片编辑/ }));
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
  expect(screen.getByText('这一种不用参考音频：想要什么样的声音写在下面的文字格与参数里。')).toBeTruthy();
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
  await fireEvent.click(screen.getByRole('button', { name: '同款工作流' }));
  await screen.findByRole('menu', { name: '同款工作流' });
  const rows = [...document.querySelectorAll('.cm-wf-row > .cm-wf')];
  // 图片 / 视频 各一行 + 音频一行，不是五行的流水账
  expect(rows.map((r) => r.querySelector('.cm-wf-name')?.textContent)).toEqual(['Qwen 多图编辑', '闪寻音频']);
  expect(rows.map((r) => r.querySelector('.cm-wf-kind')?.textContent)).toEqual(['图片', '音频']);
  // 正在用参考音色 ⇒ 这一行就是「当前」
  expect(rows[1].querySelector('.cm-wf-tag')?.textContent).toBe('当前');
  expect(rows[1].getAttribute('aria-checked')).toBe('true');
  // 折叠行不给删除按钮（背后是三条工作流，删哪条不该由这颗 X 决定），图片那一行的 X 照旧在
  const dels = [...document.querySelectorAll('.cm-wf-row > .cm-wf-del')];
  expect(dels).toHaveLength(1);
  expect(dels[0].getAttribute('aria-label')).toBe('删除工作流 Qwen 多图编辑');
  expect(rows[1].getAttribute('title')).toContain('三种出声方式在弹窗顶上切换');
  expect(rows[1].getAttribute('title')).toContain('参考音色 / 音色描述 / 指定音色');
});

it("已经在出声音时再点「闪寻音频」：只收起弹层，不把人从当前那种模式踢回默认", async () => {
  routes(modeRoutes());
  const screen = await ready({ image: AUDIO_CARD });
  const group = await screen.findByRole('radiogroup', { name: '音频模式' });
  // 清单里 is_active 的是 A_CLONE，音频族顺序是 参考音色 / 指定音色 / 音色描述
  await fireEvent.click(group.querySelectorAll('button')[1]);
  await tick();
  expect(await screen.findByLabelText('音色描述')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: '同款工作流' }));
  const rows = await screen.findAllByRole('menuitemradio');
  await fireEvent.click(rows[rows.length - 1]);
  await tick();
  // 还是那条「音色描述」：点族名不是「回到第一种」
  expect(screen.queryByRole('menu', { name: '同款工作流' })).toBeNull();
  expect(await screen.findByLabelText('音色描述')).toBeTruthy();
  const again = await screen.findByRole('radiogroup', { name: '音频模式' });
  expect([...again.querySelectorAll('button')].map((b) => b.getAttribute('aria-checked'))).toEqual([
    'false', 'true', 'false',
  ]);
});

it("从图片卡点「闪寻音频」：换到音频族库里标的那条，不是随便挑一条", async () => {
  routes(modeRoutes());
  const screen = await ready();
  await fireEvent.click(screen.getByRole('button', { name: '同款工作流' }));
  const rows = await screen.findAllByRole('menuitemradio');
  await fireEvent.click(rows[rows.length - 1]);
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
  await fireEvent.click(screen.getByRole('button', { name: '同款工作流' }));
  const rows = await screen.findAllByRole('menuitemradio');
  expect(rows.map((r) => r.querySelector('.cm-wf-name')?.textContent)).toEqual(['Qwen 多图编辑', '闪寻参考音色']);
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
    screen.getByRole('button', { name: '同款工作流' }).textContent).toContain('Qwen 多图编辑'),
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
  const pill = () => screen.getByRole('button', { name: '同款工作流' });
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
  const pill = screen.getByRole('button', { name: '同款工作流' });
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
