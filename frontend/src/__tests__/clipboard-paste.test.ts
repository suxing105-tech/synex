import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { isAcceptedMediaFile } from '../lib/media-format';
import {
  isEditableTarget, isPointerInsideRegion, readClipboardMedia, subscribeClipboardPaste,
} from '../lib/clipboard-paste';

const bytes = new Uint8Array([1, 2, 3, 4]);

function transfer(entries: { name: string; type: string }[], declaresFiles = true) {
  const files = entries.map(entry => new File([bytes], entry.name, { type: entry.type }));
  return {
    files,
    items: files.map((file, index) => ({ kind: 'file', type: entries[index].type, getAsFile: () => file })),
    types: declaresFiles && entries.length > 0 ? ['Files'] : ['text/plain'],
  } as unknown as DataTransfer;
}

/** 截图这类位图剪贴板只出现在 items 里，文件名是引擎合成的 image.png。 */
function bitmapTransfer() {
  const file = new File([bytes], 'image.png', { type: 'image/png' });
  return {
    files: [],
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
    types: ['Files'],
  } as unknown as DataTransfer;
}

function textTransfer() {
  return { files: [], items: [], types: ['text/plain'] } as unknown as DataTransfer;
}

function movePointer(x: number, y: number) {
  const event = new Event('pointermove');
  Object.defineProperty(event, 'clientX', { value: x });
  Object.defineProperty(event, 'clientY', { value: y });
  window.dispatchEvent(event);
}

function paste(clipboardData: DataTransfer | null, target: HTMLElement | typeof document = document) {
  const event = new Event('paste', { cancelable: true, bubbles: true });
  Object.defineProperty(event, 'clipboardData', { value: clipboardData });
  (target === document ? document.body : target).dispatchEvent(event);
  return event;
}

let region: HTMLDivElement;
let dispose: (() => void) | undefined;
let received: { files: File[]; hasFileEntry: boolean }[];

beforeEach(() => {
  received = [];
  region = document.createElement('div');
  document.body.appendChild(region);
  region.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 200, bottom: 200, x: 0, y: 0, width: 200, height: 200, toJSON: () => ({}),
  }) as DOMRect;
  document.elementFromPoint = vi.fn(() => region) as unknown as typeof document.elementFromPoint;
  dispose = subscribeClipboardPaste(() => region, media => received.push(media));
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  region.remove();
});

describe('subscribeClipboardPaste', () => {
  it('导入鼠标所在区域内的剪贴板图片', () => {
    movePointer(50, 50);
    const event = paste(transfer([{ name: 'shot.png', type: 'image/png' }]));
    expect(received).toHaveLength(1);
    expect(received[0].files.map(file => file.name)).toEqual(['shot.png']);
    expect(event.defaultPrevented).toBe(true);
  });

  it('鼠标不在缩略图区域时完全不拦截粘贴', () => {
    movePointer(900, 900);
    const event = paste(transfer([{ name: 'shot.png', type: 'image/png' }]));
    expect(received).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it('输入框里的 Ctrl+V 属于输入框', () => {
    const input = document.createElement('input');
    region.appendChild(input);
    movePointer(50, 50);
    const event = paste(transfer([{ name: 'shot.png', type: 'image/png' }]), input);
    expect(received).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it('纯文本粘贴保持原生行为，不吞事件也不提示', () => {
    movePointer(50, 50);
    const event = paste(textTransfer());
    expect(received).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it('剪贴板里是文件但不是媒体时交给调用方提示', () => {
    movePointer(50, 50);
    paste(transfer([{ name: 'note.txt', type: '' }]));
    expect(received).toEqual([{ files: [], hasFileEntry: true }]);
  });

  it('识别只有 items 条目的截图位图', () => {
    movePointer(50, 50);
    paste(bitmapTransfer());
    expect(received[0].files.map(file => file.name)).toEqual(['image.png']);
  });

  it('多个剪贴板文件只保留支持的媒体', () => {
    movePointer(50, 50);
    paste(transfer([
      { name: 'clip.mp4', type: 'video/mp4' },
      { name: 'notes.txt', type: '' },
      { name: 'art.webp', type: 'image/webp' },
    ]));
    expect(received[0].files.map(file => file.name)).toEqual(['clip.mp4', 'art.webp']);
  });

  it('遮罩层盖住缩略图区域时不导入', () => {
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    document.elementFromPoint = vi.fn(() => overlay) as unknown as typeof document.elementFromPoint;
    movePointer(50, 50);
    const event = paste(transfer([{ name: 'shot.png', type: 'image/png' }]));
    expect(received).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
    overlay.remove();
  });

  it('取消订阅后不再响应粘贴', () => {
    dispose?.();
    dispose = undefined;
    movePointer(50, 50);
    const event = paste(transfer([{ name: 'shot.png', type: 'image/png' }]));
    expect(received).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it('指针从未移动过时不猜测目标区域', () => {
    const event = paste(transfer([{ name: 'shot.png', type: 'image/png' }]));
    expect(received).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('helpers', () => {
  it('isPointerInsideRegion 只在矩形命中且命中的是区域自身时成立', () => {
    expect(isPointerInsideRegion(() => region, 10, 10)).toBe(true);
    expect(isPointerInsideRegion(() => region, 300, 10)).toBe(false);
    expect(isPointerInsideRegion(() => region, -1, 10)).toBe(false);
    expect(isPointerInsideRegion(() => null, 10, 10)).toBe(false);
    const zero = document.createElement('div');
    zero.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 0, bottom: 0, x: 0, y: 0, width: 0, height: 0, toJSON: () => ({}),
    }) as DOMRect;
    expect(isPointerInsideRegion(() => zero, 0, 0)).toBe(false);
  });

  it('isEditableTarget 覆盖输入框与富文本', () => {
    const input = document.createElement('input');
    const wrapper = document.createElement('div');
    wrapper.setAttribute('contenteditable', 'true');
    const nested = document.createElement('span');
    wrapper.appendChild(nested);
    document.body.append(input, wrapper);
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(nested)).toBe(true);
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it('readClipboardMedia 在没有剪贴板数据时报告没有文件', () => {
    expect(readClipboardMedia(undefined)).toEqual({ files: [], hasFileEntry: false });
    expect(readClipboardMedia(textTransfer())).toEqual({ files: [], hasFileEntry: false });
  });

  it('isAcceptedMediaFile 同时看 MIME 与扩展名', () => {
    expect(isAcceptedMediaFile({ name: '', type: 'image/png' })).toBe(true);
    expect(isAcceptedMediaFile({ name: 'clip.MOV', type: '' })).toBe(true);
    expect(isAcceptedMediaFile({ name: 'archive.zip', type: '' })).toBe(false);
    expect(isAcceptedMediaFile({ name: '', type: '' })).toBe(false);
  });
});

describe('Feed wiring', () => {
  const feed = () => readFileSync('src/components/Feed.svelte', 'utf8');

  it('订阅剪贴板粘贴并复用拖拽的导入流程与格式判断', () => {
    expect(feed()).toContain('subscribeClipboardPaste(() => scrollerEl');
    expect(feed()).toContain('await importFiles(files)');
    expect(feed()).toContain('return isAcceptedMediaFile(f);');
    expect(feed()).toContain('Ctrl+V 导入剪贴板图片');
  });
});
