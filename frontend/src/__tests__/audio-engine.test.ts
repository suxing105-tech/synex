import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import AudioEngine from "../components/AudioEngine.svelte";
import { audioProgress, playAudio, playingAudio, scope, stopAudio } from "../lib/stores";
import type { MediaFeedItem } from "../lib/types";

/**
 * 交付形态：待机播放条已经删掉 —— 播放/暂停的控件在音频卡本身，
 * 这里只剩全应用唯一一个不显示的 audio 实例。jsdom 不真的解码，所以钉住「换源、播、停、进度」四件事。
 */
vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn() },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn(), presence: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn() },
  scanApi: { progress: vi.fn() },
  comfyuiApi: {},
  audioApi: { open: vi.fn(async () => ({ ok: true })) },
}));

const read = (rel: string) => readFileSync(resolve(process.cwd(), "src", rel), "utf8");

const MP3 = {
  id: 7, item_type: "media", kind: "audio", filename: "氛围底噪.mp3", path: "D:/sound/氛围底噪.mp3",
  original_url: "/api/audio/7/file", play_url: "/api/audio/7/file", playable: true, duration_seconds: 42,
} as unknown as MediaFeedItem;

const playMock = vi.fn(() => Promise.resolve());
const pauseMock = vi.fn();

beforeEach(() => {
  scope.set("audio");
  stopAudio();
  playMock.mockImplementation(() => Promise.resolve());
  pauseMock.mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => playMock());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => pauseMock());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  stopAudio();
  scope.set("all");
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("音频播放实例（播放条已删除）", () => {
  it("界面上没有任何播放条，只有一个不显示的 audio", async () => {
    const { container } = render(AudioEngine);
    await tick();
    expect(container.querySelector(".audio-bar")).toBeNull();
    expect(container.querySelectorAll("audio")).toHaveLength(1);
    expect(container.querySelector("audio")?.getAttribute("preload")).toBe("none");
    playAudio(MP3);
    await tick();
    expect(container.children).toHaveLength(1); // 播着也不多出底栏
  });

  it("播放时把源指到后端文件接口并开播", async () => {
    const { container } = render(AudioEngine);
    await tick();
    playAudio(MP3);
    await tick();
    expect(container.querySelector("audio")?.getAttribute("src")).toBe("/api/audio/7/file");
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it("stopAudio 会暂停并把进度归零", async () => {
    const { container } = render(AudioEngine);
    await tick();
    playAudio(MP3);
    await tick();
    audioProgress.set(10);
    stopAudio();
    await tick();
    expect(pauseMock).toHaveBeenCalled();
    expect(get(audioProgress)).toBe(0);
    expect(playMock).toHaveBeenCalledTimes(1); // 停完不会又自己播起来
    void container;
  });

  it("切换口径自动停播：音频卡已经不在了，不能留下没有控件的声音", async () => {
    render(AudioEngine);
    await tick();
    playAudio(MP3);
    await tick();
    scope.set("image");
    await tick();
    expect(get(playingAudio)).toBeNull();
    expect(pauseMock).toHaveBeenCalled();
  });

  it("timeupdate 把进度写回 store，卡片据此画进度线", async () => {
    const { container } = render(AudioEngine);
    await tick();
    const el = container.querySelector("audio")!;
    Object.defineProperty(el, "currentTime", { value: 12.5, configurable: true });
    await fireEvent.timeUpdate(el);
    expect(get(audioProgress)).toBe(12.5);
  });

  it("播完自动收起播放态", async () => {
    const { container } = render(AudioEngine);
    await tick();
    playAudio(MP3);
    await tick();
    await fireEvent.ended(container.querySelector("audio")!);
    expect(get(playingAudio)).toBeNull();
  });

  it("卸载时暂停 —— 切去文本工作区不会漏声音", async () => {
    const { unmount } = render(AudioEngine);
    await tick();
    playAudio(MP3);
    await tick();
    pauseMock.mockClear();
    unmount();
    expect(pauseMock).toHaveBeenCalled();
  });

  it("内核拒绝解码时提示改用系统播放器，不留在假播放态", async () => {
    playMock.mockImplementation(() => Promise.reject(new Error("not supported")));
    render(AudioEngine);
    await tick();
    playAudio(MP3);
    await flush();
    expect(get(playingAudio)).toBeNull();
  });

  it("App 挂的是播放实例，不再挂播放条", () => {
    const app = read("App.svelte");
    expect(app).not.toContain("AudioPlayerBar");
    expect(app).toContain("<AudioEngine />");
  });
});
