<script lang="ts">
  import { startUpdates } from "./lib/updates";
  import { onMount, onDestroy } from "svelte";
  import { connectEvents, disconnectEvents } from "./lib/ws";
  import { refreshFolders, refreshStats, refreshFeed, selectedId, comfyuiStatus, comfyuiEnabled, mediaItems, tag, folderId, query, selectedDetail } from "./lib/stores";
  import { createSplashGate } from "./lib/splash-gate.svelte";
  import FolderTree from "./components/FolderTree.svelte";
  import DesktopTitlebar from "./components/DesktopTitlebar.svelte";
  import SidebarUpdateButton from "./components/SidebarUpdateButton.svelte";
  import { isTauri } from "./lib/tauri";
  const desktop = isTauri();
  let desktopMaximized = $state(false);
  import CollapsedSidebar from "./components/CollapsedSidebar.svelte";
  import { registerSidebarShortcuts } from "./lib/sidebar-shortcuts";
  // 内嵌层（图片 / 文本 / 视频）开着时全局快捷键让位；右侧栏常驻，所以 rightAvailable 恒真。
  const viewerOpen = () => lightboxOpen || videoPlayerOpen || Boolean($readerItem);
  onMount(() => registerSidebarShortcuts(
    () => sidebarCollapsed = !sidebarCollapsed,
    () => detailCollapsed = !detailCollapsed,
    () => viewerOpen() || settingsOpen || onboardingOpen,
    () => true,
  ));
  import { registerContentShortcuts } from './lib/content-shortcuts';
  import { registerShortcuts } from './lib/shortcuts';
  import { applyFocusStage, nextFocusStage, windowIsMaximized, type FocusStage } from './lib/window-focus';
  import { focusGallerySearch, registerSearchFocusShortcut } from './lib/search-focus';
  import { pushToast } from './lib/toast';
  onMount(() => registerContentShortcuts(type => switchContent(type, false, true), () => viewerOpen() || settingsOpen || onboardingOpen));
  // F = 沉浸循环（在输入框里打字不算），Ctrl+F = 光标进搜索框（正在打字时也能按）。
  onMount(() => registerShortcuts([{ key: "f", action: "focusMode", handler: () => cycleFocusMode() }]));
  onMount(() => registerSearchFocusShortcut(() => {
    closeOpenViewers();
    // 满屏那一步把工具栏整条摘了，搜索框不在页面上；先退出满屏再聚焦，别让人按了没反应。
    if (focusStage === "fullscreen") leaveFocusMode();
    void focusGallerySearch();
  }));
  import { switchContent, readerItem, readerTerm } from './lib/stores';
  import Feed from "./components/Feed.svelte";
  import TextReader from "./components/TextReader.svelte";
  import DetailPanel from "./components/DetailPanel.svelte";
  import Lightbox from "./components/Lightbox.svelte";
  import OnboardingModal from "./components/OnboardingModal.svelte";
  import VideoPlayer from "./components/VideoPlayer.svelte";
  import SettingsModal from "./components/SettingsModal.svelte";
  import ScanProgressBar from "./components/ScanProgressBar.svelte";
  import AudioEngine from "./components/AudioEngine.svelte";
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
    // 归档提示条的「查看」：直接落到设置的已归档目录（tab 按 label 定位）
    const openArchived = () => { settingsTab = "已归档目录"; settingsOpen = true; };
    window.addEventListener("open-model-settings", openModels);
    window.addEventListener("open-archived-settings", openArchived);
    return () => {
      window.removeEventListener("open-model-settings", openModels);
      window.removeEventListener("open-archived-settings", openArchived);
    };
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
    // Lightbox 只走媒体子序列：统一流里的文本项占位会让下标错位
    const idx = $mediaItems.findIndex((it) => it.id === id);
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
  const DETAIL_MIN = 320;
  let detailWidth = $state(DETAIL_MIN);
  const DETAIL_MAX = 560;

  let narrowMode = $state(false);
  function checkNarrow() {
    if (typeof window === "undefined") {
      narrowMode = false;
      return;
    }
    narrowMode = window.innerWidth < 768;
  }

  let drawerOpen = $state(false);

  // ============ F 键沉浸循环 ============
  //
  // 收起两侧 → 最大化 → 全屏 → 还原，再从头开始。最后一步连侧栏一起还原成
  // 进入循环前的样子，否则按一圈下来侧栏永远回不来。
  let focusStage = $state<FocusStage>("normal");
  // 沉浸那一步 = 屏幕上只剩缩略图：标题栏、两条侧栏、分隔线、网格工具栏全部退场。
  const immersive = $derived(focusStage === "fullscreen");
  let sidebarsBeforeFocus = { left: false, right: false };
  // 大多数人日常是把窗口最大化的，最后一步得回到那个状态，而不是把窗口甩成小的。
  let windowMaximizedBeforeFocus = false;
  /** 回到循环原点：侧栏还原成进入前的样子，窗口退出全屏（原本最大化的保持最大化）。 */
  function leaveFocusMode() {
    focusStage = "normal";
    sidebarCollapsed = sidebarsBeforeFocus.left;
    detailCollapsed = sidebarsBeforeFocus.right;
    void applyFocusStage("normal", windowMaximizedBeforeFocus).then((error) => { if (error) pushToast(error, { kind: "error" }); });
  }

  function cycleFocusMode() {
    // 弹窗开着时不接管 F：先把对话框处理完，别在背后把窗口和侧栏改了。
    if (document.querySelector('[aria-modal="true"], [role="dialog"]')) return;
    const next = nextFocusStage(focusStage);
    if (next === "normal") { leaveFocusMode(); return; }
    if (next === "sidebars") {
      sidebarsBeforeFocus = { left: sidebarCollapsed, right: detailCollapsed };
      sidebarCollapsed = true;
      detailCollapsed = true;
      void windowIsMaximized().then((value) => { windowMaximizedBeforeFocus = value; });
    }
    focusStage = next;
    void applyFocusStage(next, windowMaximizedBeforeFocus).then((error) => { if (error) pushToast(error, { kind: "error" }); });
  }

  /** Ctrl+F 前要先退掉内嵌层：搜索框在网格工具栏里，层开着时整块是 inert，聚焦会被拒。 */
  function closeOpenViewers() {
    lightboxOpen = false;
    videoPlayerOpen = false;
    // 阅读层自己负责先落盘再关，这里不能直接把 readerItem 清掉。
    if ($readerItem) window.dispatchEvent(new Event("close-text-reader"));
  }

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

