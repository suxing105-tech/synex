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
  //
  // fit 模式：原行为，按 max-w/max-h/object-contain 缩进视口。
  // zoom 模式：图像渲染成 naturalWidth × naturalHeight，translate 平移查看细节。
  // 双击图片切换两种模式；zoom 模式下鼠标变 grab/grabbing，拖动平移。
  // 切换图片 / 关闭 / 重新打开 → 缩放状态重置为 fit + pan=0。
  let zoomMode = $state<"fit" | "zoom">("fit");
  let pan = $state<PanOffset>({ x: 0, y: 0 });
  let isDragging = $state(false);
  let dragStartMouseX = 0;
  let dragStartMouseY = 0;
  let dragStartPanX = 0;
  let dragStartPanY = 0;
  // 当前图像原始尺寸（bind 到 <img>），用于 clamp pan 范围
  let imgNaturalW = $state(0);
  let imgNaturalH = $state(0);

  function viewportSize(): { w: number; h: number } {
    if (typeof window === "undefined") return { w: 0, h: 0 };
    return { w: window.innerWidth, h: window.innerHeight };
  }

  function onImgDblClick(e: MouseEvent) {
    // 阻止冒泡到外层 div 的 close 处理器
    e.stopPropagation();
    e.preventDefault();
    const r = nextZoomMode(zoomMode);
    zoomMode = r.mode;
    pan = r.pan;
  }

  function onImgMouseDown(e: MouseEvent) {
    if (zoomMode !== "zoom") return;
    // 只响应左键；右键交由外层 openMenu
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    isDragging = true;
    dragStartMouseX = e.clientX;
    dragStartMouseY = e.clientY;
    dragStartPanX = pan.x;
    dragStartPanY = pan.y;
  }

  function onImgMouseMove(e: MouseEvent) {
    if (!isDragging) return;
    const next = panFromDrag(
      e.clientX,
      e.clientY,
      dragStartMouseX,
      dragStartMouseY,
      { x: dragStartPanX, y: dragStartPanY },
    );
    pan = clampPan(next, { w: imgNaturalW, h: imgNaturalH }, viewportSize());
  }

  function onImgMouseUp() {
    isDragging = false;
  }

  function close() {
    open = false;
    originalUrl = null;
    // 关闭时重置缩放，下次打开是 fit
    zoomMode = "fit";
    pan = { x: 0, y: 0 };
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
    if (e.key === 'Escape') {
      // zoom 模式下 Esc 先退出 zoom，再按一次才关 Lightbox（避免误关）
      if (zoomMode === "zoom") {
        e.preventDefault();
        const r = nextZoomMode(zoomMode);
        zoomMode = r.mode;
        pan = r.pan;
        return;
      }
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      prev();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      next();
    } else if (e.key === ' ') {
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

  async function fetchBlob(it) {
    const url = it.original_url ?? `/api/images/${it.id}/file`;
    try {
      const r = await fetch(url, { cache: "no-cache" });
      if (!r.ok) return null;
      return await r.blob();
    } catch {
      return null;
    }
  }

  async function copyImage(it) {
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

  async function renameImage(it) {
    const stem = it.filename.replace(/.[^.]+$/, "");
    const next = window.prompt("新文件名（保留扩展名）:", stem);
    if (next === null) return;
    if (!next.trim()) return notify("文件名不能为空");
    try {
      await imagesApi.rename(it.id, next.trim());
      notify("已重命名");
      await Promise.all([refreshFeed(), refreshStats()]);
    } catch (e) {
      notify(`重命名失败: ${e.message}`);
    }
  }

  async function revealImage(it) {
    try {
      const r = await imagesApi.reveal(it.id);
      if (r.method && r.method !== "noop") {
        notify(`已打开图片所在位置（${r.method}）`);
      } else {
        notify(`已请求打开图片所在位置`);
      }
    } catch (e) {
      notify(`打开位置失败: ${e.message}`);
    }
  }

  async function deleteImage(it) {
    // 直接删除图片 + 缩略图，不做二次确认。
    try {
      const resp = await imagesApi.remove(it.id, true);
      notify(`已删除图片（清理缩略图 ${resp.cleaned_previews ?? 0} 个）`);
      if (selectedId === it.id) selectedId = null;
      open = false;  // 关 Lightbox
      await Promise.all([refreshFeed(), refreshStats()]);
    } catch (e) {
      notify(`删除失败: ${e.message}`);
    }
  }

  // 切换图片（index 变化）或重新打开 → 重置缩放状态并清自然尺寸
  $effect(() => {
    if (open) {
      const it = $feedItems[index];
      if (it) {
        originalUrl = `/api/images/${it.id}/file`;
        selectedId = it.id;
      }
    }
  });

  // 监听 index 变化重置 zoom（保持上一张的 zoom 模式不迁移）
  $effect(() => {
    // 读 index 让依赖被追踪
    index;
    zoomMode = "fit";
    pan = { x: 0, y: 0 };
    isDragging = false;
    imgNaturalW = 0;
    imgNaturalH = 0;
  });

  // 图像原始尺寸变了（首次加载 / 切换图片加载完成）→ zoom 模式下 clamp pan 到新范围
  $effect(() => {
    if (zoomMode === "zoom" && imgNaturalW > 0 && imgNaturalH > 0) {
      pan = clampPan(pan, { w: imgNaturalW, h: imgNaturalH }, viewportSize());
    }
  });

  // 当前光标样式：fit 默认；zoom 未拖 grab；zoom 拖动 grabbing
  let imgCursor = $derived(
    zoomMode === "fit"
      ? "default"
      : isDragging
      ? "grabbing"
      : "grab",
  );
</script>

<svelte:window onkeydown={handleKey} onmouseup={onImgMouseUp} />

{#if open && $feedItems.length > 0 && $feedItems[index]}
  {@const it = $feedItems[index]}
  <div class="fixed inset-0 z-[80] bg-black/94 flex items-center justify-center backdrop-blur-md" role="dialog" ondblclick={close} oncontextmenu={openMenu}>
    <button class="absolute top-5 right-5 w-[42px] h-[42px] rounded-full bg-white/10 border border-white/20 text-white text-[22px] hover:bg-white/22" onclick={close} title="关闭">×</button>
    <button class="absolute left-5 top-1/2 -translate-y-1/2 w-[54px] h-[86px] rounded-[10px] bg-white/8 border border-white/15 text-white text-[34px] hover:bg-white/20 flex items-center justify-center" onclick={prev} title="上一张">‹</button>
    <button class="absolute right-5 top-1/2 -translate-y-1/2 w-[54px] h-[86px] rounded-[10px] bg-white/8 border border-white/15 text-white text-[34px] hover:bg-white/20 flex items-center justify-center" onclick={next} title="下一张">›</button>

    <!--
      缩放策略：
        fit 模式：max-w-[92vw] max-h-[84vh] object-contain，跟原行为一致。
        zoom 模式：图像按 naturalWidth × naturalHeight 渲染，超出视口部分 overflow 可见；
                   用 transform: translate(panX, panY) 偏移，cursor 切到 grab/grabbing。
        切换图片 / 关闭 / 重新打开时 effect 会把 zoomMode 重置回 fit。
    -->
    <img
      src={originalUrl ?? ''}
      alt={it.filename}
      bind:naturalWidth={imgNaturalW}
      bind:naturalHeight={imgNaturalH}
      class="rounded-md shadow-2xl select-none"
      class:max-w-[92vw]={zoomMode === "fit"}
      class:max-h-[84vh]={zoomMode === "fit"}
      class:object-contain={zoomMode === "fit"}
      style:max-width={zoomMode === "zoom" ? "none" : null}
      style:max-height={zoomMode === "zoom" ? "none" : null}
      style:width={zoomMode === "zoom" && imgNaturalW > 0 ? `${imgNaturalW}px` : null}
      style:height={zoomMode === "zoom" && imgNaturalH > 0 ? `${imgNaturalH}px` : null}
      style:transform={zoomMode === "zoom" ? `translate(${pan.x}px, ${pan.y}px)` : "none"}
      style:cursor={imgCursor}
      draggable="false"
      onmousedown={onImgMouseDown}
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
  /* 防止图片被原生拖拽；同时 dblclick 时浏览器选中文字 */
  img {
    -webkit-user-drag: none;
  }
</style>
