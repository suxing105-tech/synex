import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { tick } from 'svelte';
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
  await fireEvent.click(ui.getByRole('button', { name: '有可用更新 v0.2.11' }));
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
it('styles the entry icon like the settings button and shows the 有可用更新 tooltip', () => {
  const app = readFileSync('src/App.svelte', 'utf8');
  const settings = /<button class="([^"]*)" aria-label="设置"/.exec(app)?.[1] ?? '';
  expect(settings).toContain('text-muted');
  const button = render(SidebarUpdateButton).getByRole('button', { name: '有可用更新 v0.2.11' });
  for (const cls of settings.split(/\s+/)) {
    if (['w-10', 'h-10', 'flex', 'items-center', 'justify-center', 'rounded-lg', 'text-muted'].includes(cls)) {
      expect(button.className).toContain(cls);
    }
  }
  expect(button.className).not.toContain('bg-accent');
  expect(document.querySelector('.update-tooltip')?.textContent).toBe('有可用更新');
  expect(button.hasAttribute('title')).toBe(false);
});
it('drops the tooltip once the one-click update starts', () => {
  updateStatus.set({ ...status('downloading'), downloaded: 10, total: 100 });
  render(SidebarUpdateButton);
  expect(document.querySelector('.update-tooltip')).toBeNull();
});
it('shows the install card with title, restart note, progress bar and state text', () => {
  updateStatus.set({ ...status('downloading'), downloaded: 50, total: 100 });
  const ui = render(SidebarUpdateButton);
  const card = ui.getByRole('status');
  expect(card.textContent).toContain('正在下载更新');
  expect(card.textContent).toContain('安装完成后，闪寻空间 将重新启动。');
  expect(card.querySelector('.update-card-title')?.textContent).toBe('正在下载更新');
  const bar = card.querySelector('[role="progressbar"]');
  expect(bar?.getAttribute('aria-valuenow')).toBe('50');
  expect(bar?.getAttribute('aria-valuemax')).toBe('100');
  expect(card.querySelector('.update-progress-fill')?.getAttribute('style')).toContain('width: 50%');
  expect(card.querySelector('.update-progress-state')?.textContent).toBe('正在下载 50%');
});
it('keeps the card indeterminate when the download size is unknown', () => {
  updateStatus.set({ ...status('downloading'), downloaded: 20, total: null });
  const ui = render(SidebarUpdateButton);
  const bar = ui.getByRole('status').querySelector('[role="progressbar"]');
  expect(bar?.hasAttribute('aria-valuenow')).toBe(false);
  expect(bar?.querySelector('.update-progress-fill')?.className).toContain('indeterminate');
  expect(ui.getByRole('status').querySelector('.update-progress-state')?.textContent).toBe('正在下载…');
});
it('switches the card copy while installing and preparing', () => {
  updateStatus.set(status('installing'));
  let ui = render(SidebarUpdateButton);
  expect(ui.getByRole('status').querySelector('.update-card-title')?.textContent).toBe('正在安装更新');
  expect(ui.getByRole('status').querySelector('.update-progress-state')?.textContent).toBe('正在安装…');
  cleanup();
  updateStatus.set({ ...status('checking'), version: '0.2.11' });
  oneClickUpdating.set(true);
  ui = render(SidebarUpdateButton);
  expect(ui.getByRole('status').querySelector('.update-card-title')?.textContent).toBe('正在准备更新');
  expect(ui.getByRole('status').querySelector('.update-progress-state')?.textContent).toBe('正在准备…');
});
it('keeps the background startup check silent and only shows the card once the user clicks', async () => {
  updateStatus.set({ ...status('checking'), version: '0.2.11' });
  const ui = render(SidebarUpdateButton);
  expect(document.querySelector('.update-progress-card')).toBeNull();
  expect(ui.getByRole('button', { name: '有可用更新 v0.2.11' })).toBeTruthy();
  oneClickUpdating.set(true);
  await tick();
  expect(document.querySelector('.update-progress-card')).not.toBeNull();
});
it('centers the progress card horizontally at the bottom of the window', () => {
  const css = readFileSync('src/components/SidebarUpdateButton.svelte', 'utf8');
  expect(css).toMatch(/\.update-progress-card\s*\{[\s\S]*?left:\s*50%;[\s\S]*?transform:\s*translateX\(-50%\);/);
});
it('keeps the tooltip reachable and labelled when the portable install cannot update', () => {
  const css = readFileSync('src/components/SidebarUpdateButton.svelte', 'utf8');
  expect(css).toMatch(/\.sidebar-update:disabled\s*\{[\s\S]*?pointer-events:\s*none;/);
  updateStatus.set({ ...status(), installable: false });
  render(SidebarUpdateButton);
  expect(document.querySelector('.update-tooltip')?.textContent).toBe('请使用完整安装包更新');
});
it('keeps no install card when nothing is happening', () => {
  render(SidebarUpdateButton);
  expect(document.querySelector('.update-progress-card')).toBeNull();
});
it('positions update after settings, reversing the column only when collapsed', () => {
  const app = readFileSync('src/App.svelte', 'utf8');
  expect(app.indexOf('<SidebarUpdateButton />')).toBeGreaterThan(app.indexOf('aria-label="设置"'));
  expect(app).toContain('class:collapsed-actions={sidebarCollapsed}');
  expect(app).toContain('.sidebar-actions.collapsed-actions { flex-direction: column-reverse;');
});
