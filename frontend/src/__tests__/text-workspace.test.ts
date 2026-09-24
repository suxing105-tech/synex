import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { writable } from 'svelte/store';
import TextWorkspace from '../components/TextWorkspace.svelte';
import { textsApi } from '../lib/texts';

vi.mock('../lib/stores', () => ({ textMode: writable(true), folderId: writable(null), view: writable('all'),
  folders: writable([]), textTotal: writable(0), refreshFolders: vi.fn(), refreshFeed: vi.fn(),
  selectedId: writable(null), feedItems: writable([]), switchContent: vi.fn(), kind: writable('image'), query: writable('') }));
vi.mock('../lib/native-drop', () => ({ subscribeFileDrop: () => () => {} }));
vi.mock('../lib/api', () => ({ imagesApi: { list: vi.fn() } }));
const d = (id = 1, body = '# 剧本\n\n第一幕') => ({ id, body, path: `C:/demo/${id}.md`, filename: `${id}.md`, format: 'md',
  version: 'v1', encoding: 'utf-8', newline: 'LF', bom: false, readonly: false, needs_encoding: false,
  excerpt: body, mtime: 1, created: 1, opened: 1, favorite: false, missing: false, error: '', tags: [] });
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(textsApi, 'list').mockResolvedValue({ items: [d()], total: 1 });
  vi.spyOn(textsApi, 'detail').mockImplementation(async id => d(id));
  vi.spyOn(textsApi, 'save').mockImplementation(async (id, body) => ({ ...d(id, body), version: 'v2' }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('列表宽度保存并在重启后恢复；清除筛选保留排序', async () => {
  localStorage.setItem('seekx-text-workspace-v1',JSON.stringify({sort:'name'}));
  const screen=render(TextWorkspace);
  await screen.findByText('文字，也是一份创作素材');
  await fireEvent.click(screen.getByLabelText('展开文本列表'));
  await fireEvent.keyDown(screen.getByRole('separator'),{key:'ArrowRight'});
  expect(JSON.parse(localStorage.getItem('seekx-text-workspace-v1')!).listWidth).toBe(236);
  await fireEvent.click(screen.getByLabelText('文本筛选'));
  await fireEvent.input(screen.getByLabelText('筛选标签'),{target:{value:'剧本'}});
  await fireEvent.click(screen.getByText('清除筛选'));
  expect((screen.getByLabelText('文本格式') as HTMLSelectElement).value).toBe('');
  expect((screen.getByLabelText('文本排序') as HTMLSelectElement).value).toBe('name');
  screen.unmount();
  const restored=render(TextWorkspace);
  await waitFor(() => expect(restored.getByRole('separator').getAttribute('aria-valuenow')).toBe('236'));
});

it('长按拖到另一文件之后会保存顺序，并在重启后恢复手动排序', async () => {
  let docs = [d(1), d(2)];
  vi.mocked(textsApi.list).mockImplementation(async () => ({ items:docs, total:2 }));
  const reorder = vi.spyOn(textsApi,'reorder').mockImplementation(async ids => { docs = ids.map(id => d(id)); return { ok:true }; });
  const screen = render(TextWorkspace);
  await fireEvent.click(screen.getByLabelText('展开文本列表'));
  const first = await screen.findByRole('button', { name:'1.md' });
  const second = screen.getByRole('button', { name:'2.md' });
  vi.spyOn(document,'elementFromPoint').mockReturnValue(second);
  vi.spyOn(second,'getBoundingClientRect').mockReturnValue({ top:40,height:30 } as DOMRect);
  await fireEvent.pointerDown(first, { pointerId:1,button:0,clientX:10,clientY:10 });
  await new Promise(resolve => setTimeout(resolve,370));
  await fireEvent.pointerMove(window, { pointerId:1,clientX:10,clientY:65 });
  await fireEvent.pointerUp(window, { pointerId:1,clientX:10,clientY:65 });
  await waitFor(() => expect(reorder).toHaveBeenCalledWith([2,1]));
  await waitFor(() => expect(JSON.parse(localStorage.getItem('seekx-text-workspace-v1')!).sort).toBe('manual'));
  screen.unmount();
  const restored = render(TextWorkspace);
  await restored.findByRole('button', { name:'2.md' });
  await waitFor(() => expect(textsApi.list).toHaveBeenCalledWith(expect.objectContaining({ sort:'manual' })));
});

it('双击列表内联改名，携带版本并保留中文扩展名，失败仍保留输入', async () => {
  const move = vi.spyOn(textsApi, 'move').mockRejectedValueOnce(new Error('目标文件已存在')).mockResolvedValueOnce({ ...d(), filename: '改名.md' });
  const screen = render(TextWorkspace);
  await fireEvent.click(screen.getByLabelText('展开文本列表'));
  await fireEvent.doubleClick(await screen.findByRole('button', { name: '1.md' }));
  const name = screen.getByLabelText('重命名文本');
  await fireEvent.input(name, { target: { value: '改名.md' } });
  await fireEvent.keyDown(name, { key: 'Enter' });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('目标文件已存在'));
  expect(screen.getByLabelText('重命名文本')).toBeTruthy();
  await fireEvent.keyDown(name, { key: 'Enter' });
  await waitFor(() => expect(screen.queryByLabelText('重命名文本')).toBeNull());
  expect(move).toHaveBeenLastCalledWith(1, 'C:/demo', '改名.md', 'v1');
});

it('不显示重复文件标题行，操作使用三个图标，旧源码会话重启后也先阅读', async () => {
  localStorage.setItem('seekx-text-workspace-v1', JSON.stringify({ ids:[1], activeId:1, source:true }));
  const screen = render(TextWorkspace);
  await screen.findByText('第一幕');
  expect(screen.container.querySelector('.document-title')).toBeNull();
  expect(screen.queryByRole('textbox', { name:'文本正文' })).toBeNull();
  for (const label of ['复制全文','保存','移入回收站']) {
    const button = screen.getByLabelText(label);
    expect(button.textContent?.trim()).toBe(''); expect(button.querySelector('svg')).toBeTruthy();
  }
  await fireEvent.click(screen.getByLabelText('移入回收站'));
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByRole('dialog').textContent).toContain('原文件');
});

