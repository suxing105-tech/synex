<script lang="ts">
  /**
   * 视频播放器：中间栏的内嵌层，与图片预览 / 文本阅读同一层、同一手势。
   *
   * 以前它是 fixed 全屏黑场，等于把整个图库换掉；现在收进中间栏以后，
   * 尺寸不能再按 vh/vw 算（那样会把左右侧栏算进来，画面顶出框外），
   * 全部交给 flex + object-contain 按容器自适应。
   */
  import { onMount } from "svelte";
  import { backendUrl } from "../lib/backend-url";
  import { mediaItems, multiSelectedIds } from "../lib/stores";
  import { videosApi } from "../lib/api";
  import { pushToast } from "../lib/toast";
  import type { MediaFeedItem } from "../lib/types";
  import Icon from "./Icon.svelte";
  import VideoCompare from "./VideoCompare.svelte";

  interface Props {
    open: boolean;
    startId: number | null;
  }
  let { open = $bindable(false), startId = $bindable<number | null>(null) }: Props = $props();

  // 当前 feed 里可播放的视频（有 play_url）
  const videos = $derived(
    $mediaItems.filter((it): it is MediaFeedItem & { play_url: string } => !!it.play_url),
  );

  let currentIndex = $state(0);

  const current = $derived(videos[currentIndex] ?? null);

  // 对比：feed 里恰好 ctrl 选中的两个视频，且都可播放两路 URL
  let compareOn = $state(false);
  const selectedVideos = $derived(
    $mediaItems.filter(
      (it): it is MediaFeedItem & { play_url: string } =>
        it.kind === "video" && !!it.play_url && $multiSelectedIds.has(it.id),
    ),
  );
  const compareReady = $derived(selectedVideos.length === 2);
  // 自动进入对比：仅当打开的视频本身就在选中的两个视频里（否则由用户点「对比」）
  $effect(() => {
    if (open && compareReady && current && selectedVideos.some((v) => v.id === current.id)) {
      compareOn = true;
    }
  });

  function openAt(id: number): void {
    const idx = videos.findIndex((v) => v.id === id);
    currentIndex = idx >= 0 ? idx : 0;
  }

  $effect(() => {
    if (open && startId != null) openAt(startId);
  });

  function close(): void {
    open = false;
    startId = null;
  }

  function go(delta: number): void {
    if (videos.length === 0) return;
    currentIndex = (currentIndex + delta + videos.length) % videos.length;
  }

  async function openInSystem(): Promise<void> {
    if (!current) return;
    try {
      const r = await videosApi.open(current.id);
      if (r.ok) pushToast("已用系统播放器打开");
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      const detail = m.match(/→ \d+: (.+)$/)?.[1] || m;
      pushToast(`打开失败：${detail}`, { kind: "error" });
    }
  }

  function formatDuration(sec: number | null): string {
    if (sec == null) return "";
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem.toString().padStart(2, "0")}`;
  }

  // capture + 立即停传播：网格（Feed）也监听 window 按键，内嵌以后它在同一棵树里会先收到事件。
  function onKey(e: KeyboardEvent): void {
    if (!open) return;
    const el = e.target instanceof HTMLElement ? e.target : null;
    const typing = !!el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
      return;
    }
    if (typing || e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    // 焦点在播放器自身时，← / → 是快进快退，别抢来做切换
    if (el && (el.tagName === "VIDEO" || el.tagName === "BUTTON")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    go(e.key === "ArrowLeft" ? -1 : 1);
  }
  onMount(() => {
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
</script>
{#if open && current}
  <section class="inline-viewer absolute inset-0 z-20 flex flex-col bg-bg overflow-hidden" aria-label="视频播放器">
    <header class="flex items-center gap-2 px-4 py-3 shrink-0 border-b border-border bg-surface">
      <button
        type="button"
        class="rounded-lg px-3 py-2 text-xs"
        title="返回缩略图（Esc）"
        aria-label="返回缩略图"
        onclick={close}
      >
        ← 返回
      </button>
      <span class="flex-1 min-w-0 truncate text-xs text-muted" title={current.filename}>{current.filename}</span>
      {#if compareOn && compareReady}
        <span class="text-[11px] text-muted">对比已选中的两个视频</span>
        <button type="button" class="rounded-lg px-3 py-2 text-xs" aria-pressed="true" onclick={() => { compareOn = false; }}>退出对比</button>
      {:else if compareReady}
        <button type="button" class="rounded-lg px-3 py-2 text-xs" title="对比选中的两个视频" aria-label="对比视频" onclick={() => { compareOn = true; }}>对比</button>
      {/if}
      <button type="button" class="rounded-lg px-3 py-2 text-xs" onclick={() => void openInSystem()}>用系统播放器打开</button>
    </header>

    <div class="video-canvas relative flex-1 min-h-0 overflow-hidden bg-black" ondblclick={(e) => { if (e.target === e.currentTarget) close(); }}>
      {#if compareOn && compareReady}
        <div class="absolute inset-0 p-3">
          <VideoCompare videos={selectedVideos} />
        </div>
      {:else if current.playable}
        {#key current.id}
          <video
            src={backendUrl(current.play_url)}
            controls
            autoplay
            playsinline
            preload="metadata"
            class="absolute inset-0 h-full w-full object-contain bg-black"
          >
            <span>你的浏览器不支持播放视频。</span>
          </video>
        {/key}
      {:else}
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-4 text-white">
          <Icon name="video" size={56} />
          <div class="text-[14px] text-zinc-300">该格式无法在应用内直接播放</div>
          <div class="text-[12px] text-zinc-500">({current.filename})</div>
          <button
            type="button"
            class="px-4 py-2 rounded-lg bg-accent text-bg text-[13px] font-medium hover:opacity-90"
            onclick={() => void openInSystem()}
          >
            用系统播放器打开
          </button>
        </div>
      {/if}

      {#if !compareOn && videos.length > 1}
        <button
          type="button"
          class="absolute left-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
          title="上一个视频"
          aria-label="上一个视频"
          onclick={() => go(-1)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <button
          type="button"
          class="absolute right-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
          title="下一个视频"
          aria-label="下一个视频"
          onclick={() => go(1)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      {/if}
    </div>

    <footer class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 shrink-0 border-t border-border bg-surface text-xs">
      <div class="flex items-center gap-2">
        <button type="button" class="rounded-lg px-3 py-2" title="上一个视频" aria-label="上一个视频页码" onclick={() => go(-1)}>‹</button>
        <span class="text-muted">{currentIndex + 1} / {videos.length}</span>
        <button type="button" class="rounded-lg px-3 py-2" title="下一个视频" aria-label="下一个视频页码" onclick={() => go(1)}>›</button>
      </div>
      <span class="text-muted font-mono truncate max-w-[60%]">
        {#if current.duration_seconds != null}{formatDuration(current.duration_seconds)}{/if}
        {#if current.width && current.height}· {current.width}×{current.height}{/if}
      </span>
      <span class="text-muted hidden xl:inline">Esc 返回缩略图 · ← / → 切换视频{#if compareOn && compareReady} · 按 S 切换对比方式{/if}</span>
    </footer>
  </section>
{/if}