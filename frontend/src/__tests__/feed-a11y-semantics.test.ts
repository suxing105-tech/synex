import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import Feed from '../components/Feed.svelte';
import { cardTitleMode } from '../lib/card-title';
import { feedItems, feedLoading, folders, multiSelectedIds, query, scope } from '../lib/stores';
import { imagesApi } from '../lib/api';

/**
 * 2026-11-11 无障碍审计那轮：卡片、网格、空态、搜索播报的语义。
 * 审计实测的三条硬伤都在这儿钉住——一张卡里两个停留点、搜索完读屏一句不说、
 * 键盘焦点和选中态长得一样。
 */

vi.mock('../lib/api', () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: { list: vi.fn(async () => ({ items: get(feedItems), total: get(feedItems).length })), detail: vi.fn(), rename: vi.fn(), bulkAssignFolder: vi.fn() },
  foldersApi: { tree: vi.fn(async () => get(folders)) }, statsApi: { get: vi.fn() }, scanApi: { progress: vi.fn() }, comfyuiApi: {},
}));

const NOW = Math.floor(Date.now() / 1000);
const item = { id: 1, item_type: 'media', kind: 'image', filename: 'original.jpg', path: 'D:/original.jpg', original_url: '/api/images/1/file?max=1024', thumbnail_url: '/api/images/1/thumb', width: 1600, height: 900, mtime: NOW - 60, size_bytes: 1000, duration_seconds: null, playable: true, tags: [], folder_ids: [] };

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  scope.set('image');
  cardTitleMode.set('filename');
  feedLoading.set(false);
  feedItems.set([item] as never);
  multiSelectedIds.set(new Set());
  folders.set([{ id: 10, name: '项目', children: [] }] as never);
  vi.mocked(imagesApi.rename).mockReset().mockResolvedValue({ ...item, filename: 'new.jpg' } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  scope.set('all');
  query.set('');
  feedItems.set([]);
  multiSelectedIds.set(new Set());
});

function feed() { return render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 }); }

it('一张卡只有一个键盘停留点：卡片本身是按钮，卡里的文件名不再是第二个', async () => {
  const { container } = feed();
  await waitFor(() => expect(container.querySelector('.media-card')).toBeTruthy());
  const card = container.querySelector('.media-card') as HTMLElement;
  expect(card.tagName).toBe('BUTTON');
  const name = container.querySelector('.media-card-name') as HTMLElement;
  // 老写法在这里摆 role="button" tabindex="0"，一张卡 Tab 两下才走过去；
  // 而且 aria-label="图片名称" 把真正的文件名从读屏里盖掉了。
  expect(name.getAttribute('role')).toBeNull();
  expect(name.hasAttribute('tabindex')).toBe(false);
  expect(name.getAttribute('aria-label')).toBeNull();
  // 文件名得能从卡片本身读出来：卡里的可见文字就是它
  expect(card.textContent).toContain('original.jpg');
});

it('卡片选中态对读屏可读：aria-pressed 与 is-selected 同步', async () => {
  const { container } = feed();
  await waitFor(() => expect(container.querySelector('.media-card')).toBeTruthy());
  const card = container.querySelector('.media-card') as HTMLElement;
  expect(card.getAttribute('aria-pressed')).toBe('false');
  expect(card.classList.contains('is-selected')).toBe(false);

  multiSelectedIds.set(new Set([1]));
  await waitFor(() => expect(card.getAttribute('aria-pressed')).toBe('true'));
  expect(card.classList.contains('is-selected')).toBe(true);
});

it('F2 在卡片上直接改名，不用先摸到文件名', async () => {
  const { container } = feed();
  await waitFor(() => expect(container.querySelector('.media-card')).toBeTruthy());
  const card = container.querySelector('.media-card') as HTMLElement;
  await fireEvent.keyDown(card, { key: 'F2' });
  const input = await screen.findByLabelText('编辑图片名称');
  expect(document.activeElement).toBe(input);
  await fireEvent.input(input, { target: { value: 'new' } });
  await fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(imagesApi.rename).toHaveBeenCalledWith(1, 'new'));
});

