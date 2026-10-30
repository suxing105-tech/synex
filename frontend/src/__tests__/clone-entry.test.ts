import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import Feed from '../components/Feed.svelte';
import { feedItems, feedLoading, multiSelectedIds, selectedId, targetColumns } from '../lib/stores';
import { applyCloneProgress } from '../lib/clone';
import { itemsApi } from '../lib/api';

// 一键同款的入口挂在图片卡页脚上，所以这里要连 Feed 一起渲染；
// 弹窗自己的逻辑在 clone-modal.test.ts，这里只验「入口在哪、什么时候不出现」。
vi.mock('../lib/api', () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn(), import: vi.fn(async () => ({ saved: [], skipped: [] })) },
  foldersApi: { tree: vi.fn(async () => []), archived: vi.fn(async () => []) },
  statsApi: { get: vi.fn(async () => ({ total: 0 })) },
  scanApi: { progress: vi.fn(async () => ({ running: false })) },
  comfyuiApi: { status: vi.fn(async () => ({ running: true, enabled: true, url: 'http://127.0.0.1:8188' })) },
  videosApi: { open: vi.fn() }, audioApi: { open: vi.fn() },
  http: vi.fn(async (path: string) => {
    if (path.includes('/api/clone/generate')) {
      // 弹窗只认自己提交回来的 job_id，所以「生成完」必须先真的提交一次
      return { active: true, job_id: 'j1', state: 'queued', running: true, template_id: 1, image_ids: [] };
    }
    return path.includes('/api/clone/templates')
    ? {
      items: [{
        id: 1, name: '同款工作流', is_active: true, default_prompt: '内置那句',
        created_at: '', updated_at: '', node_count: 2, prompt_count: 1, reference_count: 1, control_count: 0,
        slots: [
          { kind: 'prompt', node: '582', input: 'prompt', label: '完整提示词' },
          { kind: 'image', node: '543', input: 'image', label: '人物参考' },
        ],
      }],
    }
    : {};
  }),
}));

const card = (over: Record<string, unknown>) => ({
  id: 1, item_type: 'media', kind: 'image', filename: 'a.png', path: 'D:/a.png',
  original_url: '/api/images/1/file?max=1024', width: 800, height: 600, ...over,
});

async function openFeed(items: Record<string, unknown>[], width = 1200) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
  feedLoading.set(false);
  targetColumns.set(5);
  feedItems.set(items as never[]);
  multiSelectedIds.set(new Set());
  const screen = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
  await tick();
  return screen;
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { cleanup(); feedItems.set([]); multiSelectedIds.set(new Set()); });

it('图片卡文件名右边常驻一键同款图标，点它只开弹窗、不碰选区', async () => {
  const screen = await openFeed([card({})]);
  const btn = screen.getByRole('button', { name: '用同款工作流再生成一张' });
  // 常驻：不靠 hover 才出现，用户不用先找到那张图才能看见入口
  const cardEl = btn.closest('.media-card') as HTMLElement;
  expect(cardEl.classList.contains('is-cloneable')).toBe(true);
  // 角标是卡片的绝对定位兄弟、页脚之外的右下角控件（和音频播放键同一套几何），
  // 文件名留在页脚里，靠 padding-right 让开它。
  expect(btn.parentElement).toBe(cardEl);
  expect(btn.closest('.media-card-footer')).toBeNull();
  expect(cardEl.querySelector('.media-card-name')?.textContent).toContain('a.png');
  await fireEvent.click(btn);
  await tick();
  expect(screen.getByRole('dialog', { name: '一键同款' })).toBeTruthy();
  expect([...get(multiSelectedIds)]).toEqual([]);
});

it('角标的尺寸由页脚高度派生，位置是右下角，页脚让位公式全站只有一份', () => {
  const appCss = readFileSync('src/app.css', 'utf8');
  const feedCss = readFileSync('src/components/Feed.svelte', 'utf8');
  const clone = appCss.slice(appCss.indexOf('.media-card.is-cloneable'), appCss.indexOf('.media-card-meta'));
  // 尺寸：clamp(20px, 页脚高 - 12px, 34px) —— 两行页脚 44px → 32px，单行 26px → 20px
  expect(clone).toContain('clamp(20px, calc(var(--card-footer-h, 0px) - 12px), 34px)');
  // 位置：right: 8px + 在页脚高度里垂直居中
  expect(clone).toContain('right: 8px');
  expect(clone).toContain('max(4px, calc((var(--card-footer-h, 0px) - var(--clone-btn)) / 2))');
  // 名字要让开角标；音频卡上那颗播放角标删掉后，这条让位规矩只剩这一处
  expect(clone).toContain('padding-right: calc(8px + var(--clone-btn) + 6px)');
  expect(feedCss).not.toContain('--audio-btn');
});

