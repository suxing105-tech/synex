import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, cleanup } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { registerContentShortcuts } from '../lib/content-shortcuts';
import { loadShortcuts, validateShortcuts, defaultShortcuts } from '../lib/shortcut-settings';
import { folderId, kind, textMode } from '../lib/stores';
import ContentSwitcher from '../components/ContentSwitcher.svelte';

afterEach(() => { cleanup(); document.body.innerHTML = ''; localStorage.clear(); textMode.set(false); kind.set('image'); folderId.set(null); });
it('I / T / V 切换类型；输入、组合输入、弹窗、预览和修饰键不切换', () => {
  const switchTo = vi.fn(); let preview = false;
  const off = registerContentShortcuts(switchTo, () => preview);
  for (const key of ['i', 't', 'v']) window.dispatchEvent(new KeyboardEvent('keydown', { key }));
  expect(switchTo.mock.calls).toEqual([['image'], ['text'], ['video']]);
  for (const tag of ['input', 'textarea', 'select', 'div']) {
    const el = document.createElement(tag); if (tag === 'div') el.setAttribute('contenteditable', 'true'); document.body.append(el);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true })); document.body.removeChild(el);
  }
  for (const extra of [{ isComposing: true }, { repeat: true }, { ctrlKey: true }, { shiftKey: true }, { metaKey: true }, { altKey: true }]) window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ...extra }));
  const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); document.body.append(dialog);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v' })); dialog.remove();
  preview = true; window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' }));
  expect(switchTo).toHaveBeenCalledTimes(3); off();
});
it('旧 T 标签键迁移为 Shift+T，并保留其他自定义快捷键', () => {
  localStorage.setItem('suxing.shortcuts.v1', JSON.stringify({ tags: 't', positive: 'ctrl+q' }));
  expect(loadShortcuts()).toMatchObject({ tags: 'shift+t', positive: 'ctrl+q' });
  expect(validateShortcuts({ ...defaultShortcuts, positive: 'i' })).toContain('保留');
});
it('图标可访问、显示按键提示，切换后保留当前文件夹', async () => {
  folderId.set(42);
  const ui = render(ContentSwitcher);
  expect(ui.getByRole('button', { name: '图片' }).textContent?.trim()).toBe('');
  expect(ui.getByRole('button', { name: '文本' }).title).toBe('文本 (T)');
  await fireEvent.click(ui.getByRole('button', { name: '文本' }));
  expect(get(textMode)).toBe(true); expect(get(folderId)).toBe(42);
  await fireEvent.click(ui.getByRole('button', { name: '视频' }));
  expect(get(textMode)).toBe(false); expect(get(kind)).toBe('video'); expect(get(folderId)).toBe(42);
});
