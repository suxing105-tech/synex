import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import TextEditor from '../components/TextEditor.svelte';

afterEach(cleanup);
it('默认阅读，点击正文与 Enter 都不进入源码；显式编辑才可修改', async () => {
  const onchange = vi.fn();
  const screen = render(TextEditor, { body: '# 标题\n\n阅读正文', id: 1, markdown: true, onchange,
    onposition: vi.fn(), oncomposition: vi.fn(), onasset: vi.fn() });
  await fireEvent.click(screen.getByText('阅读正文'));
  await fireEvent.keyDown(screen.getByText('阅读正文'), { key: 'Enter' });
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(onchange).not.toHaveBeenCalled();
  await screen.rerender({ editing: true });
  await fireEvent.click(screen.getByText('阅读正文'));
  expect(screen.getByLabelText('编辑 Markdown 段落')).toBeTruthy();
});
it('空白 Markdown 可进入段落编辑并输入中文', async () => {
  const onchange = vi.fn();
  const screen = render(TextEditor, { body: '', id: 1, markdown: true, editing: true, onchange,
    onposition: vi.fn(), oncomposition: vi.fn(), onasset: vi.fn() });
  await fireEvent.click(screen.getByText('点击开始写作…')); await tick();
  const area = screen.getByLabelText('编辑 Markdown 段落');
  await fireEvent.input(area, { target: { value: '中文剧本' } });
  expect(onchange).toHaveBeenCalledWith('中文剧本');
});
it('源码模式支持输入法组合事件和纯文本编辑', async () => {
  const composition = vi.fn(); const change = vi.fn();
  const screen = render(TextEditor, { body: '原文', id: 2, markdown: false, editing: true, onchange: change,
    onposition: vi.fn(), oncomposition: composition, onasset: vi.fn() });
  const area = screen.getByLabelText('文本正文');
  await fireEvent.compositionStart(area); await fireEvent.input(area, { target: { value: '中文' } }); await fireEvent.compositionEnd(area);
  expect(composition.mock.calls).toEqual([[true], [false]]); expect(change).toHaveBeenLastCalledWith('中文');
});