it('搜索在同一工具栏，列表默认只有标题，搜索后显示正文片段；筛选可展开', async () => {
  const screen = render(TextWorkspace);
  await waitFor(() => expect(screen.getByText('文字，也是一份创作素材')).toBeTruthy());
  const search = screen.getByLabelText('搜索文本');
  expect(search.closest('header')).toBeTruthy();
  await fireEvent.click(screen.getByLabelText('展开文本列表'));
  const row = await screen.findByRole('button', { name: '1.md' });
  expect(row.querySelector('p')).toBeNull();
  expect(screen.queryByLabelText('文本格式')).toBeNull();
  await fireEvent.click(screen.getByLabelText('文本筛选'));
  expect(screen.getByLabelText('文本格式')).toBeTruthy();
  await fireEvent.click(screen.getByLabelText('收起文本列表'));
  await fireEvent.input(search, { target: { value: '第一幕' } });
  await waitFor(() => expect(textsApi.list).toHaveBeenCalledWith(expect.objectContaining({ q: '第一幕' })));
  expect(screen.getByLabelText('收起文本列表')).toBeTruthy();
  expect(screen.container.querySelector('.text-row p')?.textContent).toContain('第一幕');
});

it('默认正文优先，打开列表并编辑后 UI 与独立保存会话保持同步', async () => {
  const screen = render(TextWorkspace);
  await waitFor(() => expect(screen.getByText('文字，也是一份创作素材')).toBeTruthy());
  expect(screen.queryByLabelText('文本格式')).toBeNull();
  await fireEvent.click(screen.getByLabelText('展开文本列表'));
  await fireEvent.click(await screen.findByText('1.md'));
  await screen.findByText('第一幕');
  await fireEvent.click(screen.getByText('编辑'));
  await fireEvent.click(screen.getByText('第一幕'));
  const area = screen.getByLabelText('编辑 Markdown 段落');
  await fireEvent.input(area, { target: { value: '第二幕' } });
  await fireEvent.click(screen.getByLabelText('保存'));
  await waitFor(() => expect(textsApi.save).toHaveBeenCalledWith(1, '# 剧本\n\n第二幕', 'v1', 'utf-8', false));
  await waitFor(() => expect(screen.getByText('已保存')).toBeTruthy());
});

it('重启保留草稿，磁盘文件失联时也提供另存入口', async () => {
  localStorage.setItem('seekx-text-workspace-v1', JSON.stringify({ ids: [1], activeId: 1,
    drafts: [{ id: 1, body: '需要恢复的草稿', version: 'old', cursor: 0, scroll: 0 }] }));
  vi.mocked(textsApi.detail).mockRejectedValue(new Error('文件失联'));
  const screen = render(TextWorkspace);
  await waitFor(() => expect(screen.getByText('需要恢复的草稿')).toBeTruthy());
  expect(screen.getAllByText('另存副本').length).toBeGreaterThan(0);
  expect(JSON.parse(localStorage.getItem('seekx-text-workspace-v1')!).drafts[0].body).toBe('需要恢复的草稿');
});

it('后台刷新不会把正在编辑的段落切回预览', async () => {
  localStorage.setItem('seekx-text-workspace-v1', JSON.stringify({ ids: [1], activeId: 1 }));
  const screen = render(TextWorkspace);
  await screen.findByText('第一幕');
  await fireEvent.click(screen.getByText('编辑'));
  await fireEvent.click(screen.getByText('第一幕'));
  const area = screen.getByLabelText('编辑 Markdown 段落');
  window.dispatchEvent(new CustomEvent('texts-changed'));
  await waitFor(() => expect(textsApi.detail).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText('编辑 Markdown 段落')).toBe(area);
  await fireEvent.input(area, { target: { value: '轮询之后仍能继续编辑' } });
  await fireEvent.click(screen.getByLabelText('保存'));
  await waitFor(() => expect(textsApi.save).toHaveBeenCalledWith(1, '# 剧本\n\n轮询之后仍能继续编辑', 'v1', 'utf-8', false));
});
