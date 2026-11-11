import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerSidebarShortcuts } from '../lib/sidebar-shortcuts';
import { defaultShortcuts, saveShortcuts, shortcutSettings } from '../lib/shortcut-settings';

let off = () => {};
beforeEach(() => { localStorage.clear(); shortcutSettings.set({ ...defaultShortcuts }); });
afterEach(() => { off(); document.body.innerHTML = ''; });
function key(key: string, extra: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
  target.dispatchEvent(event);
  return event;
}
it('Ctrl+Alt+B toggles right and either form of the tilde key toggles left', () => {
  const left = vi.fn(), right = vi.fn();
  off = registerSidebarShortcuts(left, right);
  const chord = { ctrlKey: true, altKey: true };
  expect(key('b', chord).defaultPrevented).toBe(true);
  key('b', chord); key('`', { code: 'Backquote' }); key('~', { code: 'Backquote', shiftKey: true });
  expect(left).toHaveBeenCalledTimes(2); expect(right).toHaveBeenCalledTimes(2);
});
it('Tab 永远归焦点遍历：任何快捷键都不许拦（WCAG 2.1.2）', () => {
  const toggle = vi.fn(); off = registerSidebarShortcuts(toggle, toggle);
  expect(key('Tab').defaultPrevented).toBe(false);
  expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(false);
  // 就算存储里还被塞回 Tab（老配置 / 手改 localStorage），也不许再吞
  shortcutSettings.set({ ...defaultShortcuts, rightSidebar: 'tab', leftSidebar: 'shift+tab' });
  expect(key('Tab').defaultPrevented).toBe(false);
  expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(false);
  expect(toggle).not.toHaveBeenCalled();
});
it('preserves typing, composition, repeated keys and modal focus navigation', () => {
  const toggle = vi.fn(); off = registerSidebarShortcuts(toggle, toggle);
  for (const tag of ['input', 'textarea', 'select', 'div']) {
    const el = document.createElement(tag);
    if (tag === 'div') el.setAttribute('contenteditable', '');
    document.body.append(el);
    expect(key('Tab', {}, el).defaultPrevented).toBe(false);
    key('`', {}, el); document.body.removeChild(el);
  }
  key('Tab', { isComposing: true }); key('Tab', { repeat: true });
  for (const role of ['dialog', 'menu']) {
    const el = document.createElement('div'); el.setAttribute('role', role); document.body.append(el);
    expect(key('Tab').defaultPrevented).toBe(false); el.remove();
  }
  expect(toggle).not.toHaveBeenCalled();
});
it('uses saved replacements immediately and removes handlers on disposal', () => {
  const left = vi.fn(), right = vi.fn(); off = registerSidebarShortcuts(left, right);
  saveShortcuts({ ...defaultShortcuts, leftSidebar: 'ctrl+l', rightSidebar: 'ctrl+q' });
  expect(key('Tab').defaultPrevented).toBe(false); key('`');
  key('l', { ctrlKey: true }); key('q', { ctrlKey: true });
  expect(left).toHaveBeenCalledTimes(1); expect(right).toHaveBeenCalledTimes(1);
  off(); key('q', { ctrlKey: true }); expect(right).toHaveBeenCalledTimes(1);
});
it('blocks overlays and retains Tab navigation when no right pane exists', () => {
  const left = vi.fn(), right = vi.fn(); let blocked = true;
  off = registerSidebarShortcuts(left, right, () => blocked, () => false);
  key('`'); blocked = false;
  expect(key('Tab').defaultPrevented).toBe(false); key('`');
  expect(left).toHaveBeenCalledTimes(1); expect(right).not.toHaveBeenCalled();
});
