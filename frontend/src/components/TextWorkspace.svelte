<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { textMode, folderId, view, folders, textTotal, refreshFolders, refreshFeed, selectedId, feedItems, switchContent } from '../lib/stores';
  import { textsApi, TextSession, type TextSummary, type TextHistory, type TextDraft } from '../lib/texts';
  import { imagesApi, videosApi } from '../lib/api';
  import type { ImageSummary, FolderNode } from '../lib/types';
  import { backendUrl } from '../lib/backend-url';
  import { isTauri, selectTextPaths } from '../lib/tauri';
  import { subscribeFileDrop } from '../lib/native-drop';
  import { copyText } from '../lib/ws';
  import { pushToast } from '../lib/toast';
  import TextEditor from './TextEditor.svelte';
  import TextListSplitter from './TextListSplitter.svelte';
  let listWidth = $state(220);
  let bodyWidth = $state(800);
  let maxListWidth = $derived(Math.max(180, Math.min(480, bodyWidth - 260)));
  function measureBody(node: HTMLElement) {
    const update = () => { if (node.clientWidth > 0) bodyWidth = node.clientWidth; };
    update(); const observer = new ResizeObserver(update); observer.observe(node);
    return { destroy() { observer.disconnect(); } };
  }
  import { textListDrag } from '../lib/text-list-drag';
  let editing = $state(false);
  let renamingId = $state<number | null>(null);
  let renameValue = $state('');
  let renameBusy = $state(false);
  let reorderBusy = $state(false);
  let dragFrom = $state<number | null>(null);
  let dragTarget = $state<number | null>(null);
  let dragAfter = $state(false);
  import GallerySearch from './GallerySearch.svelte';
  import ContentSwitcher from './ContentSwitcher.svelte';
  let filtersOpen = $state(false);

  const STORAGE = 'seekx-text-workspace-v1';
  let region: HTMLDivElement;
  let editor = $state<TextEditor>();
  let revision = $state(0);
  const sessions = new Map<number, TextSession>();
  let ids = $state<number[]>([]);
  let activeId = $state<number | null>(null);
  // Sessions own async queues outside Svelte; publish a fresh view on each change.
  let current = $derived.by(() => { revision; const s = activeId === null ? null : sessions.get(activeId); return s ? new Proxy(s, {}) : null; });
  let openTabs = $derived.by(() => { revision; return ids.map(id => ({ id, name: sessions.get(id)?.detail.filename, dirty: sessions.get(id)?.dirty })); });
  let listOpen = $state(false);
  let source = $state(false);
  let search = $state('');
  let format = $state('');
  let tagFilter = $state('');
  let sort = $state('mtime');
  let favoriteOnly = $state(false);
  let items = $state<TextSummary[]>([]);
  let total = $state(0);
  let loading = $state(false);
  let ready = $state(false);
  let error = $state('');
  let draftError = $state('');
  let hover = $state(0);
  let modal = $state<'' | 'new' | 'associate' | 'history' | 'media' | 'move' | 'conflict' | 'trash' | 'discard'>('');
  let busy = $state(false);
  let directory = $state('');
  let filename = $state('未命名.md');
  let newFormat = $state('md');
  let pathInput = $state('');
  let pendingPaths = $state<string[]>([]);
  let preview = $state<Awaited<ReturnType<typeof textsApi.preview>> | null>(null);
  let copyBody = $state<string | null>(null);
  let modalError = $state('');
  let historyItems = $state<TextHistory[]>([]);
  let historyId = $state('');
  let historyBody = $state('');
  let diskBody = $state('');
  let mediaQuery = $state('');
  let mediaKind = $state<'image' | 'video'>('image');
  let mediaItems = $state<ImageSummary[]>([]);
  let mediaOffset = $state(0);
  let mediaTotal = $state(0);
  let replaceHref = $state('');
  let modalTextId: number | null = null;
  let requestId = 0;
  let timer: ReturnType<typeof setInterval>;
  let alive = true;
  let lastFolder: number | null = null;
  const message = (e: unknown) => e instanceof Error ? e.message : String(e);
  const stateLabel = { saved: '已保存', saving: '保存中…', dirty: '等待保存', conflict: '外部冲突', error: '保存失败' };
  const isMarkdown = (d: TextSession | null) => !!d && ['md', 'markdown'].includes(d.detail.format);
  function findFolder(nodes: FolderNode[], id: number): FolderNode | undefined {
    for (const f of nodes) { if (f.id === id) return f; const child = findFolder(f.children, id); if (child) return child; }
  }
  let folderName = $derived($folderId === null ? '全部文本' : findFolder($folders, $folderId)?.name || '项目文件夹');

  function persist() {
    try {
      localStorage.setItem(STORAGE, JSON.stringify({ ids, activeId, listOpen, listWidth, sort,
        positions: ids.map(id => { const s = sessions.get(id)!; return { id, cursor: s.cursor, scroll: s.scroll }; }),
        drafts: [...sessions.values()].filter(s => s.dirty).map(s => s.draft) }));
      draftError = '';
    } catch { draftError = '本地草稿缓存不可用，请保存或另存副本后再关闭应用'; }
  }
  function changed() { revision++; if (ready) persist(); }
  async function refreshList(append = false) {
    const request = ++requestId;
    loading = true;
    try {
      const result = await textsApi.list({ q: search, folder_id: get(folderId), view: favoriteOnly ? 'favorite' : get(view), format, tag: tagFilter, sort, offset: append ? items.length : 0 });
      if (request !== requestId || !alive) return;
      items = append ? [...items, ...result.items] : result.items; total = result.total; error = '';
      const all = await textsApi.list({ limit: 1 }); textTotal.set(all.total);
    } catch (e) { if (request === requestId) error = message(e); }
    finally { if (request === requestId) loading = false; }
  }
  async function openDocument(id: number, match?: number) {
    try {
      if (!sessions.has(id)) {
        const detail = await textsApi.detail(id, undefined, true);
        sessions.set(id, new TextSession(detail, changed));
        if (!ids.includes(id)) ids = [...ids, id];
      } else { void textsApi.detail(id, undefined, true).catch(() => {}); }
      activeId = id; source = false; editing = false; changed();
      await tick();
      if (match !== undefined && search) { await tick(); await editor?.locate(match, search.length); }
    } catch (e) { error = message(e); }
  }
  async function closeDocument(id: number) {
    const s = sessions.get(id)!;
    await s.flush();
    if (s.dirty) { activeId = id; showModal('discard'); return; }
    s.dispose(); sessions.delete(id); ids = ids.filter(v => v !== id);
    if (activeId === id) activeId = ids.at(-1) ?? null;
    changed();
  }
  function showModal(next: typeof modal) {
    modalTextId = activeId; modal = next; modalError = ''; busy = false;
  }
  function discardTab() {
    if (modalTextId === null) return;
    sessions.get(modalTextId)?.dispose(); sessions.delete(modalTextId); ids = ids.filter(id => id !== modalTextId);
    activeId = ids.at(-1) ?? null; modal = ''; changed();
  }
  function modalFocus(node: HTMLElement) {
    const previous = document.activeElement as HTMLElement | null;
    node.focus();
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) { modal = ''; assetPreview = null; }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,textarea,[tabindex="0"]'));
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === node)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === node)) { e.preventDefault(); first?.focus(); }
    };
    node.addEventListener('keydown', keys);
    return { destroy() { node.removeEventListener('keydown', keys); previous?.focus(); } };
  }
  async function pickDirectory() {
    try { const picked = (await selectTextPaths(true))[0]; if (picked) directory = picked; }
    catch (e) { modalError = message(e); }
  }
  async function pickAssociations(directory: boolean) {
    try { const paths = await selectTextPaths(directory); if (paths.length) await previewPaths(paths); }
    catch (e) { modalError = message(e); }
  }
  function newDocument(copy = false) {
    directory = $folderId === null ? '' : findFolder($folders, $folderId)?.path || '';
    filename = copy && current ? current.detail.filename.replace(/(\.[^.]+)$/, '-副本$1') : '未命名.md';
    newFormat = copy && current ? current.detail.format : 'md';
    copyBody = copy && current ? current.body : null;
    if (copy && current) directory = current.detail.path.replace(/[\\/][^\\/]+$/, '');
    showModal('new');
  }
  async function createDocument() {
    busy = true; modalError = '';
    try {
      const selectedFolder = copyBody === null && $folderId !== null && !directory ? $folderId : null;
      const name = filename.replace(/\.(txt|md|markdown|srt|vtt)$/i, '') + '.' + newFormat;
      const d = await textsApi.create({ directory, name, body: copyBody ?? '', folder_id: selectedFolder });
      sessions.set(d.id, new TextSession(d, changed)); ids = [...ids, d.id]; activeId = d.id;
      modal = ''; source = false; editing = true; changed(); await refreshList();
    } catch (e) { modalError = message(e); } finally { busy = false; }
  }
  async function previewPaths(paths: string[]) {
    showModal('associate'); pathInput = paths.join('\n'); pendingPaths = paths; preview = null; busy = true;
    try { preview = await textsApi.preview(paths); } catch (e) { modalError = message(e); } finally { busy = false; }
  }
  async function associate() {
    busy = true; modalError = '';
    try {
      const result = await textsApi.associate(pendingPaths);
      await refreshFolders(); await refreshList();
      if (result.saved[0]) await openDocument(result.saved[0].id);
      if (result.errors.length) { modalError = result.errors.map(x => `${x.path}：${x.reason}`).join('\n'); preview = null; }
      else modal = '';
    } catch (e) { modalError = message(e); } finally { busy = false; }
  }
  async function favorite() {
    if (!current) return;
    try { const result = await textsApi.meta(current.detail.id, { favorite: !current.detail.favorite }); Object.assign(current.detail, result); changed(); await refreshList(); }
    catch (e) { error = message(e); }
  }
  async function tags(value: string) {
    if (!current) return;
    try { const result = await textsApi.meta(current.detail.id, { tags: value.split(/[,，]/).map(x => x.trim()).filter(Boolean) }); Object.assign(current.detail, result); changed(); await refreshList(); }
    catch (e) { error = message(e); }
  }
  async function encoding(value: string) {
    if (!current || !value) return;
    try { const d = await textsApi.detail(current.detail.id, value); current.acceptDisk(d); }
    catch (e) { error = message(e); }
  }
  async function showHistory() {
    if (!current) return;
    showModal('history'); historyId = ''; historyBody = ''; busy = true;
    try { historyItems = await textsApi.history(current.detail.id); } catch (e) { modalError = message(e); } finally { busy = false; }
  }
  async function previewHistory(ident: string) {
    if (modalTextId === null) return;
    historyId = ident;
    try { const h = await textsApi.historical(modalTextId, ident); if (ident === historyId) historyBody = h.body; }
    catch (e) { modalError = message(e); }
  }
  async function restoreHistory() {
    const s = modalTextId === null ? null : sessions.get(modalTextId);
    if (!s || !historyId) return;
    busy = true;
    try {
      await s.flush();
      if (s.dirty) throw new Error('请先解决当前文档的保存问题');
      s.acceptDisk(await textsApi.restore(s.detail.id, historyId, s.detail.version)); modal = ''; await refreshList();
    } catch (e) { modalError = message(e); } finally { busy = false; }
  }
  async function conflict() {
    if (!current) return;
    showModal('conflict'); diskBody = ''; busy = true;
    try { diskBody = (await textsApi.detail(current.detail.id)).body; } catch (e) { modalError = message(e); } finally { busy = false; }
  }
  async function resolveConflict(mine: boolean) {
    const s = modalTextId === null ? null : sessions.get(modalTextId);
    if (!s) return;
    busy = true;
    try {
      if (mine) { await s.keepMine(); if (s.dirty) throw new Error(s.error); }
      else { s.acceptDisk(await textsApi.detail(s.detail.id)); }
      modal = ''; await refreshList();
    } catch (e) { modalError = message(e); } finally { busy = false; }
  }
  async function insert(before: string, after = '') {
    editing = true; await tick(); await editor?.insert(before, after);
  }
  function startRename(item: TextSummary) { if (renameBusy || reorderBusy) return; renamingId = item.id; renameValue = item.filename; }
  function renameFocus(node: HTMLInputElement) { node.focus(); node.setSelectionRange(0, Math.max(0,node.value.lastIndexOf('.')) || node.value.length); }
  async function saveRename(item: TextSummary) {
    if (renameBusy || renamingId !== item.id) return;
    if (renameValue.trim() === item.filename) { renamingId = null; return; }
    if (!renameValue.trim()) { error = '文件名不能为空'; return; }
    renameBusy = true;
    try {
      const session = sessions.get(item.id);
      if (session) { await session.flush(); if (session.dirty) throw new Error('请先保存正文或解决冲突，再重命名'); }
      const detail = session?.detail ?? await textsApi.detail(item.id);
      const result = await textsApi.move(item.id, detail.path.replace(/[\\/][^\\/]+$/, ''), renameValue.trim(), detail.version);
      if (session) {
        if (session.dirty) { session.detail = result; session.state = 'conflict'; session.error = '重命名期间正文发生变化，请处理冲突'; }
        else session.acceptDisk(result);
      }
      renamingId = null; changed(); await refreshList();
    } catch (e) { error = message(e); } finally { renameBusy = false; }
  }
  async function reorder(from: number, target: number, after: boolean) {
    if (reorderBusy || renameBusy) return;
    const moved = items.find(x => x.id === from); if (!moved) return;
    const next = items.filter(x => x.id !== from);
    const index = next.findIndex(x => x.id === target); if (index < 0) return;
    next.splice(index + (after ? 1 : 0), 0, moved);
    reorderBusy = true;
    try { await textsApi.reorder(next.map(x => x.id)); sort = 'manual'; items = next; persist(); await refreshList(); }
    catch (e) { error = message(e); } finally { reorderBusy = false; }
  }
  function showMove() {
    if (!current) return;
    filename = current.detail.filename; directory = current.detail.path.replace(/[\\/][^\\/]+$/, ''); showModal('move');
  }
  async function moveDocument() {
    const s = modalTextId === null ? null : sessions.get(modalTextId); if (!s) return;
    busy = true;
    try {
      await s.flush(); if (s.dirty) throw new Error('请先保存文档或解决冲突');
      s.acceptDisk(await textsApi.move(s.detail.id, directory, filename, s.detail.version)); modal = ''; await refreshList();
    } catch (e) { modalError = message(e); } finally { busy = false; }
  }
  async function trashDocument() {
    const s = modalTextId === null ? null : sessions.get(modalTextId); if (!s) return;
    busy = true;
    try {
      await s.flush(); if (s.dirty) throw new Error('请先保存文档或解决冲突');
      await textsApi.trash(s.detail.id, s.detail.version);
      s.dispose(); sessions.delete(s.detail.id); ids = ids.filter(id => id !== s.detail.id); activeId = ids.at(-1) ?? null;
      modal = ''; changed(); await refreshList();
    } catch (e) { modalError = message(e); } finally { busy = false; }
  }
  let mediaRequest = 0;
  async function loadMedia(append = false) {
    const request = ++mediaRequest;
    try {
      const r = await imagesApi.list({ kind: mediaKind, q: mediaQuery, limit: 48, offset: append ? mediaOffset : 0 });
      if (request !== mediaRequest) return;
      mediaItems = append ? [...mediaItems, ...r.items] : r.items; mediaOffset = mediaItems.length; mediaTotal = r.total;
    } catch (e) { modalError = message(e); }
  }
  function showMedia(href = '') { replaceHref = href; mediaQuery = ''; mediaItems = []; mediaOffset = 0; showModal('media'); void loadMedia(); }
  async function insertMedia(item: ImageSummary) {
    const s = modalTextId === null ? null : sessions.get(modalTextId); if (!s) return;
    try {
      const r = await textsApi.reference(s.detail.id, item.id);
      if (replaceHref) { s.edit(s.body.split(`](${replaceHref})`).join(`](${r.href})`).split(`](<${replaceHref}>)`).join(`](${r.href})`)); }
      else { await insert('\n' + r.markdown + '\n'); }
      if (!r.portable) pushToast('素材位于其他磁盘，引用使用绝对路径');
      modal = '';
    } catch (e) { modalError = message(e); }
  }
  let assetPreview = $state<{ href: string; id: number; kind: 'image' | 'video' } | null>(null);
  async function openAsset(href: string) {
    if (!current) return;
    try { const info = await textsApi.assetInfo(current.detail.id, href); if (info.kind === 'text') await openDocument(info.id); else assetPreview = { href, id: info.id, kind: info.kind }; }
    catch { showMedia(href); modalError = '素材失效或未加入图库，请选择替代素材'; }
  }
  async function reveal() {
    if (!current) return;
    try { await textsApi.reveal(current.detail.id); } catch (e) { await copyText(current.detail.path); error = message(e) + '（已复制文件路径）'; }
  }
  async function showInGallery() {
    if (!assetPreview) return;
    const item = assetPreview; assetPreview = null; switchContent(item.kind, true);
    await refreshFeed();
    if (!get(feedItems).some(x => x.id === item.id)) {
      const detail = await imagesApi.detail(item.id); feedItems.update(items => [detail, ...items]);
    }
    selectedId.set(item.id); await tick();
    window.dispatchEvent(new CustomEvent(item.kind === 'video' ? 'open-video-player' : 'open-lightbox', { detail: { id: item.id } }));
  }
  async function syncOpen() {
    if (!ready || !get(textMode) || busy || reorderBusy || renameBusy || dragFrom !== null) return;
    for (const s of sessions.values()) {
      try { await s.refresh(); } catch (e) { s.error = message(e); s.state = 'error'; changed(); }
    }
    await refreshList();
  }
  $effect(() => {
    const f = $folderId, v = $view, mode = $textMode;
    search; format; tagFilter; sort; favoriteOnly;
    if (!ready || !mode) return;
    if (f !== lastFolder) { lastFolder = f; listOpen = true; }
    const delay = setTimeout(() => { void refreshList(); }, 180);
    return () => clearTimeout(delay);
  });
  onMount(() => {
    const disposeDrop = subscribeFileDrop(() => get(textMode) ? region : null, n => hover = n, previewPaths);
    const dropped = (e: Event) => { if (get(textMode)) void previewPaths((e as CustomEvent<string[]>).detail); };
    const refresh = () => { void syncOpen(); };
    const keys = (e: KeyboardEvent) => {
      if (!get(textMode)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void current?.flush(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); listOpen = !listOpen; }
    };
    const before = (e: BeforeUnloadEvent) => { persist(); if ([...sessions.values()].some(s => s.dirty)) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('associate-text-paths', dropped); window.addEventListener('texts-changed', refresh);
    window.addEventListener('keydown', keys); window.addEventListener('beforeunload', before);
    void (async () => {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE) || '{}');
        listWidth = Number.isFinite(saved.listWidth) ? Math.max(180, Math.min(480, saved.listWidth)) : 220;
        listOpen = saved.listOpen ?? false; source = false; editing = false;
        sort = ['mtime','name','created','manual'].includes(saved.sort) ? saved.sort : 'mtime';
        const restored: number[] = [];
        for (const id of [...new Set<number>(saved.ids || [])]) {
          try {
            const d = await textsApi.detail(id);
            const s = new TextSession(d, changed, textsApi, saved.drafts?.find((d: TextDraft) => d.id === id));
            const pos = saved.positions?.find((p: TextDraft) => p.id === id); if (pos) { s.cursor = pos.cursor; s.scroll = pos.scroll; }
            sessions.set(id, s); restored.push(id); s.schedule();
          } catch (e) {
            const draft = saved.drafts?.find((d: TextDraft) => d.id === id);
            if (draft) {
              // Keep unavailable drafts recoverable instead of dropping them from storage.
              const placeholder = { id, filename: '待恢复文档', path: '', format: 'md', body: '', version: draft.version,
                encoding: 'utf-8', newline: 'LF', bom: false, readonly: false, needs_encoding: false, mtime: 0,
                created: 0, opened: 0, favorite: false, missing: true, tags: [], excerpt: '', error: message(e) };
              const s = new TextSession(placeholder, changed, textsApi, draft); s.state = 'error'; s.error = message(e);
              sessions.set(id, s); restored.push(id);
            }
          }
        }
        ids = restored; activeId = ids.includes(saved.activeId) ? saved.activeId : ids[0] ?? null;
      } catch { error = '无法恢复上次文本工作区'; }
      ready = true; changed(); await refreshList();
    })();
    timer = setInterval(() => { void syncOpen(); }, 5000);
    return () => { alive = false; disposeDrop(); clearInterval(timer); window.removeEventListener('associate-text-paths', dropped); window.removeEventListener('texts-changed', refresh); window.removeEventListener('keydown', keys); window.removeEventListener('beforeunload', before); };
  });
  onDestroy(() => { for (const s of sessions.values()) s.dispose(); });
