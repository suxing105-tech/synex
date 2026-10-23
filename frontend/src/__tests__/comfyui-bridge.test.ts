import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';
const bridge = readFileSync('src-tauri/src/comfyui_bridge.js', 'utf8');
const ORIGIN = 'http://localhost:8188';

function fakeStorage(init: Record<string, string> = {}) {
  const bag: Record<string, string> = { ...init };
  const api: any = new Proxy(bag, {
    get: (target, key) => {
      if (key === 'getItem') return (name: string) => (name in target ? target[name] : null);
      if (key === 'setItem') return (name: string, value: string) => { target[name] = String(value); };
      if (key === 'removeItem') return (name: string) => { delete target[name]; };
      return (target as any)[key];
    },
    ownKeys: (target) => Object.keys(target),
    getOwnPropertyDescriptor: (target, key) => ({ configurable: true, enumerable: true, value: (target as any)[key] }),
  });
  return { bag, api };
}

/** 起一份注入脚本；setTimeout 全走微任务，flush 够多次就能跑到收尾 */
function boot(env: Record<string, unknown>) {
  const window: any = env.window || {};
  const context = vm.createContext({
    URL, encodeURIComponent, decodeURIComponent, Promise, console,
    setTimeout: (cb: () => void) => queueMicrotask(cb), queueMicrotask, ...env, window,
  });
  vm.runInContext(bridge, context);
  const flush = async (rounds = 1200) => { for (let i = 0; i < rounds; i++) await Promise.resolve(); };
  return { window, flush };
}

async function run(env: Record<string, unknown>, flushes = 1200) {
  const started = boot(env);
  await started.flush(flushes);
  return started;
}

const tempStore = (open: unknown[] = []) => {
  const store: any = {
    openWorkflows: open,
    activeWorkflow: open.length ? open[0] : null,
    createNewTemporary: vi.fn((name: string) => {
      const tab = { filename: name, path: `workflows/${name}`, isTemporary: true };
      store.openWorkflows.push(tab);
      store.activeWorkflow = tab;
      return tab;
    }),
    openWorkflow: vi.fn(async (tab: any) => { store.activeWorkflow = tab; }),
  };
  return store;
};

it('桥接等画布就绪，把图装进以媒体名命名的标签再回报完成', async () => {
  const loadGraphData = vi.fn().mockResolvedValue({});
  const app = { graph: { _nodes: [{}, {}] }, canvas: {}, extensionManager: { workflow: { activeWorkflow: { filename: '我的工作流' } } }, loadGraphData };
  const location: any = { origin: ORIGIN, href: '' };
  await run({ window: { comfyAPI: { app: { app } } }, location, document: { readyState: 'complete' }, request: { id: 3, origin: ORIGIN, base: `${ORIGIN}/`, name: '人物', workflow: { nodes: [{}, {}] } } });
  expect(loadGraphData).toHaveBeenCalledTimes(1);
  expect(loadGraphData.mock.calls[0][0]).toEqual({ nodes: [{}, {}] });
  // 标签名 = 媒体名，用户在 ComfyUI 的标签条上能认出这是哪张图
  expect(loadGraphData.mock.calls[0][3]).toBe('人物.json');
  // 回执必须带请求 id，复用窗口时桌面壳才知道该醒哪一次
  expect(location.href).toBe('suxing-workflow://loaded?id=3');
});

