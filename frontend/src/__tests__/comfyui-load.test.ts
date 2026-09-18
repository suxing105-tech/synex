import { it, expect, vi } from 'vitest';
import { loadComfyWorkflow } from '../lib/comfyui-window';
import { comfyuiApi } from '../lib/api';
vi.mock('../lib/tauri', () => ({ isTauri: () => true }));
vi.mock('../lib/api', () => ({ comfyuiApi: { openWorkflow: vi.fn() } }));
it('传递图片完整工作流与图片名，并等待 ComfyUI 加载完成', async () => {
  const workflow = { nodes: [{ id: 1, type: 'Test' }], links: [] };
  vi.mocked(comfyuiApi.openWorkflow).mockResolvedValue({ workflow, comfyui_url: 'http://127.0.0.1:8188' } as any);
  const invoke = vi.fn().mockResolvedValue(undefined);
  (window as any).__TAURI__ = { core: { invoke } };
  await loadComfyWorkflow(7, '人物三视图.png');
  expect(invoke).toHaveBeenCalledWith('open_comfy_workflow', { url: 'http://127.0.0.1:8188', name: '人物三视图', workflow });
  delete (window as any).__TAURI__;
});
