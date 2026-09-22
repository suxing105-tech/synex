<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { subscribeFileDrop } from '../lib/native-drop';
  import { pushToast } from "../lib/toast";
  import { backendUrl } from "../lib/backend-url";
  import { folders, folderId, view, stats, kind, query, tag } from "../lib/stores";
  import Icon from "./Icon.svelte";
  import type { FolderNode } from "../lib/types";
  import { foldersApi } from "../lib/api";
  import { refreshFolders, refreshFeed, refreshStats } from "../lib/stores";

  let sidebarRegion: HTMLDivElement;
  let externalHover = $state(0);
  let importingFolders = $state(false);
  onMount(() => subscribeFileDrop(() => sidebarRegion, count => externalHover = count, async paths => {
    if (importingFolders) return;
    importingFolders = true;
    try {
      const result = await foldersApi.importDirectories(paths);
      await refreshFolders();
      if (result.moved.length) {
        view.set('all'); folderId.set(result.moved[0].id);
        await Promise.all([refreshFeed(), refreshStats()]);
        pushToast(`已完整移动 ${result.moved.length} 个文件夹到我的文件夹`);
      }
      for (const failure of [...result.failed, ...result.warnings]) {
        pushToast(`${failure.path}：${failure.reason}`, { kind: 'error' });
      }
    } catch (error) {
      pushToast(`文件夹导入失败：${error instanceof Error ? error.message : error}`, { kind: 'error' });
      await Promise.allSettled([refreshFolders(), refreshFeed(), refreshStats()]);
    } finally { importingFolders = false; }
  }));

  let { oncollapse = () => {} }: { oncollapse?: () => void } = $props();

  let menuFor = $state<number | null>(null);
  let blankMenu = $state(false);
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

  let collapsed = $state<Set<number>>(new Set());
  let clickTimer: ReturnType<typeof setTimeout> | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let pressed: { folder: FolderNode; x: number; y: number } | null = null;
  let dragging = $state<FolderNode | null>(null);
  let drop = $state<{ id: number | null; position: "before" | "after" | "inside" | "root" } | null>(null);
  let suppressClick = false;
  let saving = $state(false);

  function pickFolder(f: FolderNode) {
    view.set("all");
    folderId.set(f.id);
    const next = new Set(collapsed);
    if (next.has(f.id)) next.delete(f.id);
    else next.add(f.id);
    collapsed = next;
  }

  function clickFolder(f: FolderNode, e: MouseEvent) {
    e.stopPropagation();
    if (suppressClick) { suppressClick = false; return; }
    clearTimeout(clickTimer);
    if (e.detail > 1) return;
    clickTimer = setTimeout(() => pickFolder(f), 280);
  }

  function doubleClickFolder(f: FolderNode, e: MouseEvent) {
    e.stopPropagation();
    clearTimeout(clickTimer);
    cancelDrag();
    startRename(f.id, f.name);
  }

  function pressFolder(f: FolderNode, e: PointerEvent) {
    if (e.button !== 0 || saving || (e.target as HTMLElement).closest('button, input')) return;
    cancelDrag();
    suppressClick = false;
    pressed = { folder: f, x: e.clientX, y: e.clientY };
    holdTimer = setTimeout(() => {
      clearTimeout(clickTimer);
      dragging = f;
      suppressClick = true;
      menuFor = null;
    }, 450);
  }

  function pointerMove(e: PointerEvent) {
    if (!pressed) return;
    if (!dragging) {
      if (Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > 8) cancelDrag();
      return;
    }
    e.preventDefault();
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const row = hit?.closest<HTMLElement>('[data-folder-id]');
    const target = row ? findNode($folders, Number(row.dataset.folderId)) : null;
    drop = null;
    if (row && target && target.id !== dragging.id && !findNode(dragging.children, target.id)
        && !!target.is_system === !!dragging.is_system) {
      const rect = row.getBoundingClientRect();
      const ratio = (e.clientY - rect.top) / rect.height;
      drop = { id: target.id, position: ratio < .25 ? "before" : ratio >= .75 ? "after" : "inside" };
    }
    const root = hit?.closest<HTMLElement>('[data-folder-root]');
    if (root && (root.dataset.folderRoot === 'system') === !!dragging.is_system) drop = { id: null, position: 'root' };
    const scroller = row?.closest('.folder-scroll');
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      if (e.clientY < rect.top + 32) scroller.scrollTop -= 12;
      if (e.clientY > rect.bottom - 32) scroller.scrollTop += 12;
    }
  }

  function cancelDrag() {
    clearTimeout(holdTimer);
    pressed = null;
    dragging = null;
    drop = null;
  }

  async function releaseFolder() {
    const source = dragging;
    const target = drop;
    cancelDrag();
    if (!source || !target) return;
    saving = true;
    try {
      await foldersApi.reorder(source.id, target.id, target.position);
      if (target.position === "inside" && target.id !== null) { const next = new Set(collapsed); next.delete(target.id); collapsed = next; }
      await refreshFolders();
    } catch (error) {
      pushToast(`移动失败：${error instanceof Error ? error.message : error}`, { kind: "error" });
    } finally { saving = false; }
  }

  onDestroy(() => { clearTimeout(clickTimer); cancelDrag(); });

  function openMenu(id: number, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(clickTimer);
    cancelDrag();
    blankMenu = false;
    if (e.type !== "contextmenu" && menuFor === id) { menuFor = null; return; }
    menuFor = id;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.type === "contextmenu" ? e.clientX : rect.right;
    const y = e.type === "contextmenu" ? e.clientY : rect.bottom;
    menuPos = { x: Math.max(8, Math.min(x, window.innerWidth - 208)),
      y: Math.max(8, Math.min(y, window.innerHeight - 260)) };
  }

  function openBlankMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(clickTimer);
    cancelDrag();
    menuFor = null;
    blankMenu = true;
    menuPos = {
      x: Math.max(8, Math.min(e.clientX, window.innerWidth - 208)),
      y: Math.max(8, Math.min(e.clientY, window.innerHeight - 120)),
    };
  }

  function focusRename(input: HTMLInputElement) {
    void tick().then(() => { if (input.isConnected) { input.focus(); input.select(); } });
  }

  function startRename(id: number, name: string) {
    if (saving) return;
    clearTimeout(clickTimer);
    cancelDrag();
    renameFor = id;
    renameValue = name;
    menuFor = null;
  }

  async function submitRename() {
    if (renameFor === null || saving) return;
    const id = renameFor;
    const name = renameValue.trim();
    if (!name) { pushToast("请输入文件夹名称", { kind: "error" }); return; }
    saving = true;
    try {
      await foldersApi.rename(id, name);
      if (renameFor === id) { renameFor = null; renameValue = ""; }
      await refreshFolders();
    } catch (error) {
      pushToast(`改名失败：${error instanceof Error ? error.message : error}`, { kind: "error" });
    } finally { saving = false; }
  }

  async function move(id: number, direction: "up" | "down") {
    await foldersApi.move(id, direction);
    menuFor = null;
    await refreshFolders();
  }

  async function remove(id: number) {
    const node = findNode($folders, id);
    const isSys = !!node?.is_system;
    if (isSys) {
      const msg = `确定要删除来源目录「${node?.name}」吗？\n\n此操作会永久删除该文件夹及其磁盘上的所有文件，且不可恢复。\n\n${node?.path || ''}`;
      if (!confirm(msg)) return;
    } else {
      if (!confirm("删除此文件夹？其中的图片将升级到上一级。")) return;
    }
    await foldersApi.remove(id);
    menuFor = null;
    if ($folderId === id) folderId.set(null);
    await refreshFolders();
  }

  async function revealSystemFolder(id: number) {
    menuFor = null;
    try {
      const response = await fetch(backendUrl(`/api/folders/${id}/reveal`), { method: "POST" });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.detail || "打开文件夹失败");
      }
    } catch (error) {
      pushToast(`无法打开所在位置：${error instanceof Error ? error.message : error}`, { kind: "error" });
    }
  }

  function startNew(parent: number | null) {
    menuFor = null;
    blankMenu = false;
    newFolderFor = { parent };
    newFolderName = "新建文件夹";
    if (parent !== null) { const next = new Set(collapsed); next.delete(parent); collapsed = next; }
  }

  async function submitNewFolder() {
    if (!newFolderFor || saving) return;
    const name = newFolderName.trim();
    if (!name) { newFolderFor = null; return; }
    saving = true;
    try {
      const result = await foldersApi.create(name, newFolderFor.parent);
      newFolderFor = null;
      newFolderName = "";
      await refreshFolders();
      view.set("all"); folderId.set(result.id);
    } catch (error) {
      pushToast(`创建失败：${error instanceof Error ? error.message : error}`, { kind: "error" });
    } finally { saving = false; }
  }

  function closeAll() { menuFor = null; blankMenu = false; }

  // 把 folder 树按 is_system 拆成两份：user / system。
  // 注意：后端 folder_tree() 已经按 parent_id 嵌套好了；这里只是按根节点过滤。
  let userFolders = $derived($folders.filter((f) => !f.is_system));
  let systemFolders = $derived($folders.filter((f) => !!f.is_system));
