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
import { ICON_PATHS } from "../lib/icons";

vi.mock('../lib/native-drop', () => ({ subscribeFileDrop: vi.fn(() => () => {}) }));
vi.mock("../lib/api", () => ({ itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) }, foldersApi: { importDirectories: vi.fn(), create: vi.fn().mockResolvedValue({ id: 7 }), rename: vi.fn(), reorder: vi.fn(), move: vi.fn(), remove: vi.fn(), archive: vi.fn().mockResolvedValue({ ok: true, archived: true, hidden_media: 0, hidden_texts: 0 }), restore: vi.fn(), archived: vi.fn(async () => []), tree: vi.fn() } }));
vi.mock("../lib/stores", () => ({
  folders: writable([]), folderId: writable(null), scope: writable("all"),
  query: writable(""), tag: writable(null),
  textMode: writable(false), switchContent: vi.fn(),
  stats: writable({ total_images: 0, total_videos: 0, total_audio: 0, total_texts: 0, folders: 0 }), refreshFolders: vi.fn(), refreshFeed: vi.fn(), refreshStats: vi.fn(),
}));

/** happy-dom 会把自闭合标签补成 <rect ...></rect>，归一化后才能和 ICON_PATHS 原文比对 */
function innerSvg(el?: Element | null): string {
  return (el?.innerHTML ?? "").replace(/<([a-z]+)([^>]*?)><\/\1>/gi, "<$1$2/>");
}


const node = (id: number, name: string, children: any[] = [], parent_id: number | null = null) =>
  ({ id, name, children, parent_id, order: 0, counts: { image: 0, video: 0, audio: 0, text: 0 }, total: 0 });