<div class="app-shell" class:desktop-shell={desktop} style:--desktop-titlebar-height={desktop && !immersive ? (desktopMaximized ? "24px" : "28px") : "0px"}>
{#if desktop && !immersive}<DesktopTitlebar bind:maximized={desktopMaximized} />{/if}
<div class="h-full w-full flex flex-col bg-bg text-zinc-200" ondragover={swallowDrag} ondrop={swallowDrag} role="application">
  <ScanProgressBar />
  <div
    class="flex-1 min-h-0 grid app-grid"
    class:drawer-mode={narrowMode}
    class:sidebar-collapsed={sidebarCollapsed}
    class:immersive={immersive}
    style="--sidebar-width: {sidebarCollapsed ? 44 : 260}px; grid-template-columns: {immersive ? '1fr' : `var(--sidebar-width) 1fr 6px ${detailCollapsed ? 44 : detailWidth}px`};"
  >
    <aside class="border-r border-border bg-surface flex flex-col min-h-0">
      {#if sidebarCollapsed}
        <CollapsedSidebar onexpand={() => sidebarCollapsed = false} />
      {:else}
      <FolderTree oncollapse={() => sidebarCollapsed = true} />
      {/if}
      <div class="sidebar-actions fill-interactions flex items-center mt-auto pt-4 pb-2 shrink-0" class:justify-center={sidebarCollapsed} class:px-4={!sidebarCollapsed} class:collapsed-actions={sidebarCollapsed}>
        <button class="w-10 h-10 flex items-center justify-center rounded-lg text-muted" aria-label="设置" title="设置" onclick={() => settingsOpen = true}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="m12 2 9 5v10l-9 5-9-5V7z" /><circle cx="12" cy="12" r="4" /></svg>
        </button>
        <SidebarUpdateButton />
      </div>
    </aside>
    <main class="relative min-w-0 min-h-0 overflow-hidden isolate" style="display:flex;flex-direction:column;">
      <!--
        中间栏只有一个「打开态」层级：图片 Lightbox、文本 TextReader、视频 VideoPlayer
        都挂在这里，都是 absolute inset-0，Esc 一律回到缩略图。网格常驻，只是被 inert 挡住交互。
      -->
      <div class="h-full flex flex-col" inert={lightboxOpen || videoPlayerOpen || Boolean($readerItem)}>
      <Feed
        bind:selectedId={selectedIdValue}
        bind:lightboxOpen
        bind:lightboxIndex
        overlayOpen={lightboxOpen || videoPlayerOpen || Boolean($readerItem)}
        immersive={immersive}
      />
      </div>
      <AudioEngine />
      <Lightbox bind:open={lightboxOpen} bind:index={lightboxIndex} bind:selectedId={selectedIdValue} />
      <TextReader open={Boolean($readerItem)} item={$readerItem} term={$readerTerm} />
      <VideoPlayer bind:open={videoPlayerOpen} bind:startId={videoStartId} />
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
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16m-4-11-3 3 3 3"/></svg>
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


<OnboardingModal bind:open={onboardingOpen} />
<SettingsModal bind:open={settingsOpen} bind:tab={settingsTab} onOpenOnboarding={() => { settingsOpen = false; onboardingOpen = true; }} />
<Toast />

<SplashOverlay ready={gate.ready} error={gate.error} />
</div>

<style>
  .sidebar-actions { gap: 8px; }
  .sidebar-actions.collapsed-actions { flex-direction: column-reverse; gap: 4px; }
  .app-shell { height: 100%; padding-top: var(--desktop-titlebar-height); }
  /* 沉浸满屏：左右两栏和分隔线整块退场，网格独占整屏（0 宽会漏出内容，所以直接 display:none）。 */
  .app-grid.immersive > aside,
  .app-grid.immersive .splitter { display: none; }
  .desktop-shell :global(.fixed.inset-0) { top: var(--desktop-titlebar-height); }

  main { container-type:inline-size; }
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