</script>

<svelte:window onclick={closeAll} onpointermove={pointerMove} onpointerup={releaseFolder}
  onpointercancel={cancelDrag} onblur={cancelDrag}
  onkeydown={(e) => { if (e.key === 'Escape') { renameFor = null; newFolderFor = null; cancelDrag(); closeAll(); } }} />

<div class="px-[14px] pt-[14px] pb-[8px] flex items-center justify-between">
  <h3 class="text-[11px] uppercase text-muted tracking-wider">文件夹</h3>
  <button class="collapse-sidebar" onclick={oncollapse} title="收起左侧栏" aria-label="收起左侧栏">
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16m7-11-3 3 3 3"/></svg>
  </button>
</div>
<div bind:this={sidebarRegion} class:external-hover={externalHover > 0} class="folder-scroll flex-1 overflow-y-auto px-2 pb-3" role="presentation" oncontextmenu={openBlankMenu}>
  {#if externalHover || importingFolders}
    <div class="external-drop-status" role="status">{importingFolders ? '正在移动文件夹及全部内容…' : '松开后完整移动到我的文件夹'}</div>
  {/if}
  <div class="text-[10px] uppercase text-muted tracking-wider px-[10px] py-[10px] opacity-70">
    系统
  </div>
  <div
    class="folder-item {$view === 'all' && $folderId === null && $kind === 'image' ? 'active' : ''}"
    onclick={() => {
      kind.set('image');
      view.set('all');
      folderId.set(null);
      tag.set(null);
      query.set('');
    }}
  >
    <span class="caret-spacer"></span>
    <span class="icon"><Icon name="image" size={13} /></span>
    <span class="label">全部图片</span>
    <span class="count">{$stats.total_images}</span>
  </div>
  <div
    class="folder-item {$view === 'all' && $folderId === null && $kind === 'video' ? 'active' : ''}"
    onclick={() => {
      kind.set('video');
      view.set('all');
      folderId.set(null);
      tag.set(null);
      query.set('');
    }}
  >
    <span class="caret-spacer"></span>
    <span class="icon"><Icon name="video" size={13} /></span>
    <span class="label">所有视频</span>
    <span class="count">{$stats.total_videos}</span>
  </div>
  <div
    class="folder-item {$view === 'favorite' ? 'active' : ''}"
    onclick={() => setView('favorite')}
  >
    <span class="caret-spacer"></span>
    <span class="icon"><Icon name="star" size={13} /></span>
    <span class="label">收藏</span>
    <span class="count">{$stats.favorites}</span>
  </div>
  <div
    class="folder-item {$view === 'recent' ? 'active' : ''}"
    onclick={() => setView('recent')}
  >
    <span class="caret-spacer"></span>
    <span class="icon"><Icon name="clock" size={13} /></span>
    <span class="label">最近生成</span>
    <span class="count"></span>
  </div>

  {#if systemFolders.length > 0}
    <div class="flex items-center justify-between px-[10px] pt-[14px] pb-[4px]">
      <div data-folder-root="system" class:root-drop={drop?.position === "root" && !!dragging?.is_system} class="text-[10px] uppercase text-muted tracking-wider opacity-70">
        来源目录
      </div>
    </div>
    {#each systemFolders as f (f.id)}
      {@render systemFolderItem(f, 0)}
    {/each}
  {/if}

  <div class="flex items-center justify-between px-[10px] pt-[14px] pb-[4px]">
    <div data-folder-root="user" class:root-drop={drop?.position === "root" && !dragging?.is_system} class="text-[10px] uppercase text-muted tracking-wider opacity-70">我的文件夹</div>
    <button
      class="bg-transparent border-0 text-muted text-[12px] hover:text-zinc-200"
      onclick={(e) => {
        e.stopPropagation();
        startNew(null);
      }}
      title="新建文件夹"
    >
      <Icon name="plus" size={12} />
    </button>
  </div>

  <p class="folder-hint">单击展开 · 双击改名 · 长按拖动移动</p>

  {#if newFolderFor?.parent === null}{@render newFolderInput(0)}{/if}
  {#if userFolders.length === 0 && !newFolderFor}
    <div class="text-[12px] text-muted px-3 py-2">还没有文件夹</div>
  {/if}

  {#each userFolders as f (f.id)}
    {@render userFolderItem(f, 0)}
  {/each}
</div>

{#if blankMenu}
  <div
    class="folder-menu fixed bg-surface-2 border border-border rounded-[8px] py-1 min-w-[160px] z-40 text-[13px] shadow-xl"
    style="left: {menuPos.x}px; top: {menuPos.y}px;"
    role="menu" tabindex="-1"
    oncontextmenu={(e) => e.preventDefault()}
    onclick={(e) => e.stopPropagation()}
  >
    <button role="menuitem" class="block w-full text-left px-3 py-2 hover:bg-surface-3"
      onclick={() => startNew(null)}>新建文件夹</button>
  </div>
{:else if menuFor !== null}
  {@const menuNode = findNode($folders, menuFor)}
  <div
    class="folder-menu fixed bg-surface-2 border border-border rounded-[8px] py-1 min-w-[160px] z-40 text-[13px] shadow-xl"
    style="left: {menuPos.x}px; top: {menuPos.y}px;"
    role="menu" tabindex="-1"
    oncontextmenu={(e) => e.preventDefault()}
    onclick={(e) => e.stopPropagation()}
  >
    <button role="menuitem"
      class="block w-full text-left px-3 py-1 hover:bg-surface-3"
      onclick={() => menuFor !== null && startNew(menuFor)}
    >
      新建文件夹
    </button>
    <button
      class="block w-full text-left px-3 py-1 hover:bg-surface-3"
      onclick={() => {
        const node = findNode($folders, menuFor!);
        if (node) startRename(menuFor!, node.name);
      }}
    >
      重命名
    </button>
    <button
      class="block w-full text-left px-3 py-1 hover:bg-surface-3"
      onclick={() => menuFor !== null && move(menuFor, 'up')}
    >
      上移
    </button>
    <button
      class="block w-full text-left px-3 py-1 hover:bg-surface-3"
      onclick={() => menuFor !== null && move(menuFor, 'down')}
    >
      下移
    </button>
    <button role="menuitem" class="block w-full text-left px-3 py-1 hover:bg-surface-3 disabled:opacity-40"
      disabled={!menuNode?.path} title={menuNode?.path || '此文件夹是图库分类，没有对应的磁盘位置'}
      onclick={() => menuFor !== null && revealSystemFolder(menuFor)}>所在文件夹位置</button>
    {#if !menuNode?.path}
      <div class="px-3 pb-1 text-muted text-[11px]">图库分类，无磁盘位置</div>
    {/if}
    <div class="border-t border-border my-1"></div>
    <button
      class="block w-full text-left px-3 py-1 hover:bg-danger/30 text-danger"
      onclick={() => menuFor !== null && remove(menuFor)}
    >
      删除文件夹
    </button>
  </div>
{/if}

{#snippet userFolderItem(folder: FolderNode, depth: number)}
  {@render folderItem(folder, depth)}
{/snippet}

{#snippet systemFolderItem(folder: FolderNode, depth: number)}
  {@render folderItem(folder, depth)}
{/snippet}

{#snippet folderItem(folder: FolderNode, depth: number)}
  <div
    class="folder-item {folder.is_system ? 'system' : ''} {$folderId === folder.id ? 'active' : ''}"
    class:dragging={dragging?.id === folder.id}
    class:drop-inside={drop?.id === folder.id && drop.position === "inside"}
    class:drop-before={drop?.id === folder.id && drop.position === 'before'}
    class:drop-after={drop?.id === folder.id && drop.position === 'after'}
    data-folder-id={folder.id}
    style="margin-left: {depth * 14}px"
    role="button" tabindex="0"
    aria-label={folder.name}
    aria-expanded={folder.children.length ? !collapsed.has(folder.id) : undefined}
    onclick={(e) => clickFolder(folder, e)}
    ondblclick={(e) => doubleClickFolder(folder, e)}
    onpointerdown={(e) => pressFolder(folder, e)}
    oncontextmenu={(e) => openMenu(folder.id, e)}
    onkeydown={(e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFolder(folder); }
      if (e.key === 'F2') { e.preventDefault(); startRename(folder.id, folder.name); }
    }}
  >
    <span class="folder-caret">
      {#if folder.children.length}
        <Icon name={collapsed.has(folder.id) ? 'chevron-right' : 'chevron-down'} size={12} />
      {/if}
    </span>
    <span class="icon"><Icon name="folder" size={15} /></span>
    {#if renameFor === folder.id}
      <input class="folder-name-input" aria-label="文件夹名称" bind:value={renameValue}
        maxlength={64} readonly={saving} use:focusRename
        title={folder.is_system ? '修改图库显示名称；Enter 保存，Esc 取消' : 'Enter 保存，Esc 取消'}
        onclick={(e) => e.stopPropagation()} ondblclick={(e) => e.stopPropagation()}
        onpointerdown={(e) => e.stopPropagation()} oncontextmenu={(e) => e.stopPropagation()}
        onblur={() => submitRename()}
        onkeydown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void submitRename(); }
          if (e.key === 'Escape') { e.preventDefault(); renameFor = null; }
        }} />
    {:else}
      <span class="label" title={folder.path ?? folder.name}>{folder.name}</span>
    {/if}
    <span class="count">{folder.recursive_count}</span>
    <button class="menu-btn" onclick={(e) => openMenu(folder.id, e)}
      ondblclick={(e) => e.stopPropagation()} aria-label="文件夹操作">
      <Icon name="more-vertical" size={14} />
    </button>
  </div>
  {#if !collapsed.has(folder.id)}
    <div class="folder-children">
    {#if newFolderFor?.parent === folder.id}{@render newFolderInput(depth + 1)}{/if}
    {#each folder.children as child (child.id)}
      {@render folderItem(child, depth + 1)}
    {/each}
    </div>
  {/if}
{/snippet}

{#snippet newFolderInput(depth: number)}
  <div class="folder-item" style="margin-left: {depth * 14}px" onclick={(e) => e.stopPropagation()} role="presentation">
    <span class="folder-caret"></span><Icon name="folder" size={15} />
    <input class="folder-name-input" aria-label="新建文件夹名称" bind:value={newFolderName}
      maxlength={64} readonly={saving} use:focusRename onblur={submitNewFolder}
      onkeydown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void submitNewFolder(); }
        if (e.key === 'Escape') { e.preventDefault(); newFolderFor = null; }
      }} />
  </div>
{/snippet}

{#if dragging}
  <div class="drag-hint" role="status">正在移动「{dragging.name}」· 中部移入 · 边缘排序 · 分区标题移回根层级</div>
{/if}

<style>
  .external-hover { background: #f24e4e15; }
  .external-drop-status { position: sticky; top: 0; z-index: 2; padding: 12px 8px; background: #303034; color: #eee; font-size: 12px; border-radius: 6px; }
  :global(.folder-item.drop-inside), .root-drop { background: #f24e4e33; outline: 1px solid #f24e4e; }
  :global(.folder-item) {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    margin-bottom: 3px;
    min-height: 36px;
    transition: background 120ms, color 120ms;
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
    background: #f24e4e1a;
    color: #ff7777;
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
  :global(.folder-item:hover .menu-btn),
  :global(.folder-item:focus-within .menu-btn) {
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
  /* system folder：略微区分（图标色保留，但文字色偏暗；hover/active 用主色） */
  :global(.folder-item.system) {
    color: #c2c2c8;
  }
  :global(.folder-item.system .icon) {
    color: #8a8a8e;
    opacity: 1;
  }
  :global(.folder-item.system:hover) {
    background: #27272a;
    color: #e4e4e7;
  }
  :global(.folder-item.system.active) {
    color: #f24e4e;
  }
  .folder-hint { font-size: 10px; color: #85858e; padding: 4px 10px 10px; line-height: 1.7; }
  .folder-caret { width: 12px; height: 14px; display: flex; align-items: center; flex-shrink: 0; color: #92929c; }
  :global(.folder-item .count) { font-variant-numeric: tabular-nums; border-radius: 5px; padding: 1px 5px; background: #ffffff06; }
  :global(.folder-item:focus-visible) { outline: none; background: #ffffff12; }
  :global(.folder-item.dragging) { opacity: .45; cursor: grabbing; }
  :global(.folder-item.drop-before) { box-shadow: 0 -2px #f24e4e; }
  :global(.folder-item.drop-after) { box-shadow: 0 2px #f24e4e; }
  .drag-hint { position: fixed; bottom: 24px; left: 20px; z-index: 80; pointer-events: none; padding: 10px 14px; border-radius: 8px; background: #333338; color: #eee; font-size: 12px; box-shadow: 0 6px 24px #0005; }
  .collapse-sidebar { border: 0; background: transparent; color: #888; padding: 4px; cursor: pointer; outline: none; box-shadow: none; }
  .collapse-sidebar:hover, .collapse-sidebar:focus-visible { color: #eee; background: transparent; border: 0; outline: none; box-shadow: none; }
  .folder-name-input { flex: 1; min-width: 0; width: 0; padding: 1px 4px; border: 1px solid #777; border-radius: 3px; background: #151518; color: #eee; font: inherit; outline: none; user-select: text; }
</style>
