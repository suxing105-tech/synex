<script lang="ts">
  import { feedItems, refreshFeed, refreshStats } from "../lib/stores";
  import { imagesApi } from "../lib/api";
  import { copyText, formatDate, formatSize } from "../lib/ws";
  import ContextMenu, { type ContextMenuItem } from "./ContextMenu.svelte";
  import {
    clampPan,
    panFromDrag,
    nextZoomMode,
    type PanOffset,
  } from "../lib/lightbox-zoom";

  interface Props {
    open: boolean;
    index: number;
    selectedId: number | null;
  }
  let { open = $bindable(), index = $bindable(), selectedId = $bindable() }: Props = $props();

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
  let viewportW = $state(0);
  let viewportH = $state(0);
  let imgEl: HTMLImageElement | null = $state(null);

  function viewportSize(): { w: number; h: number } {
    if (viewportW > 0 && viewportH > 0) return { w: viewportW, h: viewportH };
    if (typeof window !== "undefined") return { w: window.innerWidth, h: window.innerHeight };
    return { w: 0, h: 0 };
  }

  $effect(() => {
    if (typeof window === "undefined") return;
    const sync = () => {
      viewportW = window.innerWidth;
      viewportH = window.innerHeight;
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  });

  // fit 模式下保持宽高比缩到 92vw × 84vh 内
  let fitRatio = $derived.by(() => {
    if (imgNaturalW <= 0 || imgNaturalH <= 0 || viewportW <= 0 || viewportH <= 0) return 1;
    return Math.min((viewportW * 0.92) / imgNaturalW, (viewportH * 0.84) / imgNaturalH);
  });

  let displayW = $derived(
    imgNaturalW <= 0 ? 0 :
    zoomMode === "zoom" ? imgNaturalW :
    Math.max(1, Math.round(imgNaturalW * fitRatio))
  );
  let displayH = $derived(
    imgNaturalH <= 0 ? 0 :
    zoomMode === "zoom" ? imgNaturalH :
    Math.max(1, Math.round(imgNaturalH * fitRatio))
  );

  let imgTransition = $derived(
    isDragging
      ? "width 0.28s ease, height 0.28s ease"
      : "width 0.28s ease, height 0.28s ease, transform 0.28s ease"
  );

  function resetZoom() {
    zoomMode = "fit";
    pan = { x: 0, y: 0 };
    isDragging = false;
    dragPointerId = -1;
    if (dragEl && dragPointerId >= 0) {
      try { dragEl.releasePointerCapture(dragPointerId); } catch {}
    }
    dragEl = null;
  }

  function toggleZoom() {
    const r = nextZoomMode(zoomMode);
    zoomMode = r.mode;
    pan = r.pan;
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
    const clamped = clampPan(next, { w: imgNaturalW, h: imgNaturalH }, viewportSize());
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
    if (!open) return;
    if (e.key === "Escape") {
      if (zoomMode === "zoom") {
        e.preventDefault();
        toggleZoom();
        return;
      }
      e.preventDefault();
      close();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      prev();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      next();
    } else if (e.key === " ") {
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
      { label: "打开图片所在位置", onClick: () => revealImage(it) },
      { kind: "sep" },
      { label: "删除图片（含缩略图）", danger: true, onClick: () => deleteImage(it) },
    ];
  });

  async function fetchBlob(it: any): Promise<Blob | null> {
    const url = it.original_url ?? `/api/images/${it.id}/file`;
    try {
      const r = await fetch(url, { cache: "no-cache" });
      if (!r.ok) return null;
      return await r.blob();
    } catch {
      return null;
    }
  }

  async function copyImage(it: any) {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
      const ok = await copyText(it.original_url ?? `/api/images/${it.id}/file`);
      notify(ok ? "已复制图片地址（剪贴板不支持图片）" : "复制失败");
      return;
    }
    const blob = await fetchBlob(it);
    if (!blob) return notify("获取图片失败");
    try {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
      notify("已复制图片到剪贴板");
    } catch {
      const ok = await copyText(it.original_url ?? `/api/images/${it.id}/file`);
      notify(ok ? "已复制图片地址" : "复制失败");
    }
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

  async function deleteImage(it: any) {
    try {
      const resp = await imagesApi.remove(it.id, true);
      notify(`已删除图片（清理缩略图 ${resp.cleaned_previews ?? 0} 个）`);
      if (selectedId === it.id) selectedId = null;
      open = false;
      await Promise.all([refreshFeed(), refreshStats()]);
    } catch (e) {
      notify(`删除失败: ${(e as Error).message}`);
    }
  }

  // 切换图片 / 重新打开：设置 URL + 选中
  $effect(() => {
    if (open) {
      const it = $feedItems[index];
      if (it) {
        originalUrl = `/api/images/${it.id}/file`;
        selectedId = it.id;
      }
    }
  });

  // 切图 → 重置 zoom + 拖动状态；不重置 naturalWidth（让 img 直接换 src 复用）
  $effect(() => {
    index;
    resetZoom();
    // 等新图加载完再清 natural，避免短暂 0×0 让 fitSize 计算抖动
    // 这里不清，依赖 imgNaturalW 重新绑定新图的尺寸即可
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
  <div
    class="fixed inset-0 z-[80] bg-black/94 flex items-center justify-center backdrop-blur-md overflow-hidden"
    role="dialog"
    ondblclick={close}
    oncontextmenu={openMenu}
  >
    <button class="absolute top-5 right-5 w-[42px] h-[42px] rounded-full bg-white/10 border border-white/20 text-white text-[22px] hover:bg-white/22" onclick={close} title="关闭">×</button>
    <button class="absolute left-5 top-1/2 -translate-y-1/2 w-[54px] h-[86px] rounded-[10px] bg-white/8 border border-white/15 text-white text-[34px] hover:bg-white/20 flex items-center justify-center" onclick={prev} title="上一张">‹</button>
    <button class="absolute right-5 top-1/2 -translate-y-1/2 w-[54px] h-[86px] rounded-[10px] bg-white/8 border border-white/15 text-white text-[34px] hover:bg-white/20 flex items-center justify-center" onclick={next} title="下一张">›</button>

    <!--
      zoom 模式额外给一个明显的"返回"按钮，避免 dblclick 没生效时用户卡住。
      pointer events 全绑在 img 上：pointerdown 起 + setPointerCapture，
      pointermove/up 自动送到同元素，跟手稳定不丢事件。
    -->
    {#if zoomMode === "zoom"}
      <button
        type="button"
        class="absolute top-5 left-5 px-3 py-1.5 rounded-full bg-white/10 border border-white/20 text-white text-[12.5px] hover:bg-white/22"
        onclick={(e) => { e.stopPropagation(); toggleZoom(); }}
        title="退出 100%（Esc）"
      >
        ↩ 退出 100%
      </button>
    {/if}

    <img
      bind:this={imgEl}
      src={originalUrl ?? ""}
      alt={it.filename}
      bind:naturalWidth={imgNaturalW}
      bind:naturalHeight={imgNaturalH}
      class="rounded-md shadow-2xl select-none lightbox-img"
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

    <div class="absolute bottom-5 left-1/2 -translate-x-1/2 bg-black/65 border border-white/12 text-white px-[18px] py-[9px] rounded-[10px] text-[12.5px] text-center backdrop-blur-md min-w-[240px]">
      <div class="font-mono font-semibold mb-[3px] truncate">{it.filename}</div>
      <div class="text-[11.5px] text-white/70">
        {#if it.width && it.height}{it.width}×{it.height} · {/if}
        {#if it.model}{it.model} · {/if}
        {#if it.seed !== null}seed {it.seed} · {/if}
        {formatSize(it.size_bytes)} · {formatDate(it.mtime)}
      </div>
      <div class="text-[11px] text-white/55 mt-1">
        {index + 1} / {$feedItems.length} ·
        {#if zoomMode === "zoom"}
          双击图片返回 · 拖动查看细节
        {:else}
          双击图片 100% 放大 · 双击空白关闭
        {/if}
      </div>
    </div>
  </div>
{/if}

<ContextMenu bind:open={menuOpen} x={menuX} y={menuY} items={menuItems} />

{#if toast}
  <div class="toast">{toast}</div>
{/if}

<style>
  .lightbox-img {
    -webkit-user-drag: none;
    user-select: none;
    -webkit-user-select: none;
  }
</style>