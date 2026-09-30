import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { readFileSync } from 'node:fs';
import SidebarUpdateButton from '../components/SidebarUpdateButton.svelte';
import { updateStatus, updateError, oneClickUpdating, installLatestUpdate, updateAction, type UpdateStatus } from '../lib/updates';

const status = (phase = 'available'): UpdateStatus => ({ current_version: '0.2.10', configured: true, installable: true, phase, message: '更新状态', version: '0.2.11', notes: '', downloaded: 0, total: null, automatic: true, last_check: 0 });
let invoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  invoke = vi.fn(); (window as any).__TAURI__ = { core: { invoke } };
  updateStatus.set(status()); updateError.set(''); oneClickUpdating.set(false);
});
afterEach(() => { cleanup(); delete (window as any).__TAURI__; });
it('hides when there is no newer version', () => {
  updateStatus.set({ ...status('latest'), version: null });
  expect(render(SidebarUpdateButton).queryByRole('button')).toBeNull();
});
it('one click downloads, verifies ready state, then installs', async () => {
  invoke.mockResolvedValueOnce(status('ready')).mockResolvedValueOnce(status('installing'));
  const ui = render(SidebarUpdateButton);
  await fireEvent.click(ui.getByRole('button', { name: '一键更新到 v0.2.11' }));
  await vi.waitFor(() => expect(invoke.mock.calls.map(c => c[0])).toEqual(['download_update', 'install_update']));
});
it('installs an already downloaded update without another download', async () => {
  updateStatus.set(status('ready')); invoke.mockResolvedValue(status('installing'));
  await installLatestUpdate(); expect(invoke).toHaveBeenCalledTimes(1); expect(invoke).toHaveBeenCalledWith('install_update', {});
});
it.each(['error', 'available'])('never installs after an unsuccessful download (%s)', async phase => {
  invoke.mockResolvedValue({ ...status(phase), message: '签名校验失败' });
  await installLatestUpdate(); expect(invoke).toHaveBeenCalledTimes(1);
  expect(get(updateError)).toBe('签名校验失败'); expect(get(oneClickUpdating)).toBe(false);
});
it('keeps the retry entry and shows rejected command errors', async () => {
  invoke.mockRejectedValue('网络断开'); await installLatestUpdate();
  expect(get(updateError)).toBe('网络断开'); expect(get(oneClickUpdating)).toBe(false);
  expect(render(SidebarUpdateButton).getByRole('button').hasAttribute('disabled')).toBe(false);
});
it('blocks duplicate clicks and automatic checks throughout the operation', async () => {
  let resolve!: (value: UpdateStatus) => void;
  invoke.mockImplementationOnce(() => new Promise(r => resolve = r)).mockResolvedValue(status('installing'));
  const pending = installLatestUpdate(); await installLatestUpdate();
  await updateAction('check_update', { automatic: true });
  expect(invoke).toHaveBeenCalledTimes(1);
  resolve(status('ready')); await pending; expect(invoke).toHaveBeenCalledTimes(2);
});
it('shows download progress and disables unsupported portable installs', async () => {
  updateStatus.set({ ...status('downloading'), downloaded: 50, total: 100 });
  const ui = render(SidebarUpdateButton);
  expect(ui.getByRole('button', { name: '正在下载更新 50%' }).hasAttribute('disabled')).toBe(true);
  cleanup(); updateStatus.set({ ...status(), installable: false });
  expect(render(SidebarUpdateButton).getByRole('button').hasAttribute('disabled')).toBe(true);
  await installLatestUpdate(); expect(invoke).not.toHaveBeenCalled();
});
it('positions update after settings, reversing the column only when collapsed', () => {
  const app = readFileSync('src/App.svelte', 'utf8');
  expect(app.indexOf('<SidebarUpdateButton />')).toBeGreaterThan(app.indexOf('aria-label="设置"'));
  expect(app).toContain('class:collapsed-actions={sidebarCollapsed}');
  expect(app).toContain('.sidebar-actions.collapsed-actions { flex-direction: column-reverse;');
});
