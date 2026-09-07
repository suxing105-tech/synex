<script lang="ts">
  // 选择目标 user folder 的模态框。
  // - system folder 不会列出（物理镜像，不是用户整理目的地）
  // - 选项里始终包含「不分配 / 从文件夹移出」（value=null）
  // - 点击条目 / 按 Enter / 按 Esc 处理交给父组件（onPick / onClose）

  import type { FolderNode } from "../lib/types";
  import Icon from "./Icon.svelte";

  interface Props {
    open: boolean;
    folders: FolderNode[];          // 整个 tree，组件内部按 is_system 过滤
    title?: string;
    subtitle?: string;
    /** 选中某项；folder=null 表示「不分配」 */
    onPick: (folder: { id: number; name: string } | null) => void | Promise<void>;
    onClose: () => void;
  }
  let { open, folders, title = "移动到文件夹", subtitle, onPick, onClose }: Props = $props();

  // 把 tree 摊平成可选列表（DFS，按 name 排序），过滤掉 system folder。
  let flat = $derived.by(() => {
    const out: { id: number; name: string; depth: number }[] = [];
    const visit = (nodes: FolderNode[], depth: number) => {
      const sorted = [...nodes].sort((a, b) => a.name.localeCompare(b.name, "zh"));
      for (const n of sorted) {
        if (n.is_system) continue;
        out.push({ id: n.id, name: n.name, depth });
        visit(n.children, depth + 1);
      }
    };
    visit(folders, 0);
    return out;
  });

  // 当前高亮的项（键盘上下选）
  let selectedIdx = $state(0);

  // open 切换时重置选中
  $effect(() => {
    if (open) selectedIdx = 0;
  });

  let listEl: HTMLDivElement | null = $state(null);

  // 搜索：按 name 模糊匹配（不区分大小写）；空字符串不过滤
  let query = $state("");
  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return flat;
    return flat.filter((it) => it.name.toLowerCase().includes(q));
  });
  $effect(() => {
    // 搜索时重置高亮
    query;
    selectedIdx = 0;
  });

  async function pickItem(idx: number) {
    if (idx < 0 || idx >= filtered.length) return;
    const item = flat[idx];
    await onPick({ id: item.id, name: item.name });
    onClose();
  }

  async function pickNone() {
    await onPick(null);
    onClose();
  }

  function handleKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      // +1 因为第 0 项是「不分配」
      const max = filtered.length; // 含 null 项
      selectedIdx = Math.min(max - 1, selectedIdx + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIdx = Math.max(0, selectedIdx - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selectedIdx === 0) pickNone();
      else pickItem(selectedIdx - 1);
    }
  }
</script>

<svelte:window onkeydown={handleKey} />

{#if open}
  <div
    class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}
  >
    <div
      class="bg-surface-2 border border-border rounded-[10px] p-4 w-[420px] max-h-[80vh] flex flex-col"
      role="dialog"
      aria-modal="true"
    >
      <h3 class="text-sm font-medium mb-1">{title}</h3>
      {#if subtitle}
        <p class="text-[12px] text-muted mb-3">{subtitle}</p>
      {:else}
        <div class="mb-3"></div>
      {/if}

      <div class="relative mb-2">
        <input
          type="text"
          bind:value={query}
          placeholder="搜索文件夹…"
          class="w-full bg-bg border border-border rounded px-2 py-1 text-[12px] outline-none focus:border-accent pl-7"
          aria-label="搜索文件夹"
        />
        <span class="absolute left-2 top-1/2 -translate-y-1/2 text-muted pointer-events-none">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </span>
      </div>

      <div bind:this={listEl} class="flex-1 overflow-y-auto -mx-1 px-1">
        <button
          type="button"
          class="fp-item w-full text-left px-3 py-2 rounded-md {selectedIdx === 0 ? 'active' : ''}"
          onclick={pickNone}
        >
          <span class="fp-icon"><Icon name="circle-slash" size={13} /></span>
          <span class="fp-label">不分配 / 从文件夹移出</span>
        </button>
        {#if filtered.length === 0}
          <p class="text-[12px] text-muted px-2 py-3">还没有 user folder</p>
        {/if}
        {#each filtered as item, i (item.id)}
          <button
            type="button"
            class="fp-item w-full text-left px-3 py-2 rounded-md {selectedIdx === i + 1 ? 'active' : ''}"
            onclick={() => pickItem(i)}
          >
            <span class="fp-spacer" style="width: {item.depth * 14}px"></span>
            <span class="fp-icon"><Icon name="folder" size={13} /></span>
            <span class="fp-label">{item.name}</span>
          </button>
        {/each}
      </div>

      <div class="flex justify-end gap-2 mt-3 pt-3 border-t border-border">
        <button
          type="button"
          class="text-[12px] px-3 py-1 rounded border border-border hover:border-accent"
          onclick={onClose}
        >
          取消
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .fp-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    cursor: pointer;
    color: #e4e4e7;
  }
  .fp-item:hover {
    background: #27272a;
  }
  .fp-item.active {
    background: #27272a;
    color: #f24e4e;
  }
  .fp-icon {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    opacity: 0.85;
  }
  .fp-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fp-spacer {
    display: inline-block;
    flex-shrink: 0;
  }
</style>