import { isTauri } from './tauri';

let dragging = false;
export const isDraggingOriginal = () => dragging;

export async function dragOriginalImages(paths: string[]): Promise<void> {
  if (!isTauri() || dragging || paths.length === 0) return;
  dragging = true;
  try {
    await (window as any).__TAURI__.core.invoke('drag_original_images', { paths });
  } finally { dragging = false; }
}

/** Move beyond the click tolerance before handing the original files to Windows. */
export function beginOriginalDrag(event: PointerEvent, paths: string[], onStart: () => void, onError: (e: unknown) => void) {
  if (!isTauri() || event.button !== 0) return;
  const x = event.clientX, y = event.clientY;
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
    window.removeEventListener('blur', stop);
  };
  const move = (e: PointerEvent) => {
    if (!(e.buttons & 1)) { stop(); return; }
    if (Math.hypot(e.clientX - x, e.clientY - y) < 6) return;
    e.preventDefault();
    stop();
    onStart();
    void dragOriginalImages(paths).catch(onError);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
  window.addEventListener('blur', stop);
  return stop;
}
