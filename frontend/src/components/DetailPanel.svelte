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
    feedItems,
    folders,
    refreshFolders,
    refreshSelectedDetail,
    playAudio,
    playingAudio,
    stopAudio,
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
  import FolderPickerModal from "./FolderPickerModal.svelte";
  import VideoCoverModal from "./VideoCoverModal.svelte";
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
          if ($selectedDetail) showTagInput = !showTagInput;
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

{#if !$selectedDetail}
  <div class="h-full flex items-center justify-center text-center text-muted p-8">
    <div>
      <div class="mb-3 opacity-50"><Icon name="arrow-left" size={36} /></div>
      <div class="text-[12.5px]">在中间选一张图片<br />查看详情和操作</div>
    </div>
  </div>
{:else}
  {@const d = $selectedDetail}
  <div class="h-full flex flex-col overflow-hidden">
    <!-- ============== Header ============== -->
    <header class="px-4 py-3 border-b border-border bg-surface-2 flex items-start gap-3 transition-colors">
      <button
        type="button"
        class="shrink-0 w-12 h-12 rounded-md overflow-hidden bg-surface-3 border border-border hover:bg-bg focus:outline-none focus:border-accent transition-colors"
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
            <Icon name="hash" size={10} />
            <span class="font-mono truncate" title={String(d.seed)}>{String(d.seed)}</span>
            <button
              type="button"
              class="opacity-50 hover:opacity-100 hover:text-accent"
              title="复制 seed"
              aria-label="复制 seed"
              onclick={() => copy(String(d.seed), "Seed")}
            >
              <Icon name="copy" size={10} />
            </button>
          </div>
        {/if}
      </div>

      <div class="shrink-0 flex items-center gap-1" data-menu-root>
        {#if d.kind === "video"}
          <button
            type="button"
            class="p-1.5 rounded border border-border hover:bg-surface-3 transition-colors"
            title="播放视频"
            aria-label="播放视频"
            onclick={playVideo}
          >
            <Icon name="play" size={14} />
          </button>
        {/if}
        <button
          type="button"
          class="p-1.5 rounded border border-border hover:bg-surface-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          title={d.workflow ? "在 ComfyUI 中打开工作流" : noWorkflowText(d.kind)}
          aria-label="在 ComfyUI 中打开工作流"
          disabled={!d.workflow}
          onclick={openInComfyui}
        >
          <Icon name="comfyui" size={14} />
        </button>
        <div class="relative">
          <button
            type="button"
            class="p-1.5 rounded border border-border hover:bg-surface-3 transition-colors"
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
              class="absolute right-0 top-full mt-1 z-30 bg-surface-2 border border-border rounded-md py-1 min-w-[180px] shadow-lg"
              role="menu"
            >
              {#if d.kind === "image"}
              <button
                type="button"
                class="w-full text-left px-3 py-1.5 text-[12px] hover:bg-surface-3 flex items-center gap-2"
                role="menuitem"
                onclick={() => { copy(d.positive_prompt, "正向 Prompt"); closeMenu(); }}
              >
                <Icon name="copy" size={11} />复制正向 Prompt
              </button>
              <button
                type="button"
                class="w-full text-left px-3 py-1.5 text-[12px] hover:bg-surface-3 flex items-center gap-2"
                role="menuitem"
                onclick={() => { copy(d.negative_prompt, "反向 Prompt"); closeMenu(); }}
              >
                <Icon name="copy" size={11} />复制反向 Prompt
              </button>
              {#if d.seed !== null}
                <button
                  type="button"
                  class="w-full text-left px-3 py-1.5 text-[12px] hover:bg-surface-3 flex items-center gap-2"
                  role="menuitem"
                  onclick={() => { copy(String(d.seed), "Seed"); closeMenu(); }}
                >
                  <Icon name="hash" size={11} />复制 Seed
                </button>
              {/if}
              <button
                type="button"
                class="w-full text-left px-3 py-1.5 text-[12px] hover:bg-surface-3 flex items-center gap-2"
                role="menuitem"
                onclick={() => { copy(allParamsText(d), "全部参数"); closeMenu(); }}
              >
                <Icon name="code" size={11} />复制全部参数
              </button>
              <div class="border-t border-border my-1"></div>
              {/if}
              <button
                type="button"
                class="w-full text-left px-3 py-1.5 text-[12px] hover:bg-surface-3 flex items-center gap-2"
                role="menuitem"
                onclick={() => { copy(d.path, "路径"); closeMenu(); }}
              >
                <Icon name="external-link" size={11} />复制绝对路径
              </button>
              {#if d.kind === "image"}
              <button
                type="button"
                class="w-full text-left px-3 py-1.5 text-[12px] hover:bg-surface-3 flex items-center gap-2"
                role="menuitem"
                onclick={() => { showTagInput = true; closeMenu(); }}
              >
                <Icon name="tag" size={11} />编辑标签…
              </button>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </header>

    <!-- ============== Body ============== -->
    <div class="flex-1 overflow-y-auto p-4 space-y-4 detail-body">
      {#if d.kind === "video"}
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
        {#if d.workflow}
          <WorkflowCard workflow={d.workflow} filename={d.filename} copy={copy} notify={notify} />
        {/if}

        <!-- AI 反推视频提示词（Seedance 2.0 / MiniMax H3） -->
        {#key d.id}
          <VideoPromptPanel videoId={d.id} filename={d.filename} durationSeconds={d.duration_seconds} />
        {/key}

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
      {:else if d.kind === "audio"}
        <!-- 音频：波形是懒生成 + 落盘缓存的预览，取不到就退回音符图形 -->
        <section class="bg-surface-2 border border-border rounded-md overflow-hidden">
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
              <Icon name="music" size={34} />
            {/if}
          </div>
          <div class="p-3 flex items-center gap-2">
            <button
              type="button"
              class="flex-1 px-3 py-2 rounded-md bg-accent/15 border border-accent/40 hover:bg-accent text-accent hover:text-white text-[12.5px] font-medium transition-colors flex items-center justify-center gap-1.5"
              title={$playingAudio?.id === d.id ? "暂停音频" : "播放音频"}
              onclick={toggleSelectedAudio}
            >
              <Icon name={$playingAudio?.id === d.id ? "pause" : "play"} size={11} />{$playingAudio?.id === d.id ? "暂停" : "播放"}
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
      {:else}
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

      <!-- 元数据：标签 + 文件夹 -->
      <section>
        <div class="flex items-center justify-between mb-1.5">
          <h4 class="text-[11px] uppercase text-muted tracking-wider">元数据</h4>
          <button
            type="button"
            class="text-[11px] text-muted hover:text-zinc-200 inline-flex items-center gap-1"
            onclick={() => (showTagInput = !showTagInput)}
          >
            <Icon name="plus" size={10} />标签
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

      <!-- Workflow JSON（默认折叠） -->
      {#if d.workflow}
        <WorkflowCard workflow={d.workflow} filename={d.filename} copy={copy} notify={notify} />
      {/if}
      {/if}
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
