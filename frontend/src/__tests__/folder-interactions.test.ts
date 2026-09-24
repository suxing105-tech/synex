import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { writable } from "svelte/store";
import { tick } from "svelte";
import FolderTree from "../components/FolderTree.svelte";
import { foldersApi } from "../lib/api";
import { folders, folderId, refreshFeed, refreshFolders } from "../lib/stores";
import { subscribeFileDrop } from '../lib/native-drop';
import { get } from "svelte/store";
import { clearToasts, toasts } from "../lib/toast";

vi.mock('../lib/native-drop', () => ({ subscribeFileDrop: vi.fn(() => () => {}) }));
vi.mock("../lib/api", () => ({ foldersApi: { importDirectories: vi.fn(), create: vi.fn().mockResolvedValue({ id: 7 }), rename: vi.fn(), reorder: vi.fn(), move: vi.fn(), remove: vi.fn(), tree: vi.fn() } }));
vi.mock("../lib/stores", () => ({
  folders: writable([]), folderId: writable(null), view: writable("all"),
  kind: writable("image"), query: writable(""), tag: writable(null),
  textMode: writable(false), textTotal: writable(0), switchContent: vi.fn(),
  stats: writable({ total_images: 0, total_videos: 0, favorites: 0 }), refreshFolders: vi.fn(), refreshFeed: vi.fn(), refreshStats: vi.fn(),
}));

