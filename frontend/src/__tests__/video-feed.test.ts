import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { get } from 'svelte/store';
import Feed from '../components/Feed.svelte';
import { feedItems, feedLoading, feedTotal, kind, multiSelectedIds } from '../lib/stores';
import { videosApi } from '../lib/api';

vi.mock('../lib/api', () => ({
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) }, statsApi: { get: vi.fn() }, scanApi: { progress: vi.fn() }, comfyuiApi: {},
  videosApi: { open: vi.fn(async () => ({ ok: true, id: 1, path: 'D:/x.mp4' })) },
}));

const video = (id: number, playable: boolean) => ({
  id, filename: `${id}.mp4`, path: `D:/${id}.mp4`, kind: 'video',
  thumbnail_url: `/api/videos/${id}/thumb`, play_url: `/api/videos/${id}/file`, playable,
  width: 1920, height: 1080, duration_seconds: 12, mtime: 1, size_bytes: 1000,
  favorite: false, folder_ids: [], tags: [], model: null, seed: null,
});

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  feedLoading.set(false); feedTotal.set(1); multiSelectedIds.set(new Set());
  kind.set('video');
  feedItems.set([video(1, true)] as any);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); kind.set('image'); feedItems.set([]); feedTotal.set(0); });

it('视频卡片渲染居中播放按钮，点击可弹层 open-video-player 事件', async () => {
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  const screen = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
  expect(screen.getByLabelText('播放 1.mp4')).toBeTruthy();
  expect(screen.getByLabelText('播放 1.mp4').querySelector('svg.video-play-icon')).toBeTruthy();
  await fireEvent.click(screen.getByLabelText('播放 1.mp4'));
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'open-video-player' }));
  expect(get(feedItems)[0].id).toBe(1);
});

it('不可播放的视频点击播放按钮调用系统播放器 open', async () => {
  feedTotal.set(1);
  feedItems.set([video(2, false)] as any);
  const screen = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
  await fireEvent.click(screen.getByLabelText('播放 2.mp4'));
  expect(videosApi.open).toHaveBeenCalledWith(2);
});

it('视频视图双击卡片同样打开播放', async () => {
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  const screen = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
  await fireEvent.doubleClick(screen.getByTitle('1.mp4'));
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'open-video-player' }));
});

it('视频视图工具栏计数使用「个」而非「张」', async () => {
  feedTotal.set(3);
  const screen = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
  expect(screen.getByText(/3 个/)).toBeTruthy();
});
