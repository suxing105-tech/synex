import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import DesktopTitlebar from '../components/DesktopTitlebar.svelte';
let maximized = false;
let resize: () => void;
const unlisten = vi.fn();
const appWindow = {
  isMaximized: vi.fn(async () => maximized),
  minimize: vi.fn(async () => {}),
  toggleMaximize: vi.fn(async () => { maximized = !maximized; }),
  close: vi.fn(async () => {}),
  onResized: vi.fn(async (listener: () => void) => { resize = listener; return unlisten; }),
};
beforeEach(() => {
  vi.clearAllMocks(); maximized = false;
  (window as any).__TAURI__ = { window: { getCurrentWindow: () => appWindow } };
});
afterEach(() => { cleanup(); delete (window as any).__TAURI__; });
it('标题栏高度为28px，品牌区域可拖动而窗口按钮独立', () => {
  const screen = render(DesktopTitlebar);
  const titlebar = screen.getByRole('banner', { name: '窗口标题栏' });
  expect(readFileSync(resolve(process.cwd(), 'src/components/DesktopTitlebar.svelte'), 'utf8')).toContain('height: var(--desktop-titlebar-height, 28px)');
  expect(titlebar.querySelector('[data-tauri-drag-region]')?.textContent).toContain('闪寻空间');
  for (const button of screen.getAllByRole('button')) expect(button.closest('[data-tauri-drag-region]')).toBeNull();
});
it('最小化、最大化、还原、关闭调用窗口API，关闭走正常生命周期', async () => {
  const screen = render(DesktopTitlebar);
  await fireEvent.click(screen.getByRole('button', { name: '最小化窗口' }));
  expect(appWindow.minimize).toHaveBeenCalledOnce();
  await fireEvent.click(screen.getByRole('button', { name: '最大化窗口' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '还原窗口' })).toBeTruthy());
  expect(screen.getByRole('banner').classList.contains('compact')).toBe(true);
  await fireEvent.click(screen.getByRole('button', { name: '还原窗口' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '最大化窗口' })).toBeTruthy());
  expect(screen.getByRole('banner').classList.contains('compact')).toBe(false);
  await fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
  expect(appWindow.close).toHaveBeenCalledOnce();
});
it('系统拖动最大化后更新按钮状态，卸载释放监听', async () => {
  const screen = render(DesktopTitlebar);
  await waitFor(() => expect(appWindow.onResized).toHaveBeenCalledOnce());
  maximized = true; resize();
  await waitFor(() => expect(screen.getByRole('button', { name: '还原窗口' })).toBeTruthy());
  expect(screen.getByRole('banner').classList.contains('compact')).toBe(true);
  screen.unmount();
  expect(unlisten).toHaveBeenCalledOnce();
});
it('打包窗口授予必要控制权限，所有全屏弹层为标题栏让出空间', () => {
  const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
  const permissions = JSON.parse(read('src-tauri/capabilities/default.json')).permissions;
  for (const action of ['minimize', 'toggle-maximize', 'close', 'start-dragging']) expect(permissions).toContain(`core:window:allow-${action}`);
  expect(read('src/App.svelte')).toContain('.desktop-shell :global(.fixed.inset-0)');
  expect(read('src/components/SplashOverlay.svelte')).toContain('inset: var(--desktop-titlebar-height, 0px) 0 0');
  expect(read('src/components/TextWorkspace.svelte')).toContain('inset:var(--desktop-titlebar-height, 0px) 0 0');
});

it('启动时已经最大化也进入紧凑状态，页面顶部使用同一高度', async () => {
  maximized = true;
  const screen = render(DesktopTitlebar);
  await waitFor(() => expect(screen.getByRole('banner').classList.contains('compact')).toBe(true));
  const source = readFileSync(resolve(process.cwd(), 'src/App.svelte'), 'utf8');
  expect(source).toContain('desktopMaximized ? "24px" : "28px"');
  expect(source).toContain('<DesktopTitlebar bind:maximized={desktopMaximized} />');
});