it('标签名会清成合法文件名，同名标签复用而不是越开越多', async () => {
  const existing = { filename: '人物', path: 'workflows/人物.json', isTemporary: true };
  const store = tempStore([existing]);
  const loadGraphData = vi.fn().mockResolvedValue({});
  const app = { graph: { _nodes: [{}, {}] }, canvas: {}, extensionManager: { workflow: store }, loadGraphData };
  const location: any = { origin: ORIGIN, href: '' };
  await run({
    window: { comfyAPI: { app: { app } } }, location, document: { readyState: 'complete' },
    localStorage: fakeStorage().api, sessionStorage: fakeStorage().api,
    request: { id: 1, origin: ORIGIN, base: `${ORIGIN}/`, name: '人物.png', workflow: { nodes: [{}, {}] } },
  });
  expect(store.createNewTemporary).not.toHaveBeenCalled();
  expect(loadGraphData.mock.calls[0][3]).toBe(existing);
  // 已经是当前标签，不用重复 open
  expect(store.openWorkflow).not.toHaveBeenCalled();
  expect(location.href).toBe('suxing-workflow://loaded?id=1');
});

it('桌面壳在同一个窗口里连续要求两个工作流：各自开标签、各自回执', async () => {
  const store = tempStore();
  const loadGraphData = vi.fn().mockResolvedValue({});
  const app = { graph: { _nodes: [{}] }, canvas: {}, extensionManager: { workflow: store }, loadGraphData };
  const location: any = { origin: ORIGIN, href: '' };
  const { window, flush } = boot({
    window: { comfyAPI: { app: { app } } }, location, document: { readyState: 'complete' },
    localStorage: fakeStorage().api, sessionStorage: fakeStorage().api,
    request: { id: 1, origin: ORIGIN, base: `${ORIGIN}/`, name: '第一个', workflow: { nodes: [{}] } },
  });
  await flush();
  expect(store.createNewTemporary).toHaveBeenLastCalledWith('第一个.json');
  expect(location.href).toBe('suxing-workflow://loaded?id=1');

  // 复用同一个窗口：第二个工作流只是再调一次 load，不新建窗口、不重新加载页面
  window.__seekxWorkflow.load({ id: 2, name: '第二个/特写', workflow: { nodes: [{}] } });
  await flush();
  expect(loadGraphData).toHaveBeenCalledTimes(2);
  expect(location.href).toBe('suxing-workflow://loaded?id=2');
  expect(store.openWorkflows.map((tab: any) => tab.filename)).toEqual(['第一个.json', '第二个 特写.json']);
});

it('媒体名里的非法字符会被清成合法标签名，空名退回 ComfyUI', async () => {
  const store = tempStore();
  const loadGraphData = vi.fn().mockResolvedValue({});
  const app = { graph: { _nodes: [{}] }, canvas: {}, extensionManager: { workflow: store }, loadGraphData };
  const location: any = { origin: ORIGIN, href: '' };
  await run({
    window: { comfyAPI: { app: { app } } }, location, document: { readyState: 'complete' },
    localStorage: fakeStorage().api, sessionStorage: fakeStorage().api,
    request: { id: 1, origin: ORIGIN, base: `${ORIGIN}/`, name: 'a/b:c*?d', workflow: { nodes: [{}] } },
  }, 2400);
  expect(store.createNewTemporary).toHaveBeenLastCalledWith('a b c d.json');

  const second = tempStore();
  const app2 = { graph: { _nodes: [{}] }, canvas: {}, extensionManager: { workflow: second }, loadGraphData: vi.fn().mockResolvedValue({}) };
  await run({
    window: { comfyAPI: { app: { app: app2 } } }, location: { origin: ORIGIN, href: '' }, document: { readyState: 'complete' },
    localStorage: fakeStorage().api, sessionStorage: fakeStorage().api,
    request: { id: 2, origin: ORIGIN, base: `${ORIGIN}/`, name: '   ', workflow: { nodes: [{}] } },
  }, 4000);
  expect(second.createNewTemporary).toHaveBeenLastCalledWith('ComfyUI.json');
});

