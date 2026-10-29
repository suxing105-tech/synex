import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import MediaPickerModal from '../components/MediaPickerModal.svelte';
import { audioApi, imagesApi } from '../lib/api';
import { playingAudio, stopAudio } from '../lib/stores';
import { clearToasts, toasts } from '../lib/toast';
import { splitIntoColumns } from '../lib/media-format';
import type { RefKind } from '../lib/clone';

/**
 * 素材选择器的画面框必须跟图片自己的宽高比一致：
 * 之前固定 4:3 + 不写 object-fit，竖图被硬压成横条，用户第一反应就是「缩略图变形了」。
 */
// 卡片现在能试听音频，组件连带引了 lib/stores：mock 得把这两处用到的 api 一起给出来，
// 少一个导出就在模块初始化阶段炸，报错还看不出跟本用例有什么关系。
vi.mock('../lib/api', () => ({
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  audioApi: { open: vi.fn(async () => ({ ok: true, id: 0, path: '' })) },
  foldersApi: { list: vi.fn(async () => []) },
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: {} })) },
  scanApi: { start: vi.fn(async () => ({ ok: true })) },
  statsApi: { get: vi.fn(async () => ({})) },
  http: vi.fn(),
}));

const ITEMS = [
  { id: 1, filename: 'tall.png', path: 'D:/tall.png', kind: 'image', width: 768, height: 1360, original_url: '/api/images/1/file', thumbnail_url: '/api/images/1/file' },
  { id: 2, filename: 'wide.png', path: 'D:/wide.png', kind: 'image', width: 1920, height: 1080, original_url: '/api/images/2/file', thumbnail_url: '/api/images/2/file' },
  { id: 3, filename: 'unknown.png', path: 'D:/unknown.png', kind: 'image', width: null, height: null, original_url: '/api/images/3/file', thumbnail_url: '/api/images/3/file' },
] as any[];

afterEach(() => {
  cleanup();
  // 试听与 toast 存在全局 store 里：不清干净会串到下一个文件（音频角标那几条尤其）。
  stopAudio();
  clearToasts();
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
  // 第二个参数是挑中那一族：合并行的「+ 参考」不绑族，靠它决定落进哪一族的第一个空位
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), "image");
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

it('头部挤不下就整块换行：族 tab 不能被窄窗口掰成竖排两个字', () => {
  const css = readFileSync('src/components/MediaPickerModal.svelte', 'utf8');
  expect(css).toMatch(/\.mp-head\s*\{[^}]*flex-wrap:\s*wrap/);
  expect(css).toMatch(/\.mp-tab\s*\{[^}]*white-space:\s*nowrap/);
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


/**
 * 视频工作流有图片/音频/视频三族参考位，选择器必须跟着换族：
 * 在一大堆画面里翻那几条 mp3，跟让厨师在冰箱里找螺丝刀一样离谱。
 */
describe("按参考位所属族列素材", () => {
  it('不传 kind 时还是图片一键同款的老样子：只列图片，标题「选一张图片」', async () => {
    const screen = await opened();
    expect(imagesApi.list).toHaveBeenCalledWith(expect.objectContaining({ kind: "image" }));
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("从图库选一张图片");
  });

  it("音频位只向后端要音频，空态和量词都念「段」", async () => {
    (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0 });
    const screen = render(MediaPickerModal, { open: true, kind: "audio", onPick: () => {}, onClose: () => {} });
    await tick();
    expect(imagesApi.list).toHaveBeenCalledWith(expect.objectContaining({ kind: "audio" }));
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("从图库选一段音频");
    expect((await screen.findByRole("status")).textContent).toContain("没有可选的音频");
  });

  it("分页按钮跟着族换量词：还有 3 段，不是还有 3 张", async () => {
    const audio = Array.from({ length: 2 }, (_, i) => ({
      id: i + 1, filename: `a${i}.mp3`, path: `D:/a${i}.mp3`, kind: "audio",
      width: null, height: null, original_url: `/api/images/${i + 1}/file`, thumbnail_url: null,
    }));
    (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: audio, total: 5 });
    const screen = render(MediaPickerModal, { open: true, kind: "audio", onPick: () => {}, onClose: () => {} });
    await screen.findByRole("button", { name: "a0.mp3" });
    expect(screen.getByRole("button", { name: "加载更多（还有 3 段）" })).toBeTruthy();
  });

  it("弹窗开着时从音频位切到视频位，列表重新读一次，标题跟着改", async () => {
    (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0 });
    const screen = render(MediaPickerModal, { open: true, kind: "audio", onPick: () => {}, onClose: () => {} });
    await tick();
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("从图库选一段音频");
    await screen.rerender({ kind: "video" });
    await tick();
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("从图库选一条视频");
    expect(imagesApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "video" }));
  });
});


