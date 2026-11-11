import { afterEach, expect, it, vi } from 'vitest';
import { subscribeFileDrop } from '../lib/native-drop';

afterEach(() => { delete (window as any).__TAURI__; vi.restoreAllMocks(); });

it('只接受中间区域的原生拖放，按屏幕缩放换算坐标，并保留原始磁盘路径', async () => {
  const callbacks: Record<string, (e: any) => void> = {};
  const unlisten = vi.fn();
  (window as any).__TAURI__ = { event: { listen: vi.fn(async (name, callback) => {
    callbacks[name] = callback; return unlisten;
  }) } };
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2);
  const region = document.createElement('div');
  vi.spyOn(region, 'getBoundingClientRect').mockReturnValue({ left: 260, right: 900, top: 50, bottom: 700 } as DOMRect);
  const hover = vi.fn(), drop = vi.fn().mockResolvedValue(undefined);
  const dispose = subscribeFileDrop(() => region, hover, drop);
  await Promise.resolve();
  const payload = { paths: ['D:/项目/图.png'], position: { x: 600, y: 200 } };
  callbacks['tauri://drag-enter']({ payload });
  expect(hover).toHaveBeenLastCalledWith(1);
  callbacks['tauri://drag-drop']({ payload: { ...payload, position: { x: 100, y: 200 } } });
  expect(drop).not.toHaveBeenCalled();
  callbacks['tauri://drag-drop']({ payload });
  // 落点同样按缩放换算后交给调用方：要按「哪一格」落位的调用方只认这一个坐标
  expect(drop).toHaveBeenCalledWith(['D:/项目/图.png'], { x: 300, y: 100 });
  dispose();
  expect(unlisten).toHaveBeenCalledTimes(4);
  callbacks['tauri://drag-drop']({ payload });
  expect(drop).toHaveBeenCalledTimes(1);
});

it('指针位置一路报给调用方：在区内给坐标，出区、离开、松手之后给 null', async () => {
  const callbacks: Record<string, (e: any) => void> = {};
  (window as any).__TAURI__ = { event: { listen: vi.fn(async (name, callback) => {
    callbacks[name] = callback; return () => {};
  }) } };
  const region = document.createElement('div');
  vi.spyOn(region, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 400, top: 0, bottom: 100 } as DOMRect);
  const points: unknown[] = [];
  const drop = vi.fn().mockResolvedValue(undefined);
  const dispose = subscribeFileDrop(() => region, vi.fn(), drop, (p) => points.push(p));
  await Promise.resolve();
  callbacks['tauri://drag-over']({ payload: { paths: ['D:/a.png'], position: { x: 120, y: 40 } } });
  expect(points).toEqual([{ x: 120, y: 40 }]);
  callbacks['tauri://drag-over']({ payload: { paths: ['D:/a.png'], position: { x: 900, y: 40 } } });
  expect(points.slice(-1)).toEqual([null]);
  callbacks['tauri://drag-drop']({ payload: { paths: ['D:/a.png'], position: { x: 120, y: 40 } } });
  // 顺序要紧：先把落点交给调用方，再清掉 over 阶段那份记录。反过来做，「正指着哪一格」就被自己清了
  expect(drop).toHaveBeenCalledWith(['D:/a.png'], { x: 120, y: 40 });
  expect(points.slice(-1)).toEqual([null]);
  dispose();
});

it('组件在订阅完成前卸载也会释放所有监听', async () => {
  const unlisten = vi.fn();
  (window as any).__TAURI__ = { event: { listen: async () => unlisten } };
  const dispose = subscribeFileDrop(() => null, vi.fn(), vi.fn());
  dispose();
  await Promise.resolve();
  expect(unlisten).toHaveBeenCalledTimes(4);
});