</script>

<div class="text-workspace" bind:this={region} data-revision={revision} inert={!!modal || !!assetPreview}>
  <header class="workspace-header">
    <div class="workspace-heading">
      <button class:chosen={listOpen} onclick={() => { listOpen = !listOpen; persist(); }} title={`${listOpen ? '收起' : '展开'}文本列表 (Ctrl+P)`} aria-label={listOpen ? '收起文本列表' : '展开文本列表'} aria-expanded={listOpen}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d={listOpen ? 'M9 4v16m7-11-3 3 3 3' : 'M9 4v16m4-11 3 3-3 3'}/></svg>
      </button><strong>{folderName}</strong>
    </div>
    <GallerySearch value={search} onsearch={(value) => { search = value; listOpen = true; }} onfocus={() => listOpen = true} label="搜索文本" placeholder="搜索标题、正文和标签…" />
    <div class="workspace-actions">
      <button onclick={() => newDocument()} title="新建文本" aria-label="新建文本"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
      <button onclick={() => { preview = null; pathInput = ''; showModal('associate'); }} title="关联文件 / 目录" aria-label="关联文件 / 目录"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 19V5h7l2 3h9v11zM12 11v6m-3-3h6"/></svg></button>
      <ContentSwitcher />
    </div>
  </header>
  {#if error || draftError}<div class="notice" role="alert">{error || draftError}<button onclick={() => { error = ''; }}>×</button></div>{/if}
  {#if hover}<div class="drop-note">松开以预览关联；编辑将保存到原文件</div>{/if}
  <div class="workspace-body" use:measureBody>
    {#if listOpen}
      <aside class="text-list" style:width={`${Math.min(listWidth, maxListWidth)}px`}>
        <div class="list-heading"><span>{total} 篇{loading ? ' · 加载中…' : ''}</span><button aria-label="文本筛选" aria-expanded={filtersOpen} class:chosen={filtersOpen || !!format || !!tagFilter || favoriteOnly} onclick={() => filtersOpen = !filtersOpen} title="筛选与排序"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg></button></div>
        {#if $folderId !== null && search}<button onclick={() => { folderId.set(null); view.set('all'); }}>搜索全部文本</button>{/if}
        {#if filtersOpen}<div class="filters">
          <div class="filter-selects">
            <label class="filter-field"><span>格式</span><div class="select-wrap">
              <select aria-label="文本格式" bind:value={format}><option value="">所有格式</option>{#each ['txt','md','markdown','srt','vtt'] as f}<option value={f}>{f.toUpperCase()}</option>{/each}</select>
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
            </div></label>
            <label class="filter-field"><span>排序</span><div class="select-wrap">
              <select aria-label="文本排序" bind:value={sort} onchange={persist}><option value="manual">手动排序</option><option value="mtime">修改时间</option><option value="name">名称</option><option value="created">创建时间</option></select>
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
            </div></label>
          </div>
          <div class="tag-filter"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="7" cy="7" r="1"/></svg><input aria-label="筛选标签" placeholder="按标签筛选" bind:value={tagFilter}/></div>
          <div class="filter-options"><label class="favorite-filter"><input type="checkbox" bind:checked={favoriteOnly}/>仅收藏</label>
            {#if format || tagFilter || favoriteOnly}<button class="clear-filters" onclick={() => { format = ''; tagFilter = ''; favoriteOnly = false; }}>清除筛选</button>{/if}
          </div>
        </div>{/if}
        <div class="list-scroll" class:dragging={dragFrom !== null} use:textListDrag={{ change: (from, target, after) => { dragFrom = from; dragTarget = target; dragAfter = after; }, drop: (from, target, after) => { void reorder(from, target, after); } }}>
          {#each items as item (item.id)}
            <div data-text-id={item.id} role="button" tabindex="0" aria-label={item.filename}
              title={`${item.filename} · 双击改名，长按拖动排序`}
              class="text-row" class:selected={activeId === item.id} class:drag-source={dragFrom === item.id}
              class:drop-before={dragTarget === item.id && !dragAfter} class:drop-after={dragTarget === item.id && dragAfter}
              onclick={() => { if (renamingId === null && !reorderBusy) void openDocument(item.id, item.match_offset); }}
              ondblclick={() => startRename(item)}
              onkeydown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === 'F2') { e.preventDefault(); startRename(item); } else if (e.key === 'Enter') void openDocument(item.id, item.match_offset); }}>
              {#if renamingId === item.id}
                <input aria-label="重命名文本" bind:value={renameValue} disabled={renameBusy} use:renameFocus
                  onclick={(e) => e.stopPropagation()} ondblclick={(e) => e.stopPropagation()}
                  onkeydown={(e) => { e.stopPropagation(); if (e.isComposing) return; if (e.key === 'Enter') { e.preventDefault(); void saveRename(item); } else if (e.key === 'Escape') { e.preventDefault(); renamingId = null; } }}
                  onblur={() => saveRename(item)} />
              {:else}<div><strong>{item.filename}</strong>{#if item.favorite}<span>★</span>{/if}</div>{/if}
              {#if search}<p>{item.excerpt || '空白文本'}</p>{/if}
            </div>
          {/each}
          {#if !items.length && !loading}<p class="empty-list">{search ? '没有匹配的文本' : '此处还没有文本，新建或关联本地文件开始使用。'}</p>{/if}
          {#if items.length < total}<button onclick={() => refreshList(true)}>加载更多</button>{/if}
        </div>
      </aside>
      <TextListSplitter bind:value={listWidth} max={maxListWidth} onchange={persist} />
    {/if}
    <section class="document-area">
      <nav class="document-tabs" aria-label="打开的文本">
        {#each openTabs as tab (tab.id)}
          <div class:active={tab.id === activeId}><button onclick={() => { activeId = tab.id; editing = false; source = false; changed(); }}>{tab.name}{tab.dirty ? ' •' : ''}</button><button aria-label="关闭文本" onclick={() => closeDocument(tab.id)}>×</button></div>
        {/each}
      </nav>
      {#if current}<div class="open-document">
        {#if current.error || current.detail.error}<div class="notice" role="alert">{current.error || current.detail.error}
          {#if current.state === 'conflict'}<button onclick={conflict}>处理冲突</button>{:else}<button onclick={() => current?.flush()}>重试保存</button>{/if}
          <button onclick={() => newDocument(true)}>另存副本</button>
        </div>{/if}
        {#if current.detail.needs_encoding}<div class="notice">编码未确定，当前只读。请选择正确编码后编辑：
          <select aria-label="选择文本编码" onchange={(e) => encoding(e.currentTarget.value)}><option value="">选择编码</option><option value="gb18030">GB18030 / GBK</option><option value="utf-8">UTF-8</option><option value="big5">Big5</option><option value="utf-16-le">UTF-16 LE</option><option value="utf-16-be">UTF-16 BE</option></select></div>{/if}
        {#if current.detail.readonly && !current.detail.needs_encoding}<div class="notice">原文件只读，可阅读和复制，或另存副本后编辑。</div>{/if}
        <div class="text-toolbar">
          <button class:chosen={editing && !source} onclick={() => { editing = source || !editing; source = false; }}>{editing && !source ? '阅读' : '编辑'}</button>
          {#if isMarkdown(current)}
            <button title="标题" onmousedown={(e) => e.preventDefault()} onclick={() => insert('## ')}>H</button>
            <button title="加粗" onmousedown={(e) => e.preventDefault()} onclick={() => insert('**','**')}><b>B</b></button>
            <button title="斜体" onmousedown={(e) => e.preventDefault()} onclick={() => insert('*','*')}><i>I</i></button>
            <button title="列表" onmousedown={(e) => e.preventDefault()} onclick={() => insert('\n- ')}>列表</button>
            <button title="任务列表" onmousedown={(e) => e.preventDefault()} onclick={() => insert('\n- [ ] ')}>☐ 任务</button>
            <button title="引用" onmousedown={(e) => e.preventDefault()} onclick={() => insert('\n> ')}>引用</button>
            <button title="链接" onmousedown={(e) => e.preventDefault()} onclick={() => insert('[','](链接地址)')}>链接</button>
            <button title="代码块" onmousedown={(e) => e.preventDefault()} onclick={() => insert('\n```\n','\n```\n')}>代码</button>
            <button title="表格" onclick={() => insert('\n| 列一 | 列二 |\n| --- | --- |\n| 内容 | 内容 |\n')}>表格</button>
            <button onclick={() => showMedia()}>插入素材</button>
            <button class:chosen={source} onclick={() => { source = !source; editing = source; }}>{source ? '阅读' : '源码'}</button>
          {/if}
          <span class="spacer"></span>
          <div class="document-actions">
            <button aria-label="复制全文" title="复制全文" onclick={async () => pushToast(await copyText(current!.body) ? '已复制全文' : '复制失败')}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></svg></button>
            <button aria-label="保存" title="保存 (Ctrl+S)" onclick={() => current?.flush()}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 3h13l4 4v14H3V3zM7 3v6h10V3M7 21v-8h10v8"/></svg></button>
            <button aria-label="移入回收站" title="移入回收站" onclick={() => showModal('trash')}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></svg></button>
          </div>
        </div>
        {#key activeId}
          <TextEditor bind:this={editor} body={current.body} id={current.detail.id} markdown={isMarkdown(current)} {source} {editing}
            readonly={current.detail.readonly || renameBusy} cursor={current.cursor} scroll={current.scroll}
            onchange={(body) => current?.edit(body)} oncomposition={(v) => current?.composition(v)} onasset={openAsset}
            onposition={(cursor, scroll) => { if (current) { current.cursor = cursor; current.scroll = scroll; persist(); } }}/>
        {/key}
        <footer><span class="save-state" class:problem={['error','conflict'].includes(current.state)}>{stateLabel[current.state]}</span><span>{Array.from(current.body.replace(/\s/g, '')).length} 字</span><span>{current.detail.encoding || '编码待选择'} · {current.detail.newline}</span>
          <span class="spacer"></span>
          <details class="document-options"><summary aria-label="文档选项" title="文档选项">⋯</summary><div>
            <button onclick={favorite}>{current.detail.favorite ? '取消收藏' : '收藏文本'}</button><button onclick={showMove}>移动文件</button>
            <label>标签<input aria-label="文本标签" placeholder="用逗号分隔" value={current.detail.tags.join('，')} onchange={(e) => tags(e.currentTarget.value)}/></label>
          </div></details><button onclick={showHistory}>历史版本</button><button title={current.detail.path} onclick={reveal}>文件位置</button><button onclick={() => newDocument(true)}>另存副本</button></footer></div>
      {:else}
        <div class="document-empty"><span class="empty-symbol">Aa</span><h2>文字，也是一份创作素材</h2><p>写提示词、整理剧本、收集灵感。<br/>文本保存在你的本地文件夹中。</p><div><button class="primary" onclick={() => newDocument()}>新建文本</button><button onclick={() => { pathInput = ''; preview = null; showModal('associate'); }}>关联本地文本</button></div><small>TXT · Markdown · SRT · VTT</small></div>
      {/if}
    </section>
  </div>
</div>

{#if modal && $textMode}
  <div class="text-modal-backdrop" role="presentation">
    <div class="text-modal" class:wide={['media','history','conflict'].includes(modal)} role="dialog" aria-modal="true" aria-label="文本操作" tabindex="-1" use:modalFocus>
      <header><h2>{{ new: copyBody === null ? '新建文本' : '另存副本', associate: '关联本地文本', history: '历史版本 · 保留 30 天', media: replaceHref ? '重新定位素材' : '插入素材', move: '重命名 / 移动原文件', conflict: '解决外部修改冲突', trash: '移入系统回收站', discard: '这份文本尚未保存' }[modal]}</h2><button disabled={busy} onclick={() => modal = ''}>×</button></header>
      {#if modalError}<div class="notice" role="alert">{modalError}</div>{/if}
      {#if modal === 'new' || modal === 'move'}
        <label>文件名称<input bind:value={filename}/></label>
        {#if modal === 'new' && copyBody === null}<label>格式<select bind:value={newFormat} onchange={() => filename = filename.replace(/\.(md|txt)$/i, '') + '.' + newFormat}><option value="md">Markdown (.md)</option><option value="txt">纯文本 (.txt)</option></select></label>{/if}
        <label>保存文件夹<input bind:value={directory} placeholder={$folderId !== null ? '留空使用当前项目文件夹' : '选择或输入本地文件夹路径'}/></label>
        {#if isTauri()}<button onclick={pickDirectory}>选择文件夹…</button>{/if}
        <p class="muted">保存为普通文件；同名文件不会被覆盖。</p>
        <button class="primary" disabled={busy || !filename.trim() || (!directory && $folderId === null)} onclick={modal === 'new' ? createDocument : moveDocument}>{busy ? '处理中…' : modal === 'new' ? '创建' : '移动 / 重命名'}</button>
      {:else if modal === 'associate'}
        <p>关联后直接编辑原文件。目录仅扫描 TXT、MD、Markdown、SRT、VTT，敏感路径自动排除。</p>
        <textarea aria-label="关联路径" bind:value={pathInput} oninput={() => preview = null} placeholder="每行一个本地文件或目录的完整路径" rows="4"></textarea>
        {#if isTauri()}<button disabled={busy} onclick={() => pickAssociations(false)}>选择文件…</button><button disabled={busy} onclick={() => pickAssociations(true)}>选择目录…</button>{/if}
        <button disabled={busy || !pathInput.trim()} onclick={() => previewPaths(pathInput.split('\n').map(x => x.trim()).filter(Boolean))}>预览范围</button>
        {#if preview}<div class="association-preview"><strong>将纳入 {preview.total} 个文本</strong><p>{Object.entries(preview.formats).filter(([,n]) => n).map(([f,n]) => `${f.toUpperCase()} ${n}`).join(' · ')}</p>{#each preview.errors as issue}<p>{issue.path}：{issue.reason}</p>{/each}</div>
          <button class="primary" disabled={busy || (!preview.total && !preview.roots?.length)} onclick={associate}>确认关联 · 编辑将保存到原文件</button>{/if}
      {:else if modal === 'history'}
        <div class="history-layout"><aside>{#each historyItems as h}<button class:chosen={h.id === historyId} onclick={() => previewHistory(h.id)}>{new Date(h.created * 1000).toLocaleString()}</button>{/each}{#if !historyItems.length}<p>尚无历史版本。修改并保存后，会保留修改前内容。</p>{/if}</aside><pre>{historyId ? historyBody || '（空白文档）' : '选择一个历史版本预览'}</pre></div>
        <p class="muted">恢复将替换当前正文，恢复前会保留当前版本。</p><button class="primary" disabled={busy || !historyId} onclick={restoreHistory}>恢复所选版本</button>
      {:else if modal === 'conflict'}
        <p>自动保存已暂停。请选择要保留的内容，也可以先另存副本。</p><div class="conflict-layout"><div><h3>当前编辑内容</h3><pre>{current?.body}</pre></div><div><h3>磁盘原文件</h3><pre>{diskBody}</pre></div></div>
        <div class="modal-actions"><button disabled={busy} onclick={() => newDocument(true)}>先另存当前内容</button><button disabled={busy} onclick={() => resolveConflict(false)}>放弃当前编辑，使用磁盘版本</button><button class="primary" disabled={busy} onclick={() => resolveConflict(true)}>保存当前编辑，替换磁盘版本</button></div>
      {:else if modal === 'discard'}
        <p>关闭标签前，请解决保存问题或另存副本。放弃编辑会清除这份未保存草稿，磁盘文件保持原样。</p>
        <button onclick={() => newDocument(true)}>另存副本</button><button onclick={() => modal = ''}>返回编辑</button><button class="danger" onclick={discardTab}>放弃未保存编辑并关闭</button>
      {:else if modal === 'trash'}
        <p>将删除磁盘原文件，并移入系统回收站：</p><pre>{current?.detail.path}</pre><p>回收站不可用时停止操作，不执行永久删除。</p><button class="danger" disabled={busy} onclick={trashDocument}>确认移入回收站</button>
      {:else if modal === 'media'}
        <div class="media-search"><select bind:value={mediaKind} onchange={() => loadMedia()}><option value="image">图片</option><option value="video">视频</option></select><input placeholder="搜索图库素材" bind:value={mediaQuery} onkeydown={(e) => { if (e.key === 'Enter') void loadMedia(); }}/><button onclick={() => loadMedia()}>搜索</button></div>
        <div class="media-grid">{#each mediaItems as item}<button onclick={() => insertMedia(item)}>{#if item.thumbnail_url || item.original_url}<img src={backendUrl(item.thumbnail_url || item.original_url!)} alt="" loading="lazy"/>{/if}<span>{item.filename}</span></button>{/each}</div>
        {#if mediaOffset < mediaTotal}<button onclick={() => loadMedia(true)}>加载更多素材</button>{/if}
        {#if !mediaItems.length}<p>没有找到素材，请先将图片或视频加入图库。</p>{/if}
      {/if}
    </div>
  </div>
{/if}
{#if assetPreview && current && $textMode}
  <div class="text-modal-backdrop" role="presentation"><div class="text-modal wide" role="dialog" aria-modal="true" aria-label="引用素材" tabindex="-1" use:modalFocus>
    <header><h2>引用素材</h2><button onclick={() => assetPreview = null}>×</button></header>
    {#if assetPreview.kind === 'image'}<img class="asset-large" src={backendUrl(`/api/texts/${current.detail.id}/asset?href=${encodeURIComponent(assetPreview.href)}`)} alt="引用图片"/>
    {:else}<video class="asset-large" controls src={backendUrl(`/api/texts/${current.detail.id}/asset?href=${encodeURIComponent(assetPreview.href)}`)}><track kind="captions"/></video>{/if}
    <button onclick={() => { const href = assetPreview!.href; assetPreview = null; showMedia(href); }}>重新定位</button>
    {#if assetPreview.kind === 'video'}<button onclick={() => { void videosApi.open(assetPreview!.id).catch(e => error = message(e)); }}>使用系统播放器打开</button>{/if}
    <button onclick={() => { void showInGallery().catch(e => error = message(e)); }}>在图库中查看</button>
  </div></div>
{/if}

<style>
  .text-workspace { height:100%; display:flex; flex-direction:column; min-width:0; background:#0e0e10; color:#dddce4; }
  button { cursor:pointer; border:1px solid transparent; border-radius:6px; padding:6px 9px; font-size:12px; white-space:nowrap; }
  button:hover:not(:disabled) { background:#323237; color:#fff; } button:disabled { opacity:.45; cursor:default; }
  button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible { outline:1px solid #d58e8e; outline-offset:2px; }
  input,select,textarea { background:#27272a; color:inherit; border:1px solid #383941; border-radius:6px; padding:7px 9px; font-size:13px; min-width:0; }
  .spacer { flex:1; }.muted { color:#8b8997; font-size:12px; }
  .workspace-header { background:#18181b; display:grid; grid-template-columns:minmax(100px,1fr) minmax(120px,2fr) minmax(180px,1fr); align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid #2e2e33; min-height:65px; flex-shrink:0; }
  .workspace-heading,.workspace-actions { display:flex; align-items:center; gap:6px; min-width:0; }.workspace-heading strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.workspace-actions { justify-content:flex-end; }.list-heading { display:flex; align-items:center; justify-content:space-between; padding:6px 10px; color:#91909c; font-size:11px; }
  .workspace-header strong { font-size:13px; }
  .workspace-body { flex:1; min-height:0; display:flex; }.text-list { flex-shrink:0; min-width:0; overflow:hidden; background:#18181b; display:flex; flex-direction:column; }
  .filters { margin:0 8px 10px; padding:10px; border:1px solid #2e2e33; border-radius:8px; background:#ffffff02; display:flex; flex-direction:column; gap:10px; flex-shrink:0; }
  .filter-selects { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:8px; }.filter-field { display:flex; flex-direction:column; gap:5px; min-width:0; }.filter-field > span { font-size:10px; color:#8a8a8e; }
  .select-wrap { position:relative; }.filters select { appearance:none; width:100%; height:29px; padding:0 22px 0 8px; font-size:11px; border:1px solid #323237; border-radius:5px; background:#222225; color:#d4d4d8; }.select-wrap svg { position:absolute; right:7px; top:9px; pointer-events:none; color:#8a8a8e; }
  .tag-filter { display:flex; align-items:center; gap:6px; height:29px; padding:0 8px; background:#222225; border:1px solid #323237; border-radius:5px; color:#8a8a8e; }.tag-filter input { width:100%; border:0; background:transparent; padding:0; height:25px; font-size:11px; outline:none; }.tag-filter:focus-within { border-color:#77777f; }
  .filter-options { display:flex; align-items:center; justify-content:space-between; min-height:20px; }.favorite-filter { display:flex; gap:6px; align-items:center; font-size:11px; color:#a1a1aa; cursor:pointer; }.favorite-filter input { width:12px; height:12px; margin:0; padding:0; accent-color:#f24e4e; }.clear-filters { padding:2px 0; font-size:10px; color:#a1a1aa; }

  .list-scroll { flex:1; overflow:auto; padding:0 6px 8px; }
  .text-row { font-size:12px; width:100%; display:block; text-align:left; border-radius:5px; padding:7px 12px; border:0; white-space:normal; }
  .text-row.selected { background:#27272a; }.text-row div { display:flex; justify-content:space-between; gap:8px; }.text-row strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500; }
  .text-row p { color:#96939f; font-size:12px; display:-webkit-box; -webkit-line-clamp:2; line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; margin:7px 0; }
  .open-document { display:flex; flex-direction:column; flex:1; min-height:0; }
  .document-area { flex:1; min-width:0; display:flex; flex-direction:column; }.document-tabs { background:#18181b; display:flex; flex-shrink:0; overflow:auto; border-bottom:1px solid #2e2e33; min-height:37px; }.document-tabs div { display:flex; border-right:1px solid #2e2e33; padding:2px; }.document-tabs .active { background:#27272a; box-shadow:inset 0 -2px #c58a8a; }
  .save-state { font-size:11px; color:#8daba1; }.save-state.problem { color:#edb37c; }
  .document-options { position:relative; }.document-options summary { cursor:pointer; list-style:none; padding:4px 8px; }.document-options > div { position:absolute; right:0; bottom:100%; z-index:10; width:230px; padding:10px; border:1px solid #383941; background:#27272a; border-radius:8px; box-shadow:0 8px 25px #0006; }.document-options label { display:flex; flex-direction:column; gap:6px; margin-top:8px; font-size:12px; }
  .document-actions { flex-shrink:0; display:flex; position:sticky; right:-18px; padding-inline:8px; background:#18181b; margin-left:auto; gap:2px; }.document-actions button { display:grid; place-items:center; }
  .text-row { cursor:pointer; }.text-row input { width:100%; padding:2px 4px; }.dragging { user-select:none; cursor:grabbing; }.drag-source { opacity:.5; }.drop-before { box-shadow:inset 0 2px #f24e4e; }.drop-after { box-shadow:inset 0 -2px #f24e4e; }
  .text-toolbar { background:#18181b; display:flex; gap:2px; padding:7px 18px; border-block:1px solid #2e2e33; align-items:center; overflow-x:auto; flex-shrink:0; }.text-toolbar button { padding:4px 7px; flex-shrink:0; }
  .chosen { background:#39313b; color:#e9b3b3; }footer { background:#18181b; display:flex; align-items:center; gap:14px; font-size:11px; color:#8c8996; border-top:1px solid #2e2e33; padding:6px 20px; }
  .notice { background:#433325; color:#f0ce9b; padding:10px 15px; font-size:12px; white-space:pre-wrap; }.notice button { margin-left:8px; background:#594434; }
  .drop-note { background:#523d46; padding:14px; text-align:center; }.empty-list { font-size:12px; color:#97939f; padding:24px 16px; line-height:1.8; }
  .document-empty { flex:1; display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center; gap:16px; padding:30px; }.empty-symbol { font:60px Georgia,serif; color:#a77e89; }.document-empty h2 { font-size:23px; }.document-empty p { color:#96919f; font-size:14px; line-height:1.9; }.document-empty small { margin-top:16px; color:#777381; }.document-empty button { padding:9px 16px; margin:0 5px; }
  .primary { background:#a86775; color:white; }.danger { background:#934747; color:white; }
  .text-modal-backdrop { position:fixed; inset:0; background:#0009; z-index:90; display:flex; align-items:center; justify-content:center; padding:25px; color:#dddce4; }
  .text-modal { width:540px; max-width:96vw; max-height:90vh; overflow:auto; border:1px solid #44404a; border-radius:12px; background:#18181b; padding:22px; box-shadow:0 22px 90px #0008; font-size:13px; }
  .text-modal.wide { width:920px; }.text-modal header { display:flex; align-items:center; justify-content:space-between; margin-bottom:18px; }.text-modal h2 { font-size:18px; font-weight:600; }.text-modal label { display:flex; flex-direction:column; gap:7px; margin:14px 0; }.text-modal p { line-height:1.8; margin:12px 0; }.text-modal textarea { width:100%; margin:12px 0; }.text-modal button { border-color:#49424c; margin:3px; }.text-modal pre { white-space:pre-wrap; overflow-wrap:anywhere; font:13px/1.8 Consolas,'Microsoft YaHei',monospace; background:#0e0e10; padding:14px; border-radius:6px; }
  .history-layout { display:grid; grid-template-columns:190px 1fr; height:400px; gap:16px; }.history-layout aside,.history-layout pre { overflow:auto; }.history-layout aside button { display:block; width:95%; text-align:left; }.conflict-layout { display:grid; grid-template-columns:1fr 1fr; gap:16px; }.conflict-layout pre { height:320px; overflow:auto; }.conflict-layout h3 { margin:10px 0; }.modal-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:6px; margin-top:15px; }
  .media-search { display:flex; gap:10px; }.media-search input { flex:1; }.media-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; max-height:480px; overflow:auto; margin:16px 0; }.media-grid button { overflow:hidden; white-space:normal; }.media-grid img { width:100%; height:100px; object-fit:cover; }.media-grid span { display:block; font-size:11px; overflow-wrap:anywhere; margin:6px; }.asset-large { display:block; width:100%; max-height:65vh; object-fit:contain; }
  @media(max-width:900px) { .media-grid { grid-template-columns:repeat(3,1fr); } }
</style>
