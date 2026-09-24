<script lang="ts">
  let { value = $bindable(220), max = 480, onchange }: { value?: number; max?: number; onchange: () => void } = $props();
  let dragging = $state(false);
  let pointer = -1, startX = 0, startWidth = 220;
  const clamp = (n: number) => Math.round(Math.max(180, Math.min(max, n)));
  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault(); dragging = true; pointer = e.pointerId; startX = e.clientX; startWidth = value;
    value = clamp(value); startWidth = value;
    (e.currentTarget as HTMLElement).focus();
  }
  function move(e: PointerEvent) {
    if (!dragging || e.pointerId !== pointer) return;
    e.preventDefault(); value = clamp(startWidth + e.clientX - startX);
  }
  function finish(e?: PointerEvent) {
    if (!dragging || (e && e.pointerId !== pointer)) return;
    dragging = false; onchange();
  }
  function cancel() { if (dragging) { value = startWidth; dragging = false; } }
  function key(e: KeyboardEvent) {
    const next = e.key === 'ArrowLeft' ? value - 16 : e.key === 'ArrowRight' ? value + 16 : e.key === 'Home' ? 180 : e.key === 'End' ? max : null;
    if (next === null) return;
    e.preventDefault(); value = clamp(next); onchange();
  }
</script>
<svelte:window onpointermove={move} onpointerup={finish} onpointercancel={cancel} onblur={() => finish()} onkeydown={(e) => { if (e.key === 'Escape') cancel(); }}/>
<!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions (A focusable separator supports keyboard resizing.) -->
<div class="list-splitter" class:dragging role="separator" aria-label="调整文本列表宽度" aria-orientation="vertical"
  aria-valuemin={180} aria-valuemax={max} aria-valuenow={clamp(value)} tabindex="0"
  title="拖动调整列表宽度；双击恢复默认" onpointerdown={down} onkeydown={key}
  ondblclick={() => { value = clamp(220); onchange(); }}></div>
<style>
  .list-splitter { width:6px; flex:0 0 6px; position:relative; cursor:col-resize; touch-action:none; outline:none; background:#18181b; }
  .list-splitter::before { content:''; position:absolute; top:0; bottom:0; width:1px; left:2px; background:#2e2e33; transition:background 120ms; }
  .list-splitter::after { content:''; position:absolute; top:calc(50% - 18px); height:36px; width:2px; left:2px; border-radius:2px; background:#55555d; opacity:0; transition:opacity 120ms; }
  .list-splitter:hover::after,.list-splitter:focus-visible::after,.list-splitter.dragging::after { opacity:1; }
  .list-splitter:hover::before,.list-splitter:focus-visible::before,.list-splitter.dragging::before { background:#8a8a8e; }
</style>
