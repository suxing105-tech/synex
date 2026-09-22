import { afterEach, expect, it, vi } from 'vitest';
import { foldersApi } from '../lib/api';
import { folders, folders as folderStore } from '../lib/stores';
import { connectEvents, disconnectEvents } from '../lib/ws';
import { get } from 'svelte/store';

vi.mock('../lib/api', () => ({
  imagesApi: { list: vi.fn().mockResolvedValue({ items: [], total: 0 }), detail: vi.fn().mockResolvedValue({ id: 1 }) },
  foldersApi: { tree: vi.fn().mockResolvedValue([{ id: 99, name: '来源目录' }]) },
  statsApi: { get: vi.fn().mockResolvedValue({ total_images: 0, favorites: 0, folders: 0 }) },
  scanApi: { progress: vi.fn() },
}));

afterEach(() => { vi.unstubAllGlobals(); disconnectEvents(); folders.set([]); });

it('收到 folders_changed 事件后刷新左侧目录树', async () => {
  let socket: any;
  class Socket {
    readyState = 1;
    onmessage: any;
    constructor() { socket = this; }
    close() {}
  }
  vi.stubGlobal('WebSocket', Socket);
  folders.set([]);
  connectEvents();
  await socket.onmessage({ data: JSON.stringify({ type: 'folders_changed' }) });
  expect(foldersApi.tree).toHaveBeenCalled();
  expect(get(folderStore).length).toBe(1);
  expect(get(folderStore)[0].name).toBe('来源目录');
});
