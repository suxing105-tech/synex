<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { connectEvents, disconnectEvents } from "./lib/ws";
  import { refreshFolders, refreshStats, refreshFeed, selectedId, comfyuiStatus, comfyuiEnabled, feedItems, tag, folderId, query, view, selectedDetail } from "./lib/stores";
  import { isTauri, onSidecarReady, onSidecarDied } from "./lib/tauri";
  import HeaderBar from "./components/HeaderBar.svelte";
  import FolderTree from "./components/FolderTree.svelte";
  import Feed from "./components/Feed.svelte";
  import DetailPanel from "./components/DetailPanel.svelte";
  import Lightbox from "./components/Lightbox.svelte";
  import OnboardingModal from "./components/OnboardingModal.svelte";
  import SettingsModal from "./components/SettingsModal.svelte";
  import ScanProgressBar from "./components/ScanProgressBar.svelte";
  import Toast from "./components/Toast.svelte";
  import { statsApi, settingsApi, comfyuiApi } from "./lib/api";

  // 窗口级 drag/drop 兜底：拖到非 Feed 区域（如文件夹树 / 详情面板 / 空白处）
  // 时让浏览器不要导航到 file:// 或打开图片。
  function swallowDrag(e: DragEvent) {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
      e.preventDefault();
    }
  }

  let onboardingOpen = $state(false);
  let settingsOpen = $state(false);

  let selectedIdValue = $state<number | null>(null);
  let lightboxOpen = $state(false);
  let lightboxIndex = $state(0);

  // 同步 selectedId prop 到 store
  $effect(() => {
    selectedId.set(selectedIdValue);
  });

  let comfyuiTimer: ReturnType<typeof setInterval> | null = null;

  async function refreshComfyuiStatus() {
    try {
      const s = await comfyuiApi.status();
      comfyuiStatus.set(s);
      comfyuiEnabled.set(s.enabled);
    } catch (e) {
      // 探测失败不报错（ComfyUI 没启动是正常状态）
      comfyuiStatus.update((cur) => ({ ...cur, running: false }));
    }
  }

