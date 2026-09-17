<script lang="ts">
  import { startUpdates, updateStatus } from "./lib/updates";
  import { onMount, onDestroy } from "svelte";
  import { connectEvents, disconnectEvents } from "./lib/ws";
  import { refreshFolders, refreshStats, refreshFeed, selectedId, comfyuiStatus, comfyuiEnabled, feedItems, tag, folderId, query, view, selectedDetail } from "./lib/stores";
  import { createSplashGate } from "./lib/splash-gate.svelte";
  import HeaderBar from "./components/HeaderBar.svelte";
  import FolderTree from "./components/FolderTree.svelte";
  import Feed from "./components/Feed.svelte";
  import DetailPanel from "./components/DetailPanel.svelte";
  import Lightbox from "./components/Lightbox.svelte";
  import OnboardingModal from "./components/OnboardingModal.svelte";
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
  }

  onMount(async () => {
    // gate.start()：浏览器模式立即 await doInit() 返回 true；
    // Tauri 模式订阅 sidecar-ready / sidecar-died + 30s 超时返回 false。
    const isBrowser = await gate.start(doInit);
    if (!isBrowser) return;
    // 浏览器 / 静态托管专用：comfyui 轮询 + window 事件
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
    stopUpdates?.();
    gate.dispose();
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
  {#if $updateStatus?.version && ["available", "ready"].includes($updateStatus.phase)}
    <button class="bg-surface-2 border-b border-border text-xs py-2 text-accent" onclick={() => (settingsOpen = true)}>
      新版本 v{$updateStatus.version} {$updateStatus.phase === "ready" ? "已下载，点击选择安装时间" : "可用，点击查看更新"}
    </button>
  {/if}
  <div
    class="flex-1 min-h-0 grid app-grid"
    class:drawer-mode={narrowMode}
    style="grid-template-columns: 260px 1fr 6px {detailWidth}px;"
  >
    <aside class="border-r border-border bg-surface flex flex-col min-h-0">
      <FolderTree />
      <div class="sidebar-settings flex items-center justify-start shrink-0 h-24 px-5">
        <button class="flex items-center justify-center w-12 h-12 rounded-xl text-zinc-400 hover:text-accent focus-visible:text-accent focus-visible:outline-none transition-colors" onclick={() => (settingsOpen = true)} aria-label="全局设置" title="设置">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10.5 2.9a3 3 0 0 1 3 0l6.3 3.6a3 3 0 0 1 1.5 2.6v7.2a3 3 0 0 1-1.5 2.6l-6.3 3.6a3 3 0 0 1-3 0l-6.3-3.6a3 3 0 0 1-1.5-2.6V9.1a3 3 0 0 1 1.5-2.6z" transform="translate(0 -0.7)" />
            <circle cx="12" cy="12" r="4" />
          </svg>
        </button>
      </div>
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
<SettingsModal bind:open={settingsOpen} bind:tab={settingsTab} />
<Toast />

<SplashOverlay ready={gate.ready} error={gate.error} />

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

</style>




