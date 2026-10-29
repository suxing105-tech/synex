import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import CloneTemplates from '../components/CloneTemplates.svelte';

const http = vi.fn();
// 同 clone-modal.test.ts：vi.mock 工厂被提升，取不到本文件的 http，所以路由挂在 globalThis 上。
vi.mock('../lib/api', () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  comfyuiApi: { status: vi.fn(async () => ({ running: true, enabled: true, url: '' })) },
  http: (path: string, init?: RequestInit) => (globalThis as any).__http(path, init),
}));
(globalThis as any).__http = http;

const TPL = {
  id: 1, name: '旧的同款', is_active: false, default_prompt: '', created_at: '', updated_at: '',
  node_count: 55, prompt_count: 2, reference_count: 1, control_count: 1,
  slots: [
    { kind: 'prompt', node: '582', input: 'prompt', label: '完整提示词' },
    { kind: 'image', node: '543', input: 'image', label: '人物参考' },
    { kind: 'select', node: '13', input: 'aspect_ratio', label: '比例', options: ['1:1'], value: '1:1' },
  ],
};

const PROMPT_SLOT = { kind: 'prompt', node: '582', input: 'prompt', label: '完整提示词' };
const IMAGE_SLOT = { kind: 'image', node: '543', input: 'image', label: '人物参考' };
const RATIO_SLOT = { kind: 'select', node: '13', input: 'aspect_ratio', label: '比例', options: ['1:1', '16:9'], value: '1:1' };
const STEPS_SLOT = { kind: 'number', node: '9', input: 'steps', label: '步数', value: 20, min: 1, max: 100, step: 1 };

function routes(map: Record<string, unknown>) {
  http.mockImplementation(async (path: string, init?: RequestInit) => {
    // 前缀匹配要挑最长的那条，否则 /api/clone/templates 会把 /api/clone/templates/1 抢走
    const key = Object.keys(map).filter((k) => path.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`未预演的接口：${path}`);
    const value = map[key];
    if (typeof value === 'function') return (value as (i?: RequestInit) => unknown)(init);
    return value;
  });
}

const inspectRoutes = () => ({
  '/api/clone/templates/inspect': {
    slots: [PROMPT_SLOT, IMAGE_SLOT, RATIO_SLOT],
    candidates: [STEPS_SLOT],
    nodes: [],
    default_prompt: '工作流里那句',
    warnings: ['节点 540 是一张没人用的孤立文本'],
    suggested_name: 'Qwen-image-2.1多图编辑',
  },
  '/api/clone/templates': { items: [TPL] },
});

async function importJson(screen: any) {
  await fireEvent.input(screen.getByLabelText('工作流 JSON'), { target: { value: '{"582":{"class_type":"X"}}' } });
  await fireEvent.click(screen.getByRole('button', { name: '解析工作流' }));
  expect(await screen.findByText('确认槽位')).toBeTruthy();
}

afterEach(() => { cleanup(); http.mockReset(); });

it('模板列表显示当前模板与槽位统计，设为当前只 PATCH is_active', async () => {
  routes({
    '/api/clone/templates': { items: [TPL, { ...TPL, id: 2, name: '当前这张', is_active: true }] },
    '/api/clone/templates/1': (init?: RequestInit) => ({ ...TPL, is_active: true, ...JSON.parse(String(init?.body)) }),
  });
  const screen = render(CloneTemplates, {});
  expect(await screen.findByText('旧的同款')).toBeTruthy();
  expect(screen.getByText('旧的同款').closest('li')?.textContent).toContain('1 个参考位');
  await fireEvent.click(screen.getByRole('button', { name: '设为当前' }));
  await tick();
  const patch = http.mock.calls.find(([path, init]) => path === '/api/clone/templates/1' && (init as RequestInit)?.method === 'PATCH');
  expect(JSON.parse(String((patch?.[1] as RequestInit)?.body))).toEqual({ is_active: true });
});

