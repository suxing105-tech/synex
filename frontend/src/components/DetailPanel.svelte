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
   *     ├─ MetadataCard（标签 + 文件夹）
   *     └─ Workflow JSON（默认折叠）
   *
   * 与外部交互：
   *   - 缩略图点击 → dispatch "open-lightbox" CustomEvent（App.svelte 监听）
   *   - 标签点击 → dispatch "open-tag-search" CustomEvent
   */

  import { get } from "svelte/store";
  import {
    selectedDetail,
    folders,
    refreshFolders,
  } from "../lib/stores";
  import { imagesApi } from "../lib/api";
  import { copyText, formatSize, formatDate, allParamsText } from "../lib/ws";
  import { pushToast } from "../lib/toast";
  import { extractLoras } from "../lib/params";
  import type { ImageDetail, FolderNode } from "../lib/types";
  import Icon from "./Icon.svelte";
  import PromptCard from "./PromptCard.svelte";
  import ReversePromptPanel from "./ReversePromptPanel.svelte";
  import ParamsCard from "./ParamsCard.svelte";
  import MetadataCard from "./MetadataCard.svelte";
  import FolderPickerModal from "./FolderPickerModal.svelte";

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
    await imagesApi.assignFolder(d.id, fid);
    selectedDetail.set({
      ...d,
      folder_ids: fid === null ? [] : [fid],
    });
    await refreshFolders();
    notify(node ? `已切换到「${node.name}」` : "已移出文件夹");
  }

  // ---------- 收藏 ----------
  async function toggleFav() {
    const d = $selectedDetail;
    if (!d) return;
    const fav = !d.favorite;
    await imagesApi.toggleFavorite(d.id, fav);
    selectedDetail.set({ ...d, favorite: fav });
    notify(fav ? "已加入收藏" : "已取消收藏");
  }

  // ---------- ComfyUI ----------
  import { comfyuiStatus } from "../lib/stores";
  import { comfyuiApi } from "../lib/api";
  import { openOrReuseComfyuiTab } from "../lib/comfyui-window";
  import { registerShortcuts } from "../lib/shortcuts";
  import { onMount, onDestroy } from "svelte";

  async function openInComfyui() {
    const det = get(selectedDetail);
    if (!det) return;
    openOrReuseComfyuiTab($comfyuiStatus.url || "http://127.0.0.1:8188");
    try {
      const r = await comfyuiApi.openWorkflow(det.id);
      notify(`${r.workflow_name}.json 已写入 ${r.file_path}`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      const detail = m.match(/→ \d+: (.+)$/)?.[1] || m;
      notify(`在 ComfyUI 中打开失败：${detail}`);
    }
  }

  // ---------- 派生 ----------
  const loras = $derived(
    $selectedDetail
      ? extractLoras($selectedDetail.positive_prompt, $selectedDetail.parameters)
      : [],
  );

  const workflowBytes = $derived(
    $selectedDetail?.workflow ? new Blob([$selectedDetail.workflow]).size : 0,
  );
  const workflowNodes = $derived(
    $selectedDetail?.workflow
      ? (countWorkflowNodes($selectedDetail.workflow))
      : 0,
  );
  function countWorkflowNodes(json: string): number {
    try {
      const o = JSON.parse(json);
      if (o && typeof o === "object") {
        // ComfyUI workflow 用 "nodes" 数组；API 格式用对象键
        if (Array.isArray(o.nodes)) return o.nodes.length;
        return Object.keys(o).length;
      }
    } catch {}
    return 0;
  }

  // 缩略图 URL：优先用 ?max=256 拿预览，没有就 null（让 alt 显示占位）
  function thumbUrl(d: ImageDetail): string | null {
    if (!d.original_url) return null;
    const sep = d.original_url.includes("?") ? "&" : "?";
    return backendUrl(`${d.original_url}${sep}max=256`);
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
        key: "p",
        handler: () => {
          const d = $selectedDetail;
          if (!d) return;
          copy(d.positive_prompt, "正向 Prompt");
        },
      },
      {
        key: "n",
        handler: () => {
          const d = $selectedDetail;
          if (!d) return;
          copy(d.negative_prompt, "反向 Prompt");
        },
      },
      {
        key: "s",
        handler: () => {
          const d = $selectedDetail;
          if (!d || d.seed == null) return;
          copy(String(d.seed), "Seed");
        },
      },
      {
        key: "shift+c",
        handler: () => {
          if ($selectedDetail) openInComfyui();
        },
      },
      {
        key: "f",
        handler: () => {
          if ($selectedDetail) toggleFav();
        },
      },
      {
        key: "t",
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
    <header class="px-4 py-3 border-b border-border bg-surface-2 flex items-start gap-3">
      <button
        type="button"
        class="shrink-0 w-12 h-12 rounded-md overflow-hidden bg-surface-3 border border-border hover:bg-bg focus:outline-none focus:border-accent"
        title="查看大图"
        aria-label="查看大图"
        onclick={() => openLightbox(d)}
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
            <Icon name="image" size={20} />
          </div>
        {/if}
      </button>

      <div class="flex-1 min-w-0">
        <div class="text-[13px] font-mono font-semibold truncate" title={d.filename}>{d.filename}</div>
        <div class="text-[11px] text-muted mt-0.5 flex gap-2 flex-wrap">
          {#if d.width && d.height}<span>{d.width}×{d.height}</span>{/if}
          <span>{formatSize(d.size_bytes)}</span>
          <span>{formatDate(d.mtime)}</span>
        </div>
        {#if d.seed !== null}
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
        <button
          type="button"
          class="p-1.5 rounded border border-border hover:bg-surface-3"
          class:!border-danger={d.favorite}
          class:text-danger={d.favorite}
          title={d.favorite ? "取消收藏" : "加入收藏"}
          aria-label={d.favorite ? "取消收藏" : "加入收藏"}
          aria-pressed={d.favorite}
          onclick={toggleFav}
        >
          <Icon name={d.favorite ? "heart-fill" : "heart"} size={14} />
        </button>
        <button
          type="button"
          class="p-1.5 rounded border border-border hover:bg-surface-3"
          title="在 ComfyUI 中打开"
          aria-label="在 ComfyUI 中打开"
          onclick={openInComfyui}
        >
          <Icon name="comfyui" size={14} />
        </button>
        <div class="relative">
          <button
            type="button"
            class="p-1.5 rounded border border-border hover:bg-surface-3"
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
              <button
                type="button"
                class="w-full text-left px-3 py-1.5 text-[12px] hover:bg-surface-3 flex items-center gap-2"
                role="menuitem"
                onclick={() => { copy(d.path, "路径"); closeMenu(); }}
              >
                <Icon name="external-link" size={11} />复制绝对路径
              </button>
              <button
                type="button"
                class="w-full text-left px-3 py-1.5 text-[12px] hover:bg-surface-3 flex items-center gap-2"
                role="menuitem"
                onclick={() => { showTagInput = true; closeMenu(); }}
              >
                <Icon name="tag" size={11} />编辑标签…
              </button>
            </div>
          {/if}
        </div>
      </div>
    </header>

    <!-- ============== Body ============== -->
    <div class="flex-1 overflow-y-auto p-4 space-y-4 detail-body">
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
          onTagClick={searchByTag}
          onRemoveTag={removeTag}
          onSwitchFolder={() => (showFolderPicker = true)}
        />
      </section>

      <!-- Workflow JSON（默认折叠） -->
      {#if d.workflow}
        <section>
          <h4 class="text-[11px] uppercase text-muted mb-1.5 tracking-wider">Workflow JSON</h4>
          <details class="bg-surface-2 border border-border rounded-md">
            <summary class="cursor-pointer text-[12px] text-muted hover:text-zinc-200 px-2 py-1.5 flex items-center gap-2 select-none">
              <Icon name="chevron-right" size={11} />
              <span class="flex-1">
                {workflowNodes > 0 ? `${workflowNodes} 节点` : "查看"}
                {#if workflowBytes > 0}
                  · {(workflowBytes / 1024).toFixed(1)} KB
                {/if}
              </span>
            </summary>
            <div class="px-2 pb-2 flex items-center gap-1">
              <button
                type="button"
                class="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-surface-3 inline-flex items-center gap-1"
                onclick={() => copy(d.workflow, "Workflow JSON")}
              >
                <Icon name="copy" size={10} />复制
              </button>
              <button
                type="button"
                class="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-surface-3 inline-flex items-center gap-1"
                onclick={() => {
                  try {
                    const formatted = JSON.stringify(JSON.parse(d.workflow), null, 2);
                    navigator.clipboard?.writeText(formatted).then(
                      () => notify("已复制（格式化后）"),
                      () => notify("复制失败"),
                    );
                  } catch {
                    notify("JSON 解析失败");
                  }
                }}
              >
                <Icon name="code" size={10} />格式化并复制
              </button>
              <button
                type="button"
                class="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-surface-3 inline-flex items-center gap-1"
                onclick={() => {
                  const blob = new Blob([d.workflow], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${d.filename.replace(/\.[^.]+$/, "")}.workflow.json`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                }}
              >
                <Icon name="download" size={10} />下载
              </button>
            </div>
            <pre class="prompt-box border-t border-border p-2 max-h-48 overflow-y-auto">{d.workflow}</pre>
          </details>
        </section>
      {/if}
    </div>
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
