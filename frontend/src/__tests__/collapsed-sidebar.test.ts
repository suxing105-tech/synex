import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { get } from 'svelte/store';
import CollapsedSidebar from '../components/CollapsedSidebar.svelte';
import { folderId, kind, query, tag, textMode, view } from '../lib/stores';

beforeEach(() => {
  textMode.set(false);
  kind.set('image');
  folderId.set(null);
  view.set('all');
  query.set('');
  tag.set(null);
});
afterEach(cleanup);

describe('收起的左侧栏', () => {
  it('显示图片、视频、文本三个可点击图标，并保留展开按钮', () => {
    const screen = render(CollapsedSidebar, { onexpand: vi.fn() });
    for (const label of ['全部图片', '所有视频', '全部文本', '展开左侧栏']) {
      const button = screen.getByRole('button', { name: label });
      expect(button.querySelector('svg')).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: '全部图片' }).getAttribute('aria-current')).toBe('page');
  });

  it('点击入口切到对应的全部内容，并清除旧文件夹和筛选', async () => {
    const screen = render(CollapsedSidebar, { onexpand: vi.fn() });
    folderId.set(42);
    view.set('favorite');
    query.set('旧搜索');
    tag.set('旧标签');

    await fireEvent.click(screen.getByRole('button', { name: '所有视频' }));
    expect(get(kind)).toBe('video');
    expect(get(textMode)).toBe(false);
    expect(get(folderId)).toBeNull();
    expect(get(view)).toBe('all');
    expect(get(query)).toBe('');
    expect(get(tag)).toBeNull();
    expect(screen.getByRole('button', { name: '所有视频' }).getAttribute('aria-current')).toBe('page');

    await fireEvent.click(screen.getByRole('button', { name: '全部文本' }));
    expect(get(textMode)).toBe(true);
    expect(screen.getByRole('button', { name: '全部文本' }).getAttribute('aria-current')).toBe('page');

    await fireEvent.click(screen.getByRole('button', { name: '全部图片' }));
    expect(get(kind)).toBe('image');
    expect(get(textMode)).toBe(false);
  });

  it('点击展开按钮触发展开回调', async () => {
    const onexpand = vi.fn();
    const screen = render(CollapsedSidebar, { onexpand });
    await fireEvent.click(screen.getByRole('button', { name: '展开左侧栏' }));
    expect(onexpand).toHaveBeenCalledOnce();
  });
});
