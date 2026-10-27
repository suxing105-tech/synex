import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { get } from 'svelte/store';
import VideoCompare from '../components/VideoCompare.svelte';
import VideoPlayer from '../components/VideoPlayer.svelte';
import { feedItems, multiSelectedIds } from '../lib/stores';
import { compareMode } from '../lib/compare-mode';

vi.mock('../lib/api', () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
videosApi: { open: vi.fn(async () => ({ ok: true, id: 1, path: 'D:/x.mp4' })), copy: vi.fn(async () => ({ ok: true, id: 1, path: 'D:/x.mp4', method: 'clipboard' })) },
}));

const video = (id: number) => ({
  id, filename: `${id}.mp4`, path: `D:/${id}.mp4`, kind: 'video',
  thumbnail_url: `/api/videos/${id}/thumb`, play_url: `/api/videos/${id}/file`, playable: true,
  width: 1920, height: 1080, duration_seconds: 12, mtime: 1, size_bytes: 1000,
  folder_ids: [], tags: [], model: null, seed: null,
});

beforeEach(() => {
  multiSelectedIds.set(new Set());
  feedItems.set([video(1), video(2)] as any);
  // 对比方式是跨组件偏好（还会落 localStorage），每个用例都从默认的左右并排开始。
  compareMode.set('side');
});
afterEach(() => { cleanup(); multiSelectedIds.set(new Set()); feedItems.set([]); });

it('视频对比默认左右并排，可切到分割视图', async () => {
  const ui = render(VideoCompare, { videos: [video(1), video(2)] as any });
  expect(ui.getByRole('button', { name: '并排对比' }).getAttribute('aria-pressed')).toBe('true');
  expect(ui.queryByLabelText('视频对比分割线')).toBeNull();
  expect(ui.getByText('A · 1.mp4')).toBeTruthy();
  expect(ui.getByText('B · 2.mp4')).toBeTruthy();
  // 并排模式有输出两个 video 元素（分割模式用 clip-path 叠放两个 video，也各有 video）
  expect(ui.container.querySelectorAll('video').length).toBe(2);
  await fireEvent.click(ui.getByRole('button', { name: '分割视图' }));
  expect(ui.getByLabelText('视频对比分割线')).toBeTruthy();
});

it('对比开着时按 S 在左右与分割之间反复切换', async () => {
  const ui = render(VideoCompare, { videos: [video(1), video(2)] as any });
  expect(get(compareMode)).toBe('side');
  await fireEvent.keyDown(window, { key: 's' });
  expect(get(compareMode)).toBe('split');
  expect(ui.getByLabelText('视频对比分割线')).toBeTruthy();
  await fireEvent.keyDown(window, { key: 's' });
  expect(get(compareMode)).toBe('side');
  expect(ui.queryByLabelText('视频对比分割线')).toBeNull();
});

it('VideoPlayer 选中两个视频时显示对比按钮，点击进入对比模式', async () => {
  multiSelectedIds.set(new Set([1, 2]));
  const ui = render(VideoPlayer, { open: true, startId: 1 });
  // 进入后默认 compareOn 由 effect 打开
  expect(ui.getByText('退出对比')).toBeTruthy();
  expect(ui.getByText('对比已选中的两个视频')).toBeTruthy();
  await fireEvent.click(ui.getByRole('button', { name: '退出对比' }));
  // 退出后出现「对比」按钮
  expect(ui.getByRole('button', { name: '对比视频' })).toBeTruthy();
});

it('VideoPlayer 只选中一个视频时不显示对比入口', async () => {
  multiSelectedIds.set(new Set([1]));
  const ui = render(VideoPlayer, { open: true, startId: 1 });
  expect(ui.queryByRole('button', { name: '对比视频' })).toBeNull();
});


it('VideoCompare 右键弹出同步菜单，可切换同步/取消同步', async () => {
  const ui = render(VideoCompare, { videos: [video(1), video(2)] as any });
  // 同步状态徽标在分割视图的播放条上，先切过去再看它。
  await fireEvent.click(ui.getByRole('button', { name: '分割视图' }));
  const rootEl = ui.container.querySelector('.video-compare') as HTMLElement;
  await fireEvent.contextMenu(rootEl);
  expect(ui.getByRole('menuitem', { name: '取消同步' })).toBeTruthy();
  await fireEvent.click(ui.getByRole('menuitem', { name: '取消同步' }));
  expect(ui.getByText('已取消同步')).toBeTruthy();
  expect(ui.queryByRole('menuitem')).toBeNull();
  await fireEvent.contextMenu(rootEl);
  expect(ui.getByRole('menuitem', { name: '同步播放' })).toBeTruthy();
});