// 详情面板缩略图点击 → 打开 Lightbox
  function handleOpenLightbox(e: Event) {
    const id = (e as CustomEvent<{ id: number }>).detail?.id;
    if (id == null) return;
    const idx = $feedItems.findIndex((it) => it.id === id);
    if (idx < 0) return;
    selectedIdValue = id;
    lightboxIndex = idx;
    lightboxOpen = true;
  }

  // 详情面板点击标签 → 触发 tag 搜索（清除 folder/view/q，避免叠加过滤）
  function handleTagSearch(e: Event) {
    const t = (e as CustomEvent<{ tag: string }>).detail?.tag;
    if (!t) return;
    folderId.set(null);
    view.set("all");
    query.set("");
    tag.set(t);
  }

  // ============ 后端就绪状态（Tauri sidecar 生命周期） ============
  // M0-f 修复：dist 产物的 App.svelte 含 splash overlay 但源码此前没有，
  // 下次 cargo tauri build 后必再次黑屏。把 splash 落到源码以确保 prod 可见。
  // - isTauri()：浏览器 dev / 静态托管为 false；Tauri WebView2 为 true。
  // - 浏览器路径直接 await doInit()（vite proxy / FastAPI 已在 8765）；
  // - Tauri 路径订阅 Rust 端 sidecar-ready / sidecar-died 事件，
  //   等到后端真正 READY 才允许主 UI 渲染，避免 #app 空 div 黑屏。
  let backendReady = $state(!isTauri());
  let backendError: string | null = $state(null);
  let initStarted = false;
  let sidecarReadyUnsub: (() => void) | null = null;
  let sidecarDiedUnsub: (() => void) | null = null;
  let backendBootTimeout: ReturnType<typeof setTimeout> | null = null;

  async function doInit() {
    if (initStarted) return;
    initStarted = true;
    try {
      await Promise.all([refreshFolders(), refreshStats(), refreshFeed()]);
      const cfg = await settingsApi.get();
      if (!cfg.watch_dirs || cfg.watch_dirs.length === 0) {
        onboardingOpen = true;
      }
    } catch (e) {
      console.error("init failed", e);
    }
    connectEvents();
  }

  function markBackendReady() {
    backendReady = true;
    backendError = null;
    if (backendBootTimeout) {
      clearTimeout(backendBootTimeout);
      backendBootTimeout = null;
    }
    void doInit();
  }

  function markBackendFailed(reason: string) {
    backendReady = false;
    backendError = reason;
    if (backendBootTimeout) {
      clearTimeout(backendBootTimeout);
      backendBootTimeout = null;
    }
  }

  onMount(async () => {
    if (isTauri()) {
      // Tauri 路径：等 Rust 端的 sidecar-ready 事件，否则一直显示 splash。
      // 30s 超时切错误卡（一般 1~2s 就能 ready；30s 留给冷启动 / 防卡死）。
      sidecarReadyUnsub = await onSidecarReady(() => markBackendReady());
      sidecarDiedUnsub = await onSidecarDied((p) => {
        markBackendFailed(p?.reason || "sidecar died");
      });
      backendBootTimeout = setTimeout(() => {
        if (!backendReady) {
          markBackendFailed(backendError || "后端进程启动超时（30s）");
        }
      }, 30000);
      return;
    }
    // 浏览器 dev / 静态托管：直接 init（vite proxy / FastAPI 已在 8765）
    await doInit();
    await refreshComfyuiStatus();
    comfyuiTimer = setInterval(refreshComfyuiStatus, 30000);
    const onVis = () => {
      if (document.visibilityState === "visible") refreshComfyuiStatus();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("open-lightbox", handleOpenLightbox);
    window.addEventListener("open-tag-search", handleTagSearch);
    checkNarrow();
    window.addEventListener("resize", checkNarrow);
  });

  onDestroy(() => {
    if (sidecarReadyUnsub) sidecarReadyUnsub();
    if (sidecarDiedUnsub) sidecarDiedUnsub();
    if (backendBootTimeout) clearTimeout(backendBootTimeout);
    disconnectEvents();
    if (comfyuiTimer) clearInterval(comfyuiTimer);
    window.removeEventListener("open-lightbox", handleOpenLightbox);
    window.removeEventListener("open-tag-search", handleTagSearch);
    window.removeEventListener("resize", checkNarrow);
  });

  // ============ 列宽可拖拽 + 窄屏抽屉 ============
  let detailWidth = $state(360);
  const DETAIL_MIN = 320;
  const DETAIL_MAX = 560;

  let narrowMode = $state(false);
  function checkNarrow() {
    if (typeof window === "undefined") {
      narrowMode = false;
      return;
    }
    narrowMode = window.innerWidth < 1024;
  }

  let drawerOpen = $state(false);

  function startDetailDrag(e: PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = detailWidth;
    const onMove = (ev: PointerEvent) => {
      const dx = startX - ev.clientX;
      const next = Math.max(DETAIL_MIN, Math.min(DETAIL_MAX, startW + dx));
      detailWidth = next;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  // 选中变化：窄屏自动展开抽屉
  $effect(() => {
    if (narrowMode && $selectedDetail) drawerOpen = true;
  });
</script>

<div class="h-screen w-screen flex flex-col bg-bg text-zinc-200" ondragover={swallowDrag} ondrop={swallowDrag} role="application">
  <HeaderBar onOpenSettings={() => (settingsOpen = true)} onOpenOnboarding={() => (onboardingOpen = true)} />
  <ScanProgressBar />
  <div
    class="flex-1 min-h-0 grid app-grid"
    class:drawer-mode={narrowMode}
    style="grid-template-columns: 260px 1fr 6px {detailWidth}px;"
  >
    <aside class="border-r border-border bg-surface flex flex-col min-h-0">
      <FolderTree />
    </aside>
    <main class="min-w-0">
      <Feed
        bind:selectedId={selectedIdValue}
        bind:lightboxOpen
        bind:lightboxIndex
      />
    </main>
    <div
      class="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整详情面板宽度"
      tabindex="0"
      onpointerdown={startDetailDrag}
    ></div>
    <aside
      class="border-l border-border bg-surface min-h-0 flex flex-col"
      class:drawer-hidden={narrowMode && !drawerOpen}
    >
      <DetailPanel />
    </aside>
  </div>

  {#if narrowMode && $selectedDetail && !drawerOpen}
    <button
      type="button"
      class="drawer-toggle"
      onclick={() => (drawerOpen = true)}
      aria-label="展开详情"
    >
      查看详情
    </button>
  {/if}
</div>

<Lightbox bind:open={lightboxOpen} bind:index={lightboxIndex} bind:selectedId={selectedIdValue} />

<OnboardingModal bind:open={onboardingOpen} />
<SettingsModal bind:open={settingsOpen} />
<Toast />

{#if !backendReady}
  <div class="splash-overlay" role="alert" aria-live="polite">
    <div class="splash-card">
      <div class="splash-logo">苏醒图库</div>
      {#if backendError}
        <div class="splash-err">后端进程异常：{backendError}</div>
        <div class="splash-hint">请关闭应用并重试；若反复失败，运行 <code>build-sidecar.ps1</code> 重建 sidecar 后再启。</div>
      {:else}
        <div class="splash-spinner"></div>
        <div class="splash-hint">正在启动后端进程…</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .splitter {
    cursor: col-resize;
    background: transparent;
    position: relative;
  }
  .splitter:focus-visible {
    background: rgba(242, 78, 78, 0.4);
    outline: none;
  }.splitter::before {
    content: "";
    position: absolute;
    left: 50%;
    top: 0;
    bottom: 0;
    width: 1px;
    background: #2e2e33;
    transform: translateX(-0.5px);
  }
  .app-grid.drawer-mode {
    grid-template-columns: 1fr !important;
  }
  .app-grid.drawer-mode aside.drawer-hidden {
    display: none;
  }
  .app-grid.drawer-mode .splitter {
    display: none;
  }
  .drawer-toggle {
    position: fixed;
    right: 16px;
    bottom: 24px;
    z-index: 70;
    background: #f24e4e;
    color: #0e0e10;
    padding: 8px 14px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 500;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    transition: transform 0.15s ease-out;
  }
  .drawer-toggle:hover {
    transform: translateY(-1px);
  }
  @media (max-width: 1100px) {
    .app-grid {
      grid-template-columns: 220px 1fr 6px 320px !important;
    }
  }
  .splash-overlay {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #18181b;
    color: #fafafa;
  }
  .splash-card {
    background: #2e2e33;
    border: 1px solid #27272a;
    border-radius: 12px;
    padding: 32px 40px;
    min-width: 320px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  }
  .splash-logo {
    font-size: 22px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: #f24e4e;
  }
  .splash-spinner {
    width: 28px;
    height: 28px;
    border: 3px solid #27272a;
    border-top-color: #f24e4e;
    border-radius: 50%;
    animation: splash-spin 0.9s linear infinite;
  }
  .splash-hint {
    font-size: 12px;
    color: #8a8a8e;
    text-align: center;
    line-height: 1.5;
  }
  .splash-hint code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    background: #18181b;
    padding: 1px 6px;
    border-radius: 4px;
    color: #fb7185;
  }
  .splash-err {
    font-size: 13px;
    color: #fb7185;
    text-align: center;
    font-weight: 500;
  }
  @keyframes splash-spin {
    to { transform: rotate(360deg); }
  }

</style>




