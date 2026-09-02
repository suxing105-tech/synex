<script lang="ts">
  import { feedItems, feedTotal, feedLoading, refreshFeed, refreshStats, targetColumns, activeFolderName, newIds } from "../lib/stores";
  import { imagesApi } from "../lib/api";
  import { copyText } from "../lib/ws";
  import type { ImageSummary } from "../lib/types";
  import ContextMenu, { type ContextMenuItem } from "./ContextMenu.svelte";

  interface Props {
    selectedId: number | null;
    lightboxOpen: boolean;
    lightboxIndex: number;
  }
  let { selectedId = $bindable(), lightboxOpen = $bindable(), lightboxIndex = $bindable() }: Props = $props();

  // 右键菜单状态
  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let menuTarget = $state<ImageSummary | null>(null);
  let menuTick = $state(0);  // items 派生依赖，避免 store 更新时菜单不同步
  let toast = $state<string | null>(null);
  function notify(msg: string) {
    toast = msg;
    setTimeout(() => (toast = null), 1800);
  }

  function aspectFor(it: ImageSummary): string {
    if (it.width && it.height && it.height > 0) return `${it.width} / ${it.height}`;
    return "1 / 1";
  }

  function openLightbox(it: ImageSummary, idx: number) {
    selectedId = it.id;
    lightboxIndex = idx;
    lightboxOpen = true;
  }

  // ---------- 右键菜单：action handlers ----------

  function openContextMenu(e: MouseEvent, it: ImageSummary) {
    e.preventDefault();
    e.stopPropagation();
    menuTarget = it;
    menuX = e.clientX;
    menuY = e.clientY;
    menuTick++;
    menuOpen = true;
  }

  // 派生：根据 menuTick + menuTarget 重建菜单项
  let menuItems = $derived.by<ContextMenuItem[]>(() => {
    // 触发依赖
    void menuTick;
    const t = menuTarget;
    if (!t) return [];
    return [
      {
        label: "复制图片",
        onClick: () => copyImageToClipboard(t),
      },
      {
        label: "重命名",
        onClick: () => renameImage(t),
      },
      {
        label: "打开图片所在位置",
        onClick: () => revealImage(t),
      },
      { kind: "sep" },
      {
        label: "删除图片",
        danger: true,
        onClick: () => deleteImage(t),
      },
    ];
  });

  async function fetchImageBlob(it: ImageSummary): Promise<Blob | null> {
    const url = it.original_url ?? `/api/images/${it.id}/file`;
    try {
      const resp = await fetch(url, { cache: "no-cache" });
      if (!resp.ok) return null;
      return await resp.blob();
    } catch {
      return null;
    }
  }

  async function copyImageToClipboard(it: ImageSummary) {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
      // 退化方案：复制原图 URL
      const ok = await copyText(it.original_url ?? `/api/images/${it.id}/file`);
      notify(ok ? "已复制图片地址（剪贴板不支持图片）" : "复制失败");
      return;
    }
    const blob = await fetchImageBlob(it);
    if (!blob) {
      notify("获取图片失败");
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
      notify("已复制图片到剪贴板");
    } catch (e) {
      const ok = await copyText(it.original_url ?? `/api/images/${it.id}/file`);
      notify(ok ? "已复制图片地址" : "复制失败");
    }
  }

  async function renameImage(it: ImageSummary) {
    const stem = it.filename.replace(/\.[^.]+$/, "");
    const def = stem;
    const next = window.prompt("新文件名（保留扩展名）:", def);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) {
      notify("文件名不能为空");
      return;
    }
    try {
      await imagesApi.rename(it.id, trimmed);
      notify("已重命名");
      await Promise.all([refreshFeed(), refreshStats()]);
    } catch (e) {
      notify(`重命名失败: ${(e as Error).message}`);
    }
  }

  async function revealImage(it: ImageSummary) {
    try {
      await imagesApi.reveal(it.id);
    } catch (e) {
      notify(`打开位置失败: ${(e as Error).message}`);
    }
  }

  async function deleteImage(it: ImageSummary) {
    const drop = window.confirm(
      `确认删除 "${it.filename}"？\n\n点"确定"仅从索引移除（保留文件）；\n点"取消"后选"同时删除文件"走彻底删除流程。`,
    );
    if (!drop) {
      const both = window.confirm("彻底删除文件（连同磁盘文件一并删除）？此操作不可撤销！");
      if (!both) return;
      await doDelete(it, true);
      return;
    }
    await doDelete(it, false);
  }

  async function doDelete(it: ImageSummary, removeFile: boolean) {
    try {
      await imagesApi.remove(it.id, removeFile);
      notify(removeFile ? "已删除图片 + 文件" : "已从索引移除");
      // 如果删的是当前选中，清空选中
      if (selectedId === it.id) selectedId = null;
      await Promise.all([refreshFeed(), refreshStats()]);
    } catch (e) {
      notify(`删除失败: ${(e as Error).message}`);
    }
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
  // 列数 = $targetColumns（4-12），列宽 = 容器宽 / 列数 - gap；贪心按 height 投放。
  // 既保留 mtime 顺序（不 shuffle），又让每列内自然横竖混合。
  // 因为列宽是 px 固定，拖动缩放滑块时缩略图会真的变大变小。
  const COL_GAP = 8;

  // 容器宽度，由 bind:clientWidth 写入
  let containerWidth = $state(0);

  // 列数随容器宽度 + 缩放基线变
  // 列数直接来自 slider（4-12）；不靠容器宽度推算，避免临界点跳动
  let columnCount = $derived(Math.max(1, $targetColumns));

  // 列宽 = 容器宽均分 + gap，用于贪心分列预计算高度
  let columnWidth = $derived.by(() => {
    if (containerWidth <= 0) return 0;
    const n = columnCount;
    return (containerWidth - (n - 1) * COL_GAP) / n;
  });

  // 贪心分组
  let columns = $derived.by(() => {
    const n = columnCount;
    const w = columnWidth;
    const cols: { items: ImageSummary[]; height: number }[] = Array.from(
      { length: n },
      () => ({ items: [], height: 0 }),
    );
    if (w <= 0) return cols;
    for (const it of $feedItems) {
      const ratio = it.width && it.height ? it.height / it.width : 1;
      const h = w * ratio + COL_GAP;
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
    <span>列数</span>
    <input
      type="range"
      min="4"
      max="12"
      step="1"
      value={$targetColumns}
      oninput={(e) => targetColumns.set(Number((e.target as HTMLInputElement).value))}
      class="accent-accent w-32"
    />
    <span class="text-zinc-200 font-mono">{$targetColumns} 列</span>
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
        - 列数固定 = $targetColumns，列宽 = 容器宽 / 列数 - gap（拖滑块时缩略图真切变大变小）
        - 列数直接 = $targetColumns（不再推算）
        - 每张图放进当前最矮的列
        - 外层 overflow-x: auto 处理极窄屏兜底
    -->
    <div
      class="masonry-scroller"
      bind:clientWidth={containerWidth}
    >
      <div
        class="masonry-grid"
        style="grid-template-columns: repeat({columnCount}, minmax(0, 1fr)); gap: {COL_GAP}px;"
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
                oncontextmenu={(e) => openContextMenu(e, it)}
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

<ContextMenu bind:open={menuOpen} x={menuX} y={menuY} items={menuItems} />

{#if toast}
  <div class="toast">{toast}</div>
{/if}

<style>
  .masonry-scroller {
    /* 容器宽变化时整排可能溢出，横向滚动兜底；
       纵向交给父级 overflow-y-auto 处理 */
    overflow-x: auto;
    overflow-y: visible;
  }
  .masonry-grid {
    display: grid;
    /* align-items: start 防止 grid 拉伸列高 */
    align-items: start;
    /* 不再 width: max-content，让 grid 占满父级；
       repeat(n, minmax(0, 1fr)) 由 grid 平分容器宽，0 右缺口 */
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
