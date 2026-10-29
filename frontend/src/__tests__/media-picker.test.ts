import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import MediaPickerModal from '../components/MediaPickerModal.svelte';
import { imagesApi } from '../lib/api';
import { splitIntoColumns } from '../lib/media-format';

/**
 * 素材选择器的画面框必须跟图片自己的宽高比一致：
 * 之前固定 4:3 + 不写 object-fit，竖图被硬压成横条，用户第一反应就是「缩略图变形了」。
 */
vi.mock('../lib/api', () => ({
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
}));

const ITEMS = [
  { id: 1, filename: 'tall.png', path: 'D:/tall.png', kind: 'image', width: 768, height: 1360, original_url: '/api/images/1/file', thumbnail_url: '/api/images/1/file' },
  { id: 2, filename: 'wide.png', path: 'D:/wide.png', kind: 'image', width: 1920, height: 1080, original_url: '/api/images/2/file', thumbnail_url: '/api/images/2/file' },
  { id: 3, filename: 'unknown.png', path: 'D:/unknown.png', kind: 'image', width: null, height: null, original_url: '/api/images/3/file', thumbnail_url: '/api/images/3/file' },
] as any[];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function opened() {
  (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: ITEMS, total: 3 });
  const screen = render(MediaPickerModal, { open: true, onPick: () => {}, onClose: () => {} });
  await screen.findByRole('button', { name: 'tall.png' });
  return screen;
}

it('每张素材按自己的宽高比排框，竖图不再被压成横条', async () => {
  const screen = await opened();
  const boxOf = (name: string) => (screen.getByRole('button', { name }).querySelector('.media-card-media') as HTMLElement).style.aspectRatio;
  expect(boxOf('tall.png')).toBe('768 / 1360');
  expect(boxOf('wide.png')).toBe('1920 / 1080');
  expect(boxOf('unknown.png')).toBe('1 / 1');
});

it('画面用等比缩放而不是拉伸，读不到尺寸时退回方形', async () => {
  const screen = await opened();
  const img = screen.getByRole('button', { name: 'tall.png' }).querySelector('img') as HTMLImageElement;
  expect(img.classList.contains('object-contain')).toBe(true);
  expect(img.classList.contains('object-cover')).toBe(false);
});

it('点一张就交出去并收起', async () => {
  const onPick = vi.fn();
  const onClose = vi.fn();
  (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: ITEMS, total: 3 });
  const screen = render(MediaPickerModal, { open: true, onPick, onClose });
  await fireEvent.click(await screen.findByRole('button', { name: 'wide.png' }));
  await tick();
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
  expect(onClose).toHaveBeenCalled();
});

describe('分列而不是分行', () => {
  it('按当前最矮的一列投放：数量尽量平均，短的图下面不再空出一大块', () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ id: i + 1 }));
    const cols = splitIntoColumns(items, 4, () => 1);
    expect(cols.map((c) => c.length)).toEqual([3, 2, 2, 2]);
    expect(cols.flat().map((i) => i.id)).toEqual([1, 5, 9, 2, 6, 3, 7, 4, 8]);
  });

  it('竖图先占住第一列时，后面的横图自动去矮列，而不是把第一列越堆越长', () => {
    const items = [
      { id: 1, h: 2 }, { id: 2, h: 0.5 }, { id: 3, h: 0.5 }, { id: 4, h: 0.5 }, { id: 5, h: 0.5 },
    ];
    const cols = splitIntoColumns(items, 2, (i) => i.h);
    expect(cols.map((c) => c.map((i) => i.id))).toEqual([[1], [2, 3, 4, 5]]);
  });

  it('列数至少 1，空列表给的是空的列而不是 undefined', () => {
    expect(splitIntoColumns([], 0, () => 1).length).toBe(1);
    expect(splitIntoColumns([{ id: 1 }], 3, () => Number.NaN).map((c) => c.length)).toEqual([1, 0, 0]);
  });

  it('选择器把卡片装进列容器里，卡片不再是网格的直接子元素', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      id: i + 1, filename: `p${i}.png`, path: `D:/p${i}.png`, kind: 'image' as const,
      width: 768, height: 1360, original_url: '/api/images/1/file', thumbnail_url: '/api/images/1/file',
    }));
    (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: many, total: 7 });
    const screen = render(MediaPickerModal, { open: true, onPick: () => {}, onClose: () => {} });
    await screen.findByRole('button', { name: 'p0.png' });
    const cols = screen.container.querySelectorAll('.mp-col');
    expect(cols.length).toBe(4);
    expect(screen.container.querySelectorAll('.mp-grid > .mp-card')).toHaveLength(0);
    expect([...cols].reduce((sum, c) => sum + c.querySelectorAll('.mp-card').length, 0)).toBe(7);
  });
});

it('列容器不让卡片被拉伸：这两条规则少了任何一条，缩略图就会重新被压扁', () => {
  // happy-dom 不会注入 scoped CSS，算不出 computed style，所以直接钉住样式源头。
  const css = readFileSync('src/components/MediaPickerModal.svelte', 'utf8');
  expect(css).toMatch(/\.mp-grid\s*\{[^}]*align-items:\s*flex-start/);
  expect(css).toMatch(/\.mp-col\s*>\s*\.mp-card\s*\{[^}]*flex:\s*none/);
});

it('选择器按弹窗自己的高度撑开，不再被全局 .media-pick-grid 的 480px 压成一条窄带', () => {
  const css = readFileSync('src/components/MediaPickerModal.svelte', 'utf8');
  // 弹窗更宽 → 每张缩略图 ~240px，和图库页面上的观感一个量级
  expect(css).toMatch(/\.mp-panel\s*\{[^}]*width:\s*min\(1040px/);
  // 网格跟着弹窗高度走；少了这条就只剩四张可见，用户得一直滚
  expect(css).toMatch(/\.mp-grid\s*\{[^}]*max-height:\s*calc\(84vh/);
});
