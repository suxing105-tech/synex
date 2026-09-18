import { afterEach, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { imagesApi } from '../lib/api';
import { feedItems, feedTotal, refreshFeed, removeImageFromFeed, selectedId, selectedDetail } from '../lib/stores';
import { connectEvents, disconnectEvents } from '../lib/ws';

vi.mock('../lib/api', () => ({
  imagesApi: { list: vi.fn().mockResolvedValue({ items: [], total: 0 }), detail: vi.fn().mockResolvedValue({ id: 1 }) },
  foldersApi: { tree: vi.fn().mockResolvedValue([]) },
  statsApi: { get: vi.fn().mockResolvedValue({ total_images: 0, favorites: 0, folders: 0 }) },
  scanApi: { progress: vi.fn() },
}));

afterEach(() => { vi.unstubAllGlobals(); feedItems.set([]); selectedId.set(null); });

it('删除事件立即去掉缩略图并清理详情，不重排剩余图片', async () => {
  let socket: any;
  class Socket {
    readyState = 1;
    onmessage: any;
    constructor() { socket = this; }
    close() {}
  }
  vi.stubGlobal('WebSocket', Socket);
  feedItems.set([{ id: 1 }, { id: 2 }] as any);
  feedTotal.set(2);
  selectedId.set(1);
  await Promise.resolve();
  connectEvents();
  await socket.onmessage({ data: JSON.stringify({ type: 'image_removed', id: 1 }) });
  expect(get(feedItems).map(i => i.id)).toEqual([2]);
  expect(get(feedTotal)).toBe(1);
  expect(get(selectedId)).toBeNull();
  expect(get(selectedDetail)).toBeNull();
  await socket.onmessage({ data: JSON.stringify({ type: 'image_removed', id: 1 }) });
  expect(get(feedTotal)).toBe(1);
  disconnectEvents();
});

it('进行中的旧请求不能恢复已删除缩略图', async () => {
  let resolve!: (value: any) => void;
  vi.mocked(imagesApi.list).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const request = refreshFeed();
  removeImageFromFeed(8);
  resolve({ items: [{ id: 8 }, { id: 9 }], total: 2 });
  await request;
  expect(get(feedItems).map(i => i.id)).toEqual([9]);
  expect(get(feedTotal)).toBe(1);
});

it('晚到的详情请求不能重新打开已删除图片', async () => {
  let resolve!: (value: any) => void;
  vi.mocked(imagesApi.detail).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  feedItems.set([{ id: 10 }] as any);
  selectedId.set(10);
  removeImageFromFeed(10);
  resolve({ id: 10 });
  await Promise.resolve();
  expect(get(selectedDetail)).toBeNull();
});


it('旧的列表响应不能覆盖移动完成后的新列表', async () => {
  let first!: (value: any) => void;
  vi.mocked(imagesApi.list).mockImplementationOnce(() => new Promise(resolve => { first = resolve; }));
  const old = refreshFeed();
  vi.mocked(imagesApi.list).mockResolvedValueOnce({ items: [{ id: 42 }], total: 1 } as any);
  await refreshFeed();
  first({ items: [{ id: 8 }], total: 1 });
  await old;
  expect(get(feedItems).map(item => item.id)).toEqual([42]);
});
