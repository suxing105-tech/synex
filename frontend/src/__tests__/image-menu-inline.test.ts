import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import Feed from '../components/Feed.svelte';
import ContextMenu from '../components/ContextMenu.svelte';
import { feedItems, feedLoading, folders, multiSelectedIds, scope } from '../lib/stores';
import { imagesApi } from '../lib/api';
vi.mock('../lib/api', () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) } ,
imagesApi: { list: vi.fn(async () => ({ items: get(feedItems), total: get(feedItems).length })), detail: vi.fn(), rename: vi.fn(), bulkAssignFolder: vi.fn() },
  foldersApi: { tree: vi.fn(async () => get(folders)) }, statsApi: { get: vi.fn() }, scanApi: { progress: vi.fn() }, comfyuiApi: {},
}));
const item = { id: 1, item_type: 'media', kind: 'image', filename: 'original.jpg', path: 'D:/original.jpg', width: 1600, height: 900 };
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  scope.set('image');
  feedLoading.set(false); feedItems.set([item] as any); multiSelectedIds.set(new Set());
  folders.set([{ id: 10, name: '项目', children: [{ id: 11, name: '角色', children: [{ id: 12, name: '定妆', children: [] }] }] }] as any);
  vi.mocked(imagesApi.rename).mockReset().mockResolvedValue({ ...item, filename: 'new.jpg' } as any);
  vi.mocked(imagesApi.bulkAssignFolder).mockReset().mockResolvedValue({ ids: [1] } as any);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); scope.set('all'); vi.mocked(imagesApi.list).mockImplementation(async () => ({ items: get(feedItems), total: get(feedItems).length }) as any); });
function feed() { return render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 }); }
it('菜单改名关闭菜单并聚焦名称输入，Enter 保存而不打开预览', async () => {
  const screen = feed();
  const prompt = vi.spyOn(window, 'prompt');
  await fireEvent.contextMenu(screen.getByAltText('original.jpg'));
  expect(screen.getByText('图片所在位置')).toBeTruthy(); expect(screen.getByText('删除图片')).toBeTruthy();
  await fireEvent.click(screen.getByText('重命名'));
  const input = await screen.findByLabelText('编辑图片名称');
  expect(document.activeElement).toBe(input); expect(screen.queryByRole('menu')).toBeNull();
  await fireEvent.input(input, { target: { value: 'new' } });
  await fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(screen.queryByLabelText('编辑图片名称')).toBeNull());
  expect(imagesApi.rename).toHaveBeenCalledWith(1, 'new'); expect(get(feedItems)[0].filename).toBe('new.jpg'); expect(prompt).not.toHaveBeenCalled();
});
it('双击名称进入编辑，Esc 取消不提交', async () => {
  const screen = feed();
  await fireEvent.doubleClick(screen.getByText('original.jpg'));
  const input = await screen.findByLabelText('编辑图片名称');
  await fireEvent.input(input, { target: { value: 'discard' } });
  await fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByLabelText('编辑图片名称')).toBeNull(); expect(imagesApi.rename).not.toHaveBeenCalled();
});
it('中文输入法 Enter 不提交，失焦保存，失败仍可编辑', async () => {
  vi.mocked(imagesApi.rename).mockRejectedValueOnce(new Error('目标文件已存在'));
  const screen = feed(); await fireEvent.doubleClick(screen.getByText('original.jpg'));
  const input = await screen.findByLabelText('编辑图片名称');
  await fireEvent.input(input, { target: { value: '中文' } });
  await fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(imagesApi.rename).not.toHaveBeenCalled();
  await fireEvent.blur(input);
  await waitFor(() => expect(screen.getByText(/目标文件已存在/)).toBeTruthy());
  expect(screen.getByLabelText('编辑图片名称')).toBeTruthy();
  expect(get(feedItems)[0].filename).toBe('original.jpg');
});
it('移动到逐级悬停展开，点击深层目录提交目标并关闭所有菜单', async () => {
  const screen = feed(); await fireEvent.contextMenu(screen.getByAltText('original.jpg'));
  await fireEvent.pointerEnter(screen.getByText('移动到…').closest('button')!);
  expect(screen.getAllByRole('menu')).toHaveLength(2);
  await fireEvent.pointerEnter(screen.getByText('项目').closest('button')!);
  expect(screen.getAllByRole('menu')).toHaveLength(3);
  await fireEvent.pointerEnter(screen.getByText('角色').closest('button')!);
  expect(screen.getAllByRole('menu')).toHaveLength(4);
  await fireEvent.click(screen.getByText('定妆'));
  expect(imagesApi.bulkAssignFolder).toHaveBeenCalledWith([1], 12);
  expect(screen.queryByRole('menu')).toBeNull();
});
it('有子目录的父目录也可以直接作为目标', async () => {
  const screen = feed(); await fireEvent.contextMenu(screen.getByAltText('original.jpg'));
  await fireEvent.pointerEnter(screen.getByText('移动到…').closest('button')!);
  await fireEvent.click(screen.getByText('项目'));
  expect(imagesApi.bulkAssignFolder).toHaveBeenCalledWith([1], 10);
});
it('切换父项清理旧分支，键盘可以展开，菜单位置限制在窗口内', async () => {
  const screen = render(ContextMenu, { open: true, x: -20, y: -20, items: [
    { label: '一级', children: [{ label: '二级', onClick: vi.fn() }] }, { label: '普通', onClick: vi.fn() },
  ] });
  expect(screen.getByRole('menu').getAttribute('style')).toContain('left: 4px');
  await fireEvent.keyDown(screen.getByText('一级').closest('button')!, { key: 'ArrowRight' });
  expect(document.activeElement?.textContent).toContain('二级');
  expect(screen.getByText('一级').closest('button')?.getAttribute('aria-expanded')).toBe('true');
  await fireEvent.pointerEnter(screen.getByText('普通').closest('button')!);
  expect(screen.queryByText('二级')).toBeNull();
});

it('右键菜单不再有任何收藏入口，重命名后面直接是所在位置', async () => {
  const screen = feed(); await fireEvent.contextMenu(screen.getByAltText('original.jpg'));
  const labels = screen.getAllByRole('menuitem').map(it => it.textContent?.trim());
  expect(labels).not.toContain('收藏');
  expect(labels).not.toContain('取消收藏');
  expect(labels.indexOf('图片所在位置')).toBe(labels.indexOf('重命名') + 1);
  expect(screen.queryByLabelText('已收藏')).toBeNull();
});

it('音频条目的菜单用「播放」替代复制图片', async () => {
  feedItems.set([{ id: 2, filename: 'take.mp3', path: 'D:/take.mp3', kind: 'audio', duration_seconds: 42 }] as any);
  const screen = feed(); await fireEvent.contextMenu(screen.getByTitle('take.mp3'));
  expect(screen.getByText('播放')).toBeTruthy();
  expect(screen.queryByText('复制图片')).toBeNull();
  expect(screen.getByText('删除音频')).toBeTruthy();
});
