<script lang="ts">
  import { tick } from 'svelte';
  import { markdownBlocks, renderMarkdown } from '../lib/text-markdown';
  let { body, id, markdown, readonly = false, source = false, editing = false, cursor = 0, scroll = 0,
    onchange, onposition, oncomposition, onasset }:
    { body: string; id: number; markdown: boolean; readonly?: boolean; source?: boolean; editing?: boolean;
      cursor?: number; scroll?: number; onchange: (body: string) => void;
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
    if (!editing && markdown && !source) {
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
  {#if fullSource}
    <textarea bind:this={area} aria-label="文本正文" value={body} readonly={readonly || !editing} spellcheck="false"
      oninput={input} onclick={position} onkeyup={position} onblur={position}
      oncompositionstart={() => { composing = true; oncomposition(true); }}
      oncompositionend={() => { composing = false; input(); oncomposition(false); }}></textarea>
  {:else}
    <div class="markdown-page">
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
            {:else}{@html renderMarkdown(block.text, id)}{/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .text-editor { overflow:auto; flex:1; min-height:0; padding:30px clamp(20px,5vw,90px) 120px; }
  textarea { display:block; width:100%; min-height:180px; resize:none; background:transparent; border:0; outline:none; color:inherit; font:15px/1.85 Consolas,'Microsoft YaHei',monospace; padding:8px 0; tab-size:2; }
  .markdown-page { max-width:880px; margin:auto; font-size:16px; line-height:1.9; overflow-wrap:anywhere; }
  .markdown-block { min-height:15px; cursor:text; outline:none; border-radius:5px; }
  .markdown-block:focus-visible { box-shadow:0 0 0 1px #777; }
  .empty-reading { color:#8a8a8e; }
  .markdown-page :global(h1) { font-size:32px; font-weight:650; margin:12px 0 24px; }
  .markdown-page :global(h2) { font-size:25px; font-weight:600; margin:18px 0 12px; }
  .markdown-page :global(h3) { font-size:21px; font-weight:600; margin:15px 0 8px; }
  .markdown-page :global(p) { margin:8px 0; white-space:pre-wrap; }
  .markdown-page :global(ul), .markdown-page :global(ol) { padding-left:26px; list-style:revert; }
  .markdown-page :global(blockquote) { border-left:3px solid #ac6666; color:#b6b3bf; padding-left:18px; margin:14px 0; }
  .markdown-page :global(pre) { background:#18181b; padding:16px; border-radius:8px; overflow:auto; }
  .markdown-page :global(code) { font-family:Consolas,monospace; background:#27272a; padding:2px 4px; border-radius:3px; }
  .markdown-page :global(pre code) { background:transparent; padding:0; }
  .markdown-page :global(table) { width:100%; border-collapse:collapse; margin:16px 0; }
  .markdown-page :global(th),.markdown-page :global(td) { border:1px solid #454550; padding:8px 12px; text-align:left; }
  .markdown-page :global(img) { max-width:100%; max-height:520px; object-fit:contain; border-radius:8px; display:block; }
  .markdown-page :global(button) { color:#dfa2a2; cursor:pointer; font-size:13px; padding:4px; }
  .markdown-page :global(a) { color:#dfa2a2; text-decoration:underline; }
  .markdown-page :global(.text-asset) { display:block; margin:16px 0; }
  .markdown-page :global(.placeholder) { color:#72727e; }
</style>
