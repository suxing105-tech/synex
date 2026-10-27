import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import SettingsModal from '../components/SettingsModal.svelte';
import { foldersApi } from '../lib/api';

vi.mock('../lib/api', () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  settingsApi: { get: vi.fn(async () => ({ watch_dirs: ['D:/AI/ComfyUI/output'], live_enabled: true })), update: vi.fn(async (cfg: any) => cfg) },
  comfyuiApi: { status: vi.fn(async () => ({ running: false, enabled: true, url: 'http://127.0.0.1:8188' })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  foldersApi: {
    tree: vi.fn(async () => []),
    archived: vi.fn(async () => [
      { id: 12, name: 'output', path: 'D:/AI/ComfyUI/output', is_system: true, media: 425, texts: 0 },
    ]),
    restore: vi.fn(async () => ({ ok: true, archived: false })),
  },
  http: vi.fn(async (path: string) => path === '/api/reverse-prompt-settings' ? { default_model_id: null, instruction: '', default_instruction: '' } : []),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('通用设置列出已归档目录，并可恢复', async () => {
  const screen = render(SettingsModal, { open: true, tab: '通用' });
  // 归档入口不在侧栏里藏死：设置页必须看得见、能一键恢复
  expect(await screen.findByText(/output · 藏起 425 项/)).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: '恢复目录 output' }));
  await waitFor(() => expect(foldersApi.restore).toHaveBeenCalledWith(12));
  // 恢复之后必须重读目录树与素材流，否则侧栏还是空的
  await waitFor(() => expect(foldersApi.tree).toHaveBeenCalled());
});

it('没有归档记录时给出下一步指引，而不是空荡荡', async () => {
  vi.mocked(foldersApi.archived).mockResolvedValueOnce([]);
  const screen = render(SettingsModal, { open: true, tab: '通用' });
  expect(await screen.findByText(/没有已归档的目录/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^恢复目录/ })).toBeNull();
});
