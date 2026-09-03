<script lang="ts">
  import { folders, folderId, view, stats } from "../lib/stores";
  import Icon from "./Icon.svelte";
  import type { FolderNode } from "../lib/types";
  import { foldersApi } from "../lib/api";
  import { refreshFolders } from "../lib/stores";

  let menuFor = $state<number | null>(null);
  let menuPos = $state<{ x: number; y: number }>({ x: 0, y: 0 });
  let renameFor = $state<number | null>(null);
  let renameValue = $state("");
  let newFolderFor = $state<{ parent: number | null } | null>(null);
  let newFolderName = $state("");

  function findNode(nodes: FolderNode[], id: number): FolderNode | null {
    for (const n of nodes) {
      if (n.id === id) return n;
      const f = findNode(n.children, id);
      if (f) return f;
    }
    return null;
  }

  function setView(v: "all" | "favorite" | "recent") {
    view.set(v);
    folderId.set(null);
  }

  function pickFolder(f: FolderNode) {
    view.set("all");
    folderId.set(f.id);
  }

  function openMenu(id: number, e: MouseEvent) {
    e.stopPropagation();
    if (menuFor === id) {
      menuFor = null;
      return;
    }
    menuFor = id;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menuPos = { x: rect.right, y: rect.bottom };
  }

  function startRename(id: number, name: string) {
    renameFor = id;
    renameValue = name;
    menuFor = null;
  }

  async function submitRename() {
    if (!renameFor) return;
    const name = renameValue.trim();
    if (name) await foldersApi.rename(renameFor, name);
    renameFor = null;
    renameValue = "";
    await refreshFolders();
  }

  async function move(id: number, direction: "up" | "down") {
    await foldersApi.move(id, direction);
    menuFor = null;
    await refreshFolders();
  }

  async function remove(id: number) {
    if (!confirm("删除此文件夹？其中的图片将升级到上一级。")) return;
    await foldersApi.remove(id);
    menuFor = null;
    if ($folderId === id) folderId.set(null);
    await refreshFolders();
  }

  function startNew(parent: number | null) {
    newFolderFor = { parent };
    newFolderName = "";
  }

  async function submitNewFolder() {
    const name = newFolderName.trim();
    if (!name) {
      newFolderFor = null;
      return;
    }
    await foldersApi.create(name, newFolderFor?.parent ?? null);
    newFolderFor = null;
    newFolderName = "";
    await refreshFolders();
  }

  function closeAll() {
    menuFor = null;
    newFolderFor = null;
    renameFor = null;
  }
</script>

<svelte:window onclick={closeAll} />

<div class="px-[14px] pt-[14px] pb-[8px] flex items-center justify-between">
  <h3 class="text-[11px] uppercase text-muted tracking-wider">文件夹</h3>
  <button class="bg-transparent border border-border text-muted w-6 h-6 rounded-[5px] hover:border-accent hover:text-zinc-200 flex items-center justify-center" onclick={(e) => { e.stopPropagation(); startNew(null); }} title="在根目录新建文件夹"><Icon name="plus" size={12} /></button>