/**
 * 参考区在弹窗里合成了一行，加素材只有一颗「+ 参考」：族要在这儿挑，
 * 所以选择器得给族 tab；一屏能看几张也该由用户说了算，不能永远四列。
 */
describe("一颗「+ 参考」管三族", () => {
  const MANY = Array.from({ length: 9 }, (_, i) => ({
    id: i + 1, filename: `p${i}.png`, path: `D:/p${i}.png`, kind: "image" as const,
    width: 768, height: 1360, original_url: `/api/images/${i + 1}/file`, thumbnail_url: `/api/images/${i + 1}/file`,
  }));

  it("只给一族时不出 tab：图片一键同款的标题行一个字没多", async () => {
    const screen = await opened();
    expect(screen.queryByRole("group", { name: "素材类型" })).toBeNull();
    expect(screen.queryByRole("button", { name: "音频" })).toBeNull();
  });

  it("给三族就出 tab，顺序照参考区那一行（图片 → 视频 → 音频）", async () => {
    (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0 });
    const screen = render(MediaPickerModal, {
      open: true, kind: "image", kinds: ["audio", "image", "video"], onPick: () => {}, onClose: () => {},
    });
    await tick();
    const tabs = screen.getByRole("group", { name: "素材类型" });
    expect([...tabs.querySelectorAll(".mp-tab")].map((el) => el.textContent?.trim())).toEqual(["图片", "视频", "音频"]);
    expect(tabs.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
  });

  it("点 tab 换族：重新按族读一次，标题跟着换，交出去的族也是当前这一族", async () => {
    const onPick = vi.fn();
    const audio = [{ id: 5, filename: "a.mp3", path: "D:/a.mp3", kind: "audio", width: null, height: null, original_url: "/api/audio/5/file", thumbnail_url: null }];
    (imagesApi.list as ReturnType<typeof vi.fn>).mockImplementation(async (q: any) =>
      q.kind === "audio" ? { items: audio, total: 1 } : { items: [], total: 0 });
    const screen = render(MediaPickerModal, {
      open: true, kind: "image", kinds: ["image", "audio", "video"], onPick, onClose: () => {},
    });
    await tick();
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("从图库选一张图片");
    await fireEvent.click(await screen.findByRole("button", { name: "音频" }));
    await vi.waitFor(() => expect(imagesApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "audio" })));
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("从图库选一段音频");
    await fireEvent.click(await screen.findByRole("button", { name: "a.mp3" }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), "audio");
  });

  it("列数滑块直接决定排几列：默认跟着弹窗宽度，拖完按用户给的", async () => {
    (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: MANY, total: 9 });
    const screen = render(MediaPickerModal, { open: true, onPick: () => {}, onClose: () => {} });
    await screen.findByRole("button", { name: "p0.png" });
    expect(screen.container.querySelectorAll(".mp-col")).toHaveLength(4);
    const slider = screen.getByLabelText("列数") as HTMLInputElement;
    slider.value = "2";
    await fireEvent.input(slider);
    await tick();
    expect(screen.container.querySelectorAll(".mp-col")).toHaveLength(2);
    expect(screen.getByText("2")).toBeTruthy();
  });

  /**
   * 真机踩到的 BUG：在视频工作流里挑过音频/视频，切回图片工作流再开选择器，
   * 标题写着「选一张参考图」，里面还是 flac / mp4 —— 组件关掉不销毁，tab 是组件内状态。
   */
  it("关一次再开：回到调用方那一族，上次点的 tab 不粘过来", async () => {
    const audio = [{ id: 5, filename: "a.mp3", path: "D:/a.mp3", kind: "audio", width: null, height: null, original_url: "/api/audio/5/file", thumbnail_url: null }];
    (imagesApi.list as ReturnType<typeof vi.fn>).mockImplementation(async (q: any) =>
      q.kind === "audio" ? { items: audio, total: 1 } : { items: [], total: 0 });
    const screen = render(MediaPickerModal, {
      open: true, kind: "image", kinds: ["image", "audio", "video"], onPick: () => {}, onClose: () => {},
    });
    await tick();
    await fireEvent.click(await screen.findByRole("button", { name: "音频" }));
    await vi.waitFor(() => expect(imagesApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "audio" })));
    // 关上（选完、Esc、点外面都算），再切回图片工作流打开：这一族只有图片
    await screen.rerender({ open: false });
    await tick();
    await screen.rerender({ open: true, kind: "image", kinds: ["image"] });
    await vi.waitFor(() => expect(imagesApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "image" })));
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("从图库选一张图片");
    expect(screen.queryByRole("group", { name: "素材类型" })).toBeNull();
    expect(screen.queryByRole("button", { name: "音频" })).toBeNull();
  });

  it("三族都开着再开一次，tab 也回到调用方那一族而不是上次点的", async () => {
    (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0 });
    const screen = render(MediaPickerModal, {
      open: true, kind: "image", kinds: ["image", "audio", "video"], onPick: () => {}, onClose: () => {},
    });
    await tick();
    await fireEvent.click(await screen.findByRole("button", { name: "视频" }));
    await vi.waitFor(() => expect(imagesApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "video" })));
    await screen.rerender({ open: false });
    await tick();
    await screen.rerender({ open: true, kind: "audio" });
    await vi.waitFor(() => expect(imagesApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "audio" })));
    const tabs = screen.getByRole("group", { name: "素材类型" });
    expect([...tabs.querySelectorAll('[aria-pressed="true"]')].map((el) => el.textContent?.trim())).toEqual(["音频"]);
  });
});