it('ComfyUI 一个标签都没恢复出来时，自己开标签并清掉坏掉的恢复记录', async () => {
  const tab = { filename: '角色资产.json', path: 'workflows/角色资产.json', isTemporary: true };
  const store = { openWorkflows: [], activeWorkflow: null, createNewTemporary: vi.fn(() => tab), openWorkflow: vi.fn().mockResolvedValue({}) };
  const loadGraphData = vi.fn().mockResolvedValue({});
  const app = { graph: { _nodes: [{}, {}] }, canvas: {}, extensionManager: { workflow: store }, loadGraphData };
  const local = fakeStorage({
    'Comfy.Workflow.LastOpenPaths:personal': '{"workspaceId":"personal","paths":["workflows/角色资产_00061_.json","workflows/二采_00012_.json"],"activeIndex":1}',
    'Comfy.Workflow.LastActivePath:personal': '{"workspaceId":"personal","path":"workflows/二采_00012_.json"}',
  });
  const location: any = { origin: ORIGIN, href: '' };
  await run({
    window: { comfyAPI: { app: { app } } }, location, document: { readyState: 'complete' },
    localStorage: local.api, sessionStorage: fakeStorage().api,
    request: { id: 4, origin: ORIGIN, base: `${ORIGIN}/`, name: '角色资产', workflow: { nodes: [{}, {}] } },
  }, 2400);
  // 用户看到的就是这一步：没有活动标签也必须把图装上屏
  expect(store.createNewTemporary).toHaveBeenCalledWith('角色资产.json');
  expect(store.openWorkflow).toHaveBeenCalledWith(tab, true);
  expect(loadGraphData.mock.calls[0][3]).toBe(tab);
  expect(location.href).toBe('suxing-workflow://loaded?id=4');
  // 有记录却一个标签都没恢复出来 = 记录已经不可信，清掉它，下次启动才不再空转
  expect(local.bag['Comfy.Workflow.LastOpenPaths:personal']).toBeUndefined();
  expect(local.bag['Comfy.Workflow.LastActivePath:personal']).toBeUndefined();
});

it('图被 ComfyUI 自己的恢复覆盖掉时重放，而不是让用户对着空画布', async () => {
  const tab = { filename: '角色资产.json', path: 'workflows/角色资产.json', isTemporary: true };
  const store = { openWorkflows: [], activeWorkflow: null, createNewTemporary: vi.fn(() => tab), openWorkflow: vi.fn().mockResolvedValue({}) };
  let overwritten = false;
  let ticks = 0;
  let overwriteAt = Number.POSITIVE_INFINITY;
  const clock = (cb: () => void) => queueMicrotask(() => { ticks += 1; if (ticks >= overwriteAt) overwritten = true; cb(); });
  const calls: unknown[][] = [];
  const loadGraphData = vi.fn((...args: unknown[]) => {
    calls.push(args);
    if (calls.length === 1) overwriteAt = ticks + 3;
    else overwritten = false;
    return Promise.resolve({});
  });
  const app = { graph: { get _nodes() { return overwritten ? [] : [{}, {}]; } }, canvas: {}, extensionManager: { workflow: store }, loadGraphData };
  const location: any = { origin: ORIGIN, href: '' };
  await run({
    window: { comfyAPI: { app: { app } } }, location, document: { readyState: 'complete' },
    localStorage: fakeStorage().api, sessionStorage: fakeStorage().api, setTimeout: clock,
    request: { id: 2, origin: ORIGIN, base: `${ORIGIN}/`, name: '角色资产', workflow: { nodes: [{}, {}] } },
  }, 3000);
  expect(calls.length).toBeGreaterThanOrEqual(2);
  expect(location.href).toBe('suxing-workflow://loaded?id=2');
});

it('加载失败不会回报成功，也不会提交生成任务', async () => {
  const location: any = { origin: ORIGIN, href: '' };
  const app = { graph: { _nodes: [] }, canvas: {}, extensionManager: { workflow: { activeWorkflow: {} } }, loadGraphData: vi.fn().mockResolvedValue(false), queuePrompt: vi.fn() };
  await run({ window: { comfyAPI: { app: { app } } }, location, document: {}, request: { id: 6, origin: ORIGIN, name: '失败', workflow: { nodes: [{}, {}] } } });
  expect(location.href).toContain('suxing-workflow://failed?id=6');
  expect(location.href).toContain(encodeURIComponent('ComfyUI 未能加载此工作流'));
  expect(app.queuePrompt).not.toHaveBeenCalled();
});

