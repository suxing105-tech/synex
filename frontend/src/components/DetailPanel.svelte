<script lang="ts">
  import { backendUrl } from "../lib/backend-url";
  /**
   * 右侧工作台：吸附的素材身份与操作区，下方展示提示词、参数与队列。
   * 提示词优先；参数按需展开，避免整栏过长。
   */

  import { get } from "svelte/store";
  import {
    selectedDetail,
    selectedText,
    feedItems,
    folders,
    refreshFolders,
    refreshSelectedDetail,
    playAudio,
    playingAudio,
    stopAudio,
    appBooting,
  } from "../lib/stores";
  import { audioApi, imagesApi } from "../lib/api";
  import { copyText, formatSize, formatDate, allParamsText } from "../lib/ws";
  import { pushToast } from "../lib/toast";
  import { extractLoras } from "../lib/params";
  import type { ImageDetail, FolderNode } from "../lib/types";
  import Icon from "./Icon.svelte";
  import PromptCard from "./PromptCard.svelte";
  import ReversePromptPanel from "./ReversePromptPanel.svelte";
import VideoPromptPanel from "./VideoPromptPanel.svelte";
  import ParamsCard from "./ParamsCard.svelte";
  import WorkflowCard from "./WorkflowCard.svelte";
  import TextDetailPanel from "./TextDetailPanel.svelte";
  import FolderPickerModal from "./FolderPickerModal.svelte";
  import VideoCoverModal from "./VideoCoverModal.svelte";
  import CloneQueuePanel from "./CloneQueuePanel.svelte";
  import { moveSummary } from "../lib/move-result";
  import { nativePath, parentDirectory } from "../lib/file-location";
  import { cloneJob } from "../lib/clone";

  // ---------- 通知（全局 toast） ----------
  async function copy(text: string, label: string) {
    if (!text) return;
    const ok = await copyText(text);
    pushToast(ok ? `已复制 ${label}` : "复制失败", { kind: ok ? "success" : "error" });
  }
  const notify = (msg: string, kind: "info" | "success" | "error" = "info") =>
    pushToast(msg, { kind });

  // ---------- ⋯ 菜单 ----------
  let menuOpen = $state(false);
  function toggleMenu() {
    menuOpen = !menuOpen;
  }
  function closeMenu() {
    menuOpen = false;
  }

  // ---------- 标签 ----------

  // ---------- 视频封面 ----------
  let coverModalOpen = $state(false);

  // 音频波形是懒生成的：URL 404（ffmpeg 缺失 / 还没生成）时退回音符图形，
  // 换一条音频要重新给一次机会。
  let waveFailed = $state(false);
  $effect(() => {
    void $selectedDetail?.id;
    waveFailed = false;
  });

  async function refreshAfterCoverChange() {
    const id = $selectedDetail?.id;
    if (id == null) return;
    try {
      const detail = await imagesApi.detail(id);
      selectedDetail.set(detail);
      feedItems.update((items) =>
        items.map((it) =>
          it.item_type === "media" && it.id === id ? { ...it, thumbnail_url: detail.thumbnail_url } : it,
        ),
      );
    } catch {
      // 忽略：详情面板仍可继续使用
    }
  }

  // ---------- 文件夹 ----------
  let showFolderPicker = $state(false);
  async function pickFolder(node: { id: number; name: string } | null) {
    const d = $selectedDetail;
    if (!d) return;
    const fid = node?.id ?? null;
    try {
      const r = await imagesApi.assignFolder(d.id, fid);
      selectedDetail.set({
        ...d,
        folder_ids: fid === null ? [] : [fid],
      });
      await refreshFolders();
      notify(moveSummary({ moved: r.moved ? 1 : 0, kept: r.kept ? 1 : 0, failed: [] }, node ? node.name : null));
      // 文件真的换了目录 → 重拉 detail，path/filename 才不会停留在旧位置
      if (r.moved) {
        const fresh = await imagesApi.detail(d.id);
        if ($selectedDetail?.id === fresh.id) selectedDetail.set(fresh);
      }
    } catch (e) {
      notify(`移动失败：${(e as Error).message}`);
    }
  }

  // ---------- 所在文件夹 ----------
  // 位置行显示文件真实所在目录；点击走后端 reveal，资源管理器打开该目录并选中本文件。
  async function revealLocation() {
    const d = $selectedDetail;
    if (!d) return;
    try {
      // 桌面版交给桌面壳，资源管理器才会盖在应用上面；浏览器版才回退到后端接口。
      const via = await revealInShell(d.path, true, () => imagesApi.reveal(d.id));
      if (via === "backend") notify("已请求打开所在文件夹");
    } catch (e) {
      notify(`打开所在文件夹失败：${(e as Error).message}`, "error");
      // 十有八九是文件被移走/删了：重拉详情，位置行别再显示旧目录
      await refreshSelectedDetail();
    }
  }

  function copyLocation() {
    const d = $selectedDetail;
    if (!d) return;
    copy(nativePath(parentDirectory(d.path)), "文件夹路径");
  }


  // ---------- ComfyUI ----------
  import { comfyuiStatus } from "../lib/stores";
  import { openWorkflowForMedia } from "../lib/comfyui-window";
  import { revealLocation as revealInShell } from "../lib/reveal";
  import { registerShortcuts } from "../lib/shortcuts";
  import { onMount, onDestroy, tick } from "svelte";

  // 图片和视频同一条路：桌面版在应用内 ComfyUI 窗口里直接 loadGraphData，
  // 浏览器版退化成「复用标签 + 落临时文件」。没带工作流就别点了，直接说明原因。
  async function openInComfyui() {
    const det = get(selectedDetail);
    if (!det) return;
    if (!det.workflow) {
      notify(noWorkflowText(det.kind));
      return;
    }
    try {
      const message = await openWorkflowForMedia(
        det.id,
        det.filename,
        $comfyuiStatus.url || "http://127.0.0.1:8188",
      );
      notify(message, "success");
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      const detail = m.match(/→ \d+: (.+)$/)?.[1] || m;
      notify(`在 ComfyUI 中打开失败：${detail}`, "error");
    }
  }

  function noWorkflowText(kind: string): string {
    if (kind === "video") return "该视频未携带 ComfyUI 工作流";
    if (kind === "audio") return "该音频未携带 ComfyUI 工作流";
    return "该图片未携带 ComfyUI 工作流";
  }

  interface Props { active?: boolean }
  let { active = true }: Props = $props();

  let detailScrollEl: HTMLDivElement | null = $state(null);
  let paramsOpen = $state(false);
  let workflowOpen = $state(false);
  let lastDetailId: number | null = null;
  $effect(() => {
    const id = $selectedDetail?.id ?? null;
    if (id === null) {
      lastDetailId = null;
      return;
    }
    if (id !== lastDetailId) {
      lastDetailId = id;
      paramsOpen = false;
      workflowOpen = false;
      menuOpen = false;
      void tick().then(() => detailScrollEl?.scrollTo({ top: 0 }));
    }
  });

  // ---------- 派生 ----------
  const loras = $derived(
    $selectedDetail
      ? extractLoras($selectedDetail.positive_prompt, $selectedDetail.parameters)
      : [],
  );

  // 缩略图 URL：视频用海报帧、音频用波形图，图片用 ?max=256 预览；没有就 null
  function thumbUrl(d: ImageDetail): string | null {
    if (d.kind === "video" || d.kind === "audio") return d.thumbnail_url ? backendUrl(d.thumbnail_url) : null;
    if (!d.original_url) return null;
    const sep = d.original_url.includes("?") ? "&" : "?";
    return backendUrl(`${d.original_url}${sep}max=256`);
  }

  function formatDuration(sec: number | null): string {
    if (sec == null) return "";
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem.toString().padStart(2, "0")}`;
  }

  /**
   * 音频信息行。
   *
   * 采样率 / 声道 / 码率没有独立表列 —— 后端 ffprobe 把它们落在 parameters.audio，
   * 这里就地读，避免为三个只展示不检索的字段加列。
   */
  function audioInfoRows(d: ImageDetail) {
    const extra = ((d.parameters ?? {}) as { audio?: Record<string, unknown> }).audio ?? {};
    const num = (key: string): number => {
      const raw = extra[key];
      const value = typeof raw === "number" ? raw : Number(raw);
      return Number.isFinite(value) ? value : 0;
    };
    const rate = num("sample_rate");
    const channels = num("channels");
    const bitrate = num("bit_rate");
    const title = typeof extra.title === "string" ? extra.title : "";
    const artist = typeof extra.artist === "string" ? extra.artist : "";
    return [
      { label: "时长", value: formatDuration(d.duration_seconds) || "—" },
      { label: "采样率", value: rate > 0 ? `${Math.round(rate / 100) / 10} kHz` : "—" },
      { label: "声道", value: channels === 1 ? "单声道" : channels === 2 ? "立体声" : channels > 0 ? `${channels} 声道` : "—" },
      { label: "编码", value: d.audio_codec ?? "—" },
      { label: "码率", value: bitrate > 0 ? `${Math.round(bitrate / 1000)} kbps` : "—" },
      { label: "容器", value: d.format ?? "—" },
      { label: "大小", value: formatSize(d.size_bytes) },
      ...(title ? [{ label: "标题", value: title }] : []),
      ...(artist ? [{ label: "艺术家", value: artist }] : []),
    ];
  }

  // 音频走全应用唯一的播放实例（AudioEngine，隐藏）：这里只是又一个入口，没有常驻底栏。
  // 容器不被 WebView 支持时直接降级到系统播放器，不进播放态。
  function toggleSelectedAudio() {
    const d = $selectedDetail;
    if (!d || d.kind !== "audio") return;
    if ($playingAudio?.id === d.id) { stopAudio(); return; }
    if (d.playable === false) { void openSelectedAudioExternally(); return; }
    playAudio({ ...d, item_type: "media" });
  }

  async function openSelectedAudioExternally() {
    const d = $selectedDetail;
    if (!d || d.kind !== "audio") return;
    try {
      const r = await audioApi.open(d.id);
      notify(r.ok ? "已用系统播放器打开" : "已请求用系统播放器打开", "success");
    } catch (e) {
      notify(`打开失败：${(e as Error).message}`, "error");
    }
  }

  // 缩略图的点击语义按类型分：视频 = 改封面（面板里已不再重复放大图），其余 = 看大图
  function headerThumbLabel(kind: string): string {
    return kind === "video" ? "修改视频封面" : "查看大图";
  }

  // 打开视频播放器弹层（App.svelte 监听）
  function playVideo() {
    const d = $selectedDetail;
    if (!d || d.kind !== "video") return;
    window.dispatchEvent(new CustomEvent("open-video-player", { detail: { id: d.id } }));
  }

  function openLightbox(d: ImageDetail) {
    window.dispatchEvent(
      new CustomEvent("open-lightbox", { detail: { id: d.id } }),
    );
  }

  // ---------- 快捷键 ----------
  // P / N / S / Shift+C / F / T / Esc（在详情面板有选中时生效）
  let shortcutOff: (() => void) | null = null;
  onMount(() => {
    shortcutOff = registerShortcuts([
      {
        key: "p", action: "positive",
        handler: () => {
          const d = $selectedDetail;
          if (!d) return;
          copy(d.positive_prompt, "正向 Prompt");
        },
      },
      {
        key: "n", action: "negative",
        handler: () => {
          const d = $selectedDetail;
          if (!d) return;
          copy(d.negative_prompt, "反向 Prompt");
        },
      },
      {
        key: "s", action: "seed",
        handler: () => {
          const d = $selectedDetail;
          if (!d || d.seed == null) return;
          copy(String(d.seed), "Seed");
        },
      },
      {
        key: "shift+c", action: "comfy",
        handler: () => {
          if ($selectedDetail) openInComfyui();
        },
      },
      {
        key: "escape",
        handler: () => {
          if (showFolderPicker) showFolderPicker = false;
          else if (menuOpen) menuOpen = false;
        },
      },
    ]);
  });
  onDestroy(() => {
    shortcutOff?.();
    shortcutOff = null;
  });
</script>

<svelte:window
  onclick={(e) => {
    // 点击 ⋯ 菜单以外的地方自动收起
    if (!menuOpen) return;
    const t = e.target as HTMLElement | null;
    if (t && !t.closest("[data-menu-root]")) menuOpen = false;
  }}
/>

{#if $selectedText}
  <!-- 文本选中走独立分支：texts.id 与 images.id 会撞车，详情不能复用图片那套字段 -->
  <TextDetailPanel />
{:else if $appBooting}
  <!-- 启动期别急着教用户「选一张图」：这时候中间栏自己也还没东西 -->
  <div class="detail-skeleton" role="status" aria-label="详情正在载入">
    <span class="ds-head"></span>
    <span class="ds-line" style="--i: 0;"></span>
    <span class="ds-line" style="--i: 1;"></span>
    <span class="ds-block" style="--i: 2;"></span>
  </div>
{:else if !$selectedDetail}
  <div class="h-full flex items-center justify-center text-center text-muted p-8">
    <div>
      <div class="mb-3 opacity-50"><Icon name="arrow-left" size={36} /></div>
      <div class="text-[12.5px]">在中间选一张图片或文本<br />查看详情和操作</div>
    </div>
  </div>
{:else}
  {@const d = $selectedDetail}
  <div class="h-full flex flex-col overflow-hidden">
    <header class="detail-header sticky top-0 z-20 shrink-0 border-b border-border bg-surface-2 px-3 py-4">
      <div class="flex items-center gap-2.5 min-w-0" data-menu-root>
        <button
          type="button"
          class="detail-thumb shrink-0 w-10 h-10 hover:bg-surface-3"
          title={headerThumbLabel(d.kind)}
          aria-label={headerThumbLabel(d.kind)}
          onclick={() => (d.kind === "video" ? (coverModalOpen = true) : openLightbox(d))}
        >
          {#if thumbUrl(d)}
            <img src={thumbUrl(d)} alt={d.filename} loading="lazy" />
          {:else}
            <span class="w-full h-full flex items-center justify-center text-muted">
              <Icon name={d.kind === "video" ? "video" : d.kind === "audio" ? "music" : "image"} size={16} />
            </span>
          {/if}
        </button>
        <div class="min-w-0 flex-1">
          <div class="text-[12px] font-mono font-semibold truncate" title={d.filename}>{d.filename}</div>
          <div class="text-[10px] text-muted mt-0.5 flex gap-x-2 gap-y-0.5 flex-wrap">
            {#if d.width && d.height}<span>{d.width}×{d.height}</span>{/if}
            {#if (d.kind === "video" || d.kind === "audio") && d.duration_seconds != null}<span>{formatDuration(d.duration_seconds)}</span>{/if}
            {#if d.kind === "video" && d.fps != null}<span>{d.fps} fps</span>{/if}
            <span>{formatSize(d.size_bytes)}</span>
            <span>{formatDate(d.mtime)}</span>
          </div>
        </div>
        {#if d.kind === "video"}
          <button type="button" class="icon-action p-1.5 rounded border border-border hover:bg-surface-3 transition-colors" title="播放视频" aria-label="播放视频" onclick={playVideo}>
            <Icon name="play" size={14} />
          </button>
        {/if}
        {#if d.kind === "audio"}
          <button type="button" class="icon-action p-1.5 rounded border border-border hover:bg-surface-3 transition-colors" title={$playingAudio?.id === d.id ? "暂停音频" : "播放音频"} aria-label={$playingAudio?.id === d.id ? "暂停音频" : "播放音频"} onclick={toggleSelectedAudio}>
            <Icon name={$playingAudio?.id === d.id ? "pause" : "play"} size={14} />
          </button>
        {/if}
        <div class="relative shrink-0">
          <button
            type="button"
            class="dock-btn more-button hover:bg-surface-3 transition-colors"
            title="更多操作"
            aria-label="更多操作"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onclick={toggleMenu}
          >
            <Icon name="more-vertical" size={14} />
          </button>
          {#if menuOpen}
            <div class="dock-menu bg-surface-2 border border-border rounded-md py-1 min-w-[190px] shadow-lg" role="menu">
              {#if d.kind === "image"}
                <button type="button" class="menu-item" role="menuitem" aria-label="复制全部参数" onclick={() => { copy(allParamsText(d), "全部参数"); closeMenu(); }}>
                  复制全部参数
                </button>
                <button type="button" class="menu-item" role="menuitem" onclick={() => { copy(String(d.seed ?? ""), "Seed"); closeMenu(); }}>
                  复制 Seed
                </button>
                <div class="border-t border-border my-1"></div>
              {/if}
              {#if d.positive_prompt}
                <button type="button" class="menu-item" role="menuitem" onclick={() => { copy(d.positive_prompt, "工作流提示词"); closeMenu(); }}>
                  复制工作流提示词
                </button>
              {/if}
              {#if d.negative_prompt}
                <button type="button" class="menu-item" role="menuitem" onclick={() => { copy(d.negative_prompt, "反向提示词"); closeMenu(); }}>
                  复制反向提示词
                </button>
              {/if}
              <button type="button" class="menu-item" role="menuitem" onclick={() => { copy(d.path, "路径"); closeMenu(); }}>
                复制绝对路径
              </button>
              {#if d.kind === "audio"}
                <button type="button" class="menu-item" role="menuitem" onclick={() => { openSelectedAudioExternally(); closeMenu(); }}>
                  系统播放器打开
                </button>
              {/if}
              <button type="button" class="menu-item" role="menuitem" onclick={() => { revealLocation(); closeMenu(); }}>
                在文件夹中显示
              </button>
              <button type="button" class="menu-item" role="menuitem" onclick={() => { copyLocation(); closeMenu(); }}>
                复制所在文件夹路径
              </button>
            </div>
          {/if}
        </div>
      </div>
    </header>

    <div bind:this={detailScrollEl} class="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 detail-body">
      {#if d.kind !== "audio"}
        <section class="workbench-section prompt-workspace" data-workbench-section="prompts" aria-labelledby="prompt-workspace-title">
          <div class="section-heading">
            <span class="section-icon"><Icon name="wand" size={14} /></span>
            <div class="min-w-0">
              <h3 id="prompt-workspace-title" class="section-title">提示词</h3>
              <p class="section-subtitle">工作流原文与 AI 反推结果</p>
            </div>
          </div>
          {#key d.id}
          <div class="prompt-stack">
            {#if d.positive_prompt}
              <PromptCard title="原始提示词" text={d.positive_prompt} copyLabel="工作流提示词"
                onCopy={(ok) => notify(ok ? "已复制 工作流提示词" : "复制失败", ok ? "success" : "error")} />
            {/if}
            {#if d.negative_prompt}
              <PromptCard title="工作流负向提示词" text={d.negative_prompt} copyLabel="工作流负向提示词"
                onCopy={(ok) => notify(ok ? "已复制 工作流负向提示词" : "复制失败", ok ? "success" : "error")} />
            {/if}
            {#if d.kind === "video"}
              {#key d.id}
                <VideoPromptPanel videoId={d.id} filename={d.filename} durationSeconds={d.duration_seconds} />
              {/key}
            {:else}
              {#key d.id}<ReversePromptPanel imageId={d.id} />{/key}
            {/if}
          </div>
          {/key}
        </section>
      {/if}

      {#if d.kind === "image"}
        <section class="workbench-section" data-workbench-section="parameters" aria-labelledby="parameter-summary-title">
          <div class="section-heading">
            <div>
              <h3 id="parameter-summary-title" class="section-title">生成参数</h3>
            </div>
          </div>
          <details bind:open={paramsOpen} class="workbench-disclosure">
            <summary>查看完整参数{#if d.seed !== null}<span>Seed {d.seed}</span>{/if}</summary>
            <div class="disclosure-content">
              <ParamsCard parameters={d.parameters} detail={{ sampler: d.sampler, steps: d.steps, cfg: d.cfg,
                seed: d.seed, model: d.model, width: d.width, height: d.height }} loras={loras}
                onCopy={(ok) => notify(ok ? "已复制" : "复制失败", ok ? "success" : "error")} />
            </div>
          </details>
          {#if d.workflow}
            <div class="workflow-download-slot"><WorkflowCard workflow={d.workflow} filename={d.filename} /></div>
          {/if}
        </section>
      {:else if d.kind === "video"}
        <section class="workbench-section" data-workbench-section="parameters" aria-label="工作流下载">
          {#if d.workflow}
            <WorkflowCard workflow={d.workflow} filename={d.filename} />
          {/if}
        </section>
      {/if}

      <section class="workbench-section queue-workspace" data-workbench-section="queue" aria-labelledby="queue-title">
        <div class="section-heading">
          <div><h3 id="queue-title" class="section-title">队列</h3><p class="section-subtitle">当前任务与最近产出</p></div>
          {#if $cloneJob.running}<span class="queue-live-dot" aria-label="有任务正在运行"></span>{/if}
        </div>
        <CloneQueuePanel active={active} />
      </section>

    </div>

    <VideoCoverModal bind:open={coverModalOpen} video={d} onCoverChange={refreshAfterCoverChange} />
  </div>
{/if}

<!-- 文件夹选择弹层 -->
<FolderPickerModal
  open={showFolderPicker}
  folders={$folders}
  title="切换所属文件夹"
  subtitle="选择目标 user folder；选「不分配」把图移出文件夹"
  onPick={pickFolder}
  onClose={() => (showFolderPicker = false)}
/>


<style>
  .detail-header { box-shadow: 0 8px 18px rgb(0 0 0 / 14%); }
  .dock-btn:hover:not(:disabled) { background: var(--raise-1); }
  .dock-btn:disabled { cursor:not-allowed; }
  .more-button { width:var(--ctl-md); justify-content:center; padding:0; }
  .dock-menu {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    z-index: 40;
    max-height: min(60vh, 420px);
    overflow-y: auto;
  }
  .menu-item {
    width:100%; display:flex; align-items:center; gap:8px;
    padding:6px 10px; text-align:left; font-size:12px;
    color:var(--text-2); white-space:nowrap;
  }
  .menu-item:hover,
  .menu-item:focus-visible { background:var(--raise-1); color:var(--text-1); outline:none; }

  .detail-body { scrollbar-gutter:stable; }
  .workbench-section {
    padding:10px 2px;
    border:0;
    border-radius:0;
    background:transparent;
  }
  .prompt-stack { display:flex; flex-direction:column; gap:10px; }
  .prompt-stack :global(.reverse-panel),
  .prompt-stack :global(.rounded-lg.border) { margin-top:0; }
  .workbench-disclosure { border-top:1px solid var(--line); margin-top:9px; padding-top:8px; }
  .workbench-disclosure > summary {
    display:flex; align-items:center; gap:8px; min-height:26px;
    cursor:pointer; list-style:none; color:var(--text-2); font-size:11px;
  }
  .workbench-disclosure > summary::-webkit-details-marker { display:none; }
  .workbench-disclosure > summary::before {
    content:""; width:6px; height:6px; flex:none;
    border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor;
    transform:rotate(-45deg); transition:transform .15s ease;
  }
  .workbench-disclosure[open] > summary::before { color:var(--text-3); }
  .workbench-disclosure summary span { color:var(--text-3); font-family:var(--font-mono); }
  .disclosure-content { padding-top:9px; }
  .workflow-download-slot { margin-top:10px; }
  .queue-live-dot { width:7px; height:7px; border-radius:50%; background:var(--accent); box-shadow:0 0 10px color-mix(in srgb, var(--accent) 70%, transparent); }
  @media (max-width: 390px) {
    .detail-header { padding-inline:9px; }
    .detail-body { padding-inline:9px; }
    .workbench-section { padding:10px; }
  }

  /* 面板里的缩略图只借共用形状（圆角、无常态描边），hover 仍旧只改底色：
     详情面板的交互件统一「底色变化」是用户定过的规则，不吃主网格那圈描边。 */
  /* 启动期详情骨架：一个头块 + 两条文字 + 一块方形占位 */
  .detail-skeleton { display: flex; flex-direction: column; gap: 10px; padding: 16px; }
  .detail-skeleton span {
    display: block; border-radius: var(--r-1); background: var(--ink-2);
    animation: ds-in 260ms ease-out both;
    animation-delay: calc(var(--i, 0) * 55ms);
  }
  .ds-head { width: 55%; height: 14px; }
  .ds-line { width: 82%; height: 10px; }
  .ds-block { width: 100%; height: 132px; margin-top: 6px; }
  @keyframes ds-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) {
    .detail-skeleton span { animation: none; opacity: 1; transform: none; }
  }

  .detail-thumb {
    border: 0;
    padding: 0;
    overflow: hidden;
    border-radius: var(--thumb-radius);
    background: var(--thumb-media-bg);
    cursor: pointer;
  }

  .detail-thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* 波形块与缩略图同一套形状语言：只有圆角和底色，不带常态描边 */
  .detail-media-card {
    border-radius: var(--thumb-radius);
    background: var(--thumb-bg);
    overflow: hidden;
  }

  .detail-body {
    /* 让深色模式下滚动条更柔和 */
    scrollbar-gutter: stable;
  }
  /* 详情内按钮焦点环 */
  .detail-body :global(button:focus-visible),
  header :global(button:focus-visible):not(.more-button) {
    outline: 1px solid var(--line);
    outline-offset: 1px;
  }
</style>
