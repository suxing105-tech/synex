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
  expect(hover).toHaveBeenLastCalledWith(1, ['D:/项目/图.png']);
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

it('弹窗遮罩盖在上面时不算落在区域里：一次松手不许两处都收', async () => {
  const callbacks: Record<string, (e: any) => void> = {};
  (window as any).__TAURI__ = { event: { listen: vi.fn(async (name, callback) => {
    callbacks[name] = callback; return () => {};
  }) } };
  const region = document.createElement('div');
  vi.spyOn(region, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 800, top: 0, bottom: 600 } as DOMRect);
  // 弹窗那一整片遮罩不在 region 里，却盖在 region 上面：矩形算进来两处都算数
  const overlay = document.createElement('div');
  const hit = vi.spyOn(document, 'elementFromPoint').mockReturnValue(overlay);
  const hover = vi.fn(), drop = vi.fn().mockResolvedValue(undefined);
  const dispose = subscribeFileDrop(() => region, hover, drop);
  await Promise.resolve();
  const payload = { paths: ['D:/技能包.zip'], position: { x: 100, y: 100 } };
  callbacks['tauri://drag-enter']({ payload });
  expect(hover).toHaveBeenLastCalledWith(0, []);
  callbacks['tauri://drag-drop']({ payload });
  expect(drop).not.toHaveBeenCalled();
  // 命中的是这块地自己（或它肚子里的东西）就照常算落在这里
  hit.mockReturnValue(region);
  callbacks['tauri://drag-enter']({ payload });
  expect(hover).toHaveBeenLastCalledWith(1, ['D:/技能包.zip']);
  callbacks['tauri://drag-drop']({ payload });
  expect(drop).toHaveBeenCalledWith(['D:/技能包.zip'], { x: 100, y: 100 });
  dispose();
});

it('命中测试问不到就退回只看矩形，不把原本收得到的落点判没', async () => {
  const callbacks: Record<string, (e: any) => void> = {};
  (window as any).__TAURI__ = { event: { listen: vi.fn(async (name, callback) => {
    callbacks[name] = callback; return () => {};
  }) } };
  const region = document.createElement('div');
  vi.spyOn(region, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 400, top: 0, bottom: 200 } as DOMRect);
  vi.spyOn(document, 'elementFromPoint').mockImplementation(() => {
    throw new Error('这个环境不做命中测试');
  });
  const drop = vi.fn().mockResolvedValue(undefined);
  const dispose = subscribeFileDrop(() => region, vi.fn(), drop);
  await Promise.resolve();
  callbacks['tauri://drag-drop']({ payload: { paths: ['D:/a.png'], position: { x: 80, y: 80 } } });
  expect(drop).toHaveBeenCalledWith(['D:/a.png'], { x: 80, y: 80 });
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
