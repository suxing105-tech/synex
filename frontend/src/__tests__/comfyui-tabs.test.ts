import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

const tabs = readFileSync('src-tauri/src/comfyui_tabs.js', 'utf8');

// localStorage 的数据键要能被 Object.keys 枚举，方法本身不能混进去
function fakeStorage(initial: Record<string, string> = {}) {
  const storage: Record<string, unknown> = { ...initial };
  Object.defineProperties(storage, {
    getItem: { value: (key: string) => (typeof storage[key] === 'string' ? storage[key] : null) },
    setItem: { value: (key: string, value: string) => { storage[key] = String(value); } },
    removeItem: { value: (key: string) => { delete storage[key]; } },
  });
  return storage as Record<string, string> & { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
}

const COMFYUI = 'http://127.0.0.1:8188';

function run(storage: ReturnType<typeof fakeStorage>, name: string, origin = COMFYUI, href = '') {
  const listeners: Record<string, () => void> = {};
  const window = { addEventListener: (event: string, handler: () => void) => { listeners[event] = handler; } };
  vm.runInNewContext(tabs, { window, URL, localStorage: storage, location: { origin, href: origin + href }, request: { origin: COMFYUI, name } });
  return { fire: (event: string) => listeners[event]?.(), listeners };
}

it('清掉自己上次打开的工作流标签，保留用户自己的标签', () => {
  const storage = fakeStorage({
    'Comfy.Workflow.OpenPaths:personal': JSON.stringify(['workflows/我的合成.json', 'workflows/一采_00083_.json']),
    'Comfy.Workflow.ActivePath:personal': 'workflows/一采_00083_.json',
    [TRACKED]: JSON.stringify(['一采_00083_.json']),
  });
  run(storage, '高清_00019_');
  expect(JSON.parse(storage['Comfy.Workflow.OpenPaths:personal'])).toEqual(['workflows/我的合成.json']);
  expect(storage['Comfy.Workflow.ActivePath:personal']).toBeUndefined();
  expect(JSON.parse(storage[TRACKED])).toEqual(['一采_00083_.json', '高清_00019_.json']);
});

it('旧版 ComfyUI 的标签键和激活下标一起收拾', () => {
  const storage = fakeStorage({
    'Comfy.OpenWorkflowsPaths': JSON.stringify(['Unsaved Workflow', '一采_00081_.json']),
    'Comfy.ActiveWorkflowIndex': '1',
    'Comfy.Workflow.DraftOrder': JSON.stringify(['一采_00081_.json']),
    [TRACKED]: JSON.stringify(['一采_00081_.json']),
  });
  run(storage, '二采_00099_');
  expect(JSON.parse(storage['Comfy.OpenWorkflowsPaths'])).toEqual(['Unsaved Workflow']);
  expect(JSON.parse(storage['Comfy.Workflow.DraftOrder'])).toEqual([]);
  expect(storage['Comfy.ActiveWorkflowIndex']).toBeUndefined();
});

it('窗口关闭时把自己的标签摘掉', () => {
  const storage = fakeStorage({
    'Comfy.Workflow.OpenPaths:personal': JSON.stringify(['workflows/我的合成.json', 'workflows/一采_00083_.json']),
  });
  const { fire } = run(storage, '一采_00083_');
  expect(JSON.parse(storage['Comfy.Workflow.OpenPaths:personal'])).toEqual(['workflows/我的合成.json', 'workflows/一采_00083_.json']);
  fire('pagehide');
  expect(JSON.parse(storage['Comfy.Workflow.OpenPaths:personal'])).toEqual(['workflows/我的合成.json']);
});

it('不是我们打开过的标签名，一个都不动', () => {
  const storage = fakeStorage({
    'Comfy.Workflow.OpenPaths:personal': JSON.stringify(['workflows/我的合成.json']),
    'Comfy.Workflow.DraftIndex.v2:personal': JSON.stringify([{ path: 'workflows/我的合成.json', updatedAt: 1 }]),
  });
  run(storage, '全新的一张图');
  expect(JSON.parse(storage['Comfy.Workflow.OpenPaths:personal'])).toEqual(['workflows/我的合成.json']);
  expect(JSON.parse(storage['Comfy.Workflow.DraftIndex.v2:personal'])).toHaveLength(1);
});

it('页面不是 ComfyUI 自己时什么都不做', () => {
  const storage = fakeStorage({ 'Comfy.Workflow.OpenPaths:personal': '[]' });
  const before = JSON.stringify(storage);
  run(storage, '某张图', 'http://example.com');
  expect(JSON.stringify(storage)).toBe(before);
});

it('插件页面（/loras）不碰 ComfyUI 的标签键', () => {
  const storage = fakeStorage({
    'Comfy.Workflow.OpenPaths:personal': JSON.stringify(['workflows/一采_00083_.json']),
    [TRACKED]: JSON.stringify(['一采_00083_.json']),
  });
  const before = JSON.stringify(storage);
  run(storage, '某张图', COMFYUI, '/loras');
  expect(JSON.stringify(storage)).toBe(before);
});

const TRACKED = 'SeekX.OpenedWorkflowTabs';
