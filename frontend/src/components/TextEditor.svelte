<script lang="ts">
  import { tick } from 'svelte';
  import { escapeHtml, highlightHtml, markdownBlocks, renderMarkdown } from '../lib/text-markdown';
  let { body, id, markdown, readonly = false, source = false, editing = false, cursor = 0, scroll = 0, highlight = '',
    pageWidth = '', pageFontSize = '',
    onchange, onposition, oncomposition, onasset }:
    { body: string; id: number; markdown: boolean; readonly?: boolean; source?: boolean; editing?: boolean;
      cursor?: number; scroll?: number; highlight?: string; pageWidth?: string; pageFontSize?: string;
      onchange: (body: string) => void;
      onposition: (cursor: number, scroll: number) => void; oncomposition: (v: boolean) => void;
      onasset: (href: string) => void } = $props();
  let area = $state<HTMLTextAreaElement>();
  let scroller = $state<HTMLDivElement>();
  let active = $state<{ start: number; end: number } | null>(null);
  let fullSource = $derived(source || !markdown);
  let blocks = $derived(markdownBlocks(body));
  let shown = $derived(fullSource ? body : active ? body.slice(active.start, active.end) : '');
  let composing = false;
  const grow = () => { if (area) { area.style.height = 'auto'; area.style.height = Math.max(110, area.scrollHeight) + 'px'; } };
  function position() { onposition((fullSource ? 0 : active?.start || 0) + (area?.selectionStart || 0), scroller?.scrollTop || 0); }
  function input() {
    if (!area || readonly || !editing) return;
    const value = area.value;
    if (fullSource) onchange(value);
    else if (active) {
      const next = body.slice(0, active.start) + value + body.slice(active.end);
      active = { start: active.start, end: active.start + value.length }; onchange(next);
    }
    grow(); position();
  }
  async function activate(start: number, end: number, at = start) {
    if (readonly || !editing || composing) return;
    active = { start, end };
    await tick();
    area?.focus(); area?.setSelectionRange(Math.max(0, at - start), Math.max(0, at - start)); grow();
  }
  export async function locate(at: number, length = 0) {
    // 阅读态（Markdown 分块或纯文本分行）都带 data-block-start，按块滚动定位。
    if (!editing) {
      const b = blocks.find(b => at >= b.start && at <= b.end) || blocks[0];
      await tick();
      scroller?.querySelector(`[data-block-start="${b?.start}"]`)?.scrollIntoView({ block: 'center' });
      return;
    }
    if (fullSource) {
      await tick(); area?.focus(); area?.setSelectionRange(at, at + length);
    } else {
      const b = blocks.find(b => at >= b.start && at <= b.end) || blocks[0];
      await activate(b.start, b.end, at);
      area?.setSelectionRange(at - b.start, at - b.start + length);
    }
    area?.scrollIntoView({ block: 'center' });
  }
  export async function insert(before: string, after = '') {
    if (readonly || !editing) return;
    if (!area) await locate(cursor);
    if (!area) return;
    const start = area.selectionStart, end = area.selectionEnd;
    const value = area.value;
    area.value = value.slice(0, start) + before + value.slice(start, end) + after + value.slice(end);
    input(); await tick(); area.focus(); area.setSelectionRange(start + before.length, end + before.length); grow();
  }
  function previewClick(e: MouseEvent, start: number, end: number) {
    if ((e.target as HTMLElement).closest('a')) return;
    const button = (e.target as HTMLElement).closest<HTMLElement>('[data-href]');
    if (button) { e.preventDefault(); onasset(button.dataset.href!); return; }
    void activate(start, end);
  }
  let lastDocument = -1;
  let lastSource = false;
  $effect(() => {
    const document = id, mode = source; editing;
    if (document !== lastDocument || mode !== lastSource) {
      active = null; lastDocument = document; lastSource = mode;
    }
    if (!editing) active = null;
  });
  $effect(() => { shown; void tick().then(grow); });
  function mounted(node: HTMLDivElement) { node.scrollTop = scroll; }
  function blur(e: FocusEvent) {
    position();
    if (!composing) active = null;
  }
</script>