it('面板页面（如 LoRA 管理器 /loras）不会被桥接重复加载工作流', async () => {
  const loadGraphData = vi.fn();
  const app = { graph: {}, canvas: {}, extensionManager: { workflow: { activeWorkflow: {} } }, loadGraphData };
  const location: any = { origin: ORIGIN, href: `${ORIGIN}/loras` };
  await run({ window: { comfyAPI: { app: { app } } }, location, document: { readyState: 'complete' }, request: { origin: ORIGIN, base: `${ORIGIN}/`, name: '人物', workflow: { nodes: [] } } });
  expect(loadGraphData).not.toHaveBeenCalled();
  expect(location.href).toBe(`${ORIGIN}/loras`);
});

it('停在插件页时先把工作流存进待载请求，再跳回画布', async () => {
  const loadGraphData = vi.fn();
  const app = { graph: {}, canvas: {}, extensionManager: { workflow: { activeWorkflow: {} } }, loadGraphData };
  const session = fakeStorage();
  const location: any = { origin: ORIGIN, href: `${ORIGIN}/loras` };
  const { window, flush } = boot({
    window: { comfyAPI: { app: { app } } }, location, document: { readyState: 'complete' },
    localStorage: fakeStorage().api, sessionStorage: session.api,
    request: { id: 1, origin: ORIGIN, base: `${ORIGIN}/`, name: '第一个', workflow: { nodes: [{}] } },
  });
  window.__seekxWorkflow.load({ id: 5, name: '二采_00012_', workflow: { nodes: [{}, {}] } });
  await flush(50);
  const pending = JSON.parse(session.bag['SeekX.Request']);
  expect(pending.id).toBe(5);
  expect(pending.name).toBe('二采_00012_.json');
  expect(pending.workflow.nodes).toHaveLength(2);
  // 页面自己跳回画布，装载交给画布那份脚本
  expect(location.href).toBe(`${ORIGIN}/`);
  expect(loadGraphData).not.toHaveBeenCalled();
});

it('回到画布时装的是待载请求，不是烘焙进来的第一个工作流', async () => {
  const store = tempStore();
  const loadGraphData = vi.fn().mockResolvedValue({});
  const app = { graph: { _nodes: [{}] }, canvas: {}, extensionManager: { workflow: store }, loadGraphData };
  const session = fakeStorage({ 'SeekX.Request': JSON.stringify({ id: 5, name: '二采_00012_.json', workflow: { nodes: [{}] } }) });
  const location: any = { origin: ORIGIN, href: '' };
  await run({
    window: { comfyAPI: { app: { app } } }, location, document: { readyState: 'complete' },
    localStorage: fakeStorage().api, sessionStorage: session.api,
    request: { id: 1, origin: ORIGIN, base: `${ORIGIN}/`, name: '第一个', workflow: { nodes: [{}, {}, {}] } },
  });
  expect(store.createNewTemporary).toHaveBeenCalledWith('二采_00012_.json');
  expect((loadGraphData.mock.calls[0][3] as any).filename).toBe('二采_00012_.json');
  expect(location.href).toBe('suxing-workflow://loaded?id=5');
  // 待载请求是一次性的，读走就清掉
  expect(session.bag['SeekX.Request']).toBeUndefined();
});

