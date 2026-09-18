import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { writable } from "svelte/store";
import { tick } from "svelte";
import FolderTree from "../components/FolderTree.svelte";
import { foldersApi } from "../lib/api";
import { folders } from "../lib/stores";

vi.mock("../lib/api", () => ({ foldersApi: { rename: vi.fn(), reorder: vi.fn(), tree: vi.fn() } }));
vi.mock("../lib/stores", () => ({
  folders: writable([]), folderId: writable(null), view: writable("all"),
  stats: writable({ total_images: 0, favorites: 0 }), refreshFolders: vi.fn(),
}));

const node = (id: number, name: string, children: any[] = [], parent_id: number | null = null) =>
  ({ id, name, children, parent_id, order: 0, image_count: 0, recursive_count: 0 });

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  folders.set([node(1, '父目录', [node(2, '子目录', [], 1)]), node(3, '另一个目录')]);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('真实文件夹组件交互', () => {
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
    await fireEvent.click(screen.getByText('保存'));
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
    expect(screen.getByText('修改图库中的显示名称，磁盘路径保持不变。')).toBeTruthy();
    await fireEvent.keyDown(window, { key: 'Escape' });
    await fireEvent.pointerDown(row, { button: 0 });
    await vi.advanceTimersByTimeAsync(450);
    await fireEvent.keyDown(window, { key: 'Escape' });
    await fireEvent.pointerUp(window);
    expect(foldersApi.reorder).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