// 我的文件夹住在图库数据目录里，所以真实数据一定带 path（有 path 才允许连磁盘一起删）
const mine = (id: number, name: string, children: any[] = [], parent_id: number | null = null) =>
  ({ ...node(id, name, children, parent_id), path: `D:/data/folders/${name}` });

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  clearToasts();
  folders.set([mine(1, '父目录', [mine(2, '子目录', [], 1)]), mine(3, '另一个目录')]);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('真实文件夹组件交互', () => {
  it('系统区五行把口径键写在悬停提示里', async () => {
    const screen = render(FolderTree);
    // 行的可访问名里带着计数，所以按 title 取行；提示本身就是这条用例要验的东西。
    const all = screen.getByTitle('所有素材 (0 / Q)');
    expect(all.getAttribute('aria-keyshortcuts')).toBe('0 q');
    expect(screen.getByTitle('全部音频 (A)').getAttribute('aria-keyshortcuts')).toBe('a');
  });

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

  it('虚拟分类不伪造磁盘位置，也没有删除文件夹可点', async () => {
    folders.set([node(1, '父目录', [node(2, '子目录', [], 1)])]);   // 老分类没有 path
    const screen = render(FolderTree);
    await fireEvent.contextMenu(screen.getByRole('button', { name: '父目录' }));
    expect((screen.getByRole('menuitem', { name: '所在文件夹位置' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('图库分类，无磁盘位置')).toBeTruthy();
    // 没有磁盘位置就没有「移入回收站」可言，只留归档
    expect(screen.queryByRole('menuitem', { name: '删除文件夹（移入回收站）' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: '归档' })).toBeTruthy();
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
    // 回退链路多了一层 await，提示会晚一个微任务出现，等它而不是猜时机
    await vi.waitFor(() => expect(get(toasts).some(t => t.message.includes('路径不存在'))).toBe(true));
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


it('来源目录菜单是新建/重命名/上移/下移/所在文件夹位置/归档，没有删除文件夹', async () => {
  folders.set([{ ...node(5, '来源', [], null), is_system: true, path: 'D:/watch/source' }]);
  const screen = render(FolderTree);
  await fireEvent.contextMenu(screen.getByRole('button', { name: '来源' }));
  const items = Array.from(screen.getByRole('menu').querySelectorAll('button')).map((b) => b.textContent?.trim());
  expect(items).toEqual(['新建文件夹', '重命名', '上移', '下移', '所在文件夹位置', '归档']);
});

it('归档来源目录：只调 archive，绝不调 remove，确认语说明磁盘不动', async () => {
  folders.set([{ ...node(5, '来源', [], null), is_system: true, path: 'D:/watch/source' }]);
  const c = vi.fn((_msg: string) => true);
  vi.stubGlobal('confirm', c);
  const screen = render(FolderTree);
  await fireEvent.contextMenu(screen.getByRole('button', { name: '来源' }));
  await fireEvent.click(screen.getByRole('menuitem', { name: '归档' }));
  expect(String(c.mock.calls[0][0])).toContain('磁盘上的文件夹与文件都留在原地');
  expect(String(c.mock.calls[0][0])).toContain('已归档目录');
  await tick();
  expect(foldersApi.archive).toHaveBeenCalledWith(5);
  expect(foldersApi.remove).not.toHaveBeenCalled();
  expect(refreshFeed).toHaveBeenCalled();
});

it('取消归档时什么都不调', async () => {
  folders.set([{ ...node(5, '来源', [], null), is_system: true, path: 'D:/watch/source' }]);
  vi.stubGlobal('confirm', vi.fn(() => false));
  const screen = render(FolderTree);
  await fireEvent.contextMenu(screen.getByRole('button', { name: '来源' }));
  await fireEvent.click(screen.getByRole('menuitem', { name: '归档' }));
  expect(foldersApi.archive).not.toHaveBeenCalled();
});

it('归档后浮一条 3 秒的居中提示，带查看与撤销；侧栏不再常驻说明', async () => {
  folders.set([{ ...node(5, '来源', [], null), is_system: true, path: 'D:/watch/source' }]);
  vi.stubGlobal('confirm', vi.fn(() => true));
  const screen = render(FolderTree);
  await fireEvent.contextMenu(screen.getByRole('button', { name: '来源' }));
  await fireEvent.click(screen.getByRole('menuitem', { name: '归档' }));
  await tick();
  const list = get(toasts);
  expect(list).toHaveLength(1);
  expect(list[0].placement).toBe('center');
  expect(list[0].ttl).toBe(3000);
  expect(list[0].icon).toBe('archive');
  expect(list[0].message).toContain('已归档「来源」');
  expect(list[0].actions?.map((a) => a.label)).toEqual(['查看', '撤销']);
  expect(list[0].actions?.[1].primary).toBe(true);
  // 常驻那行字撤掉了：即使有归档目录，侧栏里也不该再出现它
  vi.mocked(foldersApi.archived).mockResolvedValue([{ id: 5, name: '来源', path: 'D:/watch/source', is_system: true, media: 2, texts: 0 }]);
  await vi.runAllTimersAsync();
  await tick();
  expect(screen.queryByText(/已归档 1 个目录/)).toBeNull();
  vi.mocked(foldersApi.archived).mockResolvedValue([]);
});

it('提示条的撤销原地恢复目录，查看跳到设置的已归档目录', async () => {
  folders.set([{ ...node(5, '来源', [], null), is_system: true, path: 'D:/watch/source' }]);
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.mocked(foldersApi.restore).mockResolvedValue({ ok: true, archived: false });
  const screen = render(FolderTree);
  await fireEvent.contextMenu(screen.getByRole('button', { name: '来源' }));
  await fireEvent.click(screen.getByRole('menuitem', { name: '归档' }));
  await tick();
  const notice = get(toasts)[0];
  const dispatched: string[] = [];
  const spy = vi.spyOn(window, 'dispatchEvent').mockImplementation((e: Event) => { dispatched.push(e.type); return true; });
  notice.actions?.[0].onClick();
  expect(dispatched).toContain('open-archived-settings');
  spy.mockRestore();
  clearToasts();
  notice.actions?.[1].onClick();
  // 别跑假时钟：跑到底会把「已恢复」这条 1.5s 的提示一起超时关掉。
  // 撤销里串了三层 await（restore → 目录 → 素材），手动排空微任务。
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await tick();
  expect(foldersApi.restore).toHaveBeenCalledWith(5);
  expect(refreshFolders).toHaveBeenCalled();
  expect(refreshFeed).toHaveBeenCalled();
  expect(get(toasts).some((t) => t.message.includes('已恢复「来源」'))).toBe(true);
});

it('三个分组标题同级抢眼，文件夹行用实心文件夹字形', async () => {
  folders.set([{ ...node(5, '来源', [], null), is_system: true, path: 'D:/watch/source' }, mine(6, '我的目录')]);
  const screen = render(FolderTree);
  const bars = [...screen.container.querySelectorAll<HTMLElement>('.folder-group-bar')];
  expect(bars.map((b) => b.querySelector('.folder-group')?.textContent?.trim())).toEqual(['系统', '来源目录', '我的文件夹']);
  // 分组标题不再走「10px + uppercase + tracking」那条小字路线
  expect(bars.some((b) => (b.getAttribute('class') || '').includes('uppercase'))).toBe(false);
  // 整条标题栏都是「移回根层级」的放置区
  expect(bars.filter((b) => b.dataset.folderRoot).map((b) => b.dataset.folderRoot)).toEqual(['system', 'user']);
  const row = screen.getByRole('button', { name: '来源' });
  expect(innerSvg(row.querySelector('.icon svg'))).toBe(ICON_PATHS['folder-solid']);
});

it('「所有素材」换成房子图标（不再是叠层）', async () => {
  const screen = render(FolderTree);
  const row = screen.getByTitle('所有素材 (0 / Q)');
  expect(innerSvg(row.querySelector('svg'))).toBe(ICON_PATHS.home);
  expect(innerSvg(row.querySelector('svg'))).not.toBe(ICON_PATHS.layers);
});

it('我的文件夹菜单同时有归档与删除文件夹（移入回收站）', async () => {
  const screen = render(FolderTree);
  await fireEvent.contextMenu(screen.getByRole('button', { name: '父目录' }));
  const items = Array.from(screen.getByRole('menu').querySelectorAll('button')).map((b) => b.textContent?.trim());
  expect(items).toContain('归档');
  expect(items).toContain('删除文件夹（移入回收站）');
});


it('删除父目录后退出选中的子目录并刷新媒体列表', async () => {
  folderId.set(2);
  vi.stubGlobal('confirm', vi.fn(() => true));
  const screen = render(FolderTree);
  await fireEvent.contextMenu(screen.getByRole('button', { name: '父目录' }));
  await fireEvent.click(screen.getByRole('menuitem', { name: '删除文件夹（移入回收站）' }));
  await tick();
  expect(foldersApi.remove).toHaveBeenCalledWith(1);
  expect(get(folderId)).toBeNull();
  expect(refreshFeed).toHaveBeenCalled();
});

it('取消文件夹删除时保留当前目录且不调用删除接口', async () => {
  folderId.set(2);
  vi.stubGlobal('confirm', vi.fn(() => false));
  const screen = render(FolderTree);
  await fireEvent.contextMenu(screen.getByRole('button', { name: '父目录' }));
  await fireEvent.click(screen.getByRole('menuitem', { name: '删除文件夹（移入回收站）' }));
  expect(foldersApi.remove).not.toHaveBeenCalled();
  expect(get(folderId)).toBe(2);
});