it('页面重新加载后保持当前工作流，不把第一个重新糊上去', async () => {
  const store = tempStore();
  const loadGraphData = vi.fn().mockResolvedValue({});
  const app = { graph: { _nodes: [{}] }, canvas: {}, extensionManager: { workflow: store }, loadGraphData };
  const session = fakeStorage({ 'SeekX.Active': JSON.stringify({ id: 0, name: '当前.json', workflow: { nodes: [{}] } }) });
  const location: any = { origin: ORIGIN, href: '' };
  await run({
    window: { comfyAPI: { app: { app } } }, location, document: { readyState: 'complete' },
    localStorage: fakeStorage().api, sessionStorage: session.api,
    request: { id: 1, origin: ORIGIN, base: `${ORIGIN}/`, name: '第一个', workflow: { nodes: [{}, {}, {}] } },
  });
  expect(loadGraphData.mock.calls[0][0]).toEqual({ nodes: [{}] });
  expect((loadGraphData.mock.calls[0][3] as any).filename).toBe('当前.json');
  // 当前工作流要留着，用户再刷新还是它
  expect(session.bag['SeekX.Active']).toContain('当前.json');
});

it('画布地址写成 /index.html 时桥接照常工作', async () => {
  const loadGraphData = vi.fn().mockResolvedValue({});
  const app = { graph: { _nodes: [{}] }, canvas: {}, extensionManager: { workflow: { activeWorkflow: {} } }, loadGraphData };
  const location: any = { origin: ORIGIN, href: `${ORIGIN}/index.html` };
  await run({ window: { comfyAPI: { app: { app } } }, location, document: { readyState: 'complete' }, request: { id: 8, origin: ORIGIN, base: `${ORIGIN}/index.html`, name: '人物', workflow: { nodes: [{}] } } });
  expect(loadGraphData).toHaveBeenCalled();
  expect(location.href).toBe('suxing-workflow://loaded?id=8');
});

it('面板页的子路由同样不会被桥接接管', async () => {
  const loadGraphData = vi.fn();
  const app = { graph: {}, canvas: {}, extensionManager: { workflow: { activeWorkflow: {} } }, loadGraphData };
  const location: any = { origin: ORIGIN, href: `${ORIGIN}/loras/detail/9` };
  await run({ window: { comfyAPI: { app: { app } } }, location, document: { readyState: 'complete' }, request: { origin: ORIGIN, base: `${ORIGIN}/`, name: '人物', workflow: { nodes: [] } } });
  expect(loadGraphData).not.toHaveBeenCalled();
});

it('画布可视区尺寸一变就重新适应视图，尺寸没变则不许抢视角', async () => {
  const zoomToFit = vi.fn();
  const host: any = { clientWidth: 800, clientHeight: 600 };
  const listeners: Record<string, Array<() => void>> = {};
  const app = {
    graph: { _nodes: [{}, {}] },
    canvas: { zoomToFit },
    canvasContainer: host,
    extensionManager: { workflow: { activeWorkflow: { filename: '我的' } } },
    loadGraphData: vi.fn().mockResolvedValue({}),
  };
  const location: any = { origin: ORIGIN, href: '' };
  const { flush } = await boot({
    window: {
      comfyAPI: { app: { app } },
      addEventListener: (type: string, cb: () => void) => { (listeners[type] ||= []).push(cb); },
    },
    location,
    document: { readyState: 'complete' },
    request: { id: 9, origin: ORIGIN, base: `${ORIGIN}/`, name: '测试', workflow: { nodes: [{}, {}] } },
  });
  // 先让首帧装载和它的 autoFit 跑完，再判断「尺寸没变时不许抢视角」
  await flush();
  expect(listeners.resize?.length).toBeGreaterThan(0);

  const before = zoomToFit.mock.calls.length;
  // 尺寸没变（比如只是滚动条出现又被抵消）不该动视角
  (listeners.resize || []).forEach((cb) => cb());
  await flush();
  expect(zoomToFit.mock.calls.length).toBe(before);

  host.clientWidth = 1200;
  host.clientHeight = 700;
  (listeners.resize || []).forEach((cb) => cb());
  await flush();
  expect(zoomToFit.mock.calls.length).toBeGreaterThan(before);
});