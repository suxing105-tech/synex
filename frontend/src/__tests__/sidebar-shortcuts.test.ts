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
it('波浪键的两种按法切换左栏；右栏不再认 Ctrl+Alt+B（那是 2026-11-11 的临时键）', () => {
  const left = vi.fn(), right = vi.fn();
  off = registerSidebarShortcuts(left, right);
  key('`', { code: 'Backquote' }); key('~', { code: 'Backquote', shiftKey: true });
  expect(left).toHaveBeenCalledTimes(2);
  expect(right).not.toHaveBeenCalled();
  expect(key('b', { ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
});
it('Tab 是右栏默认键，但只在中间这一列接管（2026-11-16 苏醒要回来的那一手）', () => {
  const left = vi.fn(), right = vi.fn();
  off = registerSidebarShortcuts(left, right);
  // 不用用户自己改键：默认就是 Tab
  expect(defaultShortcuts.rightSidebar).toBe('tab');
  const grid = document.createElement('div');
  grid.setAttribute('data-tab-sidebar', '');
  const card = document.createElement('button');
  grid.append(card);
  document.body.append(grid);
  card.focus();
  expect(key('Tab', {}, card).defaultPrevented).toBe(true);
  expect(right).toHaveBeenCalledTimes(1);
  expect(left).not.toHaveBeenCalled();
  // Shift+Tab 是原生的后退遍历，不抢：那是键盘用户在这颗列里的退路，撤了就成键盘陷阱
  expect(key('Tab', { shiftKey: true }, card).defaultPrevented).toBe(false);
  expect(right).toHaveBeenCalledTimes(1);
  card.blur(); grid.remove();
});
it('点过工具条那颗「收起右侧栏」之后焦点停在按钮上，Tab 照样能把它展开回来', () => {
  const left = vi.fn(), right = vi.fn();
  off = registerSidebarShortcuts(left, right);
  // 工具条和网格在 App.svelte 里同属中间那一列，所以标记打在列上，按钮和卡片一起算
  const column = document.createElement('div');
  column.setAttribute('data-tab-sidebar', '');
  const toolbar = document.createElement('div');
  const toggleBtn = document.createElement('button');
  toolbar.append(toggleBtn);
  column.append(toolbar);
  document.body.append(column);
  toggleBtn.focus();
  expect(key('Tab', {}, toggleBtn).defaultPrevented).toBe(true);
  expect(right).toHaveBeenCalledTimes(1);
  toggleBtn.blur(); column.remove();
});
it('焦点不在中间这一列上时 Tab 照旧走焦点遍历（键盘进得来，WCAG 2.1.1 / 2.1.2）', () => {
  const toggle = vi.fn(); off = registerSidebarShortcuts(toggle, toggle);
  // 应用刚打开：焦点还落在 body 上，这一会儿 Tab 必须还是「走到下一个控件」
  expect(key('Tab').defaultPrevented).toBe(false);
  // 输入框里：Tab 要能走到下一个控件，也要能用来打字区域的导航
  const box = document.createElement('input');
  document.body.append(box);
  box.focus();
  expect(key('Tab', {}, box).defaultPrevented).toBe(false);
  // 长得像卡片、但不在那颗网格标记里（右栏那种缩略图）：同样不接管
  const rail = document.createElement('div');
  const railCard = document.createElement('button');
  rail.append(railCard);
  document.body.append(rail);
  railCard.focus();
  expect(key('Tab', {}, railCard).defaultPrevented).toBe(false);
  box.remove(); rail.remove();
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
