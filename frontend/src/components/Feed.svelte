<script lang="ts">
  import { feedItems, feedTotal, feedLoading, zoomSize, activeFolderName, newIds } from "../lib/stores";
  import { formatDate, formatSize } from "../lib/ws";
  import type { ImageSummary } from "../lib/types";

  interface Props {
    selectedId: number | null;
    lightboxOpen: boolean;
    lightboxIndex: number;
  }
  let { selectedId = $bindable(), lightboxOpen = $bindable(), lightboxIndex = $bindable() }: Props = $props();

  function openLightbox(it: ImageSummary, idx: number) {
    selectedId = it.id;
    lightboxIndex = idx;
    lightboxOpen = true;
  }

  function handleKey(e: KeyboardEvent) {
    if (lightboxOpen) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (selectedId === null) return;
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      const idx = $feedItems.findIndex((it) => it.id === selectedId);
      if (idx >= 0) {
        lightboxIndex = idx;
        lightboxOpen = true;
      }
    }
  }
</script>

<svelte:window onkeydown={handleKey} />

<div class="px-5 pt-4 pb-3 flex items-center gap-4 border-b border-border bg-surface">
  <div>
    <div class="text-base font-medium">{$activeFolderName}</div>
    <div class="text-xs text-muted mt-0">{$feedTotal} 张</div>
  </div>
  <div class="ml-auto flex items-center gap-2 text-[12.5px] text-muted">
    <span>🔍</span>
    <input
      type="range"
      min="140"
      max="360"
      step="10"
      value={$zoomSize}
      oninput={(e) => zoomSize.set(Number((e.target as HTMLInputElement).value))}
      class="accent-accent w-32"
    />
    <span class="text-zinc-200 font-mono">{$zoomSize}px</span>
  </div>
</div>

<div class="overflow-y-auto p-3 feed-body" style="height: calc(100vh - 110px)">
  {#if $feedLoading}
    <div class="text-center text-muted py-12">加载中…</div>
  {:else if $feedItems.length === 0}
    <div class="text-center text-muted py-16">
      <div class="text-4xl mb-2 opacity-60">📂</div>
      <div>此视图下没有图片</div>
      <div class="text-[11px] mt-1">从左侧选择其他文件夹，或导入目录</div>
    </div>
  {:else}
    <div
      class="grid gap-2"
      style="grid-template-columns: repeat(auto-fill, minmax({$zoomSize}px, 1fr))"
    >
      {#each $feedItems as it, idx (it.id)}
        <button
          type="button"
          class="thumb relative overflow-hidden rounded-md border border-border bg-surface-2 hover:border-accent text-left {selectedId === it.id ? 'ring-2 ring-accent' : ''} {$newIds.has(it.id) ? 'new-badge' : ''}"
          style="aspect-ratio: 1 / 1"
          onclick={() => (selectedId = it.id)}
          ondblclick={() => openLightbox(it, idx)}
          title={it.filename}
        >
          {#if it.thumb_url}
            <img src={it.thumb_url} alt={it.filename} loading="lazy" class="w-full h-full object-cover" />
          {:else}
            <div class="w-full h-full flex items-center justify-center text-muted text-xs">无缩略图</div>
          {/if}
          <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/85 to-transparent px-2 py-1 text-[11px] truncate">
            {it.filename}
          </div>
          {#if it.favorite}
            <div class="absolute top-1 right-1 text-danger text-[14px] drop-shadow">♥</div>
          {/if}
          {#if newIds.has(it.id)}
            <div class="absolute top-1 left-1 bg-success text-bg text-[10px] font-bold px-1.5 rounded">NEW</div>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .thumb {
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .thumb:hover {
    transform: translateY(-2px);
  }
</style>