<div class="text-editor" bind:this={scroller} use:mounted onscroll={() => onposition(cursor, scroller?.scrollTop || 0)}>
  {#if fullSource && !editing}
    <div class="plain-page" style:max-width={pageWidth || null} style:font-size={pageFontSize || null}>
      {#each blocks as block (block.start)}
        <pre class="plain-block" data-block-start={block.start}>{@html block.text.trim() ? highlightHtml(escapeHtml(block.text), highlight) : '<span class="empty-reading">空白文本，点击上方“编辑”开始写作。</span>'}</pre>
      {/each}
    </div>
  {:else if fullSource}
    <textarea bind:this={area} aria-label="文本正文" value={body} readonly={readonly || !editing} spellcheck="false"
      oninput={input} onclick={position} onkeyup={position} onblur={position}
      oncompositionstart={() => { composing = true; oncomposition(true); }}
      oncompositionend={() => { composing = false; input(); oncomposition(false); }}></textarea>
  {:else}
    <div class="markdown-page" style:max-width={pageWidth || null} style:font-size={pageFontSize || null}>
      {#each blocks as block (block.start)}
        {#if active && block.start === active.start}
          <textarea bind:this={area} aria-label="编辑 Markdown 段落" value={shown} {readonly} spellcheck="false"
            oninput={input} onclick={position} onkeyup={position} onblur={blur}
            oncompositionstart={() => { composing = true; oncomposition(true); }}
              oncompositionend={() => { composing = false; input(); oncomposition(false); }}></textarea>
        {:else if !active || block.end <= active.start || block.start >= active.end}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex (Edit mode changes the role and tabIndex together.) -->
          <div class="markdown-block" data-block-start={block.start} role={editing ? 'button' : 'group'} tabindex={editing ? 0 : -1}
            onclick={(e) => previewClick(e, block.start, block.end)}
            onkeydown={(e) => { if (e.target === e.currentTarget && e.key === 'Enter') void activate(block.start, block.end); }}>
            {#if !editing && !block.text.trim()}<span class="empty-reading">空白文本，点击上方“编辑”开始写作。</span>
            {:else}{@html renderMarkdown(block.text, id, highlight)}{/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .text-editor { overflow:auto; flex:1; min-height:0; padding:var(--sp-8) clamp(var(--sp-5),5vw,90px) 120px; }
  textarea { display:block; width:100%; min-height:180px; resize:none; background:transparent; border:0; outline:none; color:inherit; font-size: var(--fs-base); line-height: var(--lh-prose); font-family: var(--font-mono); padding:var(--sp-2) 0; tab-size:2; }
  /* 阅读页是全站唯一比界面正文还大一档的地方，正文走 --fs-md；标题按 24/19/16 三级跳，
     h3 和正文同字号，靠 600 字重分层——字重只有 400/500/600 三档，不能再往上要。 */
  .markdown-page { max-width:880px; margin:auto; font-size:var(--fs-md); line-height: var(--lh-prose); overflow-wrap:anywhere; }
  .plain-page { max-width:880px; margin:auto; font-size:var(--fs-md); line-height: var(--lh-prose); overflow-wrap:anywhere; }
  .plain-block { margin:0 0 1.1em; white-space:pre-wrap; font:inherit; }
  .plain-page :global(mark.text-hit), .markdown-page :global(mark.text-hit) { background:#5b4413; color:#ffe9a8; border-radius:3px; padding:0 var(--sp-05); }
  .markdown-block { min-height:15px; cursor:text; outline:none; border-radius:5px; }
  .markdown-block:focus-visible { box-shadow:0 0 0 1px #777; }
  .empty-reading { color:#8a8a8e; }
  .markdown-page :global(h1) { font-size:var(--fs-xl); font-weight:600; margin:var(--sp-3) 0 var(--sp-6); }
  .markdown-page :global(h2) { font-size:var(--fs-lg); font-weight:600; margin:var(--sp-5) 0 var(--sp-3); }
  .markdown-page :global(h3) { font-size:var(--fs-md); font-weight:600; margin:var(--sp-4) 0 var(--sp-2); }
  .markdown-page :global(p) { margin:var(--sp-2) 0; white-space:pre-wrap; }
  .markdown-page :global(ul), .markdown-page :global(ol) { padding-left:var(--sp-7); list-style:revert; }
  .markdown-page :global(blockquote) { border-left:3px solid #ac6666; color:#b6b3bf; padding-left:var(--sp-5); margin:var(--sp-4) 0; }
  .markdown-page :global(pre) { background:#18181b; padding:var(--sp-4); border-radius:8px; overflow:auto; }
  .markdown-page :global(code) { font-family:var(--font-mono); background:#27272a; padding:var(--sp-05) var(--sp-1); border-radius:3px; }
  .markdown-page :global(pre code) { background:transparent; padding:0; }
  .markdown-page :global(table) { width:100%; border-collapse:collapse; margin:var(--sp-4) 0; }
  .markdown-page :global(th),.markdown-page :global(td) { border:1px solid #454550; padding:var(--sp-2) var(--sp-3); text-align:left; }
  .markdown-page :global(img) { max-width:100%; max-height:520px; object-fit:contain; border-radius:8px; display:block; }
  .markdown-page :global(button) { color:#dfa2a2; cursor:pointer; font-size: var(--fs-sm); padding:var(--sp-1); }
  .markdown-page :global(a) { color:#dfa2a2; text-decoration:underline; }
  .markdown-page :global(.text-asset) { display:block; margin:var(--sp-4) 0; }
  .markdown-page :global(.placeholder) { color:var(--text-3); }
</style>
