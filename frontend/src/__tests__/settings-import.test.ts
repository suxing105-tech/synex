import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import SettingsModal from '../components/SettingsModal.svelte';
vi.mock('../lib/api', () => ({ settingsApi: { get: vi.fn(async () => { throw new Error('offline'); }) }, comfyuiApi: { status: vi.fn(async () => ({ running: false, enabled: true, url: 'http://127.0.0.1:8188' })) }, http: vi.fn(async (path: string) => path === '/api/reverse-prompt-settings' ? { default_model_id: null, instruction: '', default_instruction: '' } : []) }));
afterEach(cleanup);
it('后台尚未就绪时仍可从通用设置打开导入目录', async () => {
  const onOpenOnboarding = vi.fn();
  const screen = render(SettingsModal, { open: true, tab: '通用', onOpenOnboarding });
  await fireEvent.click(screen.getByRole('button', { name: '导入目录' }));
  expect(onOpenOnboarding).toHaveBeenCalledOnce();
  await fireEvent.click(screen.getByRole('button', { name: '快捷键' }));
  expect(screen.getByRole('button', { name: '导入目录' })).toBeTruthy();
});
