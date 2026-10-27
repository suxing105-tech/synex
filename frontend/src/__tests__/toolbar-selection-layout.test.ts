import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import Feed from '../components/Feed.svelte';
import { feedItems, feedLoading, multiSelectedIds, targetColumns } from '../lib/stores';
vi.mock('../lib/api', () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
imagesApi: { list: vi.fn(async () => ({ items: get(feedItems), total: get(feedItems).length })), detail: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) }, statsApi: { get: vi.fn() }, scanApi: { progress: vi.fn() }, comfyuiApi: {},
}));
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  feedLoading.set(false); multiSelectedIds.set(new Set());
  feedItems.set([1, 2, 3].map(id => ({ id, item_type: 'media', kind: 'image', filename: `${id}.jpg`, width: 900, height: 1200 })) as any);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('0、1、2、3 张选中时搜索和列数始终占用原来的工具栏位置', async () => {
  const screen = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
  const toolbar = screen.container.querySelector('.gallery-toolbar')!;
  const searchSlot = screen.getByLabelText('搜索图片、视频、音频、文本').parentElement;
  const columnsSlot = screen.container.querySelector('.columns-slider')!.parentElement;
  for (const count of [0, 1, 2, 3, 2, 0]) {
    multiSelectedIds.set(new Set(Array.from({ length: count }, (_, i) => i + 1))); await tick();
    expect(toolbar.children).toHaveLength(3);
    expect(toolbar.children[1]).toBe(searchSlot);
    expect(toolbar.children[2]).toBe(columnsSlot);
    // 选中两张图片也不会在标题旁冒出「对比图片」：对比入口只在预览层里
    if (count === 2) expect(toolbar.children[0].textContent).not.toContain('对比图片');
  }
});
it('改名输入框使用紧凑宽度，保留完整文件名供编辑', async () => {
  const screen = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
  await fireEvent.doubleClick(screen.getByText('1.jpg'));
  const input = screen.getByLabelText('编辑图片名称') as HTMLInputElement;
  expect(input.value).toBe('1');
  expect(getComputedStyle(input).width).toBe('180px');
  expect(getComputedStyle(input).maxWidth).toBe('100%');
});

it('列数控件只显示滑块，拖动仍更新列数', async () => {
  const screen = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
  const slider = screen.getByRole('slider', { name: '列数' });
  expect(screen.queryByText('列数')).toBeNull();
  expect(screen.queryByText(/^[0-9]+ 列$/)).toBeNull();
  await fireEvent.input(slider, { target: { value: '8' } });
  expect(get(targetColumns)).toBe(8);
});
