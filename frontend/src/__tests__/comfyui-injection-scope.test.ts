import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';

// comfyui.rs 把脚本拼成 `(() => { const request = …; PANEL BRIDGE })();`，
// 也就是同一个函数作用域。曾经 tabs 和 bridge 各自声明了顶层 const trimSlash，
// 拼起来直接 SyntaxError，注入脚本一起失效：画布上 window.open 没人接管，
// 用户点 LoRA 管理器图标就「毫无反应」。这个测试盯住这个坑。
const SRC = 'src-tauri/src';
const panel = readFileSync(`${SRC}/comfyui_panel.js`, 'utf8');
const bridge = readFileSync(`${SRC}/comfyui_bridge.js`, 'utf8');
const rust = readFileSync(`${SRC}/comfyui.rs`, 'utf8');

const ORIGIN = 'http://127.0.0.1:8188';

function combined() {
  const request = JSON.stringify({ origin: ORIGIN, base: `${ORIGIN}/`, name: '某张图', workflow: { nodes: [{}, {}] } });
  return `(() => { const request = ${request}; ${panel} ${bridge} })();`;
}

function fakeStore(init: Record<string, string> = {}) {
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

it('注入脚本拼进同一个作用域后必须还能编译', () => {
  expect(() => new vm.Script(combined())).not.toThrow();
});

it('注入顺序仍然是 panel、bridge 共用一个 request 作用域', () => {
  expect(rust).toContain('(() => {{ const request = {}; {PANEL_JS} {BRIDGE_JS} }})();');
  // 注入脚本只剩 panel + bridge：往 ComfyUI 的标签键里写东西的那段已经删掉了
  expect((rust.match(/include_str!\("comfyui_/g) || []).length).toBe(2);
});

it('拼起来之后两段脚本都真的在画布上跑起来了', async () => {
  const calls: unknown[][] = [];
  const app = {
    graph: { _nodes: [{}, {}] },
    canvas: {},
    extensionManager: { workflow: { activeWorkflow: { filename: '我的工作流' } } },
    loadGraphData: (...args: unknown[]) => { calls.push(args); return Promise.resolve({}); },
  };
  const session = fakeStore();
  const local = fakeStore({ 'Comfy.Workflow.LastOpenPaths:personal': '{"workspaceId":"personal","paths":["workflows/我的工作流.json"],"activeIndex":0}' });
  const location: any = { origin: ORIGIN, href: `${ORIGIN}/` };
  const body = { appendChild: () => {}, className: '' };
  const document: any = {
    readyState: 'complete',
    body,
    documentElement: body,
    createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, textContent: '' }),
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const window: any = { comfyAPI: { app: { app } }, location, sessionStorage: session.api };
  window.window = window;
  window.top = window;
  window.open = () => null;
  window.postMessage = () => {};
  window.addEventListener = () => {};
  const history = { length: 1, back: () => {}, go: () => {} };
  vm.runInNewContext(combined(), {
    window, document, location, history,
    localStorage: local.api, sessionStorage: session.api,
    URL, setTimeout: (cb: () => void) => queueMicrotask(cb), queueMicrotask, Promise, encodeURIComponent, console,
  });
  for (let i = 0; i < 600; i++) await Promise.resolve();

  // bridge：装进我们自己那个固定名字的标签，并且回报完成
  expect(calls.length).toBe(1);
  expect(calls[0][3]).toBe('ComfyUI.json');
  expect(location.href).toBe('suxing-workflow://loaded');
  // 用户正在用的标签和 ComfyUI 的标签持久化都不该被动过
  expect(app.extensionManager.workflow.activeWorkflow.filename).toBe('我的工作流');
  expect(local.bag['Comfy.Workflow.LastOpenPaths:personal']).toBeDefined();
  expect(Object.keys(local.bag).some((key) => key.startsWith('SeekX.'))).toBe(false);
  // panel：接管了 window.open，宿主对象在位
  expect(typeof window.__seekxPanel.open).toBe('function');
});