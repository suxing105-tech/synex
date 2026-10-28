<script lang="ts">
  import ImageCompare from "./ImageCompare.svelte";
  import CompareModeSwitch from "./CompareModeSwitch.svelte";
  import { compareMode, registerCompareToggle } from "../lib/compare-mode";
  import { multiSelectedIds, removeImageFromFeed, refreshFolders } from "../lib/stores";
  import { copyOriginalImage } from "../lib/image-clipboard";
  import { isPsdFilename } from "../lib/media-format";
  import { matchesAction, shortcutBlocked } from "../lib/shortcut-settings";
  import { backendUrl } from "../lib/backend-url";
  import { mediaItems, refreshFeed, refreshStats } from "../lib/stores";
  import { imagesApi } from "../lib/api";
  import { revealLocation as revealInShell } from "../lib/reveal";
  import { copyText, formatSize } from "../lib/ws";
  import ContextMenu, { type ContextMenuItem } from "./ContextMenu.svelte";
  import { ViewerZoom, ZOOM_HINT, viewerZoomWheel } from "../lib/viewer-zoom.svelte";
  import ViewerZoomControls from "./ViewerZoomControls.svelte";
  import { getOrientedImageSize, safeOrientedSize } from "../lib/image-dims";

  interface Props {
    open: boolean;
    index: number;
    selectedId: number | null;
  }
  let { open = $bindable(), index = $bindable(), selectedId = $bindable() }: Props = $props();

  let compareEnabled = $state(true);
  let compareImages = $derived($mediaItems.filter(it => $multiSelectedIds.has(it.id)));
  let comparing = $derived(compareEnabled && compareImages.length === 2);

  // 右键菜单
  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let menuTargetId = $state<number | null>(null);
  let menuTick = $state(0);
  let toast = $state<string | null>(null);
  function notify(msg: string) {
    toast = msg;
    setTimeout(() => (toast = null), 1800);
  }

  let originalUrl = $state<string | null>(null);
  let fullPreviewFailed = $state(false);

  // ---------- 适应窗口 ⇄ 100% ----------
  // 缩放状态与交互（滚轮 / 抓手拖动 / 双击 / 边界 clamp）全部在 lib/viewer-zoom.svelte.ts，
  // 与视频播放器共用同一份。这里只喂给它两样东西：图片的视觉尺寸、画布的实测尺寸。
  let imgNaturalW = $state(0);
  let imgNaturalH = $state(0);
  // 视觉尺寸（已应用 EXIF 旋转），用于 fitRatio / displayW / clampPan 等所有计算。
  // imgNaturalW/H 来自 bind:naturalWidth，是存储像素；visualW/H 是浏览器实际渲染的尺寸。
  // 不一致 = EXIF 旋转 = 之前大横图变形的根因。
  let visualW = $state(0);
  let visualH = $state(0);
  // 安全视觉尺寸：用于 fitRatio / displayW / displayH / clampPan 的真值源。
  // 防御场景_00002_ 这类大横图切图时 visualW/H 还没异步回来就先用旧值、把新图挤变形。
  // 详见 ../lib/image-dims.ts 的 safeOrientedSize。
  let safeVisualW = $derived(
    safeOrientedSize({ w: imgNaturalW, h: imgNaturalH }, { w: visualW, h: visualH }).w,
  );
  let safeVisualH = $derived(
    safeOrientedSize({ w: imgNaturalW, h: imgNaturalH }, { w: visualW, h: visualH }).h,
  );
  // 以中间预览画布的实际尺寸为准，调整侧栏宽度时自动重新适配。
  let viewportW = $state(0);
  let viewportH = $state(0);
  let imgEl: HTMLImageElement | null = $state(null);

  const zoom = new ViewerZoom({
    content: () => ({ w: safeVisualW, h: safeVisualH }),
    viewport: () => ({ w: viewportW, h: viewportH }),
    inset: 48,
    // 对比模式有自己的分割线手势，缩放整体让路。
    enabled: () => !comparing,
    // 图片永不放大超过原始分辨率：放大只会糊；百分比读数会如实停在 100%。
    upscaleToFit: false,
  });

  function onImgDblClick(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    zoom.toggle();
  }

  function close() {
    open = false;
    compareEnabled = true;
    originalUrl = null;
    zoom.reset();
  }

  function toggleCompare() {
    compareEnabled = !compareEnabled;
  }

  // App 也能把 open 直接置 false（Ctrl+F 先退层再聚焦搜索框），这条兜住没走 close() 的路径，
  // 免得下次打开还停在上一张的 100% 缩放里。
  $effect(() => {
    if (open) return;
    if (compareEnabled && zoom.mode === "fit" && !zoom.dragging) return;
    compareEnabled = true;
    zoom.reset();
  });

  // S 键换对比方式：只在对比开着时接管，退出对比后 S 仍是详情栏的「复制 Seed」。
  $effect(() => {
    if (!comparing) return;
    return registerCompareToggle(() => comparing);
  });

  function prev() {
    if ($mediaItems.length === 0) return;
    index = (index - 1 + $mediaItems.length) % $mediaItems.length;
  }
  function next() {
    if ($mediaItems.length === 0) return;
    index = (index + 1) % $mediaItems.length;
  }

  function handleKey(e: KeyboardEvent) {
    if (shortcutBlocked(e)) return;
    if (!open) return;
    if (e.key === "Delete" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      void deleteCurrent();
      return;
    }
    if (comparing && e.key !== "Escape") return;
    if (e.key === "Escape") {
      if (zoom.isZooming()) {
        e.preventDefault();
        zoom.setFit();
        return;
      }
      e.preventDefault();
      close();
    } else if (matchesAction(e, "previous")) {
      e.preventDefault();
      prev();
    } else if (matchesAction(e, "next")) {
      e.preventDefault();
      next();
    } else if (matchesAction(e, "preview")) {
      e.preventDefault();
      next();
    }
  }

  // ---------- 右键菜单 actions ----------

  function openMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const it = $mediaItems[index];
    if (!it) return;
    menuTargetId = it.id;
    menuX = e.clientX;
    menuY = e.clientY;
    menuTick++;
    menuOpen = true;
  }

  let menuItems = $derived.by<ContextMenuItem[]>(() => {
    void menuTick;
    const id = menuTargetId;
    if (id === null) return [];
    const it = $mediaItems.find((x) => x.id === id);
    if (!it) return [];
    return [
      { label: "复制图片", onClick: () => copyImage(it) },
      { label: "重命名", onClick: () => renameImage(it) },
      { label: "图片所在位置", onClick: () => revealImage(it) },
      { kind: "sep" },
      { label: "删除图片", danger: true, onClick: () => deleteImage(it) },
    ];
  });

  async function copyImage(it: { id: number; filename: string }) {
    try { await copyOriginalImage(it.id); notify(isPsdFilename(it.filename) ? "已复制 PSD 合成画面" : "已复制原图到剪贴板"); }
    catch (e) { notify(`复制原图失败：${(e as Error).message}`); }
  }

  async function renameImage(it: any) {
    const stem = it.filename.replace(/.[^.]+$/, "");
    const next = window.prompt("新文件名（保留扩展名）:", stem);
    if (next === null) return;
    if (!next.trim()) return notify("文件名不能为空");
    try {
      await imagesApi.rename(it.id, next.trim());
      notify("已重命名");
      await Promise.all([refreshFeed(), refreshStats()]);
    } catch (e) {
      notify(`重命名失败: ${(e as Error).message}`);
    }
  }

  async function revealImage(it: any) {
    try {
      const via = await revealInShell(it.path, true, () => imagesApi.reveal(it.id));
      if (via === "desktop") notify("已打开图片所在位置");
    } catch (e) {
      notify(`打开位置失败: ${(e as Error).message}`);
    }
  }

  let deleting = false;
  async function deleteCurrent() {
    if (deleting) return;
    deleting = true;
    const targets = comparing ? [...compareImages] : [$mediaItems[index]].filter(Boolean);
    for (const it of targets) await deleteImage(it);
    deleting = false;
  }
  async function deleteImage(it: any) {
    try {
      const resp = await imagesApi.remove(it.id, true);
      removeImageFromFeed(it.id);
      notify(`已删除图片（清理缩略图 ${resp.cleaned_previews ?? 0} 个）`);
      if (selectedId === it.id) selectedId = null;
      open = false;
      await Promise.allSettled([refreshStats(), refreshFolders()]);
    } catch (e) {
      notify(`删除失败: ${(e as Error).message}`);
    }
  }

  // 切换图片 / 重新打开：设置 URL + 选中
  $effect(() => {
    if (open) {
      const it = $mediaItems[index];
      if (it) {
        originalUrl = backendUrl(`/api/images/${it.id}/file?cache=2`);
        fullPreviewFailed = false;
        selectedId = it.id;
      }
    }
  });

  // 切图 → fetch + createImageBitmap 拿视觉尺寸（EXIF 旋转后），写入 visualW/H。
  // createImageBitmap(imageOrientation: from-image) 在 Chrome / Firefox / Safari 都返回浏览器
  // 实际渲染的尺寸，是统一可靠的来源；失败时 fallback 到 imgNaturalW/H。
  $effect(() => {
    const url = originalUrl;
    if (!url) {
      visualW = 0;
      visualH = 0;
      return;
    }
    let cancelled = false;
    getOrientedImageSize(url, { w: imgNaturalW, h: imgNaturalH }).then((dims) => {
      if (cancelled) return;
      if (dims.w > 0 && dims.h > 0) {
        visualW = dims.w;
        visualH = dims.h;
      }
    });
    return () => { cancelled = true; };
  });

  // 切图 → 重置 zoom + 拖动状态；不重置 naturalWidth（让 img 直接换 src 复用）
  $effect(() => {
    index;
    zoom.reset();
    // 等新图加载完再清 natural，避免短暂 0×0 让 fitSize 计算抖动
    // 这里不清，依赖 imgNaturalW 重新绑定新图的尺寸即可
  });



  // 画布尺寸变化（拖侧栏、最大化窗口）时把越界的平移拉回边界
  $effect(() => {
    zoom.clampNow();
  });

