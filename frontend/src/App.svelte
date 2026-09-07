<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { connectEvents, disconnectEvents } from "./lib/ws";
  import { refreshFolders, refreshStats, refreshFeed, selectedId, comfyuiStatus, comfyuiEnabled, feedItems, tag, folderId, query, view, selectedDetail } from "./lib/stores";
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

  onMount(async () => {
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
    // 启动一次 ComfyUI 探测；之后每 30s 轮询 + 切回标签页时立刻探
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

<style>
  .splitter {
    cursor: col-resize;
    background: transparent;
    position: relative;
  }
  .splitter:hover,
  .splitter:focus-visible {
    background: rgba(242, 78, 78, 0.4);
    outline: none;
  }
  .splitter::before {
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