const node = (id: number, name: string, children: any[] = [], parent_id: number | null = null) =>
  ({ id, name, children, parent_id, order: 0, image_count: 0, recursive_count: 0 });

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  clearToasts();
  folders.set([node(1, '父目录', [node(2, '子目录', [], 1)]), node(3, '另一个目录')]);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('真实文件夹组件交互', () => {
  it('侧栏原生拖入目录后刷新树和缩略图并选中导入目录', async () => {
    const screen = render(FolderTree);
    const [region, hover, drop] = vi.mocked(subscribeFileDrop).mock.calls[0];
    expect(region()).toBe(screen.container.querySelector('.folder-scroll'));
    hover(1); await tick();
    expect(screen.getByRole('status').textContent).toContain('复制');
    vi.mocked(foldersApi.importDirectories).mockResolvedValue({ copied: [{ id: 22, name: '桌面目录', path: 'D:/data/folders/桌面目录' }], failed: [], warnings: [] });
    await drop(['C:/Desktop/桌面目录']);
    expect(foldersApi.importDirectories).toHaveBeenCalledWith(['C:/Desktop/桌面目录']);
    expect(refreshFolders).toHaveBeenCalled();
    expect(refreshFeed).toHaveBeenCalled();
    expect(get(folderId)).toBe(22);
  });

  it('单击收起子项，再次单击恢复；保留子节点自身的展开状态', async () => {
    const screen = render(FolderTree);
    const row = screen.getByRole('button', { name: '父目录' });
    expect(screen.getByText('子目录')).toBeTruthy();
    await fireEvent.click(row, { detail: 1 });
    await vi.advanceTimersByTimeAsync(320); await tick();
    expect(screen.queryByText('子目录')).toBeNull();
    expect(row.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(row, { detail: 1 });
    await vi.advanceTimersByTimeAsync(320); await tick();
    expect(screen.getByText('子目录')).toBeTruthy();
  });

  it('双击改名不会触发折叠；保存调用接口', async () => {
    const screen = render(FolderTree);
    const row = screen.getByRole('button', { name: '父目录' });
    await fireEvent.click(row, { detail: 1 });
    await fireEvent.click(row, { detail: 2 });
    await fireEvent.doubleClick(row);
    await vi.advanceTimersByTimeAsync(300);
    expect(screen.getByText('子目录')).toBeTruthy();
    await fireEvent.input(screen.getByRole('textbox', { name: '文件夹名称' }), { target: { value: '新名字' } });
    const input = screen.getByRole('textbox', { name: '文件夹名称' });
    expect(row.contains(input)).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(screen.queryByText('重命名文件夹')).toBeNull();
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(foldersApi.rename).toHaveBeenCalledWith(1, '新名字');
  });

  it('短按不排序；长按拖动显示落点，松开只提交一次', async () => {
    const screen = render(FolderTree);
    const row = screen.getByRole('button', { name: '父目录' });
    const target = screen.getByRole('button', { name: '另一个目录' });
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 40 } as DOMRect);
    await fireEvent.pointerDown(row, { button: 0, clientX: 20, clientY: 20 });
    await vi.advanceTimersByTimeAsync(200);
    await fireEvent.pointerUp(window);
    expect(foldersApi.reorder).not.toHaveBeenCalled();
    await fireEvent.pointerDown(row, { button: 0, clientX: 20, clientY: 20 });
    await vi.advanceTimersByTimeAsync(450); await tick();
    expect(screen.getByRole('status')).toBeTruthy();
    await fireEvent.pointerMove(window, { clientX: 20, clientY: 130 });
    expect(target.classList.contains('drop-after')).toBe(true);
    await fireEvent.pointerUp(window);
    expect(foldersApi.reorder).toHaveBeenCalledWith(1, 3, 'after');
    await fireEvent.click(row, { detail: 1 });
    await vi.advanceTimersByTimeAsync(300);
    expect(screen.getByText('子目录')).toBeTruthy();
  });

  it('来源目录支持双击改显示名称；Escape 取消拖动', async () => {
    folders.set([{ ...node(5, '来源'), is_system: true, path: 'D:/watch/source' }]);
    const screen = render(FolderTree);
    const row = screen.getByRole('button', { name: '来源' });
    await fireEvent.doubleClick(row);
    expect(row.contains(screen.getByRole('textbox', { name: '文件夹名称' }))).toBe(true);
    await fireEvent.keyDown(window, { key: 'Escape' });
    await fireEvent.pointerDown(row, { button: 0 });
    await vi.advanceTimersByTimeAsync(450);
    await fireEvent.keyDown(window, { key: 'Escape' });
    await fireEvent.pointerUp(window);
    expect(foldersApi.reorder).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

 it('行内 Escape 取消；失焦保存；中文输入法 Enter 不提前提交', async () => {
    const screen = render(FolderTree);
    const row = screen.getByRole('button', { name: '父目录' });
    await fireEvent.doubleClick(row);
    let input = screen.getByRole('textbox', { name: '文件夹名称' });
    await fireEvent.input(input, { target: { value: '取消的名字' } });
    await fireEvent.keyDown(input, { key: 'Escape' });
    expect(foldersApi.rename).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
    await fireEvent.doubleClick(row);
    input = screen.getByRole('textbox', { name: '文件夹名称' });
    await fireEvent.input(input, { target: { value: '完成的名字' } });
    await fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(foldersApi.rename).not.toHaveBeenCalled();
    await fireEvent.blur(input);
    expect(foldersApi.rename).toHaveBeenCalledWith(1, '完成的名字');
  });

  it('右键来源目录显示所在位置并调用打开接口；不折叠目录', async () => {
    folders.set([{ ...node(5, '来源', [node(6, '子项', [], 5)]), is_system: true, path: 'D:/watch/source' }]);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    const screen = render(FolderTree);
    const row = screen.getByRole('button', { name: '来源' });
    await fireEvent.contextMenu(row, { clientX: 80, clientY: 120 });
    expect(screen.getByRole('menu')).toBeTruthy();
    await fireEvent.click(screen.getByRole('menuitem', { name: '所在文件夹位置' }));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/folders/5/reveal'), { method: 'POST' });
    expect(screen.getByText('子项')).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('虚拟分类不伪造磁盘位置', async () => {
    const screen = render(FolderTree);
    await fireEvent.contextMenu(screen.getByRole('button', { name: '父目录' }));
    expect((screen.getByRole('menuitem', { name: '所在文件夹位置' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('图库分类，无磁盘位置')).toBeTruthy();
  });

  it('左侧栏空白处右键显示新建文件夹，并在侧栏内编辑', async () => {
    const screen = render(FolderTree);
    const scroll = screen.container.querySelector('.folder-scroll');
    expect(scroll).toBeTruthy();
    await fireEvent.contextMenu(scroll! , { clientX: 90, clientY: 180 });
    expect(screen.getByRole('menuitem', { name: '新建文件夹' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('menuitem', { name: '新建文件夹' }));
    expect(screen.getByRole('textbox', { name: '新建文件夹名称' })).toBeTruthy();
  });

  it('文件夹菜单第一项是新建子文件夹，创建时保留父目录', async () => {
    const screen = render(FolderTree);
    await fireEvent.contextMenu(screen.getByRole('button', { name: '父目录' }));
    const items = Array.from(screen.getByRole('menu').querySelectorAll('button'));
    const childIndex = items.findIndex((item) => item.textContent?.trim() === '新建文件夹');
    const locationIndex = items.findIndex((item) => item.textContent?.trim() === '所在文件夹位置');
    expect(childIndex).toBe(0);
    expect(locationIndex).toBeGreaterThan(childIndex);
    await fireEvent.click(items[0]);
    const input = screen.getByRole('textbox', { name: '新建文件夹名称' });
    await fireEvent.input(input, { target: { value: '新子目录' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(foldersApi.create).toHaveBeenCalledWith('新子目录', 1);
  });

  it('改名失败保留行内输入；空白名称不提交', async () => {
    const screen = render(FolderTree);
    await fireEvent.doubleClick(screen.getByRole('button', { name: '父目录' }));
    const input = screen.getByRole('textbox', { name: '文件夹名称' }) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '   ' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(foldersApi.rename).not.toHaveBeenCalled();
    vi.mocked(foldersApi.rename).mockRejectedValueOnce(new Error('同名文件夹'));
    await fireEvent.input(input, { target: { value: '重复名称' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('textbox', { name: '文件夹名称' })).toBe(input);
    expect(input.value).toBe('重复名称');
    expect(get(toasts).some(t => t.message.includes('同名文件夹'))).toBe(true);
  });

  it('所在位置接口失败时显示原因', async () => {
    folders.set([{ ...node(5, '来源'), is_system: true, path: 'D:/missing' }]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, json: async () => ({ detail: '路径不存在' }) } as Response);
    const screen = render(FolderTree);
    await fireEvent.contextMenu(screen.getByRole('button', { name: '来源' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: '所在文件夹位置' }));
    expect(get(toasts).some(t => t.message.includes('路径不存在'))).toBe(true);
  });


it('我的文件夹直接在侧栏输入名称，Enter 创建并选中新文件夹', async () => {
  const screen = render(FolderTree);
  await fireEvent.click(screen.getByTitle('新建文件夹'));
  const input = screen.getByRole('textbox', { name: '新建文件夹名称' });
  expect(input.closest('.folder-scroll')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  await fireEvent.input(input, { target: { value: '真实目录' } });
  await fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(foldersApi.create).not.toHaveBeenCalled();
  await fireEvent.keyDown(input, { key: 'Enter' });
  expect(foldersApi.create).toHaveBeenCalledWith('真实目录', null);
  expect(screen.queryByRole('textbox')).toBeNull();
});

it('取消新建不创建目录，顶部按钮只收起侧栏', async () => {
  const collapse = vi.fn();
  const screen = render(FolderTree, { oncollapse: collapse });
  expect(screen.queryByTitle('在根目录新建文件夹')).toBeNull();
  await fireEvent.click(screen.getByTitle('新建文件夹'));
  await fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
  expect(foldersApi.create).not.toHaveBeenCalled();
  await fireEvent.click(screen.getByRole('button', { name: '收起左侧栏' }));
  expect(collapse).toHaveBeenCalledOnce();
});

 it('子文件夹长按可拖进另一层父目录', async () => {
  const screen = render(FolderTree);
  const child = screen.getByRole('button', { name: '子目录' });
  const target = screen.getByRole('button', { name: '另一个目录' });
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 40 } as DOMRect);
  await fireEvent.pointerDown(child, { button: 0, clientX: 20, clientY: 20 });
  await vi.advanceTimersByTimeAsync(450);
  await fireEvent.pointerMove(window, { clientX: 20, clientY: 120 });
  expect(target.classList.contains('drop-inside')).toBe(true);
  await fireEvent.pointerUp(window);
  expect(foldersApi.reorder).toHaveBeenCalledWith(2, 3, 'inside');
 });


it('来源目录菜单包含新建/重命名/上移/下移/所在文件夹位置/删除文件夹', async () => {
  folders.set([{ ...node(5, '来源', [], null), is_system: true, path: 'D:/watch/source' }]);
  const screen = render(FolderTree);
  await fireEvent.contextMenu(screen.getByRole('button', { name: '来源' }));
  const items = Array.from(screen.getByRole('menu').querySelectorAll('button')).map((b) => b.textContent?.trim());
  expect(items).toEqual(['新建文件夹', '重命名', '上移', '下移', '所在文件夹位置', '删除文件夹']);
});

it('删除来源目录触发破坏性确认并调用 remove', async () => {
  folders.set([{ ...node(5, '来源', [], null), is_system: true, path: 'D:/watch/source' }]);
  const c = vi.fn((_msg: string) => true);
  vi.stubGlobal('confirm', c);
  const screen = render(FolderTree);
  await fireEvent.contextMenu(screen.getByRole('button', { name: '来源' }));
  await fireEvent.click(screen.getByText('删除文件夹'));
  expect(c).toHaveBeenCalled();
  expect(String(c.mock.calls[0][0])).toContain('永久删除');
  expect(foldersApi.remove).toHaveBeenCalledWith(5);
});
