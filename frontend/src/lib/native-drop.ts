import { isDraggingOriginal } from './original-drag';
import { isTauri } from './tauri';

type Payload = { paths?: string[]; position?: { x: number; y: number } };

/** Native WebView drops contain the disk paths needed for copying the original file. */
export function subscribeFileDrop(
  region: () => HTMLElement | null | undefined,
  /** 悬停计数 + 正在拖的那批路径。要按「拖进来的值不值得我接」给反馈的调用方看第二个。 */
  hover: (count: number, paths: string[]) => void,
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
  /** 那一点上最挨着人的元素。命中测试拿不到就返回 null，由调用方退回只看矩形。 */
  const topmostAt = (x: number, y: number): Element | null => {
    try {
      return document.elementFromPoint?.(x, y) ?? null;
    } catch {
      return null;
    }
  };
  const inside = (payload: Payload) => {
    const node = region();
    const rect = node?.getBoundingClientRect();
    const p = pointOf(payload);
    if (!rect || !p) return false;
    if (p.x < rect.left || p.x > rect.right || p.y < rect.top || p.y > rect.bottom) return false;
    // 矩形只说明「这一点落在这块地上」，不说明这一块地此刻归谁：弹窗的遮罩整片盖在
    // 瀑布流上面时，同一个点两处都算落在自己家里，一次松手两边都收文件——
    // 在技能弹窗里丢下一个压缩包，底下的 Feed 会跟着走一遍它那套导入。
    // 所以要问最上面那个元素在谁家里，只有它在，落点才算数。
    // 问不到（浏览器不配合、点在视口外、测试环境不做命中）退回只看矩形：
    // 宁可两处都收到，也不能把原本收得到的落点判没。
    const top = topmostAt(p.x, p.y);
    return !top || !!node?.contains(top);
  };
  const listen = async (name: string, callback: (p: Payload) => void) => {
    const unlisten = await (window as any).__TAURI__.event.listen(name,
      (event: { payload: Payload }) => { if (!disposed && !isDraggingOriginal()) callback(event.payload); });
    if (disposed) unlisten(); else unlisteners.push(unlisten);
  };
  const over = (p: Payload) => {
    const ok = inside(p);
    hover(ok ? count : 0, ok ? p.paths ?? [] : []);
    onPoint?.(ok ? pointOf(p) : null);
  };
  void Promise.all([
    listen('tauri://drag-enter', (p) => { count = p.paths?.length || 1; over(p); }),
    listen('tauri://drag-over', over),
    listen('tauri://drag-leave', () => { count = 0; hover(0, []); onPoint?.(null); }),
    listen('tauri://drag-drop', (p) => {
      hover(0, []);
      // 落点先交给调用方，再清 over 阶段那份记录：反过来就把「正指着哪一格」一起清了
      if (inside(p) && p.paths?.length) void drop(p.paths, pointOf(p));
      onPoint?.(null);
    }),
  ]).catch((error) => console.error('无法接收桌面拖放事件', error));
  return () => { disposed = true; for (const unlisten of unlisteners) unlisten(); };
}
