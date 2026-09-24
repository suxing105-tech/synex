import { backendUrl } from './backend-url';

export interface TextSummary {
  id: number; path: string; filename: string; format: string; excerpt: string;
  mtime: number; created: number; opened: number; favorite: boolean; tags: string[];
  missing: boolean; error: string; match_offset?: number;
}
export interface TextDetail extends TextSummary {
  body: string; version: string; encoding: string | null; newline: string;
  bom: boolean; readonly: boolean; needs_encoding: boolean;
}
export interface TextHistory { id: string; text_id: number; created: number; filename: string; }
export class TextError extends Error { constructor(message: string, public status: number) { super(message); } }
async function request<T>(path: string, method = 'GET', payload?: unknown): Promise<T> {
  const response = await fetch(backendUrl('/api/texts' + path), {
    method, headers: { 'Content-Type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const result = await response.json();
  if (!response.ok) throw new TextError(typeof result.detail === 'string' ? result.detail : '文本操作失败', response.status);
  return result;
}
export const textsApi = {
  reorder: (ids: number[]) => request('/reorder', 'POST', { ids }),
  list: (options: Record<string, unknown> = {}) => {
    const q = new URLSearchParams();
    Object.entries(options).forEach(([k, v]) => { if (v !== null && v !== undefined && v !== '') q.set(k, String(v)); });
    return request<{ items: TextSummary[]; total: number }>('?' + q);
  },
  detail: (id: number, encoding?: string, opened = false) => request<TextDetail>(`/${id}?opened=${opened}${encoding ? '&encoding=' + encodeURIComponent(encoding) : ''}`),
  preview: (paths: string[]) => request<{ total: number; formats: Record<string, number>; roots: string[]; errors: { path: string; reason: string }[] }>('/preview', 'POST', { paths }),
  associate: (paths: string[]) => request<{ saved: TextSummary[]; errors: { path: string; reason: string }[] }>('/associate', 'POST', { paths }),
  create: (payload: { directory: string; name: string; body?: string; folder_id?: number | null }) => request<TextDetail>('', 'POST', payload),
  save: (id: number, body: string, version: string, encoding: string | null, resolving_conflict = false) => request<TextDetail>(`/${id}`, 'PUT', { body, version, encoding, resolving_conflict }),
  reveal: (id: number) => request(`/${id}/reveal`, 'POST'),
  meta: (id: number, payload: { favorite?: boolean; tags?: string[] }) => request<TextSummary>(`/${id}`, 'PATCH', payload),
  move: (id: number, directory: string, name: string, version: string) => request<TextDetail>(`/${id}/move`, 'POST', { directory, name, version }),
  trash: (id: number, version: string) => request(`/${id}/trash`, 'POST', { version }),
  history: (id: number) => request<TextHistory[]>(`/${id}/history`),
  historical: (id: number, entry: string) => request<{ body: string; created: number }>(`/${id}/history/${entry}`),
  restore: (id: number, entry: string, version: string) => request<TextDetail>(`/${id}/history/${entry}/restore`, 'POST', { version }),
  reference: (id: number, media: number) => request<{ markdown: string; href: string; portable: boolean }>(`/${id}/reference/${media}`),
  assetInfo: (id: number, href: string) => request<{ id: number; kind: 'image' | 'video' | 'text' }>(`/${id}/asset-info?href=${encodeURIComponent(href)}`),
};

export interface TextDraft { id: number; body: string; version: string; cursor: number; scroll: number; }
export type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

/** One save queue per document; responses never replace edits typed during a request. */
export class TextSession {
  body: string;
  baseline: string;
  state: SaveState = 'saved';
  error = '';
  composing = false;
  cursor = 0;
  scroll = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private resolvingConflict = false;
  constructor(public detail: TextDetail, private changed: () => void,
    private api = textsApi, draft?: TextDraft) {
    this.body = this.baseline = detail.body;
    if (draft) {
      this.cursor = draft.cursor; this.scroll = draft.scroll;
      if (draft.body !== detail.body) {
        this.body = draft.body;
        this.state = draft.version === detail.version ? 'dirty' : 'conflict';
        if (this.state === 'conflict') this.error = '恢复了未保存草稿，磁盘文件也有改动';
      }
    }
  }
  get dirty() { return this.body !== this.baseline; }
  get draft(): TextDraft { return { id: this.detail.id, body: this.body, version: this.detail.version, cursor: this.cursor, scroll: this.scroll }; }
  edit(body: string) {
    this.body = body;
    if (!['conflict', 'error'].includes(this.state)) this.state = this.dirty ? 'dirty' : 'saved';
    this.changed(); this.schedule();
  }
  composition(active: boolean) { this.composing = active; if (active) clearTimeout(this.timer); else this.schedule(); }
  schedule() {
    clearTimeout(this.timer);
    if (this.dirty && !this.composing && !this.detail.readonly && !['conflict', 'error'].includes(this.state)) {
      this.timer = setTimeout(() => { void this.flush(); }, 1000);
    }
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.pending) { await this.pending; if (this.dirty && this.state === 'dirty') await this.flush(); return; }
    if (!this.dirty || this.composing || this.detail.readonly || this.state === 'conflict') return;
    const body = this.body;
    this.state = 'saving'; this.error = ''; this.changed();
    this.pending = (async () => {
      try {
        const result = await this.api.save(this.detail.id, body, this.detail.version, this.detail.encoding, this.resolvingConflict);
        this.resolvingConflict = false;
        this.detail = result; this.baseline = body;
        this.state = this.dirty ? 'dirty' : 'saved';
      } catch (error) {
        this.state = error instanceof TextError && error.status === 409 ? 'conflict' : 'error';
        this.error = error instanceof Error ? error.message : String(error);
      } finally { this.changed(); }
    })();
    await this.pending; this.pending = undefined; this.schedule();
  }
  async refresh() {
    if (this.pending || this.composing) return;
    const previous = this.detail.version;
    const result = await this.api.detail(this.detail.id);
    if (this.pending || this.detail.version !== previous) return;
    if (result.version !== previous) {
      if (this.dirty) { this.state = 'conflict'; this.error = '其他程序修改了原文件；自动保存已暂停'; }
      else { this.detail = result; this.body = this.baseline = result.body; this.state = 'saved'; }
    } else { this.detail = result; if (!this.dirty) { this.state = 'saved'; this.error = ''; } }
    this.changed();
  }
  acceptDisk(result: TextDetail) { this.detail = result; this.body = this.baseline = result.body; this.state = 'saved'; this.error = ''; this.changed(); }
  async keepMine() {
    // Deliberate conflict resolution, using a fresh version and still checking again on save.
    const disk = await this.api.detail(this.detail.id);
    this.detail = disk; this.baseline = disk.body; this.state = 'dirty';
    this.resolvingConflict = true;
    await this.flush();
  }
  dispose() { clearTimeout(this.timer); }
}
