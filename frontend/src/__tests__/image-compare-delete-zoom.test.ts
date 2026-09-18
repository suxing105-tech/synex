import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import Feed from '../components/Feed.svelte';
import Lightbox from '../components/Lightbox.svelte';
import ImageCompare from '../components/ImageCompare.svelte';
import { feedItems, feedLoading, multiSelectedIds, selectedId } from '../lib/stores';
import { getOrientedImageSize } from '../lib/image-dims';
import { foldersApi, imagesApi } from '../lib/api';
vi.mock('../lib/api', () => ({
  imagesApi: { list: vi.fn().mockResolvedValue({ items: [], total: 0 }), detail: vi.fn(), remove: vi.fn() },
  foldersApi: { tree: vi.fn().mockResolvedValue([]) }, statsApi: { get: vi.fn() }, scanApi: { progress: vi.fn() }, comfyuiApi: {},
}));
vi.mock('../lib/image-dims', async (original) => ({ ...await original<any>(), getOrientedImageSize: vi.fn().mockResolvedValue({ w: 1600, h: 900 }) }));
const items = [1, 2, 3].map(id => ({ id, filename: `${id}.jpg`, path: `D:/${id}.jpg`, width: 1600, height: 900, size_bytes: 2000 }));
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.mocked(getOrientedImageSize).mockResolvedValue({ w: 1600, h: 900 });
  vi.mocked(imagesApi.list).mockImplementation(async () => ({ items: get(feedItems), total: get(feedItems).length }) as any);
  vi.mocked(foldersApi.tree).mockResolvedValue([] as any);
  feedLoading.set(false); feedItems.set(items as any); multiSelectedIds.set(new Set()); selectedId.set(null);
  vi.mocked(imagesApi.remove).mockReset().mockResolvedValue({ ok: true, cleaned_previews: 1 } as any);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(imagesApi.list).mockResolvedValue({ items: [], total: 0 } as any); feedItems.set([]); multiSelectedIds.set(new Set()); });
it('两张选中图片预览自动进入对比，并可切换单图', async () => {
  multiSelectedIds.set(new Set([1, 2]));
  const screen = render(Lightbox, { open: true, index: 0, selectedId: 1 });
  expect(screen.getByAltText('A：1.jpg').getAttribute('src')).toMatch(/\/1\/file$/);
  expect(screen.getByAltText('B：2.jpg').getAttribute('src')).toMatch(/\/2\/file$/);
  await fireEvent.click(screen.getByText('查看单图'));
  expect(screen.queryByLabelText('图片对比分割线')).toBeNull();
  expect(screen.getByAltText('1.jpg')).toBeTruthy();
});
it('分割线位置改变裁切范围，原图不拉伸', async () => {
  const screen = render(ImageCompare, { images: items.slice(0, 2) as any });
  await fireEvent.input(screen.getByLabelText('图片对比分割线'), { target: { value: '25' } });
  expect(screen.container.querySelector('.compare-overlay')?.getAttribute('style')).toContain('75%');
});
it('多选 Delete 成功移除原图及缩略图，失败项保留', async () => {
  multiSelectedIds.set(new Set([1, 2]));
  vi.mocked(imagesApi.remove).mockRejectedValueOnce(new Error('locked')).mockResolvedValueOnce({ ok: true } as any);
  render(Feed, { selectedId: 1, lightboxOpen: false, lightboxIndex: 0 });
  await fireEvent.keyDown(window, { key: 'Delete' });
  await waitFor(() => expect(imagesApi.remove).toHaveBeenCalledTimes(2));
  await tick();
  expect(imagesApi.remove).toHaveBeenCalledWith(2, true);
  expect(get(feedItems).map(i => i.id)).toEqual([1, 3]);
  expect(get(multiSelectedIds).has(1)).toBe(true);
});
it('输入框及重复按键不删除，打开预览后 Feed 不重复删除', async () => {
  multiSelectedIds.set(new Set([1]));
  const screen = render(Feed, { selectedId: 1, lightboxOpen: false, lightboxIndex: 0 });
  const input = document.createElement('input'); document.body.append(input);
  await fireEvent.keyDown(input, { key: 'Delete' }); input.remove();
  await fireEvent.keyDown(window, { key: 'Delete', repeat: true });
  await screen.rerender({ selectedId: 1, lightboxOpen: true, lightboxIndex: 0 });
  await fireEvent.keyDown(window, { key: 'Delete' });
  expect(imagesApi.remove).not.toHaveBeenCalled();
});
it('对比中的 Delete 删除两张，保留未选图片', async () => {
  multiSelectedIds.set(new Set([1, 2]));
  render(Lightbox, { open: true, index: 0, selectedId: 1 });
  await fireEvent.keyDown(window, { key: 'Delete' });
  await waitFor(() => expect(get(feedItems).map(i => i.id)).toEqual([3]));
  expect(imagesApi.remove).toHaveBeenCalledTimes(2);
});
it('单图滚轮向前放大、向后缩小，适应窗口可复位', async () => {
  const screen = render(Lightbox, { open: true, index: 0, selectedId: 1 });
  const img = screen.getByAltText('1.jpg') as HTMLImageElement;
  Object.defineProperties(img, { naturalWidth: { value: 1600 }, naturalHeight: { value: 900 } });
  await fireEvent.load(img); await tick();
  const canvas = screen.container.querySelector('.viewer-canvas')!;
  const before = parseFloat(img.style.width);
  await fireEvent.wheel(canvas, { deltaY: -100, clientX: 450, clientY: 300 });
  const enlarged = parseFloat(img.style.width);
  expect(enlarged).toBeGreaterThan(before);
  await fireEvent.wheel(canvas, { deltaY: 100, clientX: 450, clientY: 300 });
  expect(parseFloat(img.style.width)).toBeLessThan(enlarged);
  await fireEvent.click(screen.getByText('适应窗口'));
  expect(parseFloat(img.style.width)).toBeCloseTo(before, 0);
});

it('双选后双击保留对比对象，工具栏提供对比入口', async () => {
  multiSelectedIds.set(new Set([1, 2]));
  const screen = render(Feed, { selectedId: 1, lightboxOpen: false, lightboxIndex: 0 });
  expect(screen.getByText('对比图片')).toBeTruthy();
  const image = screen.getByAltText('1.jpg');
  await fireEvent.click(image);
  await fireEvent.doubleClick(image);
  expect([...get(multiSelectedIds)]).toEqual([1, 2]);
});
it('按住 Delete 不会对同一张图片发起重复删除', async () => {
  multiSelectedIds.set(new Set([1]));
  let finish!: (value: any) => void;
  vi.mocked(imagesApi.remove).mockImplementation(() => new Promise(resolve => finish = resolve));
  render(Feed, { selectedId: 1, lightboxOpen: false, lightboxIndex: 0 });
  await fireEvent.keyDown(window, { key: 'Delete' });
  await fireEvent.keyDown(window, { key: 'Delete' });
  expect(imagesApi.remove).toHaveBeenCalledTimes(1);
  finish({ ok: true }); await tick();
});
