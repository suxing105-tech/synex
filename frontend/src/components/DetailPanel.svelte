<script lang="ts">
  import { backendUrl } from "../lib/backend-url";
  /**
   * 详情面板（重写版）。
   *
   * 分层结构：
   *   Header（sticky）
   *     ├─ 缩略图 + 文件名 + 元数据 + 主操作（收藏 / ComfyUI / 更多菜单）
   *   Body（可滚动）
   *     ├─ PromptCard × 2（正向 / 反向）
   *     ├─ ParamsCard（参数按域分组 + LoRA 列表）
   *     ├─ MetadataCard（标签 + 所在文件夹）
   *     └─ Workflow JSON（默认折叠）
   *
   * 与外部交互：
   *   - 缩略图点击 → dispatch "open-lightbox" CustomEvent（App.svelte 监听）
   *   - 标签点击 → dispatch "open-tag-search" CustomEvent
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
  import MetadataCard from "./MetadataCard.svelte";
  import TextDetailPanel from "./TextDetailPanel.svelte";
  import FolderPickerModal from "./FolderPickerModal.svelte";
  import VideoCoverModal from "./VideoCoverModal.svelte";
  import CloneQueuePanel from "./CloneQueuePanel.svelte";
  import { cloneHistory, cloneJob } from "../lib/clone";
  import { moveSummary } from "../lib/move-result";
  import { nativePath, parentDirectory } from "../lib/file-location";

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
  let showTagInput = $state(false);
  let tagInput = $state<string>("");

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

  async function saveTagInput() {
    const d = $selectedDetail;
    if (!d) return;
    const tags = tagInput
      .split(/[,，]/)
      .map((t) => t.trim().replace(/^#/, ""))
      .filter(Boolean);
    showTagInput = false;
    tagInput = "";
    if (tags.length === 0) return;
    const resp = await imagesApi.setTags(d.id, tags);
    selectedDetail.set({ ...d, tags: resp.tags });
    notify("标签已保存");
  }

  async function removeTag(tag: string) {
    const d = $selectedDetail;
    if (!d) return;
    const next = d.tags.filter((t) => t !== tag);
    const resp = await imagesApi.setTags(d.id, next);
    selectedDetail.set({ ...d, tags: resp.tags });
  }

  function searchByTag(tag: string) {
    // 全局跳转到 ?tag=xxx，由 App.svelte 监听 custom event
    window.dispatchEvent(
      new CustomEvent("open-tag-search", { detail: { tag } }),
    );
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
  import { onMount, onDestroy } from "svelte";

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
    return kind === "video" ? "该视频未携带 ComfyUI 工作流" : "该图片未携带 ComfyUI 工作流";
  }

  // ---------- 分页 ----------
  //
  // 方案 3 第三批（2026-11-11）：右栏从「一条滚到底的灰字墙」改成分页工作台。
  // 分成 detail / prompt / params / queue，是因为这个产品读一张图就三段——这是哪一张
  // （位置与标签）→ 它怎么来的（提示词）→ 用什么参数来的（参数与工作流），再加一页队列
  // 回答「我刚跑的那批呢」。以前四样东西挤在同一条滚动里，找种子要滚过整段反推结果。
  //
  // 换页用 hidden 不用 {#if}：反推面板和视频提示词面板把跑出来的结果、进行中的请求都存在
  // 组件自己身上，切成 {#if} 就是「切出去看一眼参数，回来反推白跑一次」。挂载成本与改之前
  // 完全一样——这些组件本来就全部挂着。
  type DetailTab = "detail" | "prompt" | "params" | "queue";
  const TAB_LABELS: Record<DetailTab, string> = {
    detail: "详情", prompt: "提示词", params: "参数", queue: "队列",
  };
  /** 音频没有提示词也没有生成参数，摆两个空页不如不给。 */
  function tabsForKind(kind: string | undefined): DetailTab[] {
    if (kind === "audio") return ["detail", "queue"];
    return ["detail", "prompt", "params", "queue"];
  }
  let detailTab = $state<DetailTab>("detail");
  const tabs = $derived(tabsForKind($selectedDetail?.kind));
  const queueBusy = $derived($cloneJob.running);
  const queueCount = $derived($cloneHistory.length);
  let tabSeedId = 0;
  $effect(() => {
    const d = $selectedDetail;
    if (!d) {
      tabSeedId = 0;
      return;
    }
    if (d.id !== tabSeedId) {
      tabSeedId = d.id;
      // 提示词优先：上一把卡片页脚改成了「提示词优先」，右栏第一眼落在同一件信息上。
      detailTab = d.kind !== "audio" && d.positive_prompt ? "prompt" : "detail";
    }
    const allowed = tabsForKind(d.kind);
    if (!allowed.includes(detailTab)) detailTab = allowed[0] ?? "detail";
  });
  /** 标签输入框住在「详情」那一页：从底部 ⋯ 菜单或 T 快捷键进来，得先把那一页翻开。 */
  function openTagEditor() {
    detailTab = "detail";
    showTagInput = true;
  }

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
        key: "t", action: "tags",
        handler: () => {
          if ($selectedDetail) {
            if (showTagInput) showTagInput = false;
            else openTagEditor();
          }
        },
      },
      {
        key: "escape",
        handler: () => {
          if (showFolderPicker) showFolderPicker = false;
          else if (showTagInput) showTagInput = false;
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
    <!-- ============== 分页 ============== -->
    <nav class="detail-tabs" aria-label="详情面板分页">
      {#each tabs as key}
        <button
          type="button"
          id="detail-tab-{key}"
          role="tab"
          class="detail-tab"
          class:is-on={detailTab === key}
          aria-selected={detailTab === key}
          aria-controls="detail-pane-{key}"
          onclick={() => (detailTab = key)}
        >
          {TAB_LABELS[key]}
          {#if key === "queue" && queueBusy}
            <span class="detail-tab-dot" title="有生成任务正在跑" aria-label="有生成任务正在跑"></span>
          {:else if key === "queue" && queueCount}
            <span class="detail-tab-count" title="本次运行已跑完 {queueCount} 批">{queueCount}</span>
          {/if}
        </button>
      {/each}
    </nav>

    <!-- ============== Header ============== -->
    <header class="px-4 py-3 border-b border-border bg-surface-2 flex items-start gap-3 transition-colors">
      <button
        type="button"
        class="detail-thumb shrink-0 w-12 h-12 hover:bg-surface-3"
        title={headerThumbLabel(d.kind)}
        aria-label={headerThumbLabel(d.kind)}
        onclick={() => (d.kind === "video" ? (coverModalOpen = true) : openLightbox(d))}
      >
        {#if thumbUrl(d)}
          <img
            src={thumbUrl(d)}
            alt={d.filename}
            class="w-full h-full object-cover"
            loading="lazy"
          />
        {:else}
          <div class="w-full h-full flex items-center justify-center text-muted">
            <Icon name={d.kind === "video" ? "video" : d.kind === "audio" ? "music" : "image"} size={20} />
          </div>
        {/if}
      </button>

      <div class="flex-1 min-w-0">
        <div class="text-[13px] font-mono font-semibold truncate" title={d.filename}>{d.filename}</div>
        <div class="text-[11px] text-muted mt-0.5 flex gap-2 flex-wrap">
          {#if d.width && d.height}<span>{d.width}×{d.height}</span>{/if}
          {#if (d.kind === "video" || d.kind === "audio") && d.duration_seconds != null}<span>{formatDuration(d.duration_seconds)}</span>{/if}
          {#if d.kind === "video" && d.fps != null}<span>{d.fps} fps</span>{/if}
          <span>{formatSize(d.size_bytes)}</span>
          <span>{formatDate(d.mtime)}</span>
        </div>
        {#if d.kind === "image" && d.seed !== null}
          <div class="text-[11px] mt-0.5 flex items-center gap-1 text-muted">
            <Icon name="hash" size={12} />
            <span class="font-mono truncate" title={String(d.seed)}>{String(d.seed)}</span>
            <button
              type="button"
              class="opacity-50 hover:opacity-100 hover:text-accent"
              title="复制 seed"
              aria-label="复制 seed"
              onclick={() => copy(String(d.seed), "Seed")}
            >
              <Icon name="copy" size={12} />
            </button>
          </div>
        {/if}
      </div>

      {#if d.kind === "video"}
      <!-- 头部只管「这是哪一张」+ 预览这一张。ComfyUI 与其余动作下到底部操作条（见 detail-dock）。 -->
      <div class="shrink-0 flex items-center gap-1">
        <button
          type="button"
          class="p-1.5 rounded border border-border hover:bg-surface-3 transition-colors"
          title="播放视频"
          aria-label="播放视频"
          onclick={playVideo}
        >
          <Icon name="play" size={14} />
        </button>
      </div>
      {/if}
    </header>

    <!-- ============== Body ============== -->
    <div class="flex-1 overflow-y-auto p-4 space-y-4 detail-body">
            {#if d.kind === "video"}
        <div class="detail-pane" id="detail-pane-detail" role="tabpanel" aria-labelledby="detail-tab-detail" hidden={detailTab !== "detail"}>
        <!-- 文件夹（视频不做标签） -->
        <section>
          <MetadataCard
            tags={[]}
            folderIds={d.folder_ids}
            folders={$folders}
            path={d.path}
            onSwitchFolder={() => (showFolderPicker = true)}
            onRevealLocation={revealLocation}
            onCopyLocation={copyLocation}
          />
        </section>
        </div>
        <div class="detail-pane" id="detail-pane-prompt" role="tabpanel" aria-labelledby="detail-tab-prompt" hidden={detailTab !== "prompt"}>
        <!-- ComfyUI 写进视频容器的提示词与工作流（外部下载的视频没有这两块） -->
        {#if d.positive_prompt}
          <PromptCard
            title="ComfyUI 提示词"
            text={d.positive_prompt}
            copyLabel="提示词"
            onCopy={(ok) => notify(ok ? "已复制 提示词" : "复制失败", ok ? "success" : "error")}
            initiallyExpanded
          />
        {/if}
        {#if d.negative_prompt}
          <PromptCard
            title="反向 Prompt"
            text={d.negative_prompt}
            copyLabel="反向 Prompt"
            onCopy={(ok) => notify(ok ? "已复制 反向 Prompt" : "复制失败", ok ? "success" : "error")}
          />
        {/if}
        <!-- AI 反推视频提示词（Seedance 2.0 / MiniMax H3） -->
        {#key d.id}
          <VideoPromptPanel videoId={d.id} filename={d.filename} durationSeconds={d.duration_seconds} />
        {/key}
        </div>
        <div class="detail-pane" id="detail-pane-params" role="tabpanel" aria-labelledby="detail-tab-params" hidden={detailTab !== "params"}>
        {#if d.workflow}
          <WorkflowCard workflow={d.workflow} filename={d.filename} copy={copy} notify={notify} />
        {/if}
        </div>
      {:else if d.kind === "audio"}
        <div class="detail-pane" id="detail-pane-detail" role="tabpanel" aria-labelledby="detail-tab-detail" hidden={detailTab !== "detail"}>
        <!-- 音频：波形是懒生成 + 落盘缓存的预览，取不到就退回音符图形 -->
        <section class="detail-media-card">
          <div class="relative w-full bg-black flex items-center justify-center audio-wave" style="aspect-ratio: 21 / 9;">
            {#if thumbUrl(d) && !waveFailed}
              <img
                src={thumbUrl(d)}
                alt="波形"
                class="absolute inset-0 w-full h-full object-contain"
                loading="lazy"
                onerror={() => (waveFailed = true)}
              />
            {:else}
              <Icon name="music" size={36} />
            {/if}
          </div>
          <div class="p-3 flex items-center gap-2">
            <button
              type="button"
              class="flex-1 px-3 py-2 rounded-md bg-accent/15 border border-accent/40 hover:bg-accent text-accent hover:text-white text-[12.5px] font-medium transition-colors flex items-center justify-center gap-1.5"
              title={$playingAudio?.id === d.id ? "暂停音频" : "播放音频"}
              onclick={toggleSelectedAudio}
            >
              <Icon name={$playingAudio?.id === d.id ? "pause" : "play"} size={12} />{$playingAudio?.id === d.id ? "暂停" : "播放"}
            </button>
            <button
              type="button"
              class="px-3 py-2 rounded-md border border-border hover:bg-surface-3 text-[12.5px] transition-colors"
              title="用系统播放器打开原文件"
              onclick={openSelectedAudioExternally}
            >
              系统播放器
            </button>
          </div>
        </section>

        <!-- 音频信息卡 -->
        <section class="bg-surface-2 border border-border rounded-md p-3">
          <h4 class="text-[11px] uppercase text-muted mb-2 tracking-wider">音频信息</h4>
          <dl class="space-y-1.5 text-[12px]">
            {#each audioInfoRows(d) as row}
              <div class="flex justify-between gap-2">
                <dt class="text-muted shrink-0">{row.label}</dt>
                <dd class="font-mono text-zinc-200 text-right truncate">{row.value}</dd>
              </div>
            {/each}
          </dl>
        </section>

        <!-- 文件夹（音频不做标签、没有 Prompt 可反推） -->
        <section>
          <MetadataCard
            tags={[]}
            folderIds={d.folder_ids}
            folders={$folders}
            path={d.path}
            onSwitchFolder={() => (showFolderPicker = true)}
            onRevealLocation={revealLocation}
            onCopyLocation={copyLocation}
          />
        </section>
        </div>
      {:else}
        <div class="detail-pane" id="detail-pane-detail" role="tabpanel" aria-labelledby="detail-tab-detail" hidden={detailTab !== "detail"}>
        <!-- 元数据：标签 + 文件夹 -->
        <section>
          <div class="flex items-center justify-between mb-1.5">
            <h4 class="text-[11px] uppercase text-muted tracking-wider">元数据</h4>
            <button
              type="button"
              class="text-[11px] text-muted hover:text-zinc-200 inline-flex min-h-6 items-center gap-1"
              onclick={() => (showTagInput = !showTagInput)}
            >
              <Icon name="plus" size={12} />标签
            </button>
          </div>
          {#if showTagInput}
            <div class="mb-2 bg-surface-2 border border-border rounded p-2">
              <input
                type="text"
                bind:value={tagInput}
                placeholder="多个标签用逗号分隔"
                class="w-full bg-bg border border-border rounded px-2 py-1 text-[12px] outline-none focus:border-accent"
                onkeydown={(e) => {
                  if (e.key === "Enter") saveTagInput();
                  if (e.key === "Escape") { showTagInput = false; tagInput = ""; }
                }}
                autofocus
              />
              <div class="flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  class="text-[12px] px-2 py-0.5 rounded border border-border"
                  onclick={() => { showTagInput = false; tagInput = ""; }}
                >取消</button>
                <button
                  type="button"
                  class="text-[12px] px-2 py-0.5 rounded bg-accent text-bg"
                  onclick={saveTagInput}
                >保存</button>
              </div>
            </div>
          {/if}
          <MetadataCard
            tags={d.tags}
            folderIds={d.folder_ids}
            folders={$folders}
            path={d.path}
            onTagClick={searchByTag}
            onRemoveTag={removeTag}
            onSwitchFolder={() => (showFolderPicker = true)}
            onRevealLocation={revealLocation}
            onCopyLocation={copyLocation}
          />
        </section>
        </div>
        <div class="detail-pane" id="detail-pane-prompt" role="tabpanel" aria-labelledby="detail-tab-prompt" hidden={detailTab !== "prompt"}>
        {#key d.id}<ReversePromptPanel imageId={d.id} />{/key}
        <!-- Prompt 卡片（正向 / 反向） -->
        <PromptCard
          title="正向 Prompt"
          text={d.positive_prompt}
          copyLabel="正向 Prompt"
          onCopy={(ok) => notify(ok ? "已复制 正向 Prompt" : "复制失败", ok ? "success" : "error")}
          initiallyExpanded
        />
        <PromptCard
          title="反向 Prompt"
          text={d.negative_prompt}
          copyLabel="反向 Prompt"
          onCopy={(ok) => notify(ok ? "已复制 反向 Prompt" : "复制失败", ok ? "success" : "error")}
        />
        </div>
        <div class="detail-pane" id="detail-pane-params" role="tabpanel" aria-labelledby="detail-tab-params" hidden={detailTab !== "params"}>
        <!-- 参数分组（含 LoRA） -->
        <section>
          <h4 class="text-[11px] uppercase text-muted mb-1.5 tracking-wider">生成参数</h4>
          <ParamsCard
            parameters={d.parameters}
            detail={{
              sampler: d.sampler,
              steps: d.steps,
              cfg: d.cfg,
              seed: d.seed,
              model: d.model,
              width: d.width,
              height: d.height,
            }}
            loras={loras}
            onCopy={(ok) => notify(ok ? "已复制" : "复制失败", ok ? "success" : "error")}
          />
        </section>

        <!-- Workflow JSON（默认折叠） -->
        {#if d.workflow}
          <WorkflowCard workflow={d.workflow} filename={d.filename} copy={copy} notify={notify} />
        {/if}
        </div>
      {/if}
        <div class="detail-pane" id="detail-pane-queue" role="tabpanel" aria-labelledby="detail-tab-queue" hidden={detailTab !== "queue"}>
        <CloneQueuePanel active={detailTab === "queue"} />
        </div>
    </div>

    <!-- ============== 操作条（常驻底部） ==============
         这三件事原来挤在头部右上角三颗 30px 图标里：「在 ComfyUI 中打开工作流」
         是整条链路最该被看见的动作，却和「复制路径」同一个视觉份量，
         而且面板一滚、头部内容一多就只能靠 hover 的 title 认。
         方案 3 把它按「头部说这是哪一张 / 中间是数据 / 底下才是能做的事」分开：
         操作条不跟着 body 滚，选任何一张，手都落在同一个位置。
         hover 仍然只改底色，不高亮边框——详情面板的交互件统一走这条规则。 -->
    <footer class="detail-dock" data-menu-root>
      <button
        type="button"
        class="dock-primary flex items-center gap-1.5 hover:bg-[var(--accent-strong)] transition-colors disabled:cursor-not-allowed"
        title={d.workflow ? "在 ComfyUI 中打开工作流" : noWorkflowText(d.kind)}
        aria-label="在 ComfyUI 中打开工作流"
        disabled={!d.workflow}
        onclick={openInComfyui}
      >
        <Icon name="comfyui" size={14} />
        <span>在 ComfyUI 打开</span>
      </button>
      {#if d.kind === "image"}
        <button
          type="button"
          class="dock-btn flex items-center gap-1.5 hover:bg-surface-3 transition-colors"
          title="采样、步数、种子、模型、LoRA 一次全复制走"
          aria-label="复制全部参数"
          onclick={() => copy(allParamsText(d), "全部参数")}
        >
          <Icon name="code" size={12} />
          <span>全部参数</span>
        </button>
      {/if}
      <div class="relative ml-auto">
        <button
          type="button"
          class="dock-btn flex items-center gap-1 hover:bg-surface-3 transition-colors"
          class:!border-accent={menuOpen}
          title="更多操作"
          aria-label="更多操作"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onclick={toggleMenu}
        >
          <Icon name="more-vertical" size={14} />
        </button>
        {#if menuOpen}
          <div
            class="dock-menu bg-surface-2 border border-border rounded-md py-1 min-w-[180px] shadow-lg"
            role="menu"
          >
            {#if d.kind === "image"}
            <button
              type="button"
              class="w-full text-left px-3 py-1.5 text-[12px] hover:bg-surface-3 flex items-center gap-2"
              role="menuitem"
              onclick={() => { copy(d.positive_prompt, "正向 Prompt"); closeMenu(); }}
            >
              <Icon name="copy" size={12} />复制正向 Prompt
            </button>
            <button
              type="button"
              class="w-full text-left px-3 py-1.5 text-[12px] hover:bg-surface-3 flex items-center gap-2"
              role="menuitem"
              onclick={() => { copy(d.negative_prompt, "反向 Prompt"); closeMenu(); }}
            >
              <Icon name="copy" size={12} />复制反向 Prompt
            </button>
            {#if d.seed !== null}
              <button
                type="button"
                class="w-full text-left px-3 py-1.5 text-[12px] hover:bg-surface-3 flex items-center gap-2"
                role="menuitem"
                onclick={() => { copy(String(d.seed), "Seed"); closeMenu(); }}
              >
                <Icon name="hash" size={12} />复制 Seed
              </button>
            {/if}
            <div class="border-t border-border my-1"></div>
            {/if}
            <button
              type="button"
              class="w-full text-left px-3 py-1.5 text-[12px] hover:bg-surface-3 flex items-center gap-2"
              role="menuitem"
              onclick={() => { copy(d.path, "路径"); closeMenu(); }}
            >
              <Icon name="external-link" size={12} />复制绝对路径
            </button>
            {#if d.kind === "image"}
            <button
              type="button"
              class="w-full text-left px-3 py-1.5 text-[12px] hover:bg-surface-3 flex items-center gap-2"
              role="menuitem"
              onclick={() => { openTagEditor(); closeMenu(); }}
            >
              <Icon name="tag" size={12} />编辑标签…
            </button>
            {/if}
          </div>
        {/if}
      </div>
    </footer>

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
  /* ---------- 底部操作条 ---------- */
  .detail-dock {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-top: 1px solid var(--line);
    background: var(--ink-1);
  }
  /* 主按钮：红底配墨底字，不用白字——白字压在 #f24e4e 上只有 3.1:1，
     墨底字是 12:1。全站红底按钮同一套（--accent-ink）。 */
  .dock-primary {
    height: var(--ctl-md);
    padding: 0 12px;
    border: 1px solid transparent;
    border-radius: var(--r-1);
    background: var(--accent);
    color: var(--accent-ink);
    font-size: var(--fs-sm);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  /* 没有工作流时别把红底按钮褪成四成——那看着像控件坏了。
     退成中性描边，读作「这一张没有可打开的工作流」，手仍然落在同一个位置。 */
  .dock-primary:disabled {
    background: transparent;
    border-color: var(--line);
    color: var(--text-3);
  }

  .dock-btn {
    height: var(--ctl-md);
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: var(--r-1);
    background: transparent;
    color: var(--text-2);
    font-size: var(--fs-sm);
    cursor: pointer;
    white-space: nowrap;
  }
  /* 菜单往上开：操作条贴着视口底边，再往下就掉出屏幕了。 */
  .dock-menu {
    position: absolute;
    right: 0;
    bottom: calc(100% + 6px);
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

  /* ---------- 分页条（方案 3 第三批，2026-11-11） ----------
     下划线式，不做成胶囊分段：顶栏的类型切换和设置页那个「第一行显示」是分段控件，
     说的是「同一组里挑一个值」；这四页是四种不同的东西，读法不一样，别混成同一种控件。
     选中只多一条朱红下划线——除了顶栏 TypeChips，全站不再多一处红底。 */
  .detail-tabs {
    flex: none;
    display: flex;
    align-items: stretch;
    gap: 14px;
    height: var(--ctl-lg);
    padding: 0 16px;
    border-bottom: 1px solid var(--line);
  }
  .detail-tab {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0;
    /* 无障碍：点击目标 24×24 起（WCAG 2.5.8）。页签之间本来空着 14px，宽出这 1px 碰不到邻位 */
    min-width: 24px;
    border: 0;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px; /* 压住容器那条 hairline，选中的下划线才不会浮在半空 */
    background: transparent;
    color: var(--text-3);
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  /* hover 只改字色，不画框：详情栏的交互件统一走这条 */
  .detail-tab:hover { color: var(--text-2); }
  .detail-tab.is-on { color: var(--text-1); border-bottom-color: var(--accent); }
  .detail-tab-count {
    min-width: 15px;
    padding: 0 4px;
    border-radius: var(--r-pill);
    background: var(--raise-2);
    color: var(--text-2);
    font-size: var(--fs-2xs);
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  /* 有任务在跑时这一页得自己会打招呼：人不在这一页也要知道右栏有活 */
  .detail-tab-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    animation: detail-tab-pulse 1.4s ease-in-out infinite;
  }
  @keyframes detail-tab-pulse {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .detail-tab-dot { animation: none; opacity: 1; }
  }
  /* 换页用 hidden 不用 {#if}（原因见 script 里那段）；display 显式写死，
     免得将来给 .detail-body 加 flex 之类的规则时悄悄失效。 */
  .detail-pane[hidden] { display: none; }

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
  header :global(button:focus-visible) {
    outline: 2px solid #f24e4e;
    outline-offset: 1px;
  }
</style>
