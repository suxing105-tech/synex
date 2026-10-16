import { isAcceptedMediaFile } from './media-format';

export type ClipboardMedia = { files: File[]; hasFileEntry: boolean };

/** Ctrl+V 属于正在输入的字段时不要抢走（搜索框、重命名、标签输入、文本工作区）。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // 浏览器自己算出来的可编辑状态最准（含 contenteditable="" / plaintext-only / 继承父级）。
  if (target.isContentEditable) return true;
  return !!target.closest('input, textarea, select, [contenteditable="true"]');
}

/** 指针当前是否真的落在该区域上：用最近一次指针位置命中区域，遮罩层会自然挡住它。 */
export function isPointerInsideRegion(region: () => HTMLElement | null | undefined, x: number, y: number): boolean {
  const root = region();
  if (!root || x < 0 || y < 0) return false;
  const rect = root.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;
  // 遮罩层（灯箱、设置弹窗、文件夹选择器）盖住区域时，命中的是遮罩而不是区域。
  if (typeof document.elementFromPoint !== 'function') return true;
  const top = document.elementFromPoint(x, y);
  return !!top && (top === root || root.contains(top));
}

/** 从剪贴板事件里取出可导入的媒体文件，并告诉调用方剪贴板里到底有没有文件条目。 */
export function readClipboardMedia(data: DataTransfer | null | undefined): ClipboardMedia {
  if (!data) return { files: [], hasFileEntry: false };
  const items = data.items ? Array.from(data.items) : [];
  const files = data.files ? Array.from(data.files) : [];
  const declaresFiles = !!data.types && Array.from(data.types).some(type => type.toLowerCase() === 'files');
  const fileItems = items.filter(item => item.kind === 'file');
  const hasFileEntry = declaresFiles || fileItems.length > 0 || files.length > 0;
  // 截图位图只出现在 items 里，从资源管理器复制的文件两边都有，取一条路径即可。
  const candidates = fileItems.length > 0
    ? fileItems.map(item => item.getAsFile()).filter((file): file is File => !!file)
    : files;
  return { files: candidates.filter(isAcceptedMediaFile), hasFileEntry };
}

/**
 * 鼠标停在缩略图区域时按 Ctrl+V，把剪贴板里的图片/视频交给导入流程。
 * 语义与桌面拖拽一致：只有指针在该区域内才生效，文本粘贴不受影响。
 */
export function subscribeClipboardPaste(
  region: () => HTMLElement | null | undefined,
  onPaste: (media: ClipboardMedia) => void,
): () => void {
  let x = -1;
  let y = -1;
  const track = (event: Event) => {
    const pointer = event as PointerEvent;
    if (typeof pointer.clientX === 'number' && typeof pointer.clientY === 'number') {
      x = pointer.clientX;
      y = pointer.clientY;
    }
  };
  const handler = (event: Event) => {
    const paste = event as ClipboardEvent;
    if (isEditableTarget(paste.target)) return;
    if (!isPointerInsideRegion(region, x, y)) return;
    const media = readClipboardMedia(paste.clipboardData);
    // 纯文本粘贴保持原生行为，不吞事件也不弹提示。
    if (!media.hasFileEntry) return;
    paste.preventDefault();
    onPaste(media);
  };
  window.addEventListener('pointermove', track, true);
  window.addEventListener('pointerdown', track, true);
  document.addEventListener('paste', handler);
  return () => {
    window.removeEventListener('pointermove', track, true);
    window.removeEventListener('pointerdown', track, true);
    document.removeEventListener('paste', handler);
  };
}
