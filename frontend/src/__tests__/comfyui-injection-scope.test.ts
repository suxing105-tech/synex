import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';

// comfyui.rs 把三段脚本拼成 `(() => { const request = …; TABS PANEL BRIDGE })();`，
// 也就是同一个函数作用域。上一轮 tabs 和 bridge 各自声明了顶层 const trimSlash，
// 拼起来直接 SyntaxError，三个脚本一起失效：画布上 window.open 没人接管，
// 用户点 LoRA 管理器图标就「毫无反应」。这个测试盯住这个坑。
const SRC = 'src-tauri/src';
const tabs = readFileSync(`${SRC}/comfyui_tabs.js`, 'utf8');
const panel = readFileSync(`${SRC}/comfyui_panel.js`, 'utf8');
const bridge = readFileSync(`${SRC}/comfyui_bridge.js`, 'utf8');
const rust = readFileSync(`${SRC}/comfyui.rs`, 'utf8');

const ORIGIN = 'http://127.0.0.1:8188';

function combined(workflowName = '某张图') {
  const request = JSON.stringify({ origin: ORIGIN, base: `${ORIGIN}/`, name: workflowName, workflow: { nodes: [] } });
  return `(() => { const request = ${request}; ${tabs} ${panel} ${bridge} })();`;
}

function fakeBag() {
  const bag: Record<string, string> = {};
  const api = {
    getItem: (key: string) => (key in bag ? bag[key] : null),
    setItem: (key: string, value: string) => { bag[key] = String(value); },
    removeItem: (key: string) => { delete bag[key]; },
  };
  return { bag, api: api as typeof api & Record<string, string> };
}

it('三段注入脚本拼进同一个作用域后必须还能编译', () => {
  expect(() => new vm.Script(combined())).not.toThrow();
});

it('注入顺序仍然是 tabs、panel、bridge 共用一个 request 作用域', () => {
  expect(rust).toContain('(() => {{ const request = {}; {TABS_JS} {PANEL_JS} {BRIDGE_JS} }})();');
});

it('拼起来之后三段脚本都真的在画布上跑起来了', async () => {
  const calls: unknown[][] = [];
  const app = {
    graph: {},
    canvas: {},
    extensionManager: { workflow: { activeWorkflow: {} } },
    loadGraphData: (...args: unknown[]) => { calls.push(args); return Promise.resolve({}); },
  };
  const session = fakeBag();
  const local = fakeBag();
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
  for (let i = 0; i < 400; i++) await Promise.resolve();

  // tabs：把自己打开的标签名记进 ComfyUI 的同一份 localStorage
  expect(JSON.parse(local.bag['SeekX.OpenedWorkflowTabs'])).toEqual(['某张图.json']);
  // bridge：加载了工作流并回报完成
  expect(calls.length).toBe(1);
  expect(calls[0][3]).toBe('某张图.json');
  expect(location.href).toBe('suxing-workflow://loaded');
  // panel：接管了 window.open，宿主对象在位
  expect(typeof window.__seekxPanel.open).toBe('function');
});
