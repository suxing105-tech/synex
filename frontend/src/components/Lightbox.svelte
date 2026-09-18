<script lang="ts">
  import ImageCompare from "./ImageCompare.svelte";
  import { multiSelectedIds, removeImageFromFeed, refreshFolders } from "../lib/stores";
  import { copyOriginalImage } from "../lib/image-clipboard";
  import { matchesAction, shortcutBlocked } from "../lib/shortcut-settings";
  import { backendUrl } from "../lib/backend-url";
  import { feedItems, refreshFeed, refreshStats } from "../lib/stores";
  import { imagesApi } from "../lib/api";
  import { copyText, formatSize } from "../lib/ws";
  import ContextMenu, { type ContextMenuItem } from "./ContextMenu.svelte";
  import {
    clampPan,
    panFromDrag,
    nextZoomMode,
    type PanOffset,
  } from "../lib/lightbox-zoom";
  import { getOrientedImageSize, safeOrientedSize } from "../lib/image-dims";

  interface Props {
    open: boolean;
    index: number;
    selectedId: number | null;
  }
  let { open = $bindable(), index = $bindable(), selectedId = $bindable() }: Props = $props();

  let compareEnabled = $state(true);
  let compareImages = $derived($feedItems.filter(it => $multiSelectedIds.has(it.id)));
  let comparing = $derived(compareEnabled && compareImages.length === 2);
  $effect(() => { if (open) compareEnabled = true; });

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

  // ---------- 100% 放大 + 抓手拖动 ----------
  // 用 pointer events + setPointerCapture 是最稳的拖动模式：
  // 即使光标移出图片元素（甚至移出视口），所有 pointermove 还是会送到同一元素，
  // 不会因为 img 在 zoom 模式下溢出视口而丢事件。
  let zoomMode = $state<"fit" | "zoom">("fit");
  let zoomScale = $state(1);
  let pan = $state<PanOffset>({ x: 0, y: 0 });
  let isDragging = $state(false);
  let dragStartMouseX = 0;
  let dragStartMouseY = 0;
  let dragStartPanX = 0;
  let dragStartPanY = 0;
  // 记录拖动时的 pointerId + 元素引用，便于 releasePointerCapture
  let dragPointerId = -1;
  let dragEl: HTMLElement | null = null;
  let imgNaturalW = $state(0);
  let imgNaturalH = $state(0);
  // 视觉尺寸（已应用 EXIF 旋转），用于 fitSize/displayW/clampPan 等所有计算。
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
  let viewportW = $state(0);
  let viewportH = $state(0);
  let imgEl: HTMLImageElement | null = $state(null);

  function viewportSize(): { w: number; h: number } {
    if (viewportW > 0 && viewportH > 0) return { w: viewportW, h: viewportH };
    return { w: 0, h: 0 };
  }

  // 以中间预览画布的实际尺寸为准，调整侧栏宽度时自动重新适配。
  let fitRatio = $derived.by(() => {
    if (safeVisualW <= 0 || safeVisualH <= 0 || viewportW <= 0 || viewportH <= 0) return 1;
    return Math.min(1, Math.max(1, viewportW - 48) / safeVisualW, Math.max(1, viewportH - 48) / safeVisualH);
  });

  let displayW = $derived(
    safeVisualW <= 0 ? 0 :
    zoomMode === "zoom" ? safeVisualW * zoomScale :
    Math.max(1, Math.round(safeVisualW * fitRatio))
  );
  let displayH = $derived(
    safeVisualH <= 0 ? 0 :
    zoomMode === "zoom" ? safeVisualH * zoomScale :
    Math.max(1, Math.round(safeVisualH * fitRatio))
  );

  let imgTransition = $derived(
    isDragging
      ? "width 0.28s ease, height 0.28s ease"
      : "width 0.28s ease, height 0.28s ease, transform 0.28s ease"
  );

  function resetZoom() {
    zoomMode = "fit";
    zoomScale = 1;
    pan = { x: 0, y: 0 };
    isDragging = false;
    if (dragEl && dragPointerId >= 0) {
      try { dragEl.releasePointerCapture(dragPointerId); } catch {}
    }
    dragPointerId = -1;
    dragEl = null;
  }

  function toggleZoom() {
    const r = nextZoomMode(zoomMode);
    zoomScale = 1;
    zoomMode = r.mode;
    pan = r.pan;
  }

  function wheelZoom(node: HTMLElement) {
    node.addEventListener("wheel", onWheel, { passive: false });
    return { destroy: () => node.removeEventListener("wheel", onWheel) };
  }

  function onWheel(e: WheelEvent) {
    if (comparing || !safeVisualW || !e.deltaY) return;
    e.preventDefault();
    const previous = zoomMode === "fit" ? fitRatio : zoomScale;
    const next = Math.max(Math.min(0.05, fitRatio), Math.min(8, previous * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Number.isFinite(e.clientX) ? e.clientX - rect.left - rect.width / 2 : 0;
    const y = Number.isFinite(e.clientY) ? e.clientY - rect.top - rect.height / 2 : 0;
    pan = { x: x - (x - pan.x) * next / previous, y: y - (y - pan.y) * next / previous };
    zoomScale = next;
    zoomMode = "zoom";
  }

  function onImgDblClick(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    toggleZoom();
  }

  // ---------- Pointer events 拖动 ----------
  //
  // 为什么用 pointerdown 而不是 mousedown：
  //   - pointerdown 是统一的指针事件，鼠标/触摸/笔都走同一条路；
  //   - setPointerCapture 后，光标移出 img 也会继续送 pointermove 给同一元素，
  //     即便 img 在 zoom 模式下溢出视口 / 元素被遮，也不会丢事件；
  //   - pointercancel（系统级中断，如 alt-tab）也正确收尾。
  function onImgPointerDown(e: PointerEvent) {
    if (zoomMode !== "zoom") return;
    // 只响应左键 / 触摸 / 笔
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    isDragging = true;
    dragStartMouseX = e.clientX;
    dragStartMouseY = e.clientY;
    dragStartPanX = pan.x;
    dragStartPanY = pan.y;
    dragPointerId = e.pointerId;
    dragEl = target;
    try { target.setPointerCapture(e.pointerId); } catch {}
  }

  function onImgPointerMove(e: PointerEvent) {
    if (!isDragging) return;
    if (dragPointerId !== e.pointerId) return;
    const next = panFromDrag(
      e.clientX,
      e.clientY,
      dragStartMouseX,
      dragStartMouseY,
      { x: dragStartPanX, y: dragStartPanY },
    );
    // 内联 clampPan，并 guard 写入：避免和后续 effect 形成死循环
    const clamped = clampPan(next, { w: displayW, h: displayH }, viewportSize(), 0);
    if (clamped.x !== pan.x || clamped.y !== pan.y) {
      pan = clamped;
    }
  }

  function onImgPointerUp(e: PointerEvent) {
    if (dragPointerId !== e.pointerId) return;
    if (dragEl) {
      try { dragEl.releasePointerCapture(e.pointerId); } catch {}
    }
    isDragging = false;
    dragPointerId = -1;
    dragEl = null;
  }

  function close() {
    open = false;
    originalUrl = null;
    resetZoom();
  }

  function prev() {
    if ($feedItems.length === 0) return;
    index = (index - 1 + $feedItems.length) % $feedItems.length;
  }
  function next() {
    if ($feedItems.length === 0) return;
    index = (index + 1) % $feedItems.length;
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
      if (zoomMode === "zoom") {
        e.preventDefault();
        toggleZoom();
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
    const it = $feedItems[index];
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
    const it = $feedItems.find((x) => x.id === id);
    if (!it) return [];
    return [
      { label: "复制图片", onClick: () => copyImage(it) },
      { label: "重命名", onClick: () => renameImage(it) },
      { label: "图片所在位置", onClick: () => revealImage(it) },
      { kind: "sep" },
      { label: "删除图片", danger: true, onClick: () => deleteImage(it) },
    ];
  });

  async function copyImage(it: { id: number }) {
    try { await copyOriginalImage(it.id); notify("已复制原图到剪贴板"); }
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
      const r = await imagesApi.reveal(it.id);
      if (r.method && r.method !== "noop") {
      } else {
      }
    } catch (e) {
      notify(`打开位置失败: ${(e as Error).message}`);
    }
  }

  let deleting = false;
  async function deleteCurrent() {
    if (deleting) return;
    deleting = true;
    const targets = comparing ? [...compareImages] : [$feedItems[index]].filter(Boolean);
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
      const it = $feedItems[index];
      if (it) {
        originalUrl = backendUrl(`/api/images/${it.id}/file?cache=2`);
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
    resetZoom();
    // 等新图加载完再清 natural，避免短暂 0×0 让 fitSize 计算抖动
    // 这里不清，依赖 imgNaturalW 重新绑定新图的尺寸即可
  });



  $effect(() => {
    if (zoomMode !== "zoom") return;
    const bounded = clampPan(pan, { w: displayW, h: displayH }, { w: viewportW, h: viewportH }, 0);
    if (bounded.x !== pan.x || bounded.y !== pan.y) pan = bounded;
  });

  let imgCursor = $derived(
    zoomMode === "fit"
      ? "default"
      : isDragging
      ? "grabbing"
      : "grab",
  );
</script>

<svelte:window onkeydown={handleKey} />

{#if open && $feedItems.length > 0 && $feedItems[index]}
  {@const it = $feedItems[index]}
  <section class="inline-viewer absolute inset-0 z-20 flex flex-col bg-bg overflow-hidden fill-interactions" aria-label="图片细节预览">
    <header class="flex items-center gap-2 px-4 py-3 shrink-0 border-b border-border bg-surface">
      <button class="rounded-lg px-3 py-2 text-xs" onclick={close} title="返回缩略图（Esc）">← 返回</button>
      <span class="flex-1 min-w-0 truncate text-xs text-muted" title={it.filename}>{it.filename}</span>
      {#if compareImages.length === 2}<button class="rounded-lg px-3 py-2 text-xs" aria-pressed={comparing} onclick={() => compareEnabled = !compareEnabled}>{comparing ? "查看单图" : "对比图片"}</button>{/if}
      {#if !comparing}
      <button class="rounded-lg px-3 py-2 text-xs" aria-pressed={zoomMode === "fit"} onclick={resetZoom}>适应窗口</button>
      <button class="rounded-lg px-3 py-2 text-xs" aria-pressed={zoomMode === "zoom"} onclick={() => { zoomMode = "zoom"; zoomScale = 1; pan = { x: 0, y: 0 }; }}>100%</button>
      <span class="text-xs text-muted">{Math.round((zoomMode === "fit" ? fitRatio : zoomScale) * 100)}%</span>
      {/if}
    </header>
    <div class="viewer-canvas relative flex-1 min-h-0 overflow-hidden" bind:clientWidth={viewportW} bind:clientHeight={viewportH} oncontextmenu={openMenu} use:wheelZoom>
      {#if comparing}
        <ImageCompare images={compareImages} />
      {:else}
      <div class="absolute inset-0 flex items-center justify-center overflow-hidden" ondblclick={(e) => { if (e.button === 0 && e.target === e.currentTarget) close(); }}>
    <img
      bind:this={imgEl}
      src={originalUrl ?? ""}
      alt={it.filename}
      bind:naturalWidth={imgNaturalW}
      bind:naturalHeight={imgNaturalH}
      class="shrink-0 select-none lightbox-img"
      style:width={displayW > 0 ? `${displayW}px` : null}
      style:height={displayH > 0 ? `${displayH}px` : null}
      style:transform={zoomMode === "zoom" ? `translate(${pan.x}px, ${pan.y}px)` : "none"}
      style:transition={imgTransition}
      style:cursor={imgCursor}
      style:touch-action="none"
      draggable="false"
      onpointerdown={onImgPointerDown}
      onpointermove={onImgPointerMove}
      onpointerup={onImgPointerUp}
      onpointercancel={onImgPointerUp}
      ondblclick={onImgDblClick}
    />

      </div>
      {/if}
    </div>
    <footer class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 shrink-0 border-t border-border bg-surface text-xs">
      {#if !comparing}<div class="flex items-center gap-2">
        <button class="rounded-lg px-3 py-2" onclick={prev} title="上一张">‹</button>
        <span class="text-muted">{index + 1} / {$feedItems.length}</span>
        <button class="rounded-lg px-3 py-2" onclick={next} title="下一张">›</button>
      </div>
      <span class="text-muted">{#if it.width && it.height}{it.width} × {it.height} · {/if}{formatSize(it.size_bytes)}</span>
      {/if}
      <span class="text-muted">{comparing ? "拖动分割线对比 · Delete 删除两张图片" : zoomMode === "zoom" ? "滚轮缩放 · 拖动查看细节 · 双击适应窗口" : "滚轮缩放 · 双击图片查看 100%"}</span>
    </footer>
  </section>
{/if}

<ContextMenu bind:open={menuOpen} x={menuX} y={menuY} items={menuItems} />

{#if toast}
  <div class="toast">{toast}</div>
{/if}

<style>
  .lightbox-img {
    max-width: none;
    -webkit-user-drag: none;
    user-select: none;
    -webkit-user-select: none;
  }
</style>