it('键盘焦点和选中态不是一回事：焦点环单独用品牌红 2px 内描边', () => {
  const css = postcss.parse(readFileSync('src/app.css', 'utf8'));
  const decls: Record<string, string> = {};
  css.walkRules('.thumb.media-card:focus-visible', (rule) => {
    rule.walkDecls((d) => { decls[d.prop] = d.value; });
  });
  expect(decls.outline).toBe('2px solid var(--accent)');
  // 内描边：不占布局，也不会被 scroller 那 2px 余量裁掉
  expect(decls['outline-offset']).toBe('-2px');
  // 选中环保持中性灰白，没被焦点环带跑
  expect(rootToken('--thumb-ring')).toBe('var(--text-1)');
  // 焦点环用的是品牌红，和选中环不是同一个颜色
  expect(rootToken('--accent')).not.toBe('var(--text-1)');
});

function rootToken(name: string) {
  const css = postcss.parse(readFileSync('src/app.css', 'utf8'));
  let value = '';
  css.walkRules(':root', (rule) => { rule.walkDecls(name, (d) => { value = d.value; }); });
  return value;
}

it('这一页有标题可读：当前口径名挂在 h1 上', async () => {
  const { container } = feed();
  await waitFor(() => expect(container.querySelector('h1')).toBeTruthy());
  expect(container.querySelector('h1')?.textContent?.trim()).toBeTruthy();
  // 读屏按 H 能跳到的标题，全站只该有这一个在素材流上
  expect(container.querySelectorAll('h1')).toHaveLength(1);
});

it('网格有分组名，读屏进出流时知道进了什么', async () => {
  const { container } = feed();
  await waitFor(() => expect(container.querySelector('.masonry-grid')).toBeTruthy());
  const grid = container.querySelector('.masonry-grid') as HTMLElement;
  expect(grid.getAttribute('role')).toBe('group');
  expect(grid.getAttribute('aria-label')).toBe('素材网格');
});

it('搜索完读屏要说一句：role=status 播报命中条数', async () => {
  query.set('original');
  const { container } = feed();
  await waitFor(() => expect(container.querySelector('.media-card')).toBeTruthy());
  const live = liveText(container);
  expect(live).toContain('搜索「original」');
  expect(live).toContain('1 项');
});

it('搜索没命中也要说一句，不能只让屏幕变黑', async () => {
  feedItems.set([]);
  query.set('zzzqqq9988');
  const { container } = feed();
  await waitFor(() => expect(liveText(container)).toContain('没有匹配素材'));
  expect(liveText(container)).toContain('zzzqqq9988');
});

function liveText(container: HTMLElement) {
  return [...container.querySelectorAll('[role="status"]')]
    .map((n) => n.getAttribute('aria-label') || n.textContent?.trim() || '')
    .join(' ');
}

it('不搜索时不播报：懒加载每次多 30 张，跟着念就是噪声', async () => {
  const { container } = feed();
  await waitFor(() => expect(container.querySelector('.media-card')).toBeTruthy());
  const live = [...container.querySelectorAll('[role="status"]')].map((n) => n.textContent?.trim()).join(' ');
  expect(live).not.toMatch(/项$/);
});

it('搜不到时空态说清楚没搜到，并给一条回去的路', async () => {
  feedItems.set([]);
  query.set('zzzqqq9988');
  const { container } = feed();
  await waitFor(() => expect(container.querySelector('.empty-search')).toBeTruthy());
  // {searchWord} 插值把句子切成三个文本节点，取 <p> 整句核对
  expect(container.querySelector('.empty-search p')?.textContent).toBe('没有匹配「zzzqqq9988」的素材');
  // 空态本身要能被读屏当成一条状态播报到
  expect((container.querySelector('.empty-feed') as HTMLElement).getAttribute('role')).toBe('status');
  await fireEvent.click(container.querySelector('.empty-search button') as HTMLElement);
  expect(get(query)).toBe('');
});

it('空文件夹的空态不靠图标猜，说清楚这里还没有素材', async () => {
  feedItems.set([]);
  const { container } = feed();
  await waitFor(() => expect(container.querySelector('.empty-search')).toBeTruthy());
  expect(container.querySelector('.empty-search p')?.textContent).toBe('这里还没有素材');
  expect(container.querySelector('.empty-search small')?.textContent).toContain('Ctrl+V');
  // 没搜索时不该冒出「清除搜索」那颗按钮
  expect(container.querySelector('.empty-search button')).toBeNull();
});