</script>

<svelte:window onkeydown={handleKey} />

{#if open && $mediaItems.length > 0 && $mediaItems[index]}
  {@const it = $mediaItems[index]}
  <section class="inline-viewer absolute inset-0 z-20 flex flex-col bg-bg overflow-hidden fill-interactions" aria-label="图片细节预览">
    <header class="lightbox-header flex items-center gap-2 px-4 py-3 shrink-0 border-b border-border bg-surface">
      <button class="rounded-lg px-3 py-2 text-xs" onclick={close} title="返回缩略图（Esc）">← 返回</button>
      <span class="flex-1 min-w-0 truncate text-xs text-muted" title={it.filename}>{it.filename}</span>
      {#if compareImages.length === 2}<button class="rounded-lg px-3 py-2 text-xs" aria-pressed={comparing} onclick={toggleCompare}>{comparing ? "查看单图" : "对比图片"}</button>{/if}
      {#if comparing}
        <!-- 顶栏正中间的开关，排在本段最后：Svelte 5 的事件委托里，组件排在
             同分支兄弟元素之前会让后面的按钮点不动。 -->
        <CompareModeSwitch label="图片对比方式" />
      {/if}
      {#if !comparing}
        <!-- 缩放开关排在顶栏所有按钮之后：组件排在兄弟按钮前面会让后面的按钮点不动（Svelte 5 事件委托） -->
        <ViewerZoomControls {zoom} />
      {/if}
    </header>
    <div class="viewer-canvas relative flex-1 min-h-0 overflow-hidden" bind:clientWidth={viewportW} bind:clientHeight={viewportH} oncontextmenu={openMenu} ondblclick={(e) => { if (!comparing && e.target === e.currentTarget) close(); }} use:viewerZoomWheel={zoom}>
      <div class="absolute inset-0 flex items-center justify-center overflow-hidden" class:hidden={comparing} ondblclick={(e) => { if (e.target === e.currentTarget) close(); }}>
    <img
      bind:this={imgEl}
      src={originalUrl ?? ""}
      alt={it.filename}
      bind:naturalWidth={imgNaturalW}
      bind:naturalHeight={imgNaturalH}
      class="shrink-0 select-none lightbox-img"
      style:width={zoom.sized ? `${zoom.displayW}px` : null}
      style:height={zoom.sized ? `${zoom.displayH}px` : null}
      style:transform={zoom.isZooming() ? `translate(${zoom.pan.x}px, ${zoom.pan.y}px)` : "none"}
      style:transition={zoom.transition}
      style:cursor={zoom.cursor}
      style:touch-action="none"
      draggable="false"
      onpointerdown={zoom.onPointerDown}
      onpointermove={zoom.onPointerMove}
      onpointerup={zoom.onPointerUp}
      onpointercancel={zoom.onPointerUp}
      ondblclick={onImgDblClick}
      onerror={() => { fullPreviewFailed = true; }}
      onload={() => { fullPreviewFailed = false; }}
    />

      </div>
      {#if fullPreviewFailed && !comparing}
        <div class="absolute inset-0 flex items-center justify-center text-sm text-muted" role="status">图片预览不可用</div>
      {/if}
      <div class="absolute inset-0" class:hidden={!comparing}>
        {#if compareImages.length === 2}<ImageCompare images={compareImages} mode={$compareMode} />{/if}
      </div>
    </div>
    <footer class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 shrink-0 border-t border-border bg-surface text-xs">
      {#if !comparing}<div class="flex items-center gap-2">
        <button class="rounded-lg px-3 py-2" onclick={prev} title="上一张">‹</button>
        <span class="text-muted">{index + 1} / {$mediaItems.length}</span>
        <button class="rounded-lg px-3 py-2" onclick={next} title="下一张">›</button>
      </div>
      <span class="text-muted">{#if it.width && it.height}{it.width} × {it.height} · {/if}{formatSize(it.size_bytes)}</span>
      {/if}
      <span class="text-muted">{comparing ? ($compareMode === "split" ? "拖动分割线对比" : "左右并排查看") + " · 按 S 切换对比方式 · Delete 删除两张图片" : (zoom.isZooming() ? ZOOM_HINT.zoom : ZOOM_HINT.fit)}</span>
    </footer>
  </section>
{/if}

<ContextMenu bind:open={menuOpen} x={menuX} y={menuY} items={menuItems} />

{#if toast}
  <div class="toast">{toast}</div>
{/if}

<style>
  .lightbox-header { position:relative; }
  .lightbox-img {
    max-width: none;
    -webkit-user-drag: none;
    user-select: none;
    -webkit-user-select: none;
  }
</style>
