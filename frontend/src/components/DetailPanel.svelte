<script lang="ts">
  import { selectedDetail, folders, refreshFolders , comfyuiStatus } from "../lib/stores";
  import { imagesApi, foldersApi , comfyuiApi } from "../lib/api";
  import { copyText, formatSize, formatDate, paramsToKv, allParamsText } from "../lib/ws";
  import type { ImageDetail, FolderNode } from "../lib/types";
  import Icon from "./Icon.svelte";
  import { get } from "svelte/store";

  let toast = $state<string | null>(null);
  let tagInput = $state<string>("");
  let showTagInput = $state<boolean>(false);
  let showFolderPicker = $state<boolean>(false);

  async function openInComfyui() {
    const det = get(selectedDetail);
    if (!det) return;
    try {
      const r = await comfyuiApi.openWorkflow(det.id);
      notify(r.message || `已生成 ${r.file_path}`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      const detail = m.match(/→ \d+: (.+)$/)?.[1] || m;
      notify(`在 ComfyUI 中打开失败：${detail}`);
    }
  }

  function notify(msg: string) {
    toast = msg;
    setTimeout(() => (toast = null), 1500);
  }

  async function copy(text: string, label: string) {
    const ok = await copyText(text);
    notify(ok ? `已复制 ${label}` : "复制失败");
  }

  async function toggleFav() {
    const d = $selectedDetail;
    if (!d) return;
    const fav = !d.favorite;
    await imagesApi.toggleFavorite(d.id, fav);
    selectedDetail.set({ ...d, favorite: fav });
    notify(fav ? "已加入收藏" : "已取消收藏");
  }

  async function saveTagInput() {
    const d = $selectedDetail;
    if (!d) return;
    const tags = tagInput
      .split(/[,，]/)
      .map((t) => t.trim().replace(/^#/, ""))
      .filter(Boolean);
    if (tags.length === 0) {
      showTagInput = false;
      return;
    }
    const resp = await imagesApi.setTags(d.id, tags);
    selectedDetail.set({ ...d, tags: resp.tags });
    tagInput = "";
    showTagInput = false;
    notify("标签已保存");
  }

  async function removeTag(tag: string) {
    const d = $selectedDetail;
    if (!d) return;
    const next = d.tags.filter((t) => t !== tag);
    const resp = await imagesApi.setTags(d.id, next);
    selectedDetail.set({ ...d, tags: resp.tags });
  }

  async function assignFolder(folderId: number | null) {
    const d = $selectedDetail;
    if (!d) return;
    await imagesApi.assignFolder(d.id, folderId);
    selectedDetail.set({ ...d, folder_ids: folderId === null ? [] : [folderId] });
    showFolderPicker = false;
    notify(folderId === null ? "已移出文件夹" : "已切换文件夹");
    await refreshFolders();
  }

  function flatten(nodes: FolderNode[], depth = 0): { node: FolderNode; depth: number }[] {
    const out: { node: FolderNode; depth: number }[] = [];
    for (const n of nodes) {
      out.push({ node: n, depth });
      out.push(...flatten(n.children, depth + 1));
    }
    return out;
  }
</script>

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
    <div class="px-5 py-4 border-b border-border bg-surface-2">
      <div class="text-[13px] font-mono font-semibold truncate" title={d.filename}>{d.filename}</div>
      <div class="text-[11px] text-muted mt-1 flex gap-3">
        {#if d.width && d.height}<span>{d.width}×{d.height}</span>{/if}
        <span>{formatSize(d.size_bytes)}</span>
        <span>{formatDate(d.mtime)}</span>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto p-4 space-y-4">
      <!-- 快捷复制条 -->
      <div class="flex flex-wrap gap-1.5">
        <button class="px-2 py-1 text-[11px] rounded border border-border hover:border-accent" onclick={() => copy(d.positive_prompt, "正向 Prompt")}>＋ Prompt</button>
        <button class="px-2 py-1 text-[11px] rounded border border-border hover:border-accent" onclick={() => copy(d.negative_prompt, "反向 Prompt")}>－ Prompt</button>
        <button class="px-2 py-1 text-[11px] rounded border border-border hover:border-accent" onclick={() => copy(String(d.seed ?? ""), "Seed")}># Seed</button>
        <button class="px-2 py-1 text-[11px] rounded border border-border hover:border-accent" onclick={() => copy(allParamsText(d), "完整参数")}>所有参数</button>
        <button class="px-2 py-1 text-[11px] rounded border border-border hover:border-accent" onclick={() => copy(d.workflow || "", "Workflow JSON")}>Workflow</button>
        <button
          class="px-2 py-1 text-[11px] rounded border border-border hover:border-accent disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
          disabled={!$comfyuiStatus.running || !d.workflow}
          onclick={openInComfyui}
          title={!d.workflow ? "该图片没有 ComfyUI 工作流" : !$comfyuiStatus.running ? "未检测到 ComfyUI" : "在 ComfyUI 中打开工作流"}
        >
          <Icon name="comfyui" size={12} />
          <span>在 ComfyUI 中打开</span>
        </button>
      </div>

      <!-- 正向 Prompt -->
      <section>
        <h4 class="text-[11px] uppercase text-muted mb-1.5 tracking-wider">正向 Prompt</h4>
        <div class="prompt-box bg-surface-2 border border-border rounded-md p-2 max-h-48 overflow-y-auto">{d.positive_prompt || "—"}</div>
      </section>

      <!-- 反向 Prompt -->
      {#if d.negative_prompt}
        <section>
          <h4 class="text-[11px] uppercase text-muted mb-1.5 tracking-wider">反向 Prompt</h4>
          <div class="prompt-box bg-surface-2 border border-border rounded-md p-2 max-h-32 overflow-y-auto">{d.negative_prompt}</div>
        </section>
      {/if}

      <!-- 参数 -->
      <section>
        <h4 class="text-[11px] uppercase text-muted mb-1.5 tracking-wider">生成参数</h4>
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          {#each paramsToKv(d.parameters) as [k, v]}
            <dt class="text-muted">{k}</dt>
            <dd class="font-mono break-all">{v}</dd>
          {/each}
          {#if d.seed !== null}
            <dt class="text-muted">seed</dt>
            <dd class="font-mono">{d.seed}</dd>
          {/if}
        </dl>
      </section>

      <!-- 收藏 / 标签 -->
      <section>
        <div class="flex items-center gap-2 flex-wrap">
          <button class="px-2 py-1 text-[12px] rounded border border-border hover:border-accent" class:!border-danger={d.favorite} class:!text-danger={d.favorite} onclick={toggleFav}>{d.favorite ? "♥ 已收藏" : "♡ 收藏"}</button>
          <button class="px-2 py-1 text-[12px] rounded border border-border hover:border-accent" onclick={() => (showTagInput = !showTagInput)}>＋ 标签</button>
        </div>
        {#if d.tags.length > 0}
          <div class="flex flex-wrap gap-1 mt-2">
            {#each d.tags as t}
              <span class="inline-flex items-center gap-1 bg-surface-2 border border-border rounded-full px-2 py-0.5 text-[11px]">
                {t}
                <button class="text-muted hover:text-danger" onclick={() => removeTag(t)} title="删除">×</button>
              </span>
            {/each}
          </div>
        {/if}
        {#if showTagInput}
          <div class="mt-2">
            <input
              type="text"
              bind:value={tagInput}
              placeholder="多个标签用逗号分隔"
              class="w-full bg-bg border border-border rounded px-2 py-1 text-[12px] outline-none focus:border-accent"
              onkeydown={(e) => {
                if (e.key === 'Enter') saveTagInput();
                if (e.key === 'Escape') { showTagInput = false; tagInput = ''; }
              }}
              autofocus
            />
            <div class="flex justify-end gap-2 mt-2">
              <button class="text-[12px] px-2 py-0.5 rounded border border-border" onclick={() => { showTagInput = false; tagInput = ''; }}>取消</button>
              <button class="text-[12px] px-2 py-0.5 rounded bg-accent text-bg" onclick={saveTagInput}>保存</button>
            </div>
          </div>
        {/if}
      </section>

      <!-- 所属文件夹 -->
      <section>
        <div class="flex items-center justify-between">
          <h4 class="text-[11px] uppercase text-muted tracking-wider">所属文件夹</h4>
          <button class="text-[11px] text-muted hover:text-zinc-200" onclick={() => (showFolderPicker = !showFolderPicker)}>切换</button>
        </div>
        <div class="mt-2 text-[12px] text-zinc-200">
          {#if d.folder_ids.length === 0}
            <span class="text-muted">未分类</span>
          {:else}
            {#each d.folder_ids as fid}
              {@const node = $folders.find((f) => f.id === fid)}
              {#if node}
                <span class="inline-block bg-surface-2 border border-border rounded px-2 py-0.5 mr-1 mb-1">{node.name}</span>
              {/if}
            {/each}
          {/if}
        </div>
        {#if showFolderPicker}
          <div class="mt-2 bg-surface-2 border border-border rounded p-2 max-h-48 overflow-y-auto text-[12px]">
            <button class="block w-full text-left px-2 py-1 hover:bg-surface-3 rounded text-muted" onclick={() => assignFolder(null)}>未分类</button>
            {#each flatten($folders) as { node, depth }}
              <button
                class="block w-full text-left px-2 py-1 hover:bg-surface-3 rounded"
                style="padding-left: {depth * 12 + 8}px"
                onclick={() => assignFolder(node.id)}
              >
                {node.name} <span class="text-muted">({node.recursive_count})</span>
              </button>
            {/each}
            {#if $folders.length === 0}
              <div class="text-muted px-2 py-1">还没有自定义文件夹</div>
            {/if}
          </div>
        {/if}
      </section>

      <!-- Workflow JSON -->
      {#if d.workflow}
        <section>
          <h4 class="text-[11px] uppercase text-muted mb-1.5 tracking-wider">Workflow JSON</h4>
          <details>
            <summary class="text-[12px] text-muted cursor-pointer hover:text-zinc-200">展开查看</summary>
            <pre class="prompt-box bg-surface-2 border border-border rounded-md p-2 max-h-48 overflow-y-auto mt-1">{d.workflow}</pre>
          </details>
        </section>
      {/if}
    </div>
  </div>
{/if}

{#if toast}
  <div class="toast">{toast}</div>
{/if}
