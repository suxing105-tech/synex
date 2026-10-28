<script lang="ts">
  /**
   * 视频播放器：中间栏的内嵌层，与图片预览 / 文本阅读同一层、同一手势。
   *
   * 以前它是 fixed 全屏黑场，等于把整个图库换掉；现在收进中间栏以后，
   * 尺寸不能再按 vh/vw 算（那样会把左右侧栏算进来，画面顶出框外），
   * 全部交给 flex + object-contain 按容器自适应。
   */
  import { onMount, untrack } from "svelte";
  import { backendUrl } from "../lib/backend-url";
  import { mediaItems, multiSelectedIds } from "../lib/stores";
  import { videosApi } from "../lib/api";
  import { pushToast } from "../lib/toast";
  import type { MediaFeedItem } from "../lib/types";
  import Icon from "./Icon.svelte";
  import CompareModeSwitch from "./CompareModeSwitch.svelte";
  import VideoCompare from "./VideoCompare.svelte";
  import { ViewerZoom, ZOOM_HINT, viewerZoomWheel } from "../lib/viewer-zoom.svelte";
  import ViewerZoomControls from "./ViewerZoomControls.svelte";

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
  // 真正在放对比视图的条件。只按 compareOn 判断会在「选中掉到不足两个」后
  // 卡在一个既没在对比、又显示退出对比按钮的中间态，缩放开关会被它一起藏掉。
  const comparing = $derived(compareOn && compareReady);
  // 自动进入对比：打开的视频正好在选中的两个里时自动开一次。
  // 必须记住「这一组已经自动开过」，否则用户点「退出对比」会被这个 effect 顶回去；
  // 换一组选中或换一支视频（key 变了）才再自动开。
  const autoCompareKey = $derived(
    compareReady && current && selectedVideos.some((v) => v.id === current.id)
      ? `${selectedVideos.map((v) => v.id).join("+")}@${current.id}`
      : null,
  );
  let autoOpenedKey: string | null = $state(null);
  $effect(() => {
    if (!open) { untrack(() => { autoOpenedKey = null; }); return; }
    const key = autoCompareKey;
    untrack(() => {
      if (!key) { autoOpenedKey = null; return; }   // 选中不再是两个：忘记「这一组开过」，重新选上还能自动开
      if (key !== autoOpenedKey) {
        autoOpenedKey = key;
        compareOn = true;
      }
    });
  });

  function openAt(id: number): void {
    const idx = videos.findIndex((v) => v.id === id);
    currentIndex = idx >= 0 ? idx : 0;
  }

  $effect(() => {
    if (open && startId != null) openAt(startId);
  });

  // ---------- 适应窗口 ⇄ 100%：与图片预览共用 lib/viewer-zoom.svelte.ts ----------
  // 视频以前只有一句 object-contain 铺满，等于只有「适应窗口」没有「100%」。
  // 现在两边读同一份缩放实现：按钮、百分比、滚轮、抓手拖动、双击、Esc 两段退出全一致。
  let viewportW = $state(0);
  let viewportH = $state(0);
  // 画面原始像素：打开时先用 feed 已知的宽高（省掉首帧前的抖动），metadata 到齐后校准。
  let videoW = $state(0);
  let videoH = $state(0);
  let videoEl = $state<HTMLVideoElement | null>(null);
  let resumeOnFit = false;

  const zoom = new ViewerZoom({
    content: () => ({ w: videoW, h: videoH }),
    viewport: () => ({ w: viewportW, h: viewportH }),
    // 黑底画布本来就该铺满，适应窗口不留白（图片留 48 是给白底图呼吸空间）。
    inset: 0,
    // 视频允许上采样：480p 也要能铺满中间栏，缩在角落看不是看片。
    upscaleToFit: true,
    // 对比模式有自己的双路画面和分割线手势，缩放整体让路。
    enabled: () => !comparing,
    // 不拦拖动起手动作，放大态单击画面仍能播放/暂停；真拖过的那次单击由 onVideoClick 吞掉。
    preventDefaultDrag: false,
    onModeChange: (mode) => {
      // 放大是为了停帧看细节：进缩放先暂停，回适应窗口再续播。
      const el = videoEl;
      if (!el) return;
      if (mode === "zoom") {
        resumeOnFit = !el.paused;
        el.pause();
      } else if (resumeOnFit) {
        resumeOnFit = false;
        try { void el.play()?.catch?.(() => {}); } catch { /* 自动播放被宿主拦下就算了 */ }
      }
    },
  });

  // 换视频 / 进出对比：缩放归零，尺寸换成新素材的已知宽高。
  $effect(() => {
    const it = current;
    const inCompare = comparing;
    resumeOnFit = false;
    untrack(() => zoom.reset());
    if (inCompare) return; // 对比模式用 VideoCompare 自己的两路画面，不参与缩放
    const w = it?.width ?? 0;
    const h = it?.height ?? 0;
    videoW = w > 0 && h > 0 ? w : 0;
    videoH = w > 0 && h > 0 ? h : 0;
  });

  // 画布尺寸变化（拖侧栏、F 键最大化、全屏）时把越界的平移拉回边界
  $effect(() => {
    zoom.clampNow();
  });

  function onLoadedMetadata(e: Event): void {
    const el = e.currentTarget as HTMLVideoElement;
    if (el.videoWidth > 0 && el.videoHeight > 0) {
      videoW = el.videoWidth;
      videoH = el.videoHeight;
    }
  }

  function onVideoDblClick(e: MouseEvent): void {
    // 必须挡默认动作：Chromium 对带 controls 的 video 双击默认进全屏
    e.preventDefault();
    e.stopPropagation();
    zoom.toggle();
  }

  /**
   * 双击黑边返回缩略图，与图片预览一致。
   * 判据写的是「不是点在自己渲染的画面上」而不是「点在了画布上」：
   * 画面居中容器会挡住画布，按 currentTarget 判等会永远不成立。
   */
  function onCanvasDblClick(e: MouseEvent): void {
    if (comparing) return; // 对比模式有自己的手势，别一双击就把图层关了
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (el && el.tagName === "VIDEO") return;
    close();
  }

  function onVideoClick(e: MouseEvent): void {
    // 刚拖动过画面，这次 click 是拖动的尾巴，别让它触发播放/暂停
    if (zoom.dragMoved) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function close(): void {
    open = false;
    startId = null;
    untrack(() => zoom.reset());
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
      // 与图片一致的两段退出：100% 态先退回适应窗口，再按一次才回缩略图
      if (zoom.isZooming()) {
        zoom.setFit();
        return;
      }
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
    <header class="video-header relative flex items-center gap-2 px-4 py-3 shrink-0 border-b border-border bg-surface">
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
      {#if comparing}
        <span class="text-[11px] text-muted">对比已选中的两个视频</span>
        <button type="button" class="rounded-lg px-3 py-2 text-xs" aria-pressed="true" onclick={() => { compareOn = false; }}>退出对比</button>
        <!-- 与图片同一处、同一套按钮：顶栏正中间。必须排在本段最后：
             Svelte 5 的事件委托里，组件排在同分支的兄弟元素之前会让后面的按钮点不动。 -->
        <CompareModeSwitch label="视频对比方式" />
      {:else if compareReady}
        <button type="button" class="rounded-lg px-3 py-2 text-xs" title="对比选中的两个视频" aria-label="对比视频" onclick={() => { compareOn = true; }}>对比</button>
      {/if}
      <button type="button" class="rounded-lg px-3 py-2 text-xs" onclick={() => void openInSystem()}>用系统播放器打开</button>
      {#if !comparing && current.playable}
        <!-- 与图片预览同一组按钮、同一个组件；必须排在顶栏所有按钮之后（Svelte 5 事件委托） -->
        <ViewerZoomControls {zoom} />
      {/if}
    </header>

    <div
      class="video-canvas relative flex-1 min-h-0 overflow-hidden bg-black"
      bind:clientWidth={viewportW}
      bind:clientHeight={viewportH}
      ondblclick={onCanvasDblClick}
      use:viewerZoomWheel={zoom}
    >
      {#if comparing}
        <div class="absolute inset-0 p-3">
          <VideoCompare videos={selectedVideos} />
        </div>
      {:else if current.playable}
        <!-- 画面按显示框定尺寸，与图片预览同构：Letterbox 黑边上的双击是「返回缩略图」，
             抓手拖动的也只有画面本身。宽高还没测到时退回 contain 铺满兜底。 -->
        <div class="video-stage absolute inset-0 flex items-center justify-center overflow-hidden">
          {#key current.id}
            <video
              bind:this={videoEl}
              src={backendUrl(current.play_url)}
              controls
              autoplay
              playsinline
              preload="metadata"
              class="video-media"
              class:video-fill={!zoom.sized}
              style:width={zoom.sized ? `${zoom.displayW}px` : null}
              style:height={zoom.sized ? `${zoom.displayH}px` : null}
              style:transform={zoom.isZooming() ? `translate(${zoom.pan.x}px, ${zoom.pan.y}px)` : "none"}
              style:transition={zoom.transition}
              style:cursor={zoom.cursor}
              style:touch-action={zoom.isZooming() ? "none" : null}
              onpointerdown={zoom.onPointerDown}
              onpointermove={zoom.onPointerMove}
              onpointerup={zoom.onPointerUp}
              onpointercancel={zoom.onPointerUp}
              ondblclick={onVideoDblClick}
              onclick={onVideoClick}
              onloadedmetadata={onLoadedMetadata}
            >
              <span>你的浏览器不支持播放视频。</span>
            </video>
          {/key}
        </div>
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
      <span class="text-muted hidden xl:inline">{#if comparing}Esc 返回缩略图 · 按 S 切换对比方式 · 右键画面可同步播放 / 同步停止{:else}Esc 返回缩略图 · ← / → 切换视频 · {zoom.isZooming() ? ZOOM_HINT.zoom : ZOOM_HINT.fit}{/if}</span>
    </footer>
  </section>
{/if}

<style>
  /* 按显示框定尺寸后不能再被 max-width / max-height 夹住，否则 100% 放不开。 */
  .video-media {
    max-width: none;
    max-height: none;
    object-fit: contain;
    background: #000;
    -webkit-user-drag: none;
    user-select: none;
  }
  /* 宽高还没测到（首帧 metadata 未就绪、feed 里也没记录尺寸）时的兜底：按画布铺满。 */
  .video-fill {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
</style>