it('导入先给槽位确认：检测到的默认勾上，步数这类候选默认不进弹窗', async () => {
  routes(inspectRoutes());
  const screen = render(CloneTemplates, {});
  await screen.findByText('旧的同款');
  await importJson(screen);
  expect(screen.getByRole('status').textContent).toContain('孤立文本');
  const box = (label: string) => screen.getByLabelText(new RegExp(label)).closest('label')!.querySelector('input') as HTMLInputElement;
  expect(box('完整提示词').checked).toBe(true);
  expect(box('人物参考').checked).toBe(true);
  expect(box('比例').checked).toBe(true);
  expect(box('步数').checked).toBe(false);
});

it('保存模板只交勾上的槽位，名字取文件名', async () => {
  routes({ ...inspectRoutes(), '/api/clone/templates': { items: [TPL] } });
  let created: Record<string, unknown> | null = null;
  http.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/clone/templates' && (init as RequestInit)?.method === 'POST') {
      created = JSON.parse(String(init?.body));
      return { ...TPL, name: 'Qwen-image-2.1多图编辑' };
    }
    if (path === '/api/clone/templates/inspect') return inspectRoutes()['/api/clone/templates/inspect'];
    if (path === '/api/clone/templates') return { items: [TPL] };
    throw new Error(`未预演的接口：${path}`);
  });
  const screen = render(CloneTemplates, {});
  await screen.findByText('旧的同款');
  await importJson(screen);
  // 勾上「步数」：用户想调步数就该能加进弹窗
  const steps = screen.getByLabelText(/步数/).closest('label')!.querySelector('input') as HTMLInputElement;
  await fireEvent.click(steps);
  await fireEvent.click(screen.getByRole('button', { name: '保存模板' }));
  await tick();
  await tick();
  const body = created as unknown as Record<string, any> | null;
  expect(body?.name).toBe('Qwen-image-2.1多图编辑');
  expect(body?.workflow).toEqual({ '582': { class_type: 'X' } });
  expect(body?.slots.map((s: { node: string }) => s.node)).toEqual(['582', '543', '13', '9']);
});

it('导入 UI 格式工作流时把后端的中文提示原样贴出来，不让用户猜', async () => {
  routes({
    ...inspectRoutes(),
    '/api/clone/templates/inspect': () => { throw Object.assign(new Error('422'), { detail: '这是 ComfyUI 的界面格式，请改用「Export (API)」导出 API 格式后再导入。' }); },
  });
  const screen = render(CloneTemplates, {});
  await screen.findByText('旧的同款');
  await fireEvent.input(screen.getByLabelText('工作流 JSON'), { target: { value: '{"nodes":[]}' } });
  await fireEvent.click(screen.getByRole('button', { name: '解析工作流' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Export (API)');
  expect(screen.queryByText('确认槽位')).toBeNull();
});

it('一个提示词槽都不勾就不许存，省得导入一个改不了文案的模板', async () => {
  routes(inspectRoutes());
  const screen = render(CloneTemplates, {});
  await screen.findByText('旧的同款');
  await importJson(screen);
  for (const label of ['完整提示词']) {
    const box = screen.getByLabelText(new RegExp(label)).closest('label')!.querySelector('input') as HTMLInputElement;
    await fireEvent.click(box);
  }
  await fireEvent.click(screen.getByRole('button', { name: '保存模板' }));
  await tick();
  expect((await screen.findByRole('alert')).textContent).toContain('提示词');
});

it('删除要二次确认，确认才发 DELETE', async () => {
  routes({ '/api/clone/templates': { items: [TPL] } });
  const screen = render(CloneTemplates, {});
  await screen.findByText('旧的同款');
  await fireEvent.click(screen.getByRole('button', { name: '删除' }));
  expect(http.mock.calls.filter(([path]) => path === '/api/clone/templates/1')).toHaveLength(0);
  await fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await tick();
  const del = http.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'DELETE');
  expect(del?.[0]).toBe('/api/clone/templates/1');
});

it('从设置页导入也要把多图参考的扩位信息带回去，不然弹窗只剩一个参考位', async () => {
  const GROW = { kind: 'image', node: '543', input: 'image', label: '人物参考', grow: { node: '582', group: 'images', names: ['image_2'] } };
  let created: { slots: { kind: string; grow?: unknown }[] } | null = null;
  http.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/clone/templates' && (init as RequestInit)?.method === 'POST') {
      created = JSON.parse(String(init?.body));
      return { ...TPL };
    }
    if (path === '/api/clone/templates/inspect') {
      return { ...inspectRoutes()['/api/clone/templates/inspect'], slots: [PROMPT_SLOT, GROW, RATIO_SLOT] };
    }
    if (path === '/api/clone/templates') return { items: [TPL] };
    throw new Error(`未预演的接口：${path}`);
  });
  const screen = render(CloneTemplates, {});
  await screen.findByText('旧的同款');
  await importJson(screen);
  await fireEvent.click(screen.getByRole('button', { name: '保存模板' }));
  await tick();
  await tick();
  const image = (created as unknown as { slots: Record<string, unknown>[] }).slots.find((s) => s.kind === 'image');
  expect(image?.grow).toEqual({ node: '582', group: 'images', names: ['image_2'] });
});

