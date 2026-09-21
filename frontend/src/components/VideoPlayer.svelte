<script lang="ts">
  import { backendUrl } from "../lib/backend-url";
  import { feedItems } from "../lib/stores";
  import { videosApi } from "../lib/api";
  import { pushToast } from "../lib/toast";
  import type { ImageSummary } from "../lib/types";
  import Icon from "./Icon.svelte";

  interface Props {
    open: boolean;
    startId: number | null;
  }
  let { open = $bindable(false), startId = $bindable<number | null>(null) }: Props = $props();

  // 当前 feed 里可播放的视频（有 play_url）
  const videos = $derived(
    $feedItems.filter((it): it is ImageSummary & { play_url: string } => !!it.play_url),
  );

  let currentIndex = $state(0);

  const current = $derived(videos[currentIndex] ?? null);

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
</script>

<svelte:window
  onkeydown={(e) => {
    if (!open) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowRight") go(1);
  }}
/>

{#if open && current}
  <div class="fixed inset-0 z-[80] bg-black/90 backdrop-blur-sm flex items-center justify-center" role="dialog" aria-modal="true" aria-label="视频播放器">
    <button
      type="button"
      class="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
      title="关闭 (Esc)"
      aria-label="关闭"
      onclick={close}
    >
      <Icon name="x" size={18} />
    </button>

    <button
      type="button"
      class="absolute left-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
      title="上一个"
      aria-label="上一个视频"
      onclick={() => go(-1)}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
    <button
      type="button"
      class="absolute right-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
      title="下一个"
      aria-label="下一个视频"
      onclick={() => go(1)}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </button>

    <div
      class="max-w-[90vw] max-h-[88vh] w-full h-full flex flex-col items-center justify-center gap-3"
      onclick={(e) => e.stopPropagation()}
    >
      {#if current.playable}
        {#key current.id}
          <video
            src={backendUrl(current.play_url)}
            controls
            autoplay
            playsinline
            class="max-w-full max-h-[80vh] rounded-md bg-black shadow-2xl"
          >
            <span>你的浏览器不支持播放视频。</span>
          </video>
        {/key}
      {:else}
        <div class="flex flex-col items-center gap-4 text-white">
          <Icon name="video" size={56}/>
          <div class="text-[14px] text-zinc-300">该格式无法在应用内直接播放</div>
          <div class="text-[12px] text-zinc-500">({current.filename})</div>
          <button
            type="button"
            class="px-4 py-2 rounded-lg bg-accent text-bg text-[13px] font-medium hover:opacity-90"
            onclick={openInSystem}
          >
            用系统播放器打开
          </button>
        </div>
      {/if}

      <div class="text-white/80 text-[12px] font-mono truncate max-w-[80vw]">
        {current.filename}
        {#if current.duration_seconds != null}
          · {formatDuration(current.duration_seconds)}
        {/if}
        {#if current.width && current.height}
          · {current.width}×{current.height}
        {/if}
      </div>
    </div>
  </div>
{/if}
