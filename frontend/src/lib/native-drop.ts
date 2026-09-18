import { isDraggingOriginal } from './original-drag';
import { isTauri } from './tauri';

type Payload = { paths?: string[]; position?: { x: number; y: number } };

/** Native WebView drops contain the disk paths needed for copying the original file. */
export function subscribeFileDrop(
  region: () => HTMLElement | null | undefined,
  hover: (count: number) => void,
  drop: (paths: string[]) => Promise<void>,
): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let count = 0;
  const unlisteners: (() => void)[] = [];
  const inside = (payload: Payload) => {
    const rect = region()?.getBoundingClientRect();
    if (!rect || !payload.position) return false;
    const scale = window.devicePixelRatio || 1;
    const x = payload.position.x / scale, y = payload.position.y / scale;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  };
  const listen = async (name: string, callback: (p: Payload) => void) => {
    const unlisten = await (window as any).__TAURI__.event.listen(name,
      (event: { payload: Payload }) => { if (!disposed && !isDraggingOriginal()) callback(event.payload); });
    if (disposed) unlisten(); else unlisteners.push(unlisten);
  };
  void Promise.all([
    listen('tauri://drag-enter', (p) => { count = p.paths?.length || 1; hover(inside(p) ? count : 0); }),
    listen('tauri://drag-over', (p) => hover(inside(p) ? count : 0)),
    listen('tauri://drag-leave', () => { count = 0; hover(0); }),
    listen('tauri://drag-drop', (p) => { hover(0); if (inside(p) && p.paths?.length) void drop(p.paths); }),
  ]).catch((error) => console.error('无法接收桌面拖放事件', error));
  return () => { disposed = true; for (const unlisten of unlisteners) unlisten(); };
}