it('「重新检测槽位」补回导入时丢掉的参数，并把结果说给用户', async () => {
  // 导入那一刻 ComfyUI 没开 → 比例/分辨率没检测到；现在它开着，点一下就该补回来
  const offline = { ...TPL, control_count: 0, slots: TPL.slots.filter((s: any) => s.kind !== 'select') };
  const detected = { ...offline, control_count: 1, slots: TPL.slots };
  let current: unknown = offline;
  routes({
    '/api/clone/templates/1/redetect': () => { current = detected; return detected; },
    '/api/clone/templates': () => ({ items: [current] }),
  });
  const screen = render(CloneTemplates, {});
  await screen.findByText('旧的同款');
  expect(screen.getByText('旧的同款').closest('li')?.textContent).toContain('0 个弹窗控件');
  await fireEvent.click(screen.getByRole('button', { name: '重新检测槽位' }));
  expect(await screen.findByText(/已重新检测「旧的同款」：1 个弹窗控件/)).toBeTruthy();
  const call = http.mock.calls.find(([path]) => path === '/api/clone/templates/1/redetect');
  expect((call?.[1] as RequestInit)?.method).toBe('POST');
  expect(screen.getByText('旧的同款').closest('li')?.textContent).toContain('1 个弹窗控件');
});

it('ComfyUI 还没开时重新检测失败，只给一句中文，不动模板', async () => {
  routes({
    '/api/clone/templates/1/redetect': () => {
      throw { detail: '还是没能读到 ComfyUI 的节点信息（ComfyUI 没在 http://127.0.0.1:8188 运行），把它打开以后再点一次。' };
    },
    '/api/clone/templates': { items: [TPL] },
  });
  const screen = render(CloneTemplates, {});
  await screen.findByText('旧的同款');
  await fireEvent.click(screen.getByRole('button', { name: '重新检测槽位' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('把它打开以后再点一次');
  expect(screen.queryByText(/已重新检测/)).toBeNull();
});

it('工作流能吃多张图时，模板列表把「最多吃几张」说出来', async () => {
  const multi = {
    ...TPL,
    slots: TPL.slots.map((s: any) => (s.kind === 'image' ? { ...s, grow: { node: '582', group: 'images', names: ['image_2', 'image_3'] } } : s)),
  };
  routes({ '/api/clone/templates': { items: [multi] } });
  const screen = render(CloneTemplates, {});
  await screen.findByText('旧的同款');
  expect(screen.getByText('旧的同款').closest('li')?.textContent).toContain('最多吃 3 张');
});
