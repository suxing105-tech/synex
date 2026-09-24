import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextError, TextSession, type TextDetail, textsApi } from '../lib/texts';
import { markdownBlocks, renderMarkdown } from '../lib/text-markdown';

export const detail = (body = '原文', version = 'v1'): TextDetail => ({ id: 1, path: 'C:/notes/剧本.md', filename: '剧本.md', format: 'md', body,
  version, encoding: 'utf-8', newline: 'LF', bom: false, readonly: false, needs_encoding: false,
  excerpt: body, mtime: 0, created: 0, opened: 0, favorite: false, missing: false, error: '', tags: [] });
afterEach(() => vi.useRealTimers());

describe('独立文档保存队列', () => {
  it('输入法组词期间不保存，完成后延迟保存', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_id, body) => detail(body, 'v2'));
    const session = new TextSession(detail(), vi.fn(), { ...textsApi, save });
    session.composition(true); session.edit('中文输入');
    await vi.advanceTimersByTimeAsync(2000); expect(save).not.toHaveBeenCalled();
    session.composition(false); await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledWith(1, '中文输入', 'v1', 'utf-8', false);
    expect(session.state).toBe('saved'); session.dispose();
  });
  it('保存请求返回后仍保留后续输入，下次保存使用最新版本号', async () => {
    let resolve!: (d: TextDetail) => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise(r => resolve = r)).mockImplementation(async (_id, body) => detail(body, 'v3'));
    const s = new TextSession(detail(), vi.fn(), { ...textsApi, save });
    s.edit('第一次'); const pending = s.flush(); s.edit('第二次');
    resolve(detail('第一次', 'v2')); await pending;
    expect(s.body).toBe('第二次'); expect(s.dirty).toBe(true);
    await s.flush(); expect(save.mock.calls[1][2]).toBe('v2'); expect(s.state).toBe('saved'); s.dispose();
  });
  it('冲突后暂停自动保存并保留当前草稿', async () => {
    const save = vi.fn().mockRejectedValue(new TextError('外部修改', 409));
    const s = new TextSession(detail(), vi.fn(), { ...textsApi, save });
    s.edit('我的内容'); await s.flush(); expect(s.state).toBe('conflict');
    await s.flush(); expect(save).toHaveBeenCalledTimes(1); expect(s.draft.body).toBe('我的内容'); s.dispose();
  });
  it('外部变化在无本地修改时刷新，有修改时进入冲突', async () => {
    const api = { ...textsApi, detail: vi.fn().mockResolvedValue(detail('外部内容', 'v2')) };
    const clean = new TextSession(detail(), vi.fn(), api); await clean.refresh(); expect(clean.body).toBe('外部内容');
    const dirty = new TextSession(detail(), vi.fn(), api); dirty.edit('我的内容'); await dirty.refresh();
    expect(dirty.body).toBe('我的内容'); expect(dirty.state).toBe('conflict'); clean.dispose(); dirty.dispose();
  });
  it('重启恢复草稿时检查磁盘版本', () => {
    const s = new TextSession(detail('外部', 'v2'), vi.fn(), textsApi, { id: 1, body: '未保存', version: 'v1', cursor: 3, scroll: 42 });
    expect(s.body).toBe('未保存'); expect(s.state).toBe('conflict'); expect(s.scroll).toBe(42); s.dispose();
  });
});

describe('安全 Markdown 排版', () => {
  it('转义 HTML 并且不自动请求远程图片或执行协议', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n![x](https://example.com/x.png)\n[x](javascript:alert)', 1);
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<img'); expect(html).not.toContain('href="javascript:');
  });
  it('只使用本地素材接口，并转义属性', () => {
    const html = renderMarkdown('![参考](../图.png)\n[坏](<a"onclick="bad>)', 1);
    expect(html).toContain('/api/texts/1/asset?href='); expect(html).not.toContain(' onclick=');
  });
  it('标题、任务、表格、代码和引用有对应排版', () => {
    const html = renderMarkdown('# 标题\n- [x] 已完成\n> 引用\n\n| 一 | 二 |\n| --- | --- |\n| a | b |\n\n```\n<script>\n```', 1);
    for (const tag of ['<h1>', '☑', '<blockquote>', '<table>', '<pre>']) expect(html).toContain(tag);
    expect(html).toContain('&lt;script&gt;');
  });
  it('分块不改变原文，代码中的空行保持在同一块', () => {
    const body = '# 标题\n\n```\na\n\nb\n```\n\n结尾';
    const blocks = markdownBlocks(body);
    expect(blocks.map(x => x.text).join('')).toBe(body);
    expect(blocks.some(x => x.text.includes('a\n\nb'))).toBe(true);
  });
});