it('角标不加边框也不加底色，悬停只是图标变品牌色，焦点环关掉', () => {
  const appCss = readFileSync('src/app.css', 'utf8');
  const block = appCss.slice(appCss.indexOf('.media-clone-btn {'), appCss.indexOf('.media-card-meta'));
  // 静止态里不许出现 border / background / box-shadow
  const base = /\.media-clone-btn \{[^}]*\}/.exec(block)?.[0] ?? '';
  expect(base).not.toMatch(/border(?!-radius)/);
  expect(base).not.toMatch(/background/);
  expect(base).not.toMatch(/box-shadow/);
  // 悬停：只染颜色，不许放大、不许加底
  const hover = /\.media-clone-btn:hover \{[^}]*\}/.exec(block)?.[0] ?? '';
  expect(hover).toContain('color: var(--thumb-accent)');
  expect(hover).not.toMatch(/transform/);
  expect(hover).not.toMatch(/background|border|box-shadow/);
  // 关掉弹窗后焦点退回图标时那圈默认焦点环必须压掉
  expect(/\.media-clone-btn:focus,\s*\.media-clone-btn:focus-visible \{\s*outline: none;/.test(block)).toBe(true);
});

it('三类卡挂同一颗一键同款角标，量词按族：一张 / 一条 / 一段', async () => {
  const screen = await openFeed([
    card({ id: 2, kind: 'video', filename: 'v.mp4', original_url: null, thumbnail_url: '/api/videos/2/thumb', playable: false }),
    card({ id: 3, kind: 'audio', filename: 'a.mp3', original_url: '/api/audio/3/file', thumbnail_url: '/api/audio/3/waveform' }),
  ]);
  // 入口的几何、常驻规则、is-cloneable 让位规则全部照图片卡，不另立一套
  for (const name of ['用同款工作流再生成一条', '用同款工作流再生成一段']) {
    const btn = screen.getByRole('button', { name });
    expect(btn.closest('.media-card')?.classList.contains('is-cloneable')).toBe(true);
    expect(btn.closest('.media-card-footer')).toBeNull();
    await fireEvent.click(btn);
    await tick();
    expect(screen.getByRole('dialog', { name: '一键同款' })).toBeTruthy();
    await fireEvent.keyDown(document, { key: 'Escape' });
    await tick();
    expect(screen.queryByRole('dialog', { name: '一键同款' })).toBeNull();
  }
});

it('音频卡悬停后也只有「一键同款」这一颗角标，画面里不再长出播放键', async () => {
  const screen = await openFeed([
    card({ id: 3, kind: 'audio', filename: 'a.mp3', original_url: '/api/audio/3/file', thumbnail_url: '/api/audio/3/waveform' }),
  ]);
  const cardEl = screen.getByRole('button', { name: '用同款工作流再生成一段' }).closest('.media-card') as HTMLElement;
  await fireEvent.mouseEnter(cardEl);
  await tick();
  // 悬停曾经在画面左下角长一颗播放圆标，压在波形上；现在整张卡就是播放入口
  expect(screen.queryByRole('button', { name: '播放 a.mp3' })).toBeNull();
  expect(cardEl.querySelectorAll('.audio-play-btn')).toHaveLength(0);
  const clone = screen.getByRole('button', { name: '用同款工作流再生成一段' }) as HTMLElement;
  expect(clone.closest('.media-card-media')).toBeNull();
});

it('窄列页脚不渲染时，音频卡也没有角标（与图片/视频同一条规则）', async () => {
  const screen = await openFeed([
    card({ id: 3, kind: 'audio', filename: 'a.mp3', original_url: '/api/audio/3/file', thumbnail_url: '/api/audio/3/waveform' }),
  ], 300);
  expect(screen.queryByRole('button', { name: /用同款工作流再生成/ })).toBeNull();
});

it('窄列下音频卡的右键菜单也能进一键同款', async () => {
  const screen = await openFeed([
    card({ id: 3, kind: 'audio', filename: 'a.mp3', original_url: '/api/audio/3/file', thumbnail_url: '/api/audio/3/waveform' }),
  ], 300);
  await fireEvent.contextMenu(screen.container.querySelector('.thumb')!, { clientX: 10, clientY: 10 });
  await tick();
  await fireEvent.click(screen.getByRole('menuitem', { name: '一键同款' }));
  await tick();
  expect(screen.getByRole('dialog', { name: '一键同款' })).toBeTruthy();
});