/**
 * 一键同款的素材选择器里，缩略图得先自己交代内容：
 * 视频滑过就动起来（不然挑视频只能靠文件名猜），音频要有能点开的试听角标
 * ——但点角标绝不能顺手把那张「选」出去。
 */
describe('滑过播视频、点开听音频', () => {
  const video = (over: any = {}) => ({
    id: 9, filename: 'clip.mp4', path: 'D:/clip.mp4', kind: 'video', width: 1280, height: 720,
    original_url: '/api/images/9/file', thumbnail_url: '/api/images/9/thumbnail',
    play_url: '/api/videos/9/file?v=abc', playable: true, ...over,
  });
  const audio = (over: any = {}) => ({
    id: 5, filename: 'voice.mp3', path: 'D:/voice.mp3', kind: 'audio', width: null, height: null,
    original_url: '/api/audio/5/file', thumbnail_url: null, playable: true, ...over,
  });

  async function openWith(kind: RefKind, items: any[]) {
    (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items, total: items.length });
    const onPick = vi.fn();
    const onClose = vi.fn();
    const screen = render(MediaPickerModal, { open: true, kind, onPick, onClose });
    await screen.findByRole('button', { name: items[0].filename });
    return { ...screen, onPick, onClose };
  }

  it('滑过视频卡：叠一层静音 <video> 自动播，移开就卸掉', async () => {
    const screen = await openWith('video', [video()]);
    const card = screen.getByRole('button', { name: 'clip.mp4' });
    expect(card.querySelector('video')).toBeNull();
    await fireEvent.mouseEnter(card);
    const vid = card.querySelector('video.media-card-video') as HTMLVideoElement;
    expect(vid).toBeTruthy();
    expect(vid.getAttribute('src')).toContain('/api/videos/9/file');
    expect(vid.muted).toBe(true);
    expect(screen.onPick).not.toHaveBeenCalled();
    await fireEvent.mouseLeave(card);
    expect(card.querySelector('video')).toBeNull();
  });

  it('一屏只解码滑过那一条：鼠标换到别的卡，前一张的视频跟着卸', async () => {
    const other = video({ id: 10, filename: 'clip2.mp4', play_url: '/api/videos/10/file' });
    const screen = await openWith('video', [video(), other]);
    const a = screen.getByRole('button', { name: 'clip.mp4' });
    const b = screen.getByRole('button', { name: 'clip2.mp4' });
    await fireEvent.mouseEnter(a);
    await fireEvent.mouseEnter(b);
    expect(a.querySelector('video')).toBeNull();
    expect(b.querySelector('video')).toBeTruthy();
  });

  it('播不了的容器不挂 <video>，别给一个黑框假装能播', async () => {
    const screen = await openWith('video', [video({ playable: false })]);
    await fireEvent.mouseEnter(screen.getByRole('button', { name: 'clip.mp4' }));
    expect(screen.container.querySelector('video')).toBeNull();
  });

  it('音频卡有一颗试听角标，点它只出声、不选中、不关窗', async () => {
    const screen = await openWith('audio', [audio()]);
    const badge = await screen.findByRole('button', { name: '播放 voice.mp3' });
    await fireEvent.click(badge);
    expect(get(playingAudio)?.id).toBe(5);
    expect(screen.onPick).not.toHaveBeenCalled();
    expect(screen.onClose).not.toHaveBeenCalled();
    expect(badge.getAttribute('aria-label')).toBe('暂停 voice.mp3');
    await fireEvent.click(badge);
    expect(get(playingAudio)).toBeNull();
  });

  it('内嵌解不了的容器交给系统播放器，并说明为什么，不假装在播', async () => {
    const screen = await openWith('audio', [audio({ playable: false })]);
    await fireEvent.click(await screen.findByRole('button', { name: '播放 voice.mp3' }));
    expect(audioApi.open).toHaveBeenCalledWith(5);
    expect(get(playingAudio)).toBeNull();
    expect(get(toasts).some((t) => t.message.includes('系统播放器'))).toBe(true);
  });

  it('换族与关弹窗都收掉试听：不能让人带着一段不知道哪儿在响的音频离开', async () => {
    (imagesApi.list as ReturnType<typeof vi.fn>).mockImplementation(async (q: any) =>
      q.kind === 'audio' ? { items: [audio()], total: 1 } : { items: [], total: 0 });
    const screen = render(MediaPickerModal, { open: true, kind: 'image', kinds: ['image', 'audio'], onPick: () => {}, onClose: () => {} });
    await tick();
    await fireEvent.click(await screen.findByRole('button', { name: '音频' }));
    await fireEvent.click(await screen.findByRole('button', { name: '播放 voice.mp3' }));
    expect(get(playingAudio)?.id).toBe(5);
    // 切回图片族：那批素材不在了，声音也不能留在后台继续响
    await fireEvent.click(screen.getByRole('button', { name: '图片' }));
    expect(get(playingAudio)).toBeNull();
    await fireEvent.click(await screen.findByRole('button', { name: '音频' }));
    await fireEvent.click(await screen.findByRole('button', { name: '播放 voice.mp3' }));
    expect(get(playingAudio)?.id).toBe(5);
    await screen.rerender({ open: false });
    expect(get(playingAudio)).toBeNull();
  });

  it('hover-play 只有一份：图库卡片与选择器共用同一个 action', () => {
    const shared = readFileSync('src/lib/hover-play.ts', 'utf8');
    expect(shared).toMatch(/export function hoverPlay/);
    for (const file of ['src/components/Feed.svelte', 'src/components/MediaPickerModal.svelte']) {
      const src = readFileSync(file, 'utf8');
      expect(src).toMatch(/import \{ hoverPlay \} from "\.\.\/lib\/hover-play"/);
      expect(src).not.toMatch(/function hoverPlay/);
    }
  });

  it('试听角标和文件名同一行、同一条中线，不再浮在波形上', async () => {
    const screen = await openWith('audio', [audio()]);
    const badge = await screen.findByRole('button', { name: '播放 voice.mp3' });
    const footer = badge.closest('.media-card-footer') as HTMLElement;
    // 页脚那一行同时装着文件名和角标：二者共用同一条 26px 行的中线
    expect(footer.querySelector('.media-card-name')).toBeTruthy();
    expect(badge.parentElement).toBe(footer);
    const css = readFileSync('src/components/MediaPickerModal.svelte', 'utf8');
    expect(css).toMatch(/\.mp-footer-audio\s*\{[^}]*flex-direction:\s*row/);
    expect(css).toMatch(/\.mp-footer-audio\s*\{[^}]*align-items:\s*center/);
    // absolute 一旦回来，角标就又回到画面框下沿，跟文字各站一头
    expect(css).toMatch(/\.mp-audio-btn\s*\{[^}]*flex:\s*none/);
    expect(css).not.toMatch(/\.mp-audio-btn\s*\{[^}]*position:\s*absolute/);
    // 卡片本身就是 <button>，角标再造一个可聚焦节点会让人 Tab 两下才走出一张卡。
    expect(css).toMatch(/tabindex="-1"[\s\S]{0,60}class="mp-audio-btn"/);
  });
});
