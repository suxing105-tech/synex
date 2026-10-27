<script lang="ts">
  /**
   * 文本阅读层：中间栏里文本的「打开态」，与 Lightbox / VideoPlayer 同一层。
   *
   * 为什么不再用全屏工作区：文本和图片一样只是素材，点开就该在同一个框里读，
   * Esc 回缩略图，左右侧栏不动。读 + 复制是主路径，编辑就地发生，
   * 所以自动保存 / 版本冲突 / 草稿这套文档状态搬到这里，标签页那套不再需要。
   */
  import { onMount, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { backendUrl } from '../lib/backend-url';
  import { imagesApi, videosApi } from '../lib/api';
  import { isTextItem } from '../lib/items';
  import { isTypingTarget, modalFocus } from '../lib/modal-focus';
  import { pushToast } from '../lib/toast';
  import { revealLocation } from '../lib/reveal';
  import { matchesAction } from '../lib/shortcut-settings';
  import { closeTextReader, feedItems, markTextFeedStale, openTextReader, readerWantsEdit, refreshFolders, refreshFeed, selectedId, selectedText, switchContent } from '../lib/stores';
  import { copyText } from '../lib/ws';
  import { textsApi, TextSession, type TextDraft, type TextHistory } from '../lib/texts';
  import { SAVE_STATE_LABEL, hitOffsets, loadReaderPrefs, readerPosition, saveReaderPrefs, stepFontScale, stepHit, textFormatLabel, textFeedItemOf, type ReaderPrefs, type ReaderWidth } from '../lib/text-reading';
  import type { ImageSummary, TextFeedItem } from '../lib/types';
  import ContextMenu, { type ContextMenuItem } from './ContextMenu.svelte';
  import TextCreateModal from './TextCreateModal.svelte';
  import TextEditor from './TextEditor.svelte';

  interface Props { open: boolean; item: TextFeedItem | null; term?: string; }
  let { open, item, term = '' }: Props = $props();

  const ENCODINGS = ['utf-8', 'gb18030', 'big5', 'utf-16le'];
  const message = (e: unknown) => e instanceof Error ? e.message : String(e);

  /**
   * TextSession 自己管保存队列与定时器，塞进 $state 会让 Svelte 在异步回调里
   * 追不住半途状态；所以只用 revision 当发布信号，模板一律读 current。
   */
  let session: TextSession | null = null;
  let revision = $state(0);
  let current = $derived.by(() => { revision; return session ? new Proxy(session, {}) : null; });
  // 关闭时正文存不下去就留在这里，重开同一篇时提示并继续编辑（不落 localStorage，避免跨设备误恢复）。
  const drafts = new Map<number, TextDraft>();
  let lastState = 'saved';
  function changed() {
    revision++;
    if (session && lastState === 'saving' && session.state === 'saved') markTextFeedStale();
    if (session) lastState = session.state;
  }

  type ModalKind = '' | 'history' | 'move' | 'tags' | 'conflict' | 'trash' | 'media' | 'copy';
  let modal = $state<ModalKind>('');
  let encodingMode = $state(false);
  let busy = $state(false);
  let modalError = $state('');
  let editor = $state<TextEditor>();
  let loading = $state(false);
  let loadError = $state('');
  let notice = $state('');
  let editing = $state(false);
  let source = $state(false);
  let encodingChosen = $state(false);
  let hits = $state<number[]>([]);
  let hitAt = $state(0);
  let prefs = $state<ReaderPrefs>(loadReaderPrefs());
  let requestId = 0;

  const isMarkdown = $derived.by(() => { revision; return !!session && ['md', 'markdown'].includes(session.detail.format); });
  const canEdit = $derived.by(() => { revision; return !!session && !session.detail.readonly && !session.detail.needs_encoding; });
  const sequence = $derived($feedItems.filter(isTextItem));
  const position = $derived(item ? sequence.findIndex(x => x.id === item.id) : -1);
  async function dropSession() {
    const closing = session;
    if (!closing) return;
    session = null; revision++;
    try { await closing.flush(); } catch { /* 失败原因已记在 closing.error */ }
    // 存不下去（冲突 / 只读 / 网络断）就把草稿留在内存里，重开这篇时提示，不静默丢字。
    if (closing.dirty) drafts.set(closing.detail.id, closing.draft);
    closing.dispose();
  }

  async function close() {
    modal = ''; assetPreview = null; menuOpen = false;
    await dropSession();
    await closeTextReader();
  }

  /** 翻页序列 = 当前流里的文本项；不在序列里（从引用跳进来）就从首/尾开始。 */
  async function openAdjacent(delta: 1 | -1) {
    const list = sequence;
    if (!list.length) return;
    const at = list.findIndex(x => x.id === item?.id);
    const nextAt = at < 0 ? (delta > 0 ? 0 : list.length - 1) : at + delta;
    const next = list[Math.min(Math.max(nextAt, 0), list.length - 1)];
    if (!next || next.id === item?.id) return;
    await dropSession();
    openTextReader(next, term);
  }

  function gotoHit(delta: 1 | -1) {
    const at = stepHit(hits, hitAt, delta);
    if (at < 0) return;
    hitAt = at;
    void editor?.locate(hits[at], term.length);
  }

  // 打开 / 换篇：先冲掉上一篇，再取详情。term 是打开瞬间的搜索词快照，故意不做成依赖。
  $effect(() => {
    const isOpen = open, id = item?.id ?? null;
    if (!isOpen || id === null) { void dropSession(); return; }
    const request = ++requestId;
    void (async () => {
      await dropSession();
      if (request !== requestId) return;
      loading = true; loadError = ''; notice = '';
      try {
        const fresh = await textsApi.detail(id, undefined, true);
        if (request !== requestId) return;
        const draft = drafts.get(id);
        session = new TextSession(fresh, changed, textsApi, draft);
        drafts.delete(id);
        if (draft && draft.body !== fresh.body) notice = '恢复了上次未保存的正文，已继续自动保存。';
        lastState = session.state;
        // 「就地编辑」的意图只活过一次打开：只读或编码待选时回落到阅读态，别给用户一个点不动的光标。
        const wantsEdit = get(readerWantsEdit);
        readerWantsEdit.set(false);
        editing = wantsEdit && !fresh.readonly && !fresh.needs_encoding;
        source = false; encodingChosen = false; modal = ''; modalError = ''; encodingMode = false;
        hits = hitOffsets(session.body, term); hitAt = 0;
        loading = false; revision++;
        if (hits.length) { await tick(); await editor?.locate(hits[0], term.length); }
      } catch (e) { if (request === requestId) { loadError = message(e); loading = false; } }
    })();
  });

  /** 光标与滚动位置只服务草稿恢复，不触发重渲染，所以直接写回 session。 */
  function rememberPosition(cursor: number, scroll: number) {
    if (!session) return;
    session.cursor = cursor; session.scroll = scroll;
  }

  async function saveNow() { await session?.flush(); }
  async function toggleEditing() {
    if (!editing && !canEdit) return;
    editing = !editing;
    if (!editing) await session?.flush();
  }
  async function insert(before: string, after = '') { editing = true; await tick(); await editor?.insert(before, after); }
  async function copyAll() {
    if (!session) return;
    await session.flush();
    const ok = await copyText(session.body).catch(() => false);
    pushToast(ok ? '已复制全文' : '复制失败，请手动选择正文', { kind: ok ? 'success' : 'error' });
  }
  function setWidth(next: ReaderWidth) { prefs = { ...prefs, width: next }; saveReaderPrefs(prefs); }
  function zoom(delta: 1 | -1) { prefs = { ...prefs, fontScale: stepFontScale(prefs.fontScale, delta) }; saveReaderPrefs(prefs); }

  // 键盘走 window capture：Feed 的按键监听先注册，冒泡阶段抢不过它。
  function onKey(e: KeyboardEvent) {
    if (!open) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopImmediatePropagation(); void saveNow(); return; }
    if (e.key === 'Escape') {
      if (modal || assetPreview) { if (!busy) { modal = ''; assetPreview = null; } e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (session?.composing) return;   // 输入法合成中：Esc 是取消候选词，不是关窗
      e.preventDefault(); e.stopImmediatePropagation(); void close(); return;
    }
    if (modal || assetPreview || menuOpen) return;
    if (isTypingTarget(e.target)) return;
    if (matchesAction(e, 'previous')) { e.preventDefault(); e.stopImmediatePropagation(); void openAdjacent(-1); return; }
    if (matchesAction(e, 'next')) { e.preventDefault(); e.stopImmediatePropagation(); void openAdjacent(1); }
  }
  /** 复制文件本身（粘进文件夹就是那个文件）；顶栏的「复制全文」复制的是正文。 */
  async function copyTextFile() {
    const it = item;
    if (!it) return;
    try {
      await textsApi.copyFile(it.id);
      pushToast(`已复制文本文件到剪贴板（${it.filename}）`, { kind: 'success' });
    } catch (e) { pushToast(`复制文本文件失败：${message(e)}`, { kind: 'error' }); }
  }

  onMount(() => {
    window.addEventListener('keydown', onKey, true);
    // Ctrl+F 要先退出阅读层才能聚焦搜索框，退出必须走这里（先落盘再关）。
    const closeOnRequest = () => { if (open) void close(); };
    window.addEventListener('close-text-reader', closeOnRequest);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('close-text-reader', closeOnRequest);
    };
  });
  // ---------- 文档操作 ----------
  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  function openMenu(e: MouseEvent) { menuX = e.clientX; menuY = e.clientY; menuOpen = true; }
  const menuItems = $derived<ContextMenuItem[]>([
    { label: '历史版本', onClick: () => void showHistory() },
    { label: '另存副本', onClick: () => showCopy() },
    { label: '重命名 / 移动原文件', onClick: () => showMove() },
    { label: '标签', onClick: () => openTags(false) },
    { label: '重新选择编码', onClick: () => openTags(true) },
    { label: '复制文本文件', onClick: () => void copyTextFile() },
    { label: '文件位置', onClick: () => void reveal() },
    { kind: 'sep' },
    { label: '移入回收站', danger: true, onClick: () => { modal = 'trash'; modalError = ''; } },
  ]);

  let tagValue = $state('');
  function openTags(asEncoding: boolean) {
    if (!session) return;
    tagValue = session.detail.tags.join('，');
    encodingMode = asEncoding;
    modal = 'tags'; modalError = '';
  }
  async function saveTags() {
    if (!session) return;
    try {
      const result = await textsApi.meta(session.detail.id, { tags: tagValue.split(/[,，]/).map(x => x.trim()).filter(Boolean) });
      Object.assign(session.detail, result);
      markTextFeedStale(); revision++; modal = '';
    } catch (e) { modalError = message(e); }
  }
  async function changeEncoding(value: string) {
    const closing = session;
    if (!closing || !value) return;
    try {
      closing.acceptDisk(await textsApi.detail(closing.detail.id, value));
      encodingChosen = true; modal = ''; modalError = '';
      hits = hitOffsets(closing.body, term); hitAt = 0;
    } catch (e) { modalError = message(e); notice = message(e); }
  }

  let filename = $state('');
  let directory = $state('');
  function showMove() {
    if (!session) return;
    filename = session.detail.filename;
    directory = session.detail.path.replace(/[\\/][^\\/]+$/, '');
    modal = 'move'; modalError = '';
  }
  async function moveDocument() {
    const target = session; if (!target) return;
    busy = true; modalError = '';
    try {
      await target.flush();
      if (target.dirty) throw new Error('请先保存正文或处理冲突，再改文件名');
      target.acceptDisk(await textsApi.move(target.detail.id, directory, filename, target.detail.version));
      markTextFeedStale(); modal = '';
    } catch (e) { modalError = message(e); } finally { busy = false; }
  }

  let historyItems = $state<TextHistory[]>([]);
  let historyId = $state('');
  let historyBody = $state('');
  async function showHistory() {
    const target = session; if (!target) return;
    modal = 'history'; modalError = ''; busy = true; historyId = ''; historyBody = '';
    try { historyItems = await textsApi.history(target.detail.id); } catch (e) { modalError = message(e); } finally { busy = false; }
  }
  async function previewHistory(ident: string) {
    const target = session; if (!target) return;
    historyId = ident;
    try { const h = await textsApi.historical(target.detail.id, ident); if (ident === historyId) historyBody = h.body; } catch (e) { modalError = message(e); }
  }
  async function restoreHistory() {
    const target = session; if (!target || !historyId) return;
    busy = true;
    try {
      await target.flush();
      if (target.dirty) throw new Error('请先解决当前文档的保存问题');
      target.acceptDisk(await textsApi.restore(target.detail.id, historyId, target.detail.version));
      markTextFeedStale(); modal = '';
    } catch (e) { modalError = message(e); } finally { busy = false; }
  }

  let diskBody = $state('');
  async function showConflict() {
    const target = session; if (!target) return;
    modal = 'conflict'; modalError = ''; busy = true; diskBody = '';
    try { diskBody = (await textsApi.detail(target.detail.id)).body; } catch (e) { modalError = message(e); } finally { busy = false; }
  }
  async function resolveConflict(mine: boolean) {
    const target = session; if (!target) return;
    busy = true;
    try {
      if (mine) { await target.keepMine(); if (target.dirty) throw new Error(target.error); }
      else target.acceptDisk(await textsApi.detail(target.detail.id));
      modal = '';
    } catch (e) { modalError = message(e); } finally { busy = false; }
  }

  async function trashDocument() {
    const target = session; if (!target) return;
    busy = true; modalError = '';
    try {
      await target.flush();
      if (target.dirty) throw new Error('请先保存正文或处理冲突');
      await textsApi.trash(target.detail.id, target.detail.version);
      target.dispose(); session = null; revision++;
      modal = ''; selectedText.set(null); markTextFeedStale();
      await refreshFolders();
      await closeTextReader();
    } catch (e) { modalError = message(e); } finally { busy = false; }
  }

  async function reveal() {
    const target = session; if (!target) return;
    try { await revealLocation(target.detail.path, true, () => textsApi.reveal(target.detail.id)); }
    catch (e) { await copyText(target.detail.path); notice = message(e) + '（已复制文件路径）'; }
  }
  let copyBody = $state<string | null>(null);
  let copyName = $state('');
  let copyDirectory = $state('');
  let copyFormat = $state('md');
  function showCopy() {
    if (!session) return;
    copyBody = session.body;
    copyName = session.detail.filename.replace(/(\.[^.]+)$/, '-副本$1');
    copyFormat = session.detail.format;
    copyDirectory = session.detail.path.replace(/[\\/][^\\/]+$/, '');
    modal = 'copy'; modalError = '';
  }
  async function createCopy(value: { directory: string; name: string; format: string }) {
    busy = true; modalError = '';
    try {
      const name = value.name.replace(/\.(txt|md|markdown|srt|vtt)$/i, '') + '.' + value.format;
      const created = await textsApi.create({ directory: value.directory, name, body: copyBody ?? '' });
      modal = ''; copyBody = null;
      await Promise.all([refreshFolders(), refreshFeed({ keepScroll: true })]);
      openTextReader(textFeedItemOf(created), '');
    } catch (e) { modalError = message(e); } finally { busy = false; }
  }

  // ---------- 引用素材 ----------
  let mediaQuery = $state('');
  let mediaKind = $state<'image' | 'video'>('image');
  let mediaItems = $state<ImageSummary[]>([]);
  let mediaOffset = $state(0);
  let mediaTotal = $state(0);
  let replaceHref = $state('');
  let mediaRequest = 0;
  async function loadMedia(append = false) {
    const request = ++mediaRequest; modalError = '';
    try {
      const r = await imagesApi.list({ kind: mediaKind, q: mediaQuery, limit: 48, offset: append ? mediaOffset : 0 });
      if (request !== mediaRequest) return;
      mediaItems = append ? [...mediaItems, ...r.items] : r.items;
      mediaOffset = mediaItems.length; mediaTotal = r.total;
    } catch (e) { modalError = message(e); }
  }
  function showMedia(href = '') {
    replaceHref = href; mediaQuery = ''; mediaItems = []; mediaOffset = 0;
    modal = 'media'; modalError = ''; void loadMedia();
  }
  async function insertMedia(picked: ImageSummary) {
    const target = session; if (!target) return;
    try {
      const r = await textsApi.reference(target.detail.id, picked.id);
      if (replaceHref) target.edit(target.body.split(`](${replaceHref})`).join(`](${r.href})`).split(`](<${replaceHref}>)`).join(`](${r.href})`));
      else await insert('\n' + r.markdown + '\n');
      if (!r.portable) pushToast('素材位于其他磁盘，引用使用绝对路径');
      modal = '';
    } catch (e) { modalError = message(e); }
  }

  let assetPreview = $state<{ href: string; id: number; kind: 'image' | 'video' } | null>(null);
  async function openAsset(href: string) {
    const target = session; if (!target) return;
    try {
      const info = await textsApi.assetInfo(target.detail.id, href);
      if (info.kind === 'text') {
        const detail = await textsApi.detail(info.id);
        await dropSession();
        openTextReader(textFeedItemOf(detail), term);
      } else assetPreview = { href, id: info.id, kind: info.kind };
    } catch { showMedia(href); modalError = '素材失效或未加入图库，请选择替代素材'; }
  }
  /** 「在图库中查看」：先退回缩略图，再让同一层里的 Lightbox / VideoPlayer 接管这一篇素材。 */
  async function showInGallery() {
    if (!assetPreview) return;
    const picked = assetPreview;
    await close();
    switchContent(picked.kind, true);
    await refreshFeed();
    if (!get(feedItems).some(x => x.item_type === 'media' && x.id === picked.id)) {
      const detail = await imagesApi.detail(picked.id);
      feedItems.update(list => [{ ...detail, item_type: 'media' } as (typeof list)[number], ...list]);
    }
    selectedId.set(picked.id);
    await tick();
    window.dispatchEvent(new CustomEvent(picked.kind === 'video' ? 'open-video-player' : 'open-lightbox', { detail: { id: picked.id } }));
  }
</script>

{#if open}
<section class="inline-viewer absolute inset-0 z-20 flex flex-col bg-bg overflow-hidden fill-interactions" aria-label="文本阅读">
  <header class="reader-header flex items-center gap-2 px-4 py-3 shrink-0 border-b border-border bg-surface">
    <button class="rounded-lg px-3 py-2 text-xs" onclick={() => void close()} title="返回缩略图（Esc）">← 返回</button>
    <span class="flex-1 min-w-0 truncate text-xs text-muted" title={current?.detail.path || item?.path || ''}>{current?.detail.filename || item?.filename || ''}</span>
    <span class="format-badge">{textFormatLabel(current?.detail.format || item?.format || '')}</span>
    {#if canEdit}
      <button class="rounded-lg px-3 py-2 text-xs" aria-pressed={editing} onclick={() => void toggleEditing()}>{editing ? '完成编辑' : '编辑'}</button>
    {/if}
    <button class="rounded-lg px-3 py-2 text-xs" onclick={() => void copyAll()}>复制全文</button>
    <button class="rounded-lg px-3 py-2 text-xs" aria-label="更多操作" aria-haspopup="menu" aria-expanded={menuOpen} onclick={(e) => { e.stopPropagation(); openMenu(e); }}>⋯</button>
  </header>  {#if loadError || current?.error || notice}
    <div class="notice" role="status">
      {loadError || current?.error || notice}
      {#if current?.state === 'conflict'}<button onclick={() => void showConflict()}>处理冲突</button>
      {:else if current?.state === 'error'}<button onclick={() => void saveNow()}>重试保存</button>{/if}
      <button onclick={() => { notice = ''; }}>知道了</button>
    </div>
  {/if}
  {#if current?.detail.needs_encoding && !encodingChosen}
    <div class="notice" role="status">无法确定文字编码，先选一种再读；选错不会改动文件。
      {#each ENCODINGS as code}<button onclick={() => void changeEncoding(code)}>{code.toUpperCase()}</button>{/each}
    </div>
  {/if}
  {#if current?.detail.readonly}
    <div class="notice" role="status">文件是只读的：可以阅读、复制，或另存副本后编辑。</div>
  {/if}

  {#if editing && isMarkdown}
    <div class="text-toolbar" role="toolbar" aria-label="Markdown 工具">
      <button onclick={() => void insert('## ', '')}>H2</button>
      <button onclick={() => void insert('**', '**')}>B</button>
      <button onclick={() => void insert('*', '*')}>I</button>
      <button onclick={() => void insert('\n- ', '')}>列表</button>
      <button onclick={() => void insert('\n- [ ] ', '')}>待办</button>
      <button onclick={() => void insert('\n> ', '')}>引用</button>
      <button onclick={() => void insert('[', '](https://)')}>链接</button>
      <button onclick={() => void insert('\n```\n', '\n```\n')}>代码</button>
      <button onclick={() => void insert('\n| 列 | 列 |\n| --- | --- |\n|  |  |\n', '')}>表格</button>
      <button onclick={() => showMedia()}>插入素材</button>
      <button aria-pressed={source} onclick={() => source = !source}>源码</button>
    </div>
  {/if}

  <div class="reader-body flex flex-col min-h-0 flex-1" role="region" aria-label="正文" ondblclick={(e) => { if (!editing && e.target === e.currentTarget) void close(); }}>
    {#if loading || !current}
      <p class="state-line" role="status">{loadError ? '这篇文本打不开' : '正在读取正文…'}</p>
    {:else}
      {#key current.detail.id}
        <TextEditor bind:this={editor} body={current.body} id={current.detail.id} markdown={isMarkdown}
          readonly={current.detail.readonly} {source} {editing} cursor={current.cursor} scroll={current.scroll}
          highlight={term} pageWidth={prefs.width === 'wide' ? '1280px' : '880px'} pageFontSize={`${Math.round(16 * prefs.fontScale)}px`}
          onchange={(value) => session?.edit(value)}
          onposition={rememberPosition}
          oncomposition={(active) => session?.composition(active)}
          onasset={(href) => void openAsset(href)} />
      {/key}
    {/if}
  </div>

  <footer class="reader-footer flex flex-wrap items-center gap-2 px-4 py-3 shrink-0 border-t border-border bg-surface text-xs">
    <div class="flex items-center gap-1">
      <button class="rounded-lg px-3 py-2" title="上一篇" aria-label="上一篇文本" onclick={() => void openAdjacent(-1)}>‹</button>
      <span class="text-muted">{readerPosition(position, sequence.length)}</span>
      <button class="rounded-lg px-3 py-2" title="下一篇" aria-label="下一篇文本" onclick={() => void openAdjacent(1)}>›</button>
    </div>
    <span class="reader-state" class:problem={current ? ['conflict', 'error'].includes(current.state) : false}>{current ? SAVE_STATE_LABEL[current.state] : ''}</span>
    <span class="text-muted">{current ? `${current.body.length} 字` : ''}{#if current} · {textFormatLabel(current.detail.format)}{/if}{#if current} · {current.detail.encoding || '自动'} · {current.detail.newline}{/if}</span>
    {#if hits.length}
      <button class="rounded-lg px-3 py-2" onclick={() => gotoHit(1)}>下一个命中（{Math.min(hitAt + 1, hits.length)}/{hits.length}）</button>
    {/if}
    <span class="flex-1"></span>
    <div class="flex items-center gap-1" role="group" aria-label="阅读版式">
      <button class="rounded-lg px-3 py-2" aria-pressed={prefs.width === 'narrow'} onclick={() => setWidth('narrow')}>窄栏</button>
      <button class="rounded-lg px-3 py-2" aria-pressed={prefs.width === 'wide'} onclick={() => setWidth('wide')}>页宽</button>
      <button class="rounded-lg px-3 py-2" aria-label="小一号字" onclick={() => zoom(-1)}>A-</button>
      <button class="rounded-lg px-3 py-2" aria-label="大一号字" onclick={() => zoom(1)}>A+</button>
    </div>
    <span class="text-muted hidden xl:inline">Esc 返回缩略图 · ← / → 翻文本 · Ctrl+S 立即保存</span>
  </footer>
</section>
{/if}
<ContextMenu bind:open={menuOpen} x={menuX} y={menuY} items={menuItems} />

{#if modal}
  <div class="text-modal-backdrop" role="presentation">
    <div class="text-modal" class:wide={['media', 'history', 'conflict'].includes(modal)} role="dialog" aria-modal="true" aria-label="文本操作" tabindex="-1" use:modalFocus>
      <header>
        <h2>{{ copy: '另存副本', history: '历史版本 · 保留 30 天', tags: encodingMode ? '重新选择编码' : '标签', move: '重命名 / 移动原文件', conflict: '解决外部修改冲突', trash: '移入系统回收站', media: replaceHref ? '重新定位素材' : '插入素材' }[modal]}</h2>
        <button disabled={busy} onclick={() => { modal = ''; encodingMode = false; }}>×</button>
      </header>
      {#if modalError}<div class="notice" role="alert">{modalError}</div>{/if}
      {#if modal === 'move'}
        <label>文件名称<input bind:value={filename} /></label>
        <label>所在文件夹<input bind:value={directory} placeholder="留空保持原位置" /></label>
        <p class="muted">改名与移动都作用在磁盘原文件上，图库记录跟着走。</p>
        <button class="primary" disabled={busy || !filename.trim()} onclick={() => void moveDocument()}>{busy ? '处理中…' : '移动 / 重命名'}</button>
      {:else if modal === 'tags'}
        {#if encodingMode}
          <p>当前编码读出来不对？选一种重新读；这一步不会改写文件。</p>
          <div class="modal-actions">{#each ENCODINGS as code}<button disabled={busy} onclick={() => void changeEncoding(code)}>{code.toUpperCase()}</button>{/each}</div>
        {:else}
          <label>标签（用逗号分隔）<input bind:value={tagValue} placeholder="例如：剧本，灵感" /></label>
          <button class="primary" onclick={() => void saveTags()}>保存标签</button>
        {/if}
      {:else if modal === 'history'}
        <div class="history-layout">
          <aside>
            {#each historyItems as entry (entry.id)}<button class:chosen={entry.id === historyId} onclick={() => void previewHistory(entry.id)}>{new Date(entry.created * 1000).toLocaleString()}</button>{/each}
            {#if !historyItems.length}<p>尚无历史版本。修改并保存后，会保留修改前的内容。</p>{/if}
          </aside>
          <pre>{historyId ? historyBody || '（空白文档）' : '选择一个历史版本预览'}</pre>
        </div>
        <p class="muted">恢复会替换当前正文，恢复前先把当前版本存进历史。</p>
        <button class="primary" disabled={busy || !historyId} onclick={() => void restoreHistory()}>恢复所选版本</button>
      {:else if modal === 'conflict'}
        <p>自动保存已暂停。请选择保留哪一份，也可以先另存副本。</p>
        <div class="conflict-layout"><div><h3>当前编辑内容</h3><pre>{current?.body}</pre></div><div><h3>磁盘原文件</h3><pre>{diskBody}</pre></div></div>
        <div class="modal-actions">
          <button disabled={busy} onclick={() => { modal = ''; showCopy(); }}>先另存当前内容</button>
          <button disabled={busy} onclick={() => void resolveConflict(false)}>用磁盘版本</button>
          <button class="primary" disabled={busy} onclick={() => void resolveConflict(true)}>保留我的编辑并保存</button>
        </div>
      {:else if modal === 'trash'}
        <p>会把磁盘原文件一起移入系统回收站：</p><pre>{current?.detail.path}</pre>
        <p>回收站不可用时会停止操作，不做永久删除。</p>
        <div class="modal-actions"><button disabled={busy} onclick={() => modal = ''}>取消</button><button class="danger" disabled={busy} onclick={() => void trashDocument()}>确认移入回收站</button></div>
      {:else if modal === 'media'}
        <div class="media-search">
          <select bind:value={mediaKind} onchange={() => void loadMedia()}><option value="image">图片</option><option value="video">视频</option></select>
          <input placeholder="搜索图库素材" bind:value={mediaQuery} onkeydown={(e) => { if (e.key === 'Enter') void loadMedia(); }} />
          <button onclick={() => void loadMedia()}>搜索</button>
        </div>
        <div class="media-grid">
          {#each mediaItems as picked (picked.id)}
            <button onclick={() => void insertMedia(picked)}>
              {#if picked.thumbnail_url || picked.original_url}<img src={backendUrl(picked.thumbnail_url || picked.original_url!)} alt="" loading="lazy" />{/if}
              <span>{picked.filename}</span>
            </button>
          {/each}
        </div>
        {#if mediaOffset < mediaTotal}<button onclick={() => void loadMedia(true)}>加载更多素材</button>{/if}
        {#if !mediaItems.length}<p>没有找到素材，请先将图片或视频加入图库。</p>{/if}
      {/if}
    </div>
  </div>
{/if}

{#if assetPreview && current}
  <div class="text-modal-backdrop" role="presentation">
    <div class="text-modal wide" role="dialog" aria-modal="true" aria-label="引用素材" tabindex="-1" use:modalFocus>
      <header><h2>引用素材</h2><button onclick={() => assetPreview = null}>×</button></header>
      {#if assetPreview.kind === 'image'}
        <img class="asset-large" src={backendUrl(`/api/texts/${current.detail.id}/asset?href=${encodeURIComponent(assetPreview.href)}`)} alt="引用图片" />
      {:else}
        <video class="asset-large" controls src={backendUrl(`/api/texts/${current.detail.id}/asset?href=${encodeURIComponent(assetPreview.href)}`)}><track kind="captions" /></video>
      {/if}
      <div class="modal-actions">
        <button onclick={() => { const href = assetPreview!.href; assetPreview = null; showMedia(href); }}>重新定位</button>
        {#if assetPreview.kind === 'video'}<button onclick={() => void videosApi.open(assetPreview!.id).catch(e => { notice = message(e); })}>使用系统播放器打开</button>{/if}
        <button class="primary" onclick={() => void showInGallery()}>在图库中查看</button>
      </div>
    </div>
  </div>
{/if}

<TextCreateModal open={modal === 'copy'} title="另存副本" defaultName={copyName} defaultFormat={copyFormat} defaultDirectory={copyDirectory}
  error={modalError} busy={busy} onSubmit={(value) => void createCopy(value)} onClose={() => { modal = ''; copyBody = null; }} />
<style>
  /* 阅读层自己就是一层内嵌视图：顶栏 / 正文 / 底栏三段，弹层只盖中间栏，不铺满屏幕。 */
  .reader-header button, .reader-footer button, .text-toolbar button { cursor: pointer; border: 1px solid #3a3a41; background: #232327; color: #d9d8e0; }
  .format-badge { flex: none; font-size: 10px; letter-spacing: .04em; color: #b9b7c4; border: 1px solid #3f3f47; border-radius: 4px; padding: 1px 5px; }
  .notice { background: #433325; color: #f0ce9b; padding: 8px 16px; font-size: 12px; white-space: pre-wrap; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex: none; }
  .notice button { cursor: pointer; border: 0; border-radius: 5px; padding: 3px 8px; font-size: 12px; background: #594434; color: #ffe6bf; }
  .text-toolbar { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 16px; flex: none; border-bottom: 1px solid var(--color-border, #26262b); background: #141416; }
  .text-toolbar button { cursor: pointer; border: 1px solid #3a3a41; border-radius: 5px; background: #232327; color: #d9d8e0; padding: 3px 8px; font-size: 12px; }
  .reader-body { background: var(--color-bg, #0e0e10); }
  .state-line { padding: 40px 20px; text-align: center; color: #8b8997; font-size: 13px; }
  .reader-state { color: #8b8997; }
  .reader-state.problem { color: #f0ce9b; }
  .muted { color: #8b8997; font-size: 12px; }

  .text-modal-backdrop { position: absolute; inset: 0; background: #000a; z-index: 30; display: flex; align-items: center; justify-content: center; padding: 25px; color: #dddce4; }
  .text-modal { width: 540px; max-width: 96%; max-height: 92%; overflow: auto; border: 1px solid #44404a; border-radius: 12px; background: #18181b; padding: 22px; box-shadow: 0 22px 90px #0008; font-size: 13px; }
  .text-modal.wide { width: 920px; }
  .text-modal header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
  .text-modal h2 { font-size: 18px; font-weight: 600; }
  .text-modal header button { border: 0; background: transparent; color: inherit; font-size: 18px; cursor: pointer; }
  .text-modal label { display: flex; flex-direction: column; gap: 7px; margin: 14px 0; }
  .text-modal p { line-height: 1.8; margin: 12px 0; }
  .text-modal input, .text-modal select { background: #101012; border: 1px solid #45454d; border-radius: 6px; color: inherit; padding: 7px 9px; }
  .text-modal button { border: 1px solid #49424c; border-radius: 6px; background: #26262b; color: #dddce4; padding: 6px 10px; margin: 3px; cursor: pointer; font-size: 12px; }
  .text-modal button:disabled { opacity: .45; cursor: default; }
  .text-modal .primary { background: #6d4c4c; border-color: #8a5f5f; }
  .text-modal .danger { background: #5b2723; border-color: #7d3a34; }
  .text-modal pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.8 Consolas, 'Microsoft YaHei', monospace; background: #0e0e10; padding: 14px; border-radius: 6px; }
  .history-layout { display: grid; grid-template-columns: 190px 1fr; height: 340px; gap: 16px; }
  .history-layout aside, .history-layout pre { overflow: auto; }
  .history-layout aside button { display: block; width: 95%; text-align: left; }
  .conflict-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .conflict-layout pre { height: 280px; overflow: auto; }
  .conflict-layout h3 { margin: 10px 0; }
  .modal-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; margin-top: 15px; }
  .media-search { display: flex; gap: 10px; }
  .media-search input { flex: 1; }
  .media-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; max-height: 420px; overflow: auto; margin: 16px 0; }
  .media-grid button { overflow: hidden; white-space: normal; margin: 0; }
  .media-grid img { width: 100%; height: 100px; object-fit: cover; }
  .media-grid span { display: block; font-size: 11px; overflow-wrap: anywhere; margin: 6px; }
  .asset-large { display: block; width: 100%; max-height: 60%; object-fit: contain; }
  @media (max-width: 900px) { .media-grid { grid-template-columns: repeat(3, 1fr); } }
</style>