import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';
const bridge = readFileSync('src-tauri/src/comfyui_bridge.js', 'utf8');
it('桥接等待前端就绪，再以图片名加载图并回传完成', async () => {
  const loadGraphData = vi.fn().mockResolvedValue({});
  const app = { graph: {}, canvas: {}, extensionManager: { workflow: { activeWorkflow: {} } }, loadGraphData };
  const window: any = {};
  const location = { origin: 'http://localhost:8188', href: '' };
  let times = 0;
  vm.runInNewContext(bridge, {
    window, location, document: { readyState: 'loading' }, request: { origin: location.origin, base: location.origin, name: '人物', workflow: { nodes: [] } },
    URL, encodeURIComponent, setTimeout: (cb: () => void) => { if (++times === 3) window.comfyAPI = { app: { app } }; queueMicrotask(cb); },
  });
  for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(loadGraphData).toHaveBeenCalledWith({ nodes: [] }, true, true, '人物.json');
  expect(location.href).toBe('suxing-workflow://loaded');
});
it('加载失败不会回报成功，也不会提交生成任务', async () => {
  const location = { origin: 'http://localhost:8188', href: '' };
  const app = { graph: {}, canvas: {}, extensionManager: { workflow: { activeWorkflow: {} } }, loadGraphData: vi.fn().mockResolvedValue(false), queuePrompt: vi.fn() };
  vm.runInNewContext(bridge, { window: { comfyAPI: { app: { app } } }, location, document: {}, request: { origin: location.origin, name: '失败', workflow: { nodes: [] } }, URL, encodeURIComponent, setTimeout: (cb: () => void) => queueMicrotask(cb) });
  for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(location.href).toContain('suxing-workflow://failed');
  expect(app.queuePrompt).not.toHaveBeenCalled();
});
