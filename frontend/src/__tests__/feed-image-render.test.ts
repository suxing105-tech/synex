import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import Feed from '../components/Feed.svelte';
import { feedItems, feedLoading, multiSelectedIds } from '../lib/stores';
import { isMediaItem } from '../lib/items';
import type { MediaFeedItem } from '../lib/types';

vi.mock('../lib/api', () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
imagesApi: { list: vi.fn().mockResolvedValue({ items: [], total: 0 }), detail: vi.fn() },
  foldersApi: { tree: vi.fn().mockResolvedValue([]) }, statsApi: { get: vi.fn() }, scanApi: { progress: vi.fn() }, comfyuiApi: {},
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); feedItems.set([]); });

it('横竖图片使用各自比例，缺失尺寸在图片加载后校正，禁用缩略图的默认拖出', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  feedLoading.set(false);
  feedItems.set([
    { id: 1, item_type: 'media', kind: 'image', filename: 'landscape.jpg', path: 'D:/landscape.jpg', original_url: '/api/images/1/file?max=1024', width: 1600, height: 900 },
    { id: 2, item_type: 'media', kind: 'image', filename: 'portrait.png', path: 'D:/portrait.png', original_url: '/api/images/2/file?max=1024', width: 600, height: 1200 },
    { id: 3, item_type: 'media', kind: 'image', filename: 'missing.jpg', path: 'D:/missing.jpg', original_url: '/api/images/3/file?max=1024', width: null, height: null },
  ] as any);
  multiSelectedIds.set(new Set([1, 2]));
  const screen = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
  await tick();
  const landscape = screen.getByAltText('landscape.jpg') as HTMLImageElement;
  const portrait = screen.getByAltText('portrait.png') as HTMLImageElement;
  expect(landscape.parentElement?.getAttribute('style')).toContain('1600 / 900');
  expect(portrait.parentElement?.getAttribute('style')).toContain('600 / 1200');
  expect(landscape.parentElement?.classList.contains('is-selected')).toBe(true);
  expect(landscape.parentElement?.className).not.toContain('outline-[6px]');
  expect(landscape.getAttribute('draggable')).toBe('false');
  expect(landscape.classList.contains('object-contain')).toBe(true);
  const missing = screen.getByAltText('missing.jpg') as HTMLImageElement;
  Object.defineProperties(missing, { naturalWidth: { value: 300 }, naturalHeight: { value: 900 } });
  await fireEvent.load(missing);
  const after = get(feedItems).find((item): item is MediaFeedItem => isMediaItem(item) && item.id === 3);
  expect(after?.height).toBe(900);
  expect(screen.getByAltText('missing.jpg').parentElement?.getAttribute('style')).toContain('300 / 900');
});
