import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import SettingsModal from '../components/SettingsModal.svelte';
import { settingsApi } from '../lib/api';
vi.mock('../lib/api', () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  settingsApi: { get: vi.fn(async () => ({ watch_dirs: ['C:/素材'], live_enabled: true })), update: vi.fn(async (cfg) => cfg) },
  comfyuiApi: { status: vi.fn(async () => ({ running: false, enabled: true, url: 'http://127.0.0.1:8188' })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  foldersApi: { tree: vi.fn(async () => []), archived: vi.fn(async () => []), restore: vi.fn(async () => ({ ok: true })) },
  http: vi.fn(async (path: string) => path === '/api/reverse-prompt-settings' ? { default_model_id: null, instruction: '', default_instruction: '' } : []),
}));
// 目录点击 = 把该分组的标题滚到滚动区顶部（-28 的余量），所以期望值直接由位置表算出来。
const positions: Record<string, number> = {
  'settings-general': 36, 'settings-archived': 636, 'settings-shortcuts': 1036,
  'settings-models': 1636, 'settings-comfyui': 2236, 'settings-media': 2836,
  'settings-update': 3236, 'settings-about': 3636,
};
const top = (id: string) => positions[id] - 28;
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const scrollTop = this.classList.contains('settings-content') ? 0 : this.closest('.settings-content')?.scrollTop ?? 0;
    return { top: (positions[this.id] ?? 0) - scrollTop } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(function(this: HTMLElement, options: any) { this.scrollTop = options.top; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('目录跳转保留监听路径和快捷键草稿，且八个分组同时存在', async () => {
  const screen = render(SettingsModal, { open: true, tab: '通用' });
  const input = await screen.findByLabelText('新增监听目录');
  await fireEvent.input(input, { target: { value: 'D:/未保存素材' } });
  const recording = screen.getByRole('button', { name: '设置复制正向 Prompt快捷键' });
  await fireEvent.click(recording);
  await fireEvent.keyDown(recording, { key: 'j', ctrlKey: true, shiftKey: true });
  await fireEvent.click(screen.getByRole('button', { name: 'ComfyUI' }));
  const scroller = screen.container.querySelector('.settings-content')!;
  expect(scroller.scrollTop).toBe(top('settings-comfyui'));
  expect(screen.getByRole('button', { name: 'ComfyUI' }).getAttribute('aria-current')).toBe('location');
  await fireEvent.click(screen.getByRole('button', { name: '通用' }));
  expect((input as HTMLInputElement).value).toBe('D:/未保存素材');
  expect(recording.textContent).toContain('J');
  expect(screen.container.querySelectorAll('.settings-section')).toHaveLength(8);
  await fireEvent.click(screen.getByRole('button', { name: '添加目录' }));
  await fireEvent.click(screen.getByRole('button', { name: '保存通用设置' }));
  expect(settingsApi.update).toHaveBeenCalledWith({ watch_dirs: ['C:/素材', 'D:/未保存素材'], live_enabled: true });
});
it('滚动同步目录位置，点目录项仍能跳回通用；目录底部不再挂提示与回到顶部', async () => {
  const screen = render(SettingsModal, { open: true, tab: '模型与反推' });
  const scroller = screen.container.querySelector('.settings-content')!;
  await waitFor(() => expect(scroller.scrollTop).toBe(top('settings-models')));
  scroller.scrollTop = 620;
  await fireEvent.scroll(scroller);
  expect(screen.getByRole('button', { name: '已归档目录' }).getAttribute('aria-current')).toBe('location');
  await fireEvent.click(screen.getByRole('button', { name: '通用' }));
  expect(scroller.scrollTop).toBe(top('settings-general'));
  expect(screen.getByRole('button', { name: '通用' }).getAttribute('aria-current')).toBe('location');
  // 用户要求删掉目录底部那块：保存提示、版本号、回到顶部都不该再出现。
  expect(screen.container.querySelector('.settings-rail-foot')).toBeNull();
  expect(screen.queryByRole('button', { name: '返回设置顶部' })).toBeNull();
  expect(screen.container.textContent).not.toContain('改完在每组右下角保存');
});
it('目录搜索只留下命中的分组，正文跟着收窄，清空后恢复完整目录', async () => {
  const screen = render(SettingsModal, { open: true, tab: '通用' });
  await screen.findByLabelText('新增监听目录');
  const search = screen.getByLabelText('搜索设置');
  await fireEvent.input(search, { target: { value: '归档' } });
  expect(screen.container.querySelectorAll('.settings-nav-item')).toHaveLength(1);
  expect(screen.container.querySelectorAll('.settings-section')).toHaveLength(1);
  expect(screen.container.querySelector('.settings-section')?.id).toBe('settings-archived');
  await fireEvent.input(search, { target: { value: '不存在的设置词' } });
  expect(await screen.findByRole('status')).toBeTruthy();
  expect(screen.container.querySelectorAll('.settings-section')).toHaveLength(0);
  await fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
  expect(screen.container.querySelectorAll('.settings-nav-item')).toHaveLength(8);
  expect(screen.container.querySelectorAll('.settings-section')).toHaveLength(8);
});