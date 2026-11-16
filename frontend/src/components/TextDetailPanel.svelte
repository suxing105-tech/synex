<script lang="ts">
  /**
   * 右侧详情栏的文本分支。
   *
   * 只用统一流那一行里已有的字段（文件名 / 格式 / 摘录 / 路径 / 修改时间 / 标签），
   * 打开正文只在用户点「复制全文」或走删除流程时才发生 —— 选中一张卡不该把整篇读进来。
   */
  import { selectedText, refreshFeed, refreshFolders, openTextReader, markTextFeedStale } from "../lib/stores";
  import { textsApi } from "../lib/texts";
  import { copyText, formatDate } from "../lib/ws";
  import { pushToast } from "../lib/toast";
  import { revealLocation } from "../lib/reveal";

  import { textFormatLabel } from "../lib/text-reading";
  import { pathBreakSegments } from "../lib/path-segments";

  const message = (e: unknown) => e instanceof Error ? e.message : String(e);
  let busy = $state(false);
  let notice = $state("");
  let renaming = $state(false);
  let renameValue = $state("");
  let confirming = $state(false);
  let menuOpen = $state(false);

  // 换一篇文本时收起未完成的改名 / 删除确认：面板常驻，不会重建组件。
  $effect(() => { void $selectedText?.id; renaming = false; confirming = false; menuOpen = false; notice = ""; });

  function read() {
    if ($selectedText) openTextReader($selectedText);
  }
  function edit() {
    if ($selectedText) openTextReader($selectedText, "", true);
  }
  async function copyFull() {
    const it = $selectedText;
    if (!it) return;
    busy = true;
    try {
      const detail = await textsApi.detail(it.id);
      const ok = await copyText(detail.body).catch(() => false);
      pushToast(ok ? `已复制全文（${detail.body.length} 字）` : "复制失败，请打开后手动选择", { kind: ok ? "success" : "error" });
    } catch (e) {
      pushToast(message(e), { kind: "error" });
    } finally {
      busy = false;
    }
  }
  /** 复制文件本身，可在资源管理器里直接粘贴；「复制全文」复制的是正文。 */
  async function copyFile() {
    const it = $selectedText;
    if (!it) return;
    busy = true;
    try {
      await textsApi.copyFile(it.id);
      pushToast(`已复制文本文件到剪贴板（${it.filename}）`, { kind: "success" });
    } catch (e) {
      pushToast(`复制文本文件失败：${message(e)}`, { kind: "error" });
    } finally {
      busy = false;
      menuOpen = false;
    }
  }
  async function reveal() {
    const it = $selectedText;
    if (!it) return;
    try { await revealLocation(it.path, true, () => textsApi.reveal(it.id)); }
    catch (e) { await copyText(it.path); notice = message(e) + "（已复制文件路径）"; }
  }
  function startRename() {
    const it = $selectedText;
    if (!it) return;
    renameValue = it.filename;
    renaming = true;
    menuOpen = false;
  }
  async function saveRename() {
    const it = $selectedText;
    if (!it || !renameValue.trim() || renameValue.trim() === it.filename) { renaming = false; return; }
    busy = true;
    try {
      const detail = await textsApi.detail(it.id);
      await textsApi.move(it.id, detail.path.replace(/[\\/][^\\/]+$/, ""), renameValue.trim(), detail.version);
      markTextFeedStale();
      selectedTextFresh({ filename: renameValue.trim() });
      renaming = false;
      await refreshFeed({ keepScroll: true });
    } catch (e) {
      notice = message(e);
    } finally {
      busy = false;
    }
  }
  /** 详情栏显示的是统一流那一行，本地先改名再等刷新，避免点完看起来没反应。 */
  function selectedTextFresh(patch: Record<string, unknown>) {
    const it = $selectedText;
    if (!it) return;
    selectedText.set({ ...it, ...patch } as typeof it);
  }
  async function trash() {
    const it = $selectedText;
    if (!it) return;
    busy = true;
    try {
      const detail = await textsApi.detail(it.id);
      await textsApi.trash(it.id, detail.version);
      selectedText.set(null);
      confirming = false;
      await Promise.all([refreshFolders(), refreshFeed({ keepScroll: true })]);
      pushToast("已移入系统回收站", { kind: "success" });
    } catch (e) {
      notice = message(e);
    } finally {
      busy = false;
    }
  }
  function searchTag(tag: string) {
    window.dispatchEvent(new CustomEvent("open-tag-search", { detail: { tag } }));
  }
</script>

{#if $selectedText}
  {@const it = $selectedText}
  {@const pathSegs = pathBreakSegments(it?.path)}
  <div class="h-full flex flex-col overflow-hidden">
    <!-- 操作带：占的是媒体那栏 tab 行那一条（同高 --ctl-lg = 实测 38px），
         四类素材右栏的正文起点因此在一条线上。阅读 / 编辑 / ⋯ 从标题那一行挪出来 ——
         三颗按钮实测吃掉 46+46+30px，312px 的面板里标题只剩 85px，文件名被切掉 52%
         （2026-11-13 oil-ui 评审第二刀 T3）。 -->
    <nav class="detail-text-actions" aria-label="文本操作">
      <div class="flex items-center gap-1" data-text-menu-root>
        <button type="button" class="dock-btn hover:bg-surface-3 transition-colors" title="打开阅读" aria-label="打开阅读" onclick={read}>阅读</button>
        <button type="button" class="dock-btn hover:bg-surface-3 transition-colors" title="就地编辑" aria-label="就地编辑" onclick={edit}>编辑</button>
        <button type="button" class="dock-btn hover:bg-surface-3 transition-colors" title="更多操作" aria-label="更多操作" aria-haspopup="menu" aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}>⋯</button>
        {#if menuOpen}
          <div class="absolute right-4 top-full z-20 mt-1 min-w-[150px] rounded-md border border-border bg-surface-2 shadow-lg py-1 text-[12px]" role="menu" aria-label="文本更多操作">
            <button type="button" class="w-full px-3 py-1.5 text-left hover:bg-surface-3" role="menuitem" onclick={startRename}>重命名</button>
            <button type="button" class="w-full px-3 py-1.5 text-left hover:bg-surface-3" role="menuitem" onclick={() => void copyFile()}>复制文本文件</button>
            <button type="button" class="w-full px-3 py-1.5 text-left hover:bg-surface-3" role="menuitem" onclick={() => void copyFull()}>复制全文</button>
            <button type="button" class="w-full px-3 py-1.5 text-left hover:bg-surface-3" role="menuitem" onclick={() => void reveal()}>文件位置</button>
            <button type="button" class="w-full px-3 py-1.5 text-left text-danger hover:bg-surface-3" role="menuitem" onclick={() => { confirming = true; menuOpen = false; }}>移入回收站</button>
          </div>
        {/if}
      </div>
    </nav>
    <header class="px-4 py-3 border-b border-border bg-surface-2 flex items-start gap-3">
      <div class="shrink-0 w-12 h-12 rounded-md bg-surface-3 border border-border flex items-center justify-center text-zinc-400 font-mono text-[11px]" title="文本素材" aria-label="文本徽标">
        {textFormatLabel(it.format)}
      </div>
      <div class="min-w-0 flex-1">
        {#if renaming}
          <input
            class="w-full bg-bg border border-border rounded px-2 py-1 text-[12px]"
            aria-label="文件名"
            bind:value={renameValue}
            onkeydown={(e) => { if (e.key === "Enter") void saveRename(); if (e.key === "Escape") renaming = false; }}
          />
        {:else}
          <div class="text-[13px] font-mono font-semibold truncate" title={it.filename}>{it.filename}</div>
        {/if}
        <div class="text-[11px] text-muted mt-0.5 flex gap-2 flex-wrap">
          <span>{textFormatLabel(it.format)}</span>
          <span>{formatDate(it.mtime)}</span>
        </div>
      </div>
    </header>

    <div class="flex-1 overflow-y-auto p-4 space-y-4 detail-body text-[12.5px]">
      {#if renaming}
        <div class="flex gap-2">
          <button type="button" class="dock-btn hover:bg-surface-3 disabled:opacity-40" disabled={busy} onclick={() => void saveRename()}>保存</button>
          <button type="button" class="dock-btn hover:bg-surface-3" onclick={() => (renaming = false)}>取消</button>
        </div>
      {/if}
      {#if notice}<div class="rounded border border-border bg-surface-2 p-2 text-[11.5px] text-amber-200" role="status">{notice}</div>{/if}
      {#if confirming}
        <div class="rounded border border-danger/40 bg-surface-2 p-3 space-y-2" role="alertdialog" aria-label="确认移入回收站">
          <p>会把磁盘原文件一起移入系统回收站：</p>
          <p class="font-mono text-[11px] break-words text-muted">{#each pathSegs as seg, i}{seg}{#if i !== pathSegs.length - 1}<wbr />{/if}{/each}</p>
          <div class="flex gap-2">
            <button type="button" class="dock-btn is-danger hover:bg-surface-3 disabled:opacity-40" disabled={busy} onclick={() => void trash()}>确认移入回收站</button>
            <button type="button" class="dock-btn hover:bg-surface-3" onclick={() => (confirming = false)}>取消</button>
          </div>
        </div>
      {/if}

      <section>
        <h3 class="section-title mb-2">摘录</h3>
        <p class="whitespace-pre-wrap leading-relaxed rounded-md border border-border bg-surface-2 p-3 max-h-72 overflow-auto">{it.excerpt || "（空）"}</p>
      </section>

      <section>
        <h3 class="section-title mb-2">路径</h3>
        <div class="flex items-start gap-2">
          <code class="flex-1 min-w-0 break-words font-mono text-[11px] rounded-md border border-border bg-surface-2 p-2.5">{#each pathSegs as seg, i}{seg}{#if i !== pathSegs.length - 1}<wbr />{/if}{/each}</code>
          <button type="button" class="dock-btn hover:bg-surface-3 shrink-0" aria-label="复制路径" onclick={() => void copyText(it.path).then(ok => pushToast(ok ? "已复制路径" : "复制失败", { kind: ok ? "success" : "error" }))}>复制</button>
        </div>
      </section>

      <section>
        <h3 class="section-title mb-2">标签</h3>
        <div class="flex flex-wrap gap-1.5">
          {#each it.tags as tag}
            <button type="button" class="px-2 py-0.5 rounded-full border border-border hover:bg-surface-3" onclick={() => searchTag(tag)}>{tag}</button>
          {/each}
          {#if !it.tags.length}<span class="text-muted">暂无标签</span>{/if}
        </div>
      </section>

      <p class="text-[11px] text-muted leading-relaxed">正文在原文件里，打开后自动保存；改完按 Esc 回缩略图。</p>
    </div>
  </div>
{/if}