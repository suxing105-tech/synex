import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import Feed from '../components/Feed.svelte';
import { cardTitleMode } from '../lib/card-title';
import { feedItems, feedLoading, targetColumns } from '../lib/stores';

/**
 * 卡片页脚的接线（不只是 lib 里的纯函数）：第一行显示后端洗好的提示词、
 * 没提示词退回文件名，第二行是模型徽标 + 元信息，文件名挂在第一行的 title 上没走。
 */

vi.mock('../lib/api', () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: { list: vi.fn().mockResolvedValue({ items: [], total: 0 }), detail: vi.fn() },
  foldersApi: { tree: vi.fn().mockResolvedValue([]) }, statsApi: { get: vi.fn() }, scanApi: { progress: vi.fn() }, comfyuiApi: {},
}));

const NOW = Math.floor(Date.now() / 1000);

function imageItem(over: Record<string, unknown>) {
  return {
    id: 1, item_type: 'media', kind: 'image', filename: 'AnimateDiff_00001.png',
    path: 'D:/lib/AnimateDiff_00001.png', original_url: '/api/images/1/file?max=1024',
    thumbnail_url: '/api/images/1/thumb', width: 1920, height: 1080, mtime: NOW - 600,
    size_bytes: 5_500_000, duration_seconds: null, playable: true,
    model: 'Krea2\\krea2_turbo_bf16.safetensors', tags: [], folder_ids: [],
    prompt_snippet: '一位穿米色风衣的女性站在落地窗前',
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  feedItems.set([]);
  cardTitleMode.set('prompt');
});

it('第一行显示提示词那句，文件名退到 title 里', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  targetColumns.set(3); // 列宽约 293px：宽卡，尺寸该露面
  feedLoading.set(false);
  feedItems.set([imageItem({})] as never);
  const { container } = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
  await tick();

  const name = container.querySelector('.media-card-name') as HTMLElement;
  expect(name.textContent?.trim()).toBe('一位穿米色风衣的女性站在落地窗前');
  // 老口径没丢：整张卡带着 title=文件名，鼠标停上去仍然看得出这是 .png 还是 .psd
  // （title 只挂在卡片根上，不在页脚那一行再挂一份——挂两处会有两个同名元素，测试和读屏都会撞车）
  expect((name.closest('.media-card') as HTMLElement).getAttribute('title')).toBe('AnimateDiff_00001.png');
  expect(name.hasAttribute('title')).toBe(false);

  const badge = container.querySelector('.media-card-model') as HTMLElement;
  expect(badge.textContent).toBe('Krea2');
  const bits = container.querySelector('.media-card-bits') as HTMLElement;
  expect(bits.textContent).toBe('1920×1080 · 10 分前');
  // 文件大小从卡片撤了
  expect(bits.textContent).not.toMatch(/MB/);
});

it('窄一点的卡先撤尺寸，徽标和时间留着', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  targetColumns.set(5); // 列宽约 172px：还是两行页脚，但放不下尺寸
  feedLoading.set(false);
  feedItems.set([imageItem({})] as never);
  const { container } = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
  await tick();
  const bits = container.querySelector('.media-card-bits') as HTMLElement;
  expect(bits.textContent).toBe('10 分前');
  expect(container.querySelector('.media-card-model')?.textContent).toBe('Krea2');
});

it('没提示词的退回文件名；音频卡不许显示波形画布的 840×360', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  targetColumns.set(3);
  feedLoading.set(false);
  feedItems.set([
    imageItem({ prompt_snippet: '' }),
    imageItem({
      id: 2, kind: 'audio', filename: '旁白.mp3', original_url: '/api/audio/2/file',
      thumbnail_url: '/api/audio/2/wave', width: 840, height: 360, duration_seconds: 95,
      model: null, prompt_snippet: '', mtime: NOW - 3 * 86400,
    }),
  ] as never);
  const { container } = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
  await tick();
  const names = [...container.querySelectorAll('.media-card-name')].map((n) => n.textContent?.trim());
  expect(names).toEqual(['AnimateDiff_00001.png', '旁白.mp3']);
  const allBits = [...container.querySelectorAll('.media-card-bits')].map((n) => n.textContent);
  expect(allBits.join('|')).not.toContain('840×360');
  // 音频给时长，没有模型的就不给徽标
  // 音频给时长 + 时间；时间距今三天，落在月日那一档（不写死今天减三天的日期，避免跨月误报）
  expect(allBits[1]).toMatch(/^1:35 · \d{2}\/\d{2}$/);
  expect(container.querySelectorAll('.media-card-model')).toHaveLength(1);
});

it('设置里切回文件名，瀑布流立刻跟着换', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  targetColumns.set(3);
  feedLoading.set(false);
  feedItems.set([imageItem({})] as never);
  const { container } = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
  await tick();
  cardTitleMode.set('filename');
  await tick();
  expect(container.querySelector('.media-card-name')?.textContent?.trim()).toBe('AnimateDiff_00001.png');
});
