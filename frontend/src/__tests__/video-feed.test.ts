import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { get } from 'svelte/store';
import Feed from '../components/Feed.svelte';
import { feedItems, feedLoading, feedTotal, feedCounts, scope, multiSelectedIds } from '../lib/stores';
import { videosApi } from '../lib/api';

vi.mock('../lib/api', () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) }, statsApi: { get: vi.fn() }, scanApi: { progress: vi.fn() }, comfyuiApi: {},
  videosApi: { open: vi.fn(async () => ({ ok: true, id: 1, path: 'D:/x.mp4' })), copy: vi.fn(async () => ({ ok: true, id: 1, path: 'D:/x.mp4', method: 'clipboard' })) },
}));

const video = (id: number, playable: boolean) => ({
  id, filename: `${id}.mp4`, path: `D:/${id}.mp4`, kind: 'video',
  thumbnail_url: `/api/videos/${id}/thumb`, play_url: `/api/videos/${id}/file`, playable,
  width: 1920, height: 1080, duration_seconds: 12, mtime: 1, size_bytes: 1000,
  item_type: 'media', folder_ids: [], tags: [], model: null, seed: null,
});

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  // jsdom 没实现 play()，不接管会往控制台倒一堆 Not implemented
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined as never);
  feedLoading.set(false); feedTotal.set(1); multiSelectedIds.set(new Set());
  scope.set('video');
  feedCounts.set({ image: 0, video: 1, audio: 0, text: 0 });
  feedItems.set([video(1, true)] as any);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); scope.set('all'); feedItems.set([]); feedTotal.set(0); feedCounts.set({ image: 0, video: 0, audio: 0, text: 0 }); });

it('视频卡片不再有播放按钮，画面自己就是预览入口', async () => {
  const screen = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
  const card = screen.getByTitle('1.mp4');
  expect(screen.queryByLabelText('播放 1.mp4')).toBeNull();
  expect(card.querySelector('.video-play-icon')).toBeNull();
});

it('鼠标滑过挂上静音循环预览视频，移开立刻卸载（同一时刻只解码一条）', async () => {
  const screen = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
  const card = screen.getByTitle('1.mp4');
  expect(card.querySelector('video.media-card-video')).toBeNull();
  await fireEvent.mouseEnter(card);
  const v = card.querySelector('video.media-card-video') as HTMLVideoElement;
  expect(v).toBeTruthy();
  expect(v.muted).toBe(true);
  expect(v.loop).toBe(true);
  expect(v.hasAttribute('autoplay')).toBe(true);
  expect(v.getAttribute('src')).toContain('/api/videos/1/file');
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  await fireEvent.mouseLeave(card);
  expect(card.querySelector('video.media-card-video')).toBeNull();
});

it('内核解不了的容器不挂预览视频，双击走系统播放器 open', async () => {
  feedTotal.set(1);
  feedItems.set([video(2, false)] as any);
  const screen = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
  const card = screen.getByTitle('2.mp4');
  await fireEvent.mouseEnter(card);
  expect(card.querySelector('video.media-card-video')).toBeNull();
  await fireEvent.doubleClick(card);
  expect(videosApi.open).toHaveBeenCalledWith(2);
});

it('视频视图双击卡片打开内置播放器（删掉播放按钮后双击就是入口）', async () => {
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  const screen = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
  await fireEvent.doubleClick(screen.getByTitle('1.mp4'));
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'open-video-player' }));
  expect(get(feedItems)[0].id).toBe(1);
});

it('视频口径的工具栏计数用「个视频」而不是「张图片」', async () => {
  feedTotal.set(3);
  feedCounts.set({ image: 0, video: 3, audio: 0, text: 0 });
  const screen = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
  expect(screen.getByText(/3 个/)).toBeTruthy();
});


it('视频右键菜单显示「复制视频」，点击调用 videosApi.copy', async () => {
  const screen = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
  await fireEvent.contextMenu(screen.getByTitle('1.mp4'));
  expect(screen.getByText('复制视频')).toBeTruthy();
  expect(screen.queryByText('复制图片')).toBeNull();
  await fireEvent.click(screen.getByText('复制视频'));
  expect(videosApi.copy).toHaveBeenCalledWith(1);
});
