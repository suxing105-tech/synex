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
it('Tab toggles right and either form of the tilde key toggles left', () => {
  const left = vi.fn(), right = vi.fn();
  off = registerSidebarShortcuts(left, right);
  expect(key('Tab').defaultPrevented).toBe(true);
  key('Tab'); key('`', { code: 'Backquote' }); key('~', { code: 'Backquote', shiftKey: true });
  expect(left).toHaveBeenCalledTimes(2); expect(right).toHaveBeenCalledTimes(2);
  expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(false);
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
