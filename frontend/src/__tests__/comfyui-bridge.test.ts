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

/** 跑一遍注入脚本；setTimeout 全部走微任务，flush 够多次就能跑到收尾 */
async function run(env: Record<string, unknown>, flushes = 1200) {
  vm.runInNewContext(bridge, { URL, encodeURIComponent, Promise, console, setTimeout: (cb: () => void) => queueMicrotask(cb), queueMicrotask, ...env });
  for (let i = 0; i < flushes; i++) await Promise.resolve();
}

it('桥接等画布就绪，把图装进固定名字的 ComfyUI 标签再回传完成', async () => {
  const loadGraphData = vi.fn().mockResolvedValue({});
  const app = { graph: { _nodes: [{}, {}] }, canvas: {}, extensionManager: { workflow: { activeWorkflow: { filename: '我的工作流' } } }, loadGraphData };
  const location: any = { origin: ORIGIN, href: '' };
  await run({ window: { comfyAPI: { app: { app } } }, location, document: { readyState: 'complete' }, request: { origin: ORIGIN, base: `${ORIGIN}/`, name: '人物', workflow: { nodes: [{}, {}] } } });
  expect(loadGraphData).toHaveBeenCalledTimes(1);
  expect(loadGraphData.mock.calls[0][0]).toEqual({ nodes: [{}, {}] });
  // 标签名不再用图片名：每开一张图就多一个临时工作流是「越积越多」的源头
  expect(loadGraphData.mock.calls[0][3]).toBe('ComfyUI.json');
  expect(location.href).toBe('suxing-workflow://loaded');
});

it('ComfyUI 一个标签都没恢复出来时，自己开标签并清掉坏掉的恢复记录', async () => {
  const tab = { filename: 'ComfyUI', path: 'workflows/ComfyUI.json', isTemporary: true };
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
    request: { origin: ORIGIN, base: `${ORIGIN}/`, name: '角色资产', workflow: { nodes: [{}, {}] } },
  }, 2400);
  // 用户看到的就是这一步：没有活动标签也必须把图装上屏
  expect(store.createNewTemporary).toHaveBeenCalledWith('ComfyUI.json');
  expect(store.openWorkflow).toHaveBeenCalledWith(tab);
  expect(loadGraphData.mock.calls[0][3]).toBe(tab);
  expect(location.href).toBe('suxing-workflow://loaded');
  // 有记录却一个标签都没恢复出来 = 记录已经不可信，清掉它，下次启动才不再空转
  expect(local.bag['Comfy.Workflow.LastOpenPaths:personal']).toBeUndefined();
  expect(local.bag['Comfy.Workflow.LastActivePath:personal']).toBeUndefined();
});

it('图被 ComfyUI 自己的恢复覆盖掉时重放，而不是让用户对着空画布', async () => {
  const tab = { filename: 'ComfyUI', path: 'workflows/ComfyUI.json', isTemporary: true };
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
    request: { origin: ORIGIN, base: `${ORIGIN}/`, name: '角色资产', workflow: { nodes: [{}, {}] } },
  }, 3000);
  expect(calls.length).toBeGreaterThanOrEqual(2);
  expect(location.href).toBe('suxing-workflow://loaded');
});

it('加载失败不会回报成功，也不会提交生成任务', async () => {
  const location: any = { origin: ORIGIN, href: '' };
  const app = { graph: { _nodes: [] }, canvas: {}, extensionManager: { workflow: { activeWorkflow: {} } }, loadGraphData: vi.fn().mockResolvedValue(false), queuePrompt: vi.fn() };
  await run({ window: { comfyAPI: { app: { app } } }, location, document: {}, request: { origin: ORIGIN, name: '失败', workflow: { nodes: [{}, {}] } } });
  expect(location.href).toContain('suxing-workflow://failed');
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

it('画布地址写成 /index.html 时桥接照常工作', async () => {
  const loadGraphData = vi.fn().mockResolvedValue({});
  const app = { graph: { _nodes: [{}] }, canvas: {}, extensionManager: { workflow: { activeWorkflow: {} } }, loadGraphData };
  const location: any = { origin: ORIGIN, href: `${ORIGIN}/index.html` };
  await run({ window: { comfyAPI: { app: { app } } }, location, document: { readyState: 'complete' }, request: { origin: ORIGIN, base: `${ORIGIN}/index.html`, name: '人物', workflow: { nodes: [{}] } } });
  expect(loadGraphData).toHaveBeenCalled();
  expect(location.href).toBe('suxing-workflow://loaded');
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
  await run({
    window: {
      comfyAPI: { app: { app } },
      addEventListener: (type: string, cb: () => void) => { (listeners[type] ||= []).push(cb); },
    },
    location,
    document: { readyState: 'complete' },
    request: { origin: ORIGIN, base: `${ORIGIN}/`, name: '测试', workflow: { nodes: [{}, {}] } },
  });
  const flush = async () => { for (let i = 0; i < 400; i++) await Promise.resolve(); };
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
