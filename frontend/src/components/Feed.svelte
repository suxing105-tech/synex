<script lang="ts">
  import { feedItems, feedTotal, feedLoading, zoomSize, activeFolderName, newIds } from "../lib/stores";
  import type { ImageSummary } from "../lib/types";

  interface Props {
    selectedId: number | null;
    lightboxOpen: boolean;
    lightboxIndex: number;
  }
  let { selectedId = $bindable(), lightboxOpen = $bindable(), lightboxIndex = $bindable() }: Props = $props();

  function aspectFor(it: ImageSummary): string {
    if (it.width && it.height && it.height > 0) return `${it.width} / ${it.height}`;
    return "1 / 1";
  }

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

  // ---------- 真 masonry：JS 贪心分列 ----------
  //
  // 列宽固定 = $zoomSize，每列独立，贪心把每张图放进当前最矮的列。
  // 既保留 mtime 顺序（不 shuffle），又让每列内自然横竖混合。
  // 因为列宽是 px 固定，拖动缩放滑块时缩略图会真的变大变小。
  const COL_GAP = 8;

  // 容器宽度，由 bind:clientWidth 写入
  let containerWidth = $state(0);

  // 列数随容器宽度 + 缩放基线变
  let columnCount = $derived.by(() => {
    if (containerWidth <= 0) return 1;
    const n = Math.floor((containerWidth + COL_GAP) / ($zoomSize + COL_GAP));
    return Math.max(1, n);
  });

  // 贪心分组
  let columns = $derived.by(() => {
    const n = columnCount;
    const cols: { items: ImageSummary[]; height: number }[] = Array.from(
      { length: n },
      () => ({ items: [], height: 0 }),
    );
    for (const it of $feedItems) {
      const ratio = it.width && it.height ? it.height / it.width : 1;
      const h = $zoomSize * ratio + COL_GAP;
      // 找当前最矮的列
      let target = cols[0];
      for (let i = 1; i < n; i++) if (cols[i].height < target.height) target = cols[i];
      target.items.push(it);
      target.height += h;
    }
    return cols;
  });
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
      max="480"
      step="10"
      value={$zoomSize}
      oninput={(e) => zoomSize.set(Number((e.target as HTMLInputElement).value))}
      class="accent-accent w-32"
    />
    <span class="text-zinc-200 font-mono">{$zoomSize}px</span>
  </div>
</div>

<div
  class="overflow-y-auto p-3 feed-body"
  style="height: calc(100vh - 110px)"
>
  {#if $feedLoading}
    <div class="text-center text-muted py-12">加载中…</div>
  {:else if $feedItems.length === 0}
    <div class="text-center text-muted py-16">
      <div class="text-4xl mb-2 opacity-60">📂</div>
      <div>此视图下没有图片</div>
      <div class="text-[11px] mt-1">从左侧选择其他文件夹，或导入目录</div>
    </div>
  {:else}
    <!--
      贪心 masonry：
        - 列宽固定 = $zoomSize px（拖滑块时缩略图会真切变大变小）
        - 列数 = floor((容器宽 + gap) / (zoomSize + gap))
        - 每张图放进当前最矮的列
        - 外层 overflow-x: auto 处理极窄屏兜底
    -->
    <div
      class="masonry-scroller"
      bind:clientWidth={containerWidth}
    >
      <div
        class="masonry-grid"
        style="grid-template-columns: repeat({columnCount}, minmax({$zoomSize}px, 1fr)); gap: {COL_GAP}px;"
      >
        {#each columns as col}
          <div class="masonry-col" style="gap: {COL_GAP}px;">
            {#each col.items as it (it.id)}
              <button
                type="button"
                class="thumb relative overflow-hidden rounded-md border border-border bg-surface-2 hover:border-accent text-left {selectedId === it.id ? 'ring-2 ring-accent' : ''} {$newIds.has(it.id) ? 'new-badge' : ''}"
                style="aspect-ratio: {aspectFor(it)}; width: 100%;"
                title={it.filename}
                onclick={() => (selectedId = it.id)}
                ondblclick={() => openLightbox(it, $feedItems.findIndex((x) => x.id === it.id))}
              >
                <img
                  src={it.original_url}
                  alt={it.filename}
                  loading="lazy"
                  decoding="async"
                  class="w-full h-full object-cover"
                />
                <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/85 to-transparent px-2 py-1 text-[11px] truncate">
                  {it.filename}
                </div>
                {#if it.favorite}
                  <div class="absolute top-1 right-1 text-danger text-[14px] drop-shadow">♥</div>
                {/if}
                {#if $newIds.has(it.id)}
                  <div class="absolute top-1 left-1 bg-success text-bg text-[10px] font-bold px-1.5 rounded">NEW</div>
                {/if}
              </button>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .masonry-scroller {
    /* 列宽固定 = zoomSize 时整排可能溢出，横向滚动兜底；
       纵向交给父级 overflow-y-auto 处理 */
    overflow-x: auto;
    overflow-y: visible;
  }
  .masonry-grid {
    display: grid;
    /* align-items: start 防止 grid 拉伸列高 */
    align-items: start;
    /* 不再 width: max-content，让 grid 占满父级；
       repeat(n, minmax(zoomSize, 1fr)) 会自动把多余空间均分到各列 → 0 右缺口 */
  }
  .masonry-col {
    display: flex;
    flex-direction: column;
  }
  .thumb {
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .thumb:hover {
    transform: translateY(-2px);
  }
</style>
