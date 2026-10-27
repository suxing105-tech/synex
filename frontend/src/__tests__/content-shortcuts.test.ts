import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, cleanup } from '@testing-library/svelte';
import { registerContentShortcuts, SCOPE_BY_KEY } from '../lib/content-shortcuts';
import { loadShortcuts, validateShortcuts, defaultShortcuts } from '../lib/shortcut-settings';
import { folderId, scope } from '../lib/stores';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  localStorage.clear();
  scope.set('all');
  folderId.set(null);
});

const press = (key: string, extra: Partial<KeyboardEventInit> = {}) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key, ...extra }));

describe('内容口径快捷键', () => {
  it('0 / A / I / V / T 分别切到所有素材、音频、图片、视频、文本', () => {
    const switchTo = vi.fn();
    const off = registerContentShortcuts(switchTo);
    for (const key of ['0', 'a', 'i', 'v', 't']) press(key);
    expect(switchTo.mock.calls).toEqual([['all'], ['audio'], ['image'], ['video'], ['text']]);
    off();
  });

  it('Q 回到所有素材，0 仍然有效', () => {
    const switchTo = vi.fn();
    const off = registerContentShortcuts(switchTo);
    press('q');
    press('0');
    expect(switchTo.mock.calls).toEqual([['all'], ['all']]);
    off();
  });

  it('收藏快捷键随功能一起下线', () => {
    expect(SCOPE_BY_KEY.f).toBeUndefined();
    expect(Object.keys(SCOPE_BY_KEY).sort()).toEqual(['0', 'a', 'i', 'q', 't', 'v']);
  });

  it('Q 是素材口径键，自定义快捷键不能占用', () => {
    expect(validateShortcuts({ ...defaultShortcuts, positive: 'q' })).toContain('保留');
    expect(validateShortcuts({ ...defaultShortcuts, positive: 'ctrl+q' })).toBeNull();
  });

  it('输入、输入法、弹窗与预览期间不切类型', () => {
    const switchTo = vi.fn();
    let preview = false;
    const off = registerContentShortcuts(switchTo, () => preview);
    for (const tag of ['input', 'textarea', 'select', 'div']) {
      const el = document.createElement(tag);
      if (tag === 'div') el.setAttribute('contenteditable', 'true');
      document.body.append(el);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
      document.body.removeChild(el);
    }
    for (const extra of [{ isComposing: true }, { repeat: true }, { ctrlKey: true }, { shiftKey: true }, { metaKey: true }, { altKey: true }]) {
      press('t', extra);
    }
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    press('v');
    dialog.remove();
    preview = true;
    press('i');
    expect(switchTo).not.toHaveBeenCalled();
    off();
  });

  it('旧 T 标签键迁移为 Shift+T，并保留自定义快捷键', () => {
    localStorage.setItem('suxing.shortcuts.v1', JSON.stringify({ tags: 't', positive: 'ctrl+q' }));
    expect(loadShortcuts()).toMatchObject({ tags: 'shift+t', positive: 'ctrl+q' });
    expect(validateShortcuts({ ...defaultShortcuts, positive: 'i' })).toContain('保留');
  });

  it('按 a 之后焦点在输入框里再按也不会误触', () => {
    const switchTo = vi.fn();
    const off = registerContentShortcuts(switchTo);
    const input = document.createElement('input');
    document.body.append(input);
    fireEvent.keyDown(input, { key: 'a' });
    expect(switchTo).not.toHaveBeenCalled();
    input.remove();
    press('a');
    expect(switchTo).toHaveBeenCalledWith('audio');
    off();
  });
});