import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import Feed from "../components/Feed.svelte";
import { audioApi, imagesApi } from "../lib/api";
import { audioProgress, feedItems, feedLoading, playingAudio, scope, stopAudio } from "../lib/stores";
import type { MediaFeedItem } from "../lib/types";

vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: {
    list: vi.fn(async () => ({ items: [], total: 0 })),
    detail: vi.fn(),
    presence: vi.fn(async () => ({ exists: true })),
    remove: vi.fn(),
    rename: vi.fn(),
  },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn(async () => ({ total_images: 0, total_videos: 0, total_audio: 1, total_texts: 0, folders: 0 })) },
  scanApi: { progress: vi.fn() },
  comfyuiApi: {},
  audioApi: { open: vi.fn(async () => ({ ok: true })), waveform: vi.fn(), fileUrl: vi.fn() },
}));

// vitest 里 import.meta.url 是 http，按 cwd（frontend/）拼组件源码路径
const FEED_SOURCE = readFileSync(resolve(process.cwd(), "src/components/Feed.svelte"), "utf8");

const AUDIO = {
  id: 7,
  item_type: "media",
  kind: "audio",
  filename: "氛围底噪.mp3",
  path: "D:/sound/氛围底噪.mp3",
  original_url: "/api/audio/7/file",
  thumbnail_url: "/api/audio/7/waveform",
  play_url: "/api/audio/7/file",
  playable: true,
  duration_seconds: 42,
  width: null,
  height: null,
  mtime: 1700000000,
};

function audioItem(): MediaFeedItem {
  return { ...AUDIO } as unknown as MediaFeedItem;
}

function thumbOf(container: HTMLElement, alt: string): HTMLImageElement {
  const img = container.querySelector<HTMLImageElement>(`img[alt="${alt}"]`);
  if (!img) throw new Error(`没有缩略图 ${alt}`);
  return img;
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  scope.set("audio");
  feedLoading.set(false);
  stopAudio();
  audioProgress.set(0);
  feedItems.set([audioItem()]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  feedItems.set([]);
  stopAudio();
  scope.set("all");
});

function renderFeed() {
  return render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
}

