/** Long-press reorder: ordinary clicks/double clicks and scrolling remain available. */
export function textListDrag(node: HTMLElement, options: {
  change: (from: number | null, target: number | null, after: boolean) => void;
  drop: (from: number, target: number, after: boolean) => void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let from: number | null = null, target: number | null = null;
  let after = false, dragging = false, x = 0, y = 0, pointer = -1, suppress = false;
  let suppressTimer: ReturnType<typeof setTimeout> | undefined;
  function cancel() {
    clearTimeout(timer); from = target = null; dragging = false; pointer = -1;
    options.change(null, null, false);
  }
  function down(e: PointerEvent) {
    if (e.button !== 0 || !(e.target instanceof Element) || e.target.closest('input,select,textarea')) return;
    const row = e.target.closest<HTMLElement>('[data-text-id]');
    if (!row) return;
    cancel(); from = Number(row.dataset.textId); x = e.clientX; y = e.clientY; pointer = e.pointerId;
    timer = setTimeout(() => { dragging = true; options.change(from, null, false); }, 350);
  }
  function move(e: PointerEvent) {
    if (from === null || e.pointerId !== pointer) return;
    if (!dragging) { if (Math.hypot(e.clientX-x, e.clientY-y) > 7) cancel(); return; }
    e.preventDefault();
    const row = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-text-id]');
    target = row && node.contains(row) ? Number(row.dataset.textId) : null;
    after = !!row && e.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
    const bounds = node.getBoundingClientRect();
    if (e.clientY < bounds.top + 30) node.scrollTop -= 18;
    if (e.clientY > bounds.bottom - 30) node.scrollTop += 18;
    options.change(from, target, after);
  }
  function up(e: PointerEvent) {
    if (e.pointerId !== pointer) return;
    if (dragging) {
      suppress = true; clearTimeout(suppressTimer); suppressTimer = setTimeout(() => suppress = false, 0);
      if (from !== null && target !== null && from !== target) options.drop(from, target, after);
    }
    cancel();
  }
  const click = (e: MouseEvent) => { if (suppress) { e.preventDefault(); e.stopImmediatePropagation(); } };
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
  node.addEventListener('pointerdown', down); node.addEventListener('click', click, true);
  window.addEventListener('pointermove', move, { passive:false }); window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel); window.addEventListener('blur', cancel); window.addEventListener('keydown', key);
  return { destroy() {
    cancel(); clearTimeout(suppressTimer); node.removeEventListener('pointerdown', down); node.removeEventListener('click', click, true);
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', key);
  } };
}
