import { afterEach, expect, it, vi } from 'vitest';
import { beginOriginalDrag, dragOriginalImages, isDraggingOriginal } from '../lib/original-drag';

afterEach(() => { delete (window as any).__TAURI__; });

it('系统拖出传递原文件路径，包括 JPG；不传缩略图 URL', async () => {
  let finish!: () => void;
  const invoke = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  (window as any).__TAURI__ = { core: { invoke } };
  const files = ['D:/作品/横图.png', 'D:/照片/竖图.JPG'];
  const pending = dragOriginalImages(files);
  expect(invoke).toHaveBeenCalledWith('drag_original_images', { paths: files });
  expect(isDraggingOriginal()).toBe(true);
  finish(); await pending;
  expect(isDraggingOriginal()).toBe(false);
});

it('单击不拖出，移动越过阈值后只启动一次原图拖放', async () => {
  const invoke = vi.fn().mockResolvedValue(undefined);
  (window as any).__TAURI__ = { core: { invoke } };
  const started = vi.fn();
  const stop = beginOriginalDrag(new PointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10 }), ['D:/original.jpg'], started, vi.fn());
  window.dispatchEvent(new PointerEvent('pointermove', { buttons: 1, clientX: 12, clientY: 12 }));
  expect(invoke).not.toHaveBeenCalled();
  window.dispatchEvent(new PointerEvent('pointermove', { buttons: 1, clientX: 30, clientY: 10 }));
  window.dispatchEvent(new PointerEvent('pointermove', { buttons: 1, clientX: 40, clientY: 10 }));
  expect(invoke).toHaveBeenCalledOnce();
  expect(started).toHaveBeenCalledOnce();
  await Promise.resolve(); stop?.();
});

it('鼠标松开或取消后不遗留拖放手势', () => {
  const invoke = vi.fn();
  (window as any).__TAURI__ = { core: { invoke } };
  beginOriginalDrag(new PointerEvent('pointerdown', { button: 0 }), ['D:/a.png'], vi.fn(), vi.fn());
  window.dispatchEvent(new PointerEvent('pointerup'));
  window.dispatchEvent(new PointerEvent('pointermove', { buttons: 1, clientX: 30 }));
  expect(invoke).not.toHaveBeenCalled();
});
