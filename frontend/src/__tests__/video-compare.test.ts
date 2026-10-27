import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { tick } from 'svelte';
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

const videosOf = (ui: { container: HTMLElement }) =>
  Array.from(ui.container.querySelectorAll('video')) as HTMLVideoElement[];

beforeEach(() => {
  multiSelectedIds.set(new Set());
  feedItems.set([video(1), video(2)] as any);
  // 对比方式是跨组件偏好（还会落 localStorage），每个用例都从默认的左右并排开始。
  compareMode.set('side');
});
afterEach(() => { cleanup(); multiSelectedIds.set(new Set()); feedItems.set([]); });

it('视频对比默认左右并排，切到分割对比后出现分割线', async () => {
  const ui = render(VideoCompare, { videos: [video(1), video(2)] as any });
  expect(get(compareMode)).toBe('side');
  expect(ui.queryByLabelText('视频对比分割线')).toBeNull();
  expect(ui.getByText('A · 1.mp4')).toBeTruthy();
  expect(ui.getByText('B · 2.mp4')).toBeTruthy();
  expect(videosOf(ui)).toHaveLength(2);
  // 开关在播放器顶栏，所以这里直接改偏好（同一份 compareMode）验证画面跟随
  compareMode.set('split');
  await tick();
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
  expect(ui.getByText('退出对比')).toBeTruthy();
  expect(ui.getByText('对比已选中的两个视频')).toBeTruthy();
  await fireEvent.click(ui.getByRole('button', { name: '退出对比' }));
  expect(ui.getByRole('button', { name: '对比视频' })).toBeTruthy();
});

it('退出对比后不会被自动重新打开（换一组选中才再自动开）', async () => {
  multiSelectedIds.set(new Set([1, 2]));
  const ui = render(VideoPlayer, { open: true, startId: 1 });
  await fireEvent.click(ui.getByRole('button', { name: '退出对比' }));
  expect(ui.queryByText('对比已选中的两个视频')).toBeNull();
  multiSelectedIds.set(new Set());
  await tick();
  multiSelectedIds.set(new Set([1, 2]));
  await tick();
  expect(ui.getByText('对比已选中的两个视频')).toBeTruthy();
});

it('VideoPlayer 只选中一个视频时不显示对比入口', async () => {
  multiSelectedIds.set(new Set([1]));
  const ui = render(VideoPlayer, { open: true, startId: 1 });
  expect(ui.queryByRole('button', { name: '对比视频' })).toBeNull();
});

it('对比方式开关在播放器顶栏，和图片同一处；画面里不再有底部开关', async () => {
  multiSelectedIds.set(new Set([1, 2]));
  const ui = render(VideoPlayer, { open: true, startId: 1 });
  const group = ui.getByRole('group', { name: '视频对比方式' });
  expect(group.closest('header')).toBeTruthy();
  expect(group.querySelector('[aria-label="左右对比"]')?.getAttribute('aria-pressed')).toBe('true');
  await fireEvent.click(group.querySelector('[aria-label="分割对比"]') as Element);
  expect(get(compareMode)).toBe('split');
  // 老位置的按钮必须消失，否则同一件事又变成两个地方
  expect(ui.queryByRole('button', { name: '分割视图' })).toBeNull();
  expect(ui.queryByRole('button', { name: '并排对比' })).toBeNull();
});

it('右键菜单给出同步播放 / 同步停止 / 取消同步', async () => {
  const ui = render(VideoCompare, { videos: [video(1), video(2)] as any });
  const rootEl = ui.container.querySelector('.video-compare') as HTMLElement;
  await fireEvent.contextMenu(rootEl);
  const names = Array.from(ui.getByRole('menu').querySelectorAll('button')).map((b) => b.textContent?.trim());
  expect(names).toEqual(['同步播放', '同步停止', '取消同步']);
});

it('同步停止让两路都停下；同步播放把 B 拉回 A 的进度再一起放', async () => {
  const ui = render(VideoCompare, { videos: [video(1), video(2)] as any });
  const [a, b] = videosOf(ui);
  const playA = vi.spyOn(a, 'play').mockResolvedValue(undefined as never);
  const playB = vi.spyOn(b, 'play').mockResolvedValue(undefined as never);
  const rootEl = ui.container.querySelector('.video-compare') as HTMLElement;

  a.currentTime = 4;
  b.currentTime = 1;
  await fireEvent.contextMenu(rootEl);
  await fireEvent.click(ui.getByRole('menuitem', { name: '同步停止' }));
  expect(a.paused).toBe(true);
  expect(b.paused).toBe(true);
  expect(playA).not.toHaveBeenCalled();

  await fireEvent.contextMenu(rootEl);
  await fireEvent.click(ui.getByRole('menuitem', { name: '同步播放' }));
  expect(b.currentTime).toBe(4);
  expect(playA).toHaveBeenCalled();
  expect(playB).toHaveBeenCalled();
});

it('取消同步后 B 不再跟随 A，重新同步时进度对齐', async () => {
  compareMode.set('split');
  const ui = render(VideoCompare, { videos: [video(1), video(2)] as any });
  await tick();
  // 分割模式里 B 是底片、A 是覆盖层，播放条上的徽标反映同步状态
  const [b, a] = videosOf(ui);
  const rootEl = ui.container.querySelector('.video-compare') as HTMLElement;
  expect(ui.getByText('同步播放')).toBeTruthy();
  await fireEvent.contextMenu(rootEl);
  await fireEvent.click(ui.getByRole('menuitem', { name: '取消同步' }));
  expect(ui.getByText('已取消同步')).toBeTruthy();
  a.currentTime = 3;
  b.currentTime = 0;
  await fireEvent.contextMenu(rootEl);
  await fireEvent.click(ui.getByRole('menuitem', { name: '开启同步' }));
  expect(b.currentTime).toBe(3);
  expect(ui.getByText('同步播放')).toBeTruthy();
});