</div>
<div class="flex-1 overflow-y-auto px-2 pb-3">
  <div class="text-[10px] uppercase text-muted tracking-wider px-[10px] py-[10px] opacity-70">系统</div>
  <div class="folder-item {$view === 'all' && $folderId === null ? 'active' : ''}" onclick={() => { view.set('all'); folderId.set(null); }}>
    <span class="caret-spacer"></span>
    <span class="icon"><Icon name="image" size={13} /></span>
    <span class="label">全部图片</span>
    <span class="count">{$stats.total_images}</span>
  </div>
  <div class="folder-item {$view === 'favorite' ? 'active' : ''}" onclick={() => setView("favorite")}>
    <span class="caret-spacer"></span>
    <span class="icon"><Icon name="star" size={13} /></span>
    <span class="label">收藏</span>
    <span class="count">{$stats.favorites}</span>
  </div>
  <div class="folder-item {$view === 'recent' ? 'active' : ''}" onclick={() => setView("recent")}>
    <span class="caret-spacer"></span>
    <span class="icon"><Icon name="clock" size={13} /></span>
    <span class="label">最近生成</span>
    <span class="count"></span>
  </div>

  <div class="flex items-center justify-between px-[10px] pt-[14px] pb-[4px]">
    <div class="text-[10px] uppercase text-muted tracking-wider opacity-70">我的文件夹</div>
    <button class="bg-transparent border-0 text-muted text-[12px] hover:text-zinc-200" onclick={(e) => { e.stopPropagation(); startNew(null); }} title="新建文件夹"><Icon name="plus" size={12} /></button>
  </div>

  {#if $folders.length === 0}
    <div class="text-[12px] text-muted px-3 py-2">还没有文件夹</div>
  {/if}

  {#each $folders as f (f.id)}
    {@render folderItem(f, 0)}
  {/each}
</div>
<div class="border-t border-border px-4 py-[10px] text-[11px] text-muted flex justify-between">
  <span>{$stats.total_images} 张图片</span>
  <span>本地存储</span>
</div>

{#if newFolderFor !== null}
  <div class="fixed inset-0 bg-black/60 flex items-center justify-center z-50" role="presentation" onclick={closeAll}>
    <div class="bg-surface-2 border border-border rounded-[10px] p-5 w-[360px]" onclick={(e) => e.stopPropagation()}>
      <h3 class="text-sm font-medium mb-3">{newFolderFor.parent === null ? "新建根文件夹" : "新建子文件夹"}</h3>
      <input
        type="text"
        bind:value={newFolderName}
        class="w-full bg-bg border border-border rounded px-2 py-1 text-[13px] outline-none focus:border-accent"
        placeholder="名称"
        onkeydown={(e) => {
          if (e.key === 'Enter') submitNewFolder();
          if (e.key === 'Escape') closeAll();
        }}
        autofocus
      />
      <div class="flex justify-end gap-2 mt-3">
        <button class="text-[12px] px-3 py-1 rounded border border-border hover:border-accent" onclick={closeAll}>取消</button>
        <button class="text-[12px] px-3 py-1 rounded bg-accent text-bg font-medium" onclick={submitNewFolder}>创建</button>
      </div>
    </div>
  </div>
{/if}

{#if renameFor !== null}
  <div class="fixed inset-0 bg-black/60 flex items-center justify-center z-50" role="presentation" onclick={closeAll}>
    <div class="bg-surface-2 border border-border rounded-[10px] p-5 w-[360px]" onclick={(e) => e.stopPropagation()}>
      <h3 class="text-sm font-medium mb-3">重命名文件夹</h3>
      <input
        type="text"
        bind:value={renameValue}
        class="w-full bg-bg border border-border rounded px-2 py-1 text-[13px] outline-none focus:border-accent"
        onkeydown={(e) => {
          if (e.key === 'Enter') submitRename();
          if (e.key === 'Escape') closeAll();
        }}
        autofocus
      />
      <div class="flex justify-end gap-2 mt-3">
        <button class="text-[12px] px-3 py-1 rounded border border-border hover:border-accent" onclick={closeAll}>取消</button>
        <button class="text-[12px] px-3 py-1 rounded bg-accent text-bg font-medium" onclick={submitRename}>保存</button>
      </div>
    </div>
  </div>
{/if}

{#if menuFor !== null}
  <div
    class="folder-menu fixed bg-surface-2 border border-border rounded-[8px] py-1 min-w-[140px] z-40 text-[13px] shadow-xl"
    style="left: {menuPos.x}px; top: {menuPos.y}px;"
    role="menu"
    onclick={(e) => e.stopPropagation()}
  >
    <button class="block w-full text-left px-3 py-1 hover:bg-surface-3" onclick={() => {
      const node = findNode($folders, menuFor!);
      if (node) startRename(menuFor!, node.name);
    }}>重命名</button>
    <button class="block w-full text-left px-3 py-1 hover:bg-surface-3" onclick={() => menuFor !== null && move(menuFor, "up")}>上移</button>
    <button class="block w-full text-left px-3 py-1 hover:bg-surface-3" onclick={() => menuFor !== null && move(menuFor, "down")}>下移</button>
    <button class="block w-full text-left px-3 py-1 hover:bg-surface-3" onclick={() => menuFor !== null && startNew(menuFor)}>新建子文件夹</button>
    <div class="border-t border-border my-1"></div>
    <button class="block w-full text-left px-3 py-1 hover:bg-danger/30 text-danger" onclick={() => menuFor !== null && remove(menuFor)}>删除</button>
  </div>
{/if}

{#snippet folderItem(folder: FolderNode, depth: number)}
  <div class="folder-item {$folderId === folder.id ? 'active' : ''}" onclick={() => pickFolder(folder)}>
    <span class="caret-spacer" style="width: {depth * 14 + 12}px"></span>
    <span class="icon"><Icon name="folder" size={13} /></span>
    <span class="label">{folder.name}</span>
    <span class="count">{folder.recursive_count}</span>
    <button class="menu-btn" onclick={(e) => openMenu(folder.id, e)}><Icon name="more-vertical" size={14} /></button>
  </div>
  {#each folder.children as child (child.id)}
    {@render folderItem(child, depth + 1)}
  {/each}
{/snippet}

<style>
  :global(.folder-item) {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    position: relative;
    user-select: none;
  }
  :global(.folder-item:hover) {
    background: #27272a;
  }
  :global(.folder-item.active) {
    background: #27272a;
    color: #f24e4e;
  }
  :global(.folder-item.active::before) {
    content: "";
    position: absolute;
    left: 0;
    top: 4px;
    bottom: 4px;
    width: 2px;
    background: #f24e4e;
    border-radius: 1px;
  }
  :global(.folder-item .icon) {
    font-size: 13px;
    opacity: 0.85;
    flex-shrink: 0;
  }
  :global(.folder-item .label) {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  :global(.folder-item .count) {
    font-size: 11px;
    color: #8a8a8e;
    flex-shrink: 0;
  }
  :global(.folder-item.active .count) {
    color: #f24e4e;
  }
  :global(.folder-item .menu-btn) {
    opacity: 0;
    background: transparent;
    border: none;
    color: #8a8a8e;
    cursor: pointer;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 13px;
  }
  :global(.folder-item:hover .menu-btn) {
    opacity: 1;
  }
  :global(.folder-item .menu-btn:hover) {
    background: #323237;
    color: #e4e4e7;
  }
  :global(.caret-spacer) {
    display: inline-block;
    flex-shrink: 0;
  }
</style>
