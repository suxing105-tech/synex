<script lang="ts">
  import { startUpdates, updateStatus } from "./lib/updates";
  import { onMount, onDestroy } from "svelte";
  import { connectEvents, disconnectEvents } from "./lib/ws";
  import { refreshFolders, refreshStats, refreshFeed, selectedId, comfyuiStatus, comfyuiEnabled, feedItems, tag, folderId, query, view, selectedDetail } from "./lib/stores";
  import { createSplashGate } from "./lib/splash-gate.svelte";
  import FolderTree from "./components/FolderTree.svelte";
  import Feed from "./components/Feed.svelte";
  import DetailPanel from "./components/DetailPanel.svelte";
  import Lightbox from "./components/Lightbox.svelte";
  import OnboardingModal from "./components/OnboardingModal.svelte";
  import VideoPlayer from "./components/VideoPlayer.svelte";
  import SettingsModal from "./components/SettingsModal.svelte";
  import ScanProgressBar from "./components/ScanProgressBar.svelte";
  import SplashOverlay from "./components/SplashOverlay.svelte";
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
  let settingsTab = $state("通用");
  onMount(() => {
    const openModels = () => { settingsTab = "模型与反推"; settingsOpen = true; };
    window.addEventListener("open-model-settings", openModels);
    return () => window.removeEventListener("open-model-settings", openModels);
  });

  let selectedIdValue = $state<number | null>(null);
  let lightboxOpen = $state(false);
  let lightboxIndex = $state(0);
  let videoPlayerOpen = $state(false);
  let videoStartId = $state<number | null>(null);

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

  // Feed 点击视频播放按钮 → 打开 VideoPlayer 弹层
  function handleOpenVideoPlayer(e: Event) {
    const id = (e as CustomEvent<{ id: number }>).detail?.id;
    if (id == null) return;
    videoStartId = id;
    videoPlayerOpen = true;
  }

  // ============ 后端就绪门（composable） ============
  // M0-f 第三轮：把 sidecar 生命周期抽出到 lib/splash-gate.svelte.ts。
  // gate 拥有 backendReady / backendError / sidecar 订阅 / 30s 超时，
  // App.svelte 只剩 init 业务逻辑（doInit）+ browser-only 副作用。
  const gate = createSplashGate();

  let stopUpdates: (() => void) | undefined;
  let initStarted = false;
  async function doInit() {
    if (initStarted) return;
    initStarted = true;
    stopUpdates = startUpdates();
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
    await refreshComfyuiStatus();
    comfyuiTimer = setInterval(refreshComfyuiStatus, 10000);
  }

  onMount(async () => {
    // gate.start()：浏览器模式立即 await doInit() 返回 true；
    // Tauri 模式订阅 sidecar-ready / sidecar-died + 30s 超时返回 false。
    await gate.start(doInit);
    // 浏览器 / 静态托管专用：comfyui 轮询 + window 事件

    const onVis = () => {
      if (document.visibilityState === "visible") refreshComfyuiStatus();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("open-lightbox", handleOpenLightbox);
    window.addEventListener("open-tag-search", handleTagSearch);
    window.addEventListener("open-video-player", handleOpenVideoPlayer);
    checkNarrow();
    window.addEventListener("resize", checkNarrow);
  });

  onDestroy(() => {
    stopUpdates?.();
    gate.dispose();
    disconnectEvents();
    if (comfyuiTimer) clearInterval(comfyuiTimer);
    window.removeEventListener("open-lightbox", handleOpenLightbox);
    window.removeEventListener("open-tag-search", handleTagSearch);
    window.removeEventListener("open-video-player", handleOpenVideoPlayer);
    window.removeEventListener("resize", checkNarrow);
  });

  // ============ 列宽可拖拽 + 窄屏抽屉 ============
  let sidebarCollapsed = $state(false);
  let detailCollapsed = $state(false);
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
  <ScanProgressBar />
  {#if $updateStatus?.version && ["available", "ready"].includes($updateStatus.phase)}
    <button class="bg-surface-2 border-b border-border text-xs py-2 text-accent" onclick={() => (settingsOpen = true)}>
      新版本 v{$updateStatus.version} {$updateStatus.phase === "ready" ? "已下载，点击选择安装时间" : "可用，点击查看更新"}
    </button>
  {/if}
  <div
    class="flex-1 min-h-0 grid app-grid"
    class:drawer-mode={narrowMode}
    class:sidebar-collapsed={sidebarCollapsed}
    style="--sidebar-width: {sidebarCollapsed ? 44 : 260}px; grid-template-columns: var(--sidebar-width) 1fr 6px {detailCollapsed ? 44 : detailWidth}px;"
  >
    <aside class="border-r border-border bg-surface flex flex-col min-h-0">
      {#if sidebarCollapsed}
        <button class="sidebar-expand" title="展开左侧栏" aria-label="展开左侧栏" onclick={() => sidebarCollapsed = false}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16m4-11 3 3-3 3"/></svg>
        </button>
      {:else}
      <FolderTree oncollapse={() => sidebarCollapsed = true} />
      <div class="sidebar-actions fill-interactions flex items-center gap-2 px-4 py-4 shrink-0">
        <button class="w-10 h-10 flex items-center justify-center rounded-lg text-muted" aria-label="设置" title="设置" onclick={() => settingsOpen = true}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="m12 2 9 5v10l-9 5-9-5V7z" /><circle cx="12" cy="12" r="4" /></svg>
        </button>
        <button class="w-10 h-10 flex items-center justify-center rounded-lg text-muted" aria-label="导入目录" title="导入目录" onclick={() => onboardingOpen = true}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 19V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v7m-3-3 3 3 3-3" /></svg>
        </button>
      </div>
      {/if}
    </aside>
    <main class="relative min-w-0 min-h-0 overflow-hidden isolate">
      <div class="h-full flex flex-col" inert={lightboxOpen}>
      <Feed
        bind:selectedId={selectedIdValue}
        bind:lightboxOpen
        bind:lightboxIndex
      />
      </div>
      <Lightbox bind:open={lightboxOpen} bind:index={lightboxIndex} bind:selectedId={selectedIdValue} />
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
      {#if detailCollapsed}
        <button class="sidebar-expand" title="展开右侧栏" aria-label="展开右侧栏" onclick={() => (detailCollapsed = false)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16m-6-11 3 3-3 3"/></svg>
        </button>
      {:else}
        <div class="flex items-center justify-between px-3 py-[10px] border-b border-border shrink-0">
          <span class="text-[11px] uppercase text-muted tracking-wider">详情</span>
          <button class="collapse-sidebar" onclick={() => (detailCollapsed = true)} title="收起右侧栏" aria-label="收起右侧栏">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16m-7-11 3 3-3 3"/></svg>
          </button>
        </div>
        <div class="flex-1 min-h-0">
          <DetailPanel />
        </div>
      {/if}
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


<VideoPlayer bind:open={videoPlayerOpen} bind:startId={videoStartId} />

<OnboardingModal bind:open={onboardingOpen} />
<SettingsModal bind:open={settingsOpen} bind:tab={settingsTab} />
<Toast />

<SplashOverlay ready={gate.ready} error={gate.error} />

<style>
  .sidebar-expand { margin: 13px auto; padding: 4px; border: 0; background: transparent; color: #888; box-shadow: none; outline: none; }
  .sidebar-expand:hover, .sidebar-expand:focus-visible { color: #eee; border: 0; background: transparent; box-shadow: none; outline: none; }
  .collapse-sidebar { border: 0; background: transparent; color: #888; padding: 4px; cursor: pointer; outline: none; box-shadow: none; }
  .collapse-sidebar:hover, .collapse-sidebar:focus-visible { color: #eee; background: transparent; border: 0; outline: none; box-shadow: none; }
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
      grid-template-columns: var(--sidebar-width) 1fr 6px 320px !important;
    }
  }

</style>




