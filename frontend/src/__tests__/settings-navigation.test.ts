import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import SettingsModal from '../components/SettingsModal.svelte';
import { settingsApi } from '../lib/api';
vi.mock('../lib/api', () => ({
  settingsApi: { get: vi.fn(async () => ({ watch_dirs: ['C:/素材'], live_enabled: true })), update: vi.fn(async (cfg) => cfg) },
  comfyuiApi: { status: vi.fn(async () => ({ running: false, enabled: true, url: 'http://127.0.0.1:8188' })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  http: vi.fn(async (path: string) => path === '/api/reverse-prompt-settings' ? { default_model_id: null, instruction: '', default_instruction: '' } : []),
}));
const positions: Record<string, number> = { 'settings-general': 36, 'settings-shortcuts': 636, 'settings-models': 1236, 'settings-comfyui': 1836, 'settings-about': 2436 };
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const scrollTop = this.classList.contains('settings-content') ? 0 : this.closest('.settings-content')?.scrollTop ?? 0;
    return { top: (positions[this.id] ?? 0) - scrollTop } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(function(this: HTMLElement, options: any) { this.scrollTop = options.top; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('目录跳转保留监听路径和快捷键草稿，且各分组同时存在', async () => {
  const screen = render(SettingsModal, { open: true, tab: '通用' });
  const input = await screen.findByLabelText('新增监听目录');
  await fireEvent.input(input, { target: { value: 'D:/未保存素材' } });
  const recording = screen.getByRole('button', { name: '设置复制正向 Prompt快捷键' });
  await fireEvent.click(recording);
  await fireEvent.keyDown(recording, { key: 'j', ctrlKey: true, shiftKey: true });
  await fireEvent.click(screen.getByRole('button', { name: 'ComfyUI' }));
  const scroller = screen.container.querySelector('.settings-content')!;
  expect(scroller.scrollTop).toBe(1808);
  expect(screen.getByRole('button', { name: 'ComfyUI' }).getAttribute('aria-current')).toBe('location');
  await fireEvent.click(screen.getByRole('button', { name: '通用' }));
  expect((input as HTMLInputElement).value).toBe('D:/未保存素材');
  expect(recording.textContent).toContain('J');
  expect(screen.container.querySelectorAll('.settings-section')).toHaveLength(5);
  await fireEvent.click(screen.getByRole('button', { name: '添加目录' }));
  await fireEvent.click(screen.getByRole('button', { name: '保存通用设置' }));
  expect(settingsApi.update).toHaveBeenCalledWith({ watch_dirs: ['C:/素材', 'D:/未保存素材'], live_enabled: true });
});
it('滚动同步目录位置；外部指定模型页后仍可回到顶部', async () => {
  const screen = render(SettingsModal, { open: true, tab: '模型与反推' });
  const scroller = screen.container.querySelector('.settings-content')!;
  await waitFor(() => expect(scroller.scrollTop).toBe(1208));
  scroller.scrollTop = 620;
  await fireEvent.scroll(scroller);
  expect(screen.getByRole('button', { name: '快捷键' }).getAttribute('aria-current')).toBe('location');
  await fireEvent.click(screen.getByRole('button', { name: '返回设置顶部' }));
  expect(scroller.scrollTop).toBe(8);
  expect(screen.getByRole('button', { name: '通用' }).getAttribute('aria-current')).toBe('location');
});