describe("音频卡", () => {
  it("用波形图当缩略图，统一 21:9，不假装是图片", async () => {
    const { container } = renderFeed();
    await tick();
    const img = thumbOf(container, "氛围底噪.mp3");
    expect(img.getAttribute("src")).toBe("/api/audio/7/waveform");
    expect(img.getAttribute("loading")).toBe("lazy");
    // 21:9 与后端波形默认出图（840x360）同比例，object-fit 不会裁也不会留黑边
    // 比例挂在图区上；给整张卡会把页脚高度算进画面比例
    expect(img.closest(".media-card-media")?.getAttribute("style")).toContain("21 / 9");
  });

  it("播放中的音频卡不描红边，与图片/视频共用同一套边框", () => {
    expect(FEED_SOURCE).not.toMatch(/\.thumb\.is-playing\s*\{[^}]*box-shadow/);
    // 卡片 class 仍然带上「正在播放」标记，只是不拿颜色强调
    expect(FEED_SOURCE).toContain("$playingAudio?.id === it.id && it.kind === 'audio' ? 'is-playing' : ''");
  });

  it("片长落在页脚元信息行，画面左上角不再有徽标", async () => {
    const { container } = renderFeed();
    await tick();
    expect(container.querySelector(".media-duration")).toBeNull();
    expect(container.querySelector(".media-card-meta")?.textContent).toBe("0:42");
  });

  it("hover 层有播放入口", async () => {
    const { container } = renderFeed();
    await tick();
    const play = container.querySelector('[aria-label="播放 氛围底噪.mp3"]');
    expect(play).not.toBeNull();
    expect(play?.getAttribute("title")).toBe("播放音频");
  });

  it("波形 404 时降级成音符图形，而不是把音频从库里删掉", async () => {
    const { container } = renderFeed();
    await tick();
    await fireEvent.error(thumbOf(container, "氛围底噪.mp3"));
    await tick();
    expect(container.querySelector('[aria-label="波形暂不可用"]')).not.toBeNull();
    expect(imagesApi.presence).not.toHaveBeenCalled();
  });

  it("点播放三角就地播放，不落进图片 Lightbox", async () => {
    const { container } = renderFeed();
    await tick();
    await fireEvent.click(container.querySelector('[aria-label="播放 氛围底噪.mp3"]') as Element);
    expect(get(playingAudio)?.id).toBe(7);
  });

  it("单击卡片也会播放（音频没有「打开大图」这层语义）", async () => {
    const { container } = renderFeed();
    await tick();
    await fireEvent.click(thumbOf(container, "氛围底噪.mp3").closest("button") as Element);
    expect(get(playingAudio)?.id).toBe(7);
  });

  it("双击同样只播放", async () => {
    const { container } = renderFeed();
    await tick();
    const card = thumbOf(container, "氛围底噪.mp3").closest("button") as Element;
    await fireEvent.dblClick(card);
    expect(get(playingAudio)?.id).toBe(7);
  });

  it("正在播放的卡片带 is-playing 标记，切走音频就取消", async () => {
    const { container } = renderFeed();
    await tick();
    const card = thumbOf(container, "氛围底噪.mp3").closest("button") as HTMLElement;
    expect(card.classList.contains("is-playing")).toBe(false);
    await fireEvent.click(card);
    await tick();
    expect(card.classList.contains("is-playing")).toBe(true);
    stopAudio();
    await tick();
    expect(card.classList.contains("is-playing")).toBe(false);
  });

  it("再点一次就地暂停 —— 没有待机播放条，卡片本身就是开关", async () => {
    const { container } = renderFeed();
    await tick();
    const card = thumbOf(container, "氛围底噪.mp3").closest("button") as Element;
    await fireEvent.click(card);
    expect(get(playingAudio)?.id).toBe(7);
    await fireEvent.click(card);
    expect(get(playingAudio)).toBeNull();
  });

  it("播放中波形下面出现进度线与光点，页脚仍是片长不是当前进度", async () => {
    const { container } = renderFeed();
    await tick();
    await fireEvent.click(thumbOf(container, "氛围底噪.mp3").closest("button") as Element);
    audioProgress.set(21); // 42 秒的一半点
    await tick();
    expect(container.querySelector<HTMLElement>(".audio-progress")?.getAttribute("style")).toContain("width: 50%");
    // 参考图那个走带光点：挂在填充条右端，跟着 width 一起走
    expect(container.querySelector(".audio-progress .audio-progress-knob")).toBeTruthy();
    // 进度只由波形下面的 .audio-progress 表达；页脚是「这是什么文件」，不跟着走表
    expect(container.querySelector(".media-card-meta")?.textContent).toBe("0:42");
  });

  it("进度超过已知时长也不会溢出卡片", async () => {
    const { container } = renderFeed();
    await tick();
    await fireEvent.click(thumbOf(container, "氛围底噪.mp3").closest("button") as Element);
    audioProgress.set(999);
    await tick();
    expect(container.querySelector<HTMLElement>(".audio-progress")?.getAttribute("style")).toContain("width: 100%");
  });

  it("音频卡用波形当蒙版画频谱，不直接显示后端那张单色 PNG", async () => {
    const { container } = renderFeed();
    await tick();
    const card = thumbOf(container, "氛围底噪.mp3").closest("button") as HTMLElement;
    // 卡片标记 is-audio：.media-card.is-audio .media-card-img 会把 PNG 藏成纯加载探针
    expect(card.classList.contains("is-audio")).toBe(true);
    const wave = container.querySelector<HTMLElement>(".audio-wave");
    expect(wave).toBeTruthy();
    expect(wave?.getAttribute("style")).toContain("--wave: url(");
    // 三层：光晕 + 清晰主体 + 贯穿亮线，外加 hover 扫光
    expect(container.querySelectorAll(".audio-wave-fill")).toHaveLength(2);
    expect(container.querySelector(".audio-wave-line")).toBeTruthy();
    expect(container.querySelector(".audio-wave-sweep")).toBeTruthy();
    // 底部进度轨常驻，播放前只是空的暗轨
    expect(container.querySelector(".audio-track")).toBeTruthy();
    expect(container.querySelector(".audio-progress")).toBeNull();
    // 角标属于卡片、不属于图区：它坐在页脚右端，跟文件名那两行并排
    const playBtn = container.querySelector<HTMLElement>(".audio-play-btn");
    expect(playBtn).toBeTruthy();
    expect(playBtn?.parentElement?.classList.contains("media-card")).toBe(true);
    expect(playBtn?.closest(".media-card-media")).toBeNull();
    expect(container.querySelector(".audio-play-icon")).toBeTruthy();
  });

  it("波形 404：频谱层与进度轨一起撤掉，退回音符图形", async () => {
    const { container } = renderFeed();
    await tick();
    await fireEvent.error(thumbOf(container, "氛围底噪.mp3"));
    await tick();
    expect(container.querySelector(".audio-wave")).toBeNull();
    expect(container.querySelector(".audio-track")).toBeNull();
    expect(container.querySelector('[aria-label="波形暂不可用"]')).toBeTruthy();
  });
  it("播放三角在播放时换成暂停图标并改文案", async () => {
    const { container } = renderFeed();
    await tick();
    await fireEvent.click(container.querySelector('[aria-label="播放 氛围底噪.mp3"]') as Element);
    await tick();
    expect(container.querySelector('[aria-label="播放 氛围底噪.mp3"]')).toBeNull();
    expect(container.querySelector('[aria-label="暂停 氛围底噪.mp3"]')?.getAttribute("title")).toBe("暂停音频");
  });

  it("内核解不了的容器：点卡片直接走系统播放器，不假装在播", async () => {
    feedItems.set([{ ...audioItem(), playable: false } as MediaFeedItem]);
    const { container } = renderFeed();
    await tick();
    await fireEvent.click(thumbOf(container, "氛围底噪.mp3").closest("button") as Element);
    expect(audioApi.open).toHaveBeenCalledWith(7);
    expect(get(playingAudio)).toBeNull();
  });

  it("时长未知的音频不留空字段，也不留孤立分隔符", async () => {
    feedItems.set([{ ...audioItem(), duration_seconds: null } as MediaFeedItem]);
    const { container } = renderFeed();
    await tick();
    expect(container.querySelector(".media-duration")).toBeNull();
    expect(container.querySelector(".media-card-meta")?.textContent).toBe("");
  });

  it("图片卡的缺失检测逻辑不受影响：图片 404 仍然会查一次存在性", async () => {
    feedItems.set([
      {
        id: 8, item_type: "media", kind: "image", filename: "gone.jpg", path: "D:/gone.jpg",
        original_url: "/api/images/8/file", thumbnail_url: "/api/images/8/file", width: 800, height: 600, mtime: 1,
      } as unknown as MediaFeedItem,
    ]);
    const { container } = renderFeed();
    await tick();
    await fireEvent.error(thumbOf(container, "gone.jpg"));
    await tick();
    expect(imagesApi.presence).toHaveBeenCalledWith(8);
  });
});