/** Feed 渲染结果的具体类型：写成 ReturnType<typeof render> 会退化成通用查询签名，取不到元素类型。 */
type FeedScreen = Awaited<ReturnType<typeof openFeed>>;

/** 角标点开弹窗。index 对应 feedItems 里的顺序。 */
async function openCloneOn(screen: FeedScreen, index: number) {
  await fireEvent.click(screen.getAllByRole('button', { name: '用同款工作流再生成一张' })[index]);
  await tick();
}

/**
 * 真实提交一次生成：填提示词 → 点生成 → 等到任务起来。
 * 弹窗只认自己 submit 回来的 job_id（外部塞一个 done 任务它不认），
 * 所以「点产出图」这类用例必须走完整链路，不能直接改 store。
 */
async function submitClone(screen: FeedScreen) {
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '写点什么' } });
  const go = screen.getByRole('button', { name: '生成' }) as HTMLButtonElement;
  await vi.waitFor(() => expect(go.disabled).toBe(false));
  await fireEvent.click(go);
  await vi.waitFor(() => expect(screen.queryByRole('button', { name: '取消' })).toBeTruthy());
}

const DONE_ONE = { active: true, job_id: 'j1', state: 'done', running: false, template_id: 1, image_ids: [2] };

it('点弹窗里的产出图：直接进「原图 vs 产出图」对比（两张一起被选中，Lightbox 自己进对比态）', async () => {
  const src = card({ id: 1 });
  const out = card({ id: 2, filename: 'out.png' });
  vi.mocked(itemsApi.list).mockResolvedValue({ items: [out, src], total: 2, counts: { image: 2, video: 0, audio: 0, text: 0 } } as never);
  const screen = await openFeed([out, src]);
  await openCloneOn(screen, 1);            // 被点的是原图（id 1）
  await submitClone(screen);
  applyCloneProgress(DONE_ONE);
  await tick();
  await fireEvent.click(screen.getByRole('button', { name: '打开生成的第 2 张' }));
  await vi.waitFor(() => expect([...get(multiSelectedIds)].sort((a, b) => a - b)).toEqual([1, 2]));
  expect(get(selectedId)).toBe(2);
  expect(screen.queryByRole('dialog', { name: '一键同款' })).toBeNull();
});

it('刷新后原图不在当前列表里时不硬凑对比：只选中产出图', async () => {
  const src = card({ id: 1 });
  const out = card({ id: 2, filename: 'out.png' });
  // 流里本来两张都有，刷新后原图被筛掉了（换了文件夹 / 搜索词生效）
  vi.mocked(itemsApi.list).mockResolvedValue({ items: [out], total: 1, counts: { image: 1, video: 0, audio: 0, text: 0 } } as never);
  const screen = await openFeed([out, src]);
  await openCloneOn(screen, 1);
  await submitClone(screen);
  applyCloneProgress(DONE_ONE);
  await tick();
  await fireEvent.click(screen.getByRole('button', { name: '打开生成的第 2 张' }));
  await vi.waitFor(() => expect([...get(multiSelectedIds)]).toEqual([2]));
  expect(get(selectedId)).toBe(2);
});

it('列太窄整条页脚都不渲染时，图标跟着消失（不硬挤一个点不准的小按钮）', async () => {
  const screen = await openFeed([card({})], 300);
  expect(screen.container.querySelectorAll('.media-card-footer')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: '用同款工作流再生成一张' })).toBeNull();
});

it('窄列下右键菜单仍然能进一键同款', async () => {
  const screen = await openFeed([card({})], 300);
  const thumb = screen.container.querySelector('.thumb')!;
  await fireEvent.contextMenu(thumb, { clientX: 10, clientY: 10 });
  await tick();
  const item = screen.getByRole('menuitem', { name: '一键同款' });
  await fireEvent.click(item);
  await tick();
  expect(screen.getByRole('dialog', { name: '一键同款' })).toBeTruthy();
});

it('视频卡的右键菜单里也有一键同款（窄列页脚不渲染时它是唯一的入口）', async () => {
  const screen = await openFeed([card({ id: 4, kind: 'video', filename: 'v.mp4', original_url: null, thumbnail_url: '/api/videos/4/thumb', playable: false })], 300);
  await fireEvent.contextMenu(screen.container.querySelector('.thumb')!, { clientX: 10, clientY: 10 });
  await tick();
  const item = screen.getByRole('menuitem', { name: '一键同款' });
  await fireEvent.click(item);
  await tick();
  expect(screen.getByRole('dialog', { name: '一键同款' })).toBeTruthy();
});
