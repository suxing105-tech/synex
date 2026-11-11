import { isDraggingOriginal } from './original-drag';
import { isTauri } from './tauri';

type Payload = { paths?: string[]; position?: { x: number; y: number } };

/** Native WebView drops contain the disk paths needed for copying the original file. */
export function subscribeFileDrop(
  region: () => HTMLElement | null | undefined,
  hover: (count: number) => void,
  /** 落点也给 CSS 坐标。要知道「落在哪一格」的调用方必须在 drop 这一步就用它：
      紧接着那一次 onPoint(null) 会把 over 阶段记下的那一格清掉。 */
  drop: (paths: string[], point: { x: number; y: number } | null) => Promise<void>,
  /** 指针位置的 CSS 坐标（在 region 内才给，离开给 null）。落点要分到「哪一格」的调用方才需要它。 */
  onPoint?: (point: { x: number; y: number } | null) => void,
): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let count = 0;
  const unlisteners: (() => void)[] = [];
  // payload 的位置是物理像素，页面坐标要除回去
  const pointOf = (payload: Payload) => {
    if (!payload.position) return null;
    const scale = window.devicePixelRatio || 1;
    return { x: payload.position.x / scale, y: payload.position.y / scale };
  };
  const inside = (payload: Payload) => {
    const rect = region()?.getBoundingClientRect();
    const p = pointOf(payload);
    if (!rect || !p) return false;
    return p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;
  };
  const listen = async (name: string, callback: (p: Payload) => void) => {
    const unlisten = await (window as any).__TAURI__.event.listen(name,
      (event: { payload: Payload }) => { if (!disposed && !isDraggingOriginal()) callback(event.payload); });
    if (disposed) unlisten(); else unlisteners.push(unlisten);
  };
  const over = (p: Payload) => {
    const ok = inside(p);
    hover(ok ? count : 0);
    onPoint?.(ok ? pointOf(p) : null);
  };
  void Promise.all([
    listen('tauri://drag-enter', (p) => { count = p.paths?.length || 1; over(p); }),
    listen('tauri://drag-over', over),
    listen('tauri://drag-leave', () => { count = 0; hover(0); onPoint?.(null); }),
    listen('tauri://drag-drop', (p) => {
      hover(0);
      // 落点先交给调用方，再清 over 阶段那份记录：反过来就把「正指着哪一格」一起清了
      if (inside(p) && p.paths?.length) void drop(p.paths, pointOf(p));
      onPoint?.(null);
    }),
  ]).catch((error) => console.error('无法接收桌面拖放事件', error));
  return () => { disposed = true; for (const unlisten of unlisteners) unlisten(); };
}
