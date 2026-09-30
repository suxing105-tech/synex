import { afterEach, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import FolderPicker from '../components/FolderPickerModal.svelte';
import { readFileSync } from 'node:fs';

afterEach(cleanup);
const folders = [{ id: 1, name: '图片', children: [], is_system: false }, { id: 2, name: '视频目录', children: [], is_system: true }] as any;
it('asks for a real destination, includes source folders, and selects the filtered result', async () => {
  const pick = vi.fn();
  const ui = render(FolderPicker, { open: true, folders, allowNone: false, includeSystem: true, onPick: pick, onClose: vi.fn() });
  expect(ui.queryByText('不分配 / 从文件夹移出')).toBeNull();
  await fireEvent.input(ui.getByLabelText('搜索文件夹'), { target: { value: '视频' } });
  await fireEvent.click(ui.getByText('视频目录'));
  expect(pick).toHaveBeenCalledWith({ id: 2, name: '视频目录' });
});
it('allows cancel without importing', async () => {
  const pick = vi.fn(), close = vi.fn();
  const ui = render(FolderPicker, { open: true, folders, allowNone: false, onPick: pick, onClose: close });
  await fireEvent.click(ui.getByText('取消'));
  expect(close).toHaveBeenCalledOnce(); expect(pick).not.toHaveBeenCalled();
});
it('captures the selected destination before copying and describes the saved media type', () => {
  const source = readFileSync('src/components/Feed.svelte', 'utf8');
  expect(source).toContain('if ($folderId !== null) return { id: $folderId, name: $activeFolderName }');
  expect(source).toContain('imagesApi.copyFiles([path], targetId)');
  expect(source).toContain('const targetId = destination.id');
  expect(source).toContain('${videos} 个视频');
  expect(source).not.toContain('return "收件箱"');
});
