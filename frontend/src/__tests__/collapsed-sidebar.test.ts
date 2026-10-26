import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { get } from 'svelte/store';
import CollapsedSidebar from '../components/CollapsedSidebar.svelte';
import { folderId, query, scope, tag } from '../lib/stores';

beforeEach(() => {
  scope.set('image');
  folderId.set(null);
  query.set('');
  tag.set(null);
});
afterEach(cleanup);

describe('收起的左侧栏', () => {
  it('显示所有素材、图片、视频、音频、文本五个入口，并保留展开按钮', () => {
    const screen = render(CollapsedSidebar, { onexpand: vi.fn() });
    for (const label of ['所有素材', '全部图片', '所有视频', '全部音频', '全部文本', '展开左侧栏']) {
      const button = screen.getByRole('button', { name: label });
      expect(button.querySelector('svg')).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: '全部图片' }).getAttribute('aria-current')).toBe('page');
  });

  it('收藏与最近生成不在收起侧栏里', () => {
    const screen = render(CollapsedSidebar, { onexpand: vi.fn() });
    for (const label of ['收藏', '最近生成']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });

  it('收起侧栏点击对应全库内容，清空所属文件夹和筛选', async () => {
    const screen = render(CollapsedSidebar, { onexpand: vi.fn() });
    folderId.set(42);
    query.set('关键词');
    tag.set('旧标签');

    await fireEvent.click(screen.getByRole('button', { name: '所有视频' }));
    expect(get(scope)).toBe('video');
    expect(get(scope)).toBe('video');
    expect(get(folderId)).toBeNull();
    expect(get(query)).toBe('');
    expect(get(tag)).toBeNull();
    expect(screen.getByRole('button', { name: '所有视频' }).getAttribute('aria-current')).toBe('page');

    await fireEvent.click(screen.getByRole('button', { name: '全部音频' }));
    expect(get(scope)).toBe('audio');

    await fireEvent.click(screen.getByRole('button', { name: '全部文本' }));
    expect(get(scope)).toBe('text');
    expect(screen.getByRole('button', { name: '全部文本' }).getAttribute('aria-current')).toBe('page');

    await fireEvent.click(screen.getByRole('button', { name: '所有素材' }));
    expect(get(scope)).toBe('all');
    expect(screen.getByRole('button', { name: '所有素材' }).getAttribute('aria-current')).toBe('page');
  });

  it('点展开按钮回调展开回调', async () => {
    const onexpand = vi.fn();
    const screen = render(CollapsedSidebar, { onexpand });
    await fireEvent.click(screen.getByRole('button', { name: '展开左侧栏' }));
    expect(onexpand).toHaveBeenCalledOnce();
  });
});