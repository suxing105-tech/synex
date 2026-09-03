<script lang="ts">
  import {
    feedItems, feedTotal, feedLoading, refreshFeed, refreshStats,
    targetColumns, activeFolderName, newIds,
    multiSelectedIds,
    selectedId as selectedIdStore,
    applySelection, clearSelection, removeIdsFromSelection,
  } from "../lib/stores";
  import { imagesApi } from "../lib/api";
  import { copyText } from "../lib/ws";
  import type { ImageSummary } from "../lib/types";
  import ContextMenu, { type ContextMenuItem } from "./ContextMenu.svelte";
  import { folderId } from "../lib/stores";

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
  // 右键菜单的目标 id 列表：右键目标在多选集合里 → 整个集合；否则 → [右键那张]。单图时菜单走单图逻辑（重命名 / 打开位置 / 复制单图），多图时只暴露「批量删除」和「复制 URL 列表」两条。
  let menuTargetIds = $state<number[]>([]);
  let menuTick = $state(0);
  let toast = $state<string | null>(null);
  function notify(msg: string) {
    toast = msg;
    setTimeout(() => (toast = null), 1800);
  }

  // ---------- 拖拽导入状态 ----------
  // 用 dragCounter 避免子元素冒泡触发的 dragenter/leave 闪烁：
  // 进入嵌套子元素时 +1，离开嵌套子元素时 -1，仅归零时才真正隐藏覆盖层。
  let dragCounter = $state(0);
  let dragFileCount = $state(0);  // dragenter 含 file 时统计
  let importing = $state(false);   // 正在上传：用于锁定拖拽区 + 替换 overlay 文案
  let importingProgress = $state({ done: 0, total: 0 });

  // 派生：是否处于"可视的拖拽中"（counter > 0 且 dragenter 至少包含 1 个文件）
  let dragHover = $derived(dragCounter > 0 && dragFileCount > 0 && !importing);

  // 派生：拖拽时的目标文件夹展示名
  let dropTargetLabel = $derived.by(() => {
    if ($folderId == null) return "收件箱";
    return $activeFolderName;
  });

  // 从拖拽事件里挑出可接受的图片 file 列表
  function pickImageFiles(dt: DataTransfer | null): File[] {
    if (!dt) return [];
    const out: File[] = [];
    if (dt.items && dt.items.length) {
      for (let i = 0; i < dt.items.length; i++) {
        const it = dt.items[i];
        if (it.kind !== "file") continue;
        const f = it.getAsFile();
        if (f && f.type.startsWith("image/")) out.push(f);
      }
    } else if (dt.files) {
      for (let i = 0; i < dt.files.length; i++) {
        const f = dt.files[i];
        if (f.type.startsWith("image/") || /\.(png|webp)$/i.test(f.name)) {
          out.push(f);
        }
      }
    }
    return out;
  }

  function onDragEnter(e: DragEvent) {
    if (!e.dataTransfer) return;
    const types = Array.from(e.dataTransfer.types || []);
    if (!types.includes("Files")) return;
    e.preventDefault();
    dragCounter++;
    const files = pickImageFiles(e.dataTransfer);
    if (files.length > 0) dragFileCount = files.length;
  }

  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer) return;
    const types = Array.from(e.dataTransfer.types || []);
    if (!types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(e: DragEvent) {
    if (!e.dataTransfer) return;
    e.preventDefault();
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) dragFileCount = 0;
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    dragCounter = 0;
    dragFileCount = 0;
    const files = pickImageFiles(e.dataTransfer);
    if (files.length === 0) {
      notify("未检测到 PNG / WebP 图片");
      return;
    }
    await importFiles(files);
  }

  async function importFiles(files: File[]) {
    importing = true;
    importingProgress = { done: 0, total: files.length };
    notify(`导入中… 0/${files.length}`);
    try {
      const resp = await imagesApi.import(files, $folderId);
      const saved = resp.saved?.length ?? 0;
      const skipped = resp.skipped ?? [];
      const folderTag = $folderId != null ? `「${dropTargetLabel}」` : "收件箱";
      if (saved > 0 && skipped.length === 0) {
        notify(`已导入 ${saved} 张到 ${folderTag}`);
      } else if (saved > 0 && skipped.length > 0) {
        const reasons = new Map<string, number>();
        for (const s of skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
        const reasonText = Array.from(reasons.entries())
          .map(([r, n]) => `${n} 张${reasonTextOf(r)}`)
          .join("，");
        notify(`已导入 ${saved} 张；跳过 ${reasonText}`);
      } else if (saved === 0 && skipped.length > 0) {
        notify(`全部 ${skipped.length} 张被跳过（${reasonTextOf(skipped[0].reason)}）`);
      } else {
        notify("导入完成");
      }
    } catch (err) {
      notify(`导入失败：${(err as Error).message}`);
    } finally {
      importing = false;
      importingProgress = { done: 0, total: 0 };
    }
  }

  function reasonTextOf(reason: string): string {
    switch (reason) {
      case "unsupported_format": return "格式不支持";
      case "too_large": return "超过 100MB";
      case "write_failed": return "写入失败";
      case "indexed_failed": return "索引失败";
      case "name_collision_exhausted": return "同名过多";
      default: return reason;
    }


  }

  function aspectFor(it: ImageSummary): string {
    if (it.width && it.height && it.height > 0) return `${it.width} / ${it.height}`;
    return "1 / 1";
  }

  // 当前多选张数（派生：用于 header 计数器）
  let selectedCount = $derived($multiSelectedIds.size);

  // 当前鼠标滑过的缩略图 id（空格键放大这张；不受 selectedId 影响）
  let hoveredId = $state<number | null>(null);

  // 反向同步：applySelection 写 store.selectedId 但不会反向写到这里的 prop，
  // 导致 handleKey（空格开 Lightbox）读到旧 prop。
  // 这里把 store 反向写到 prop，比较相等时跳过，避免 prop→store→prop 回环。
  $effect(() => {
    const v = $selectedIdStore;
    if (selectedId !== v) selectedId = v;
  });

  function openLightbox(it: ImageSummary, idx: number) {
    // 双击只对 primary 生效，不动多选集合
    selectedId = it.id;
    lightboxIndex = idx;
    lightboxOpen = true;
  }

  // 缩略图点击：根据修饰键走单选 / Ctrl 多选切换 / Shift 区间
  function onThumbClick(e: MouseEvent, it: ImageSummary) {
    const modifier = e.shiftKey ? "shift" : e.ctrlKey || e.metaKey ? "ctrl" : "none";
    applySelection($feedItems, it.id, modifier);
  }

  // ---------- 右键菜单：action handlers ----------

  function openContextMenu(e: MouseEvent, it: ImageSummary) {
    e.preventDefault();
    e.stopPropagation();
    // 右键的图不在当前多选集合里 → 先单选这张（与文件管理器行为一致），菜单对单图生效。
    // 右键的图已在多选集合里 → 不改选区，菜单对整个集合生效（多选才有意义）。
    if (!$multiSelectedIds.has(it.id)) {
      applySelection($feedItems, it.id, "none");
      menuTargetIds = [it.id];
    } else {
      // 复制当前多选集合快照，避免后续状态变化污染菜单项
      menuTargetIds = [...$multiSelectedIds];
    }
    menuX = e.clientX;
    menuY = e.clientY;
    menuTick++;
    menuOpen = true;
  }

  // 派生：根据 menuTick + menuTargetIds + 当前 feed 派生菜单项。
  // 单图：复制图片 / 重命名 / 打开位置 / 删除。
  // 多图：复制 N 个图片地址（Clipboard 一次只能写一张图，多张降级为 URL 文本）/ 批量删除。
  let menuItems = $derived.by<ContextMenuItem[]>(() => {
    void menuTick;
    const ids = menuTargetIds;
    if (ids.length === 0) return [];
    const items = $feedItems.filter((x) => ids.includes(x.id));
    if (items.length === 0) return [];
    if (items.length === 1) {
      const t = items[0];
      return [
        { label: "复制图片", onClick: () => copyImageToClipboard(t) },
        { label: "重命名", onClick: () => renameImage(t) },
        { label: "打开图片所在位置", onClick: () => revealImage(t) },
        { kind: "sep" },
        { label: "删除图片（含缩略图）", danger: true, onClick: () => deleteImages(items) },
      ];
    }
    return [
      { label: `复制 ${items.length} 个图片地址`, onClick: () => copyImageUrls(items) },
      { kind: "sep" },
      { label: `批量删除 ${items.length} 张图片`, danger: true, onClick: () => deleteImages(items) },
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
      const r = await imagesApi.reveal(it.id);
      if (r.method && r.method !== "noop") {
        notify(`已打开图片所在位置（${r.method}）`);
      } else {
        notify(`已请求打开图片所在位置`);
      }
    } catch (e) {
      notify(`打开位置失败: ${(e as Error).message}`);
    }
  }

  // 批量删除：单图也走这条，传 length=1 的数组即可。
  // 失败的项不会从多选集合里剔除，保留以便用户重试。
  async function deleteImages(items: ImageSummary[]) {
    if (items.length === 0) return;
    const succeeded: number[] = [];
    const failed: number[] = [];
    let cleaned = 0;
    for (const it of items) {
      try {
        const resp = await imagesApi.remove(it.id, true);
        succeeded.push(it.id);
        cleaned += resp.cleaned_previews ?? 0;
      } catch (e) {
        failed.push(it.id);
        console.error("delete failed", it.id, e);
      }
    }
    // 同步从多选集合里剔除真正删除成功的（失败的保留以便重试）
    removeIdsFromSelection(succeeded);
    const okCount = succeeded.length;
    const failCount = failed.length;
    if (okCount > 0 && failCount === 0) {
      notify(okCount === 1 ? `已删除图片（清理缩略图 ${cleaned} 个）` : `已删除 ${okCount} 张图片（清理缩略图 ${cleaned} 个）`);
    } else if (okCount > 0 && failCount > 0) {
      notify(`已删除 ${okCount} 张，${failCount} 张失败`);
    } else {
      notify(`删除失败（${failCount} 张）`);
    }
    // 乐观更新本地 feedItems：直接从数组里过滤掉已删 id。
    // 不调 refreshFeed() —— 整个数组替换会让 masonry 贪心分组重算，滚动条跳回顶部。
    // feedItems 用 (it.id) keyed each，Svelte 会复用 DOM，scroll 位置自然保持。
    if (okCount > 0) {
      const removed = new Set(succeeded);
      feedItems.update((items) => items.filter((it) => !removed.has(it.id)));
      feedTotal.update((n) => Math.max(0, n - okCount));
    }
    await refreshStats();
  }

  // 批量复制图片地址（多张时降级为 URL 文本）。
  // 浏览器 Clipboard 一次只能写一张 ClipboardItem（图片），多张只能合并成 text。
  async function copyImageUrls(items: ImageSummary[]) {
    const urls = items.map((it) => it.original_url ?? `/api/images/${it.id}/file`);
    const text = urls.join("\n");
    const ok = await copyText(text);
    notify(ok ? `已复制 ${items.length} 个图片地址` : "复制失败");
  }

  // 全局键盘：Esc 清空选区（仅在 feed 聚焦时；input 焦点时让原生处理）
  function isTypingTarget(t: EventTarget | null): boolean {
    if (!t || !(t instanceof HTMLElement)) return false;
    const tag = t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (t.isContentEditable) return true;
    return false;
  }

  function handleKey(e: KeyboardEvent) {
    if (isTypingTarget(e.target)) return;
    if (e.key === "Escape") {
      if (selectedCount > 0) {
        e.preventDefault();
        clearSelection();
      }
      return;
    }
    if (e.key === " " || e.code === "Space") {
      // Lightbox 已开时让位给 Lightbox 自己的 handler（按空格翻下一张）。
      // 否则两个 svelte:window handler 都触发：Feed 先把 lightboxOpen 改成 true，
      // Lightbox 的 handler 看到 open=true 紧接着调 next()，结果展示的是选中图的下一张。
      if (lightboxOpen) return;
      // 空格放大：当前鼠标滑过的那张，不再依赖 selectedId。
      // 鼠标没在任何缩略图上 → 不响应（避免误触发）。
      if (hoveredId !== null) {
        e.preventDefault();
        // 阻止 Lightbox 的 window keydown 也响应本次空格。
        e.stopImmediatePropagation();
        const idx = $feedItems.findIndex((it) => it.id === hoveredId);
        if (idx >= 0) {
          lightboxIndex = idx;
          lightboxOpen = true;
        }
      }
    }
  }

  // 空白区域点击 → 清空选区（不冒泡到 thumb）
  function onScrollerClick(e: MouseEvent) {
    if (e.target === e.currentTarget && selectedCount > 0) {
      clearSelection();
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
  // scroller DOM 引用 + lightbox 关闭时用于恢复 scrollTop
  let scrollerEl: HTMLDivElement | null = $state(null);
  let prevLightboxOpen = false;
  let savedScrollTop = 0;


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

  // Lightbox 开关时保留/恢复 scroller 滚动位置：
  // 关闭瞬间 feed 容器可能因 layout / focus 转移导致 scrollTop 落回 0，
  // 这里在打开时记一次，关闭后下一帧恢复，让用户继续在原来位置浏览。
  $effect(() => {
    const nowOpen = lightboxOpen;
    const wasOpen = prevLightboxOpen;
    prevLightboxOpen = nowOpen;
    if (nowOpen && !wasOpen) {
      if (scrollerEl) savedScrollTop = scrollerEl.scrollTop;
    } else if (!nowOpen && wasOpen) {
      const st = savedScrollTop;
      // 下一帧恢复（让 Svelte 先把 Lightbox 从 DOM 移除）
      queueMicrotask(() => {
        if (scrollerEl) scrollerEl.scrollTop = st;
      });
    }
  });
</script>

<svelte:window onkeydown={handleKey} />

<div class="px-5 pt-4 pb-3 flex items-center gap-4 border-b border-border bg-surface">
  <div>
    <div class="text-base font-medium">{$activeFolderName}</div>
    <div class="text-xs text-muted mt-0">
      {$feedTotal} 张
      {#if selectedCount > 0}
        <span class="ml-2 inline-flex items-center gap-1 text-accent">
          <span>已选 {selectedCount} 张</span>
          <button
            type="button"
            class="px-1.5 py-0.5 text-[11px] rounded border border-border hover:border-accent"
            onclick={() => clearSelection()}
            title="清空选区（Esc）"
          >清空</button>
        </span>
      {/if}
    </div>
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
      class="columns-slider w-32"
      style="--value: {$targetColumns}"
    />
    <span class="text-zinc-200">{$targetColumns} 列</span>
  </div>
</div>

<div
  bind:this={scrollerEl}
  class="overflow-y-auto p-3 feed-body relative"
  style="height: calc(100vh - 110px)"
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  role="region"
  aria-label="图片流；可拖拽文件到此处导入"
>
  {#if dragHover || importing}
    <div
      class="absolute inset-2 rounded-lg border-2 border-dashed border-accent bg-accent/10 backdrop-blur-sm flex items-center justify-center pointer-events-none z-20"
      role="presentation"
    >
      <div class="text-center px-6 py-4 rounded-md bg-surface-2/80 border border-accent shadow-2xl">
        {#if importing}
          <div class="text-3xl mb-2">⏳</div>
          <div class="text-[15px] font-medium">导入中…</div>
          <div class="text-[12px] text-muted mt-1 font-mono">
            {importingProgress.done}/{importingProgress.total}
          </div>
        {:else}
          <div class="text-3xl mb-2">📥</div>
          <div class="text-[15px] font-medium">释放以导入到{dropTargetLabel}</div>
          <div class="text-[12px] text-muted mt-1">
            {#if dragFileCount > 0}
              <span class="inline-block px-2 py-0.5 rounded bg-accent/20 text-accent font-mono">
                {dragFileCount} 个文件
              </span>
            {/if}
          </div>
          <div class="text-[11px] text-muted/80 mt-2">支持 PNG / WebP</div>
        {/if}
      </div>
    </div>
  {/if}

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
        - onScrollerClick: 点击空白区域时清空选区
    -->
    <div
      class="masonry-scroller"
      bind:clientWidth={containerWidth}
      onclick={onScrollerClick}
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
                class="thumb relative overflow-hidden rounded-md border border-border bg-surface-2 text-left {$multiSelectedIds.has(it.id) ? 'ring-2 ring-inset ring-accent' : ''} {$newIds.has(it.id) ? 'new-badge' : ''}"
                style="aspect-ratio: {aspectFor(it)}; width: 100%;"
                title={it.filename}
                onclick={(e) => onThumbClick(e, it)}
                ondblclick={() => openLightbox(it, $feedItems.findIndex((x) => x.id === it.id))}
                oncontextmenu={(e) => openContextMenu(e, it)}
                onmouseenter={() => (hoveredId = it.id)}
                onmouseleave={() => { if (hoveredId === it.id) hoveredId = null; }}
              >
                <img
                  src={it.original_url}
                  alt={it.filename}
                  loading="lazy"
                  decoding="async"
                  class="thumb-img w-full h-full object-cover"
                />
                <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/85 to-transparent px-2 py-1 text-[11px] truncate">
                  {it.filename}
                </div>
                {#if it.favorite}
                  <div class="absolute top-1 right-1 text-danger text-[14px] drop-shadow">♥</div>
                {/if}
                {#if $newIds.has(it.id)}
                  <div class="absolute bottom-8 left-1 bg-success text-bg text-[10px] font-bold px-1.5 rounded shadow">NEW</div>
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
  .thumb-img {
    transition: transform 0.35s cubic-bezier(0.2, 0.6, 0.2, 1); will-change: transform;
  }
  .thumb:hover .thumb-img {
    transform: scale(1.04);
  }
  /* 列数滑块：精致风格 — 细轨 + 圆形 thumb + filled 进度 + hover 反馈 */
  .columns-slider {
    -webkit-appearance: none;
    appearance: none;
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(
      to right,
      rgb(242 78 78) 0%,
      rgb(242 78 78) calc((var(--value) - 4) * 100% / 8),
      rgb(50 50 55) calc((var(--value) - 4) * 100% / 8),
      rgb(50 50 55) 100%
    );
    outline: none;
    cursor: pointer;
    transition: opacity 0.15s ease;
  }
  .columns-slider:hover { opacity: 0.92; }
  .columns-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: rgb(242 78 78);
    border: 2px solid rgb(24 24 27);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(242, 78, 78, 0.4);
    cursor: grab;
    transition: transform 0.15s cubic-bezier(0.2, 0.6, 0.2, 1), box-shadow 0.15s ease;
  }
  .columns-slider:hover::-webkit-slider-thumb {
    transform: scale(1.15);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6), 0 0 0 4px rgba(242, 78, 78, 0.2);
  }
  .columns-slider:active::-webkit-slider-thumb {
    cursor: grabbing;
    transform: scale(1.1);
  }
  .columns-slider::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: rgb(242 78 78);
    border: 2px solid rgb(24 24 27);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(242, 78, 78, 0.4);
    cursor: grab;
  }
  .columns-slider::-moz-range-track {
    height: 4px;
    border-radius: 2px;
    background: rgb(50 50 55);
  }
  .columns-slider:focus-visible::-webkit-slider-thumb {
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5), 0 0 0 4px rgba(242, 78, 78, 0.35);
  }
</style>
