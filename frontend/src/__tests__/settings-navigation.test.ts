import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import SettingsModal from '../components/SettingsModal.svelte';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { settingsApi } from '../lib/api';
vi.mock('../lib/api', () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  settingsApi: { get: vi.fn(async () => ({ watch_dirs: ['C:/素材'], live_enabled: true })), update: vi.fn(async (cfg) => cfg) },
  comfyuiApi: { status: vi.fn(async () => ({ running: false, enabled: true, url: 'http://127.0.0.1:8188' })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  foldersApi: { tree: vi.fn(async () => []), archived: vi.fn(async () => []), restore: vi.fn(async () => ({ ok: true })) },
  http: vi.fn(async (path: string) => path === '/api/reverse-prompt-settings' ? { default_model_id: null, instruction: '', default_instruction: '' } : []),
}));
// 目录点击 = 把该分组的标题滚到滚动区顶部（-28 的余量），所以期望值直接由位置表算出来。
const positions: Record<string, number> = {
  'settings-general': 36, 'settings-archived': 636, 'settings-shortcuts': 1036,
  'settings-model-api': 1636, 'settings-reverse': 1936, 'settings-comfyui': 2236, 'settings-clone': 2536,
  'settings-media': 2836,
  'settings-update': 3236, 'settings-about': 3636,
};
const top = (id: string) => positions[id] - 28;
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const scrollTop = this.classList.contains('settings-content') ? 0 : this.closest('.settings-content')?.scrollTop ?? 0;
    return { top: (positions[this.id] ?? 0) - scrollTop } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(function(this: HTMLElement, options: any) { this.scrollTop = options.top; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('目录跳转保留监听路径和快捷键草稿，且十个分组同时存在', async () => {
  const screen = render(SettingsModal, { open: true, tab: '通用' });
  const input = await screen.findByLabelText('新增监听目录');
  await fireEvent.input(input, { target: { value: 'D:/未保存素材' } });
  const recording = screen.getByRole('button', { name: '设置复制正向 Prompt快捷键' });
  await fireEvent.click(recording);
  await fireEvent.keyDown(recording, { key: 'j', ctrlKey: true, shiftKey: true });
  await fireEvent.click(screen.getByRole('button', { name: 'ComfyUI' }));
  const scroller = screen.container.querySelector('.settings-content')!;
  expect(scroller.scrollTop).toBe(top('settings-comfyui'));
  expect(screen.getByRole('button', { name: 'ComfyUI' }).getAttribute('aria-current')).toBe('location');
  await fireEvent.click(screen.getByRole('button', { name: '通用' }));
  expect((input as HTMLInputElement).value).toBe('D:/未保存素材');
  expect(recording.textContent).toContain('J');
  expect(screen.container.querySelectorAll('.settings-section')).toHaveLength(10);
  await fireEvent.click(screen.getByRole('button', { name: '添加目录' }));
  await fireEvent.click(screen.getByRole('button', { name: '保存通用设置' }));
  expect(settingsApi.update).toHaveBeenCalledWith({ watch_dirs: ['C:/素材', 'D:/未保存素材'], live_enabled: true });
});
it('滚动同步目录位置，点目录项仍能跳回通用；目录底部不再挂提示与回到顶部', async () => {
  const screen = render(SettingsModal, { open: true, tab: '模型API配置' });
  const scroller = screen.container.querySelector('.settings-content')!;
  await waitFor(() => expect(scroller.scrollTop).toBe(top('settings-model-api')));
  scroller.scrollTop = 620;
  await fireEvent.scroll(scroller);
  expect(screen.getByRole('button', { name: '已归档目录' }).getAttribute('aria-current')).toBe('location');
  await fireEvent.click(screen.getByRole('button', { name: '通用' }));
  expect(scroller.scrollTop).toBe(top('settings-general'));
  expect(screen.getByRole('button', { name: '通用' }).getAttribute('aria-current')).toBe('location');
  // 用户要求删掉目录底部那块：保存提示、版本号、回到顶部都不该再出现。
  expect(screen.container.querySelector('.settings-rail-foot')).toBeNull();
  expect(screen.queryByRole('button', { name: '返回设置顶部' })).toBeNull();
  expect(screen.container.textContent).not.toContain('改完在每组右下角保存');
});
it('目录搜索只留下命中的分组，正文跟着收窄，清空后恢复完整目录', async () => {
  const screen = render(SettingsModal, { open: true, tab: '通用' });
  await screen.findByLabelText('新增监听目录');
  const search = screen.getByLabelText('搜索设置');
  await fireEvent.input(search, { target: { value: '归档' } });
  expect(screen.container.querySelectorAll('.settings-nav-item')).toHaveLength(1);
  expect(screen.container.querySelectorAll('.settings-section')).toHaveLength(1);
  expect(screen.container.querySelector('.settings-section')?.id).toBe('settings-archived');
  await fireEvent.input(search, { target: { value: '不存在的设置词' } });
  expect(await screen.findByRole('status')).toBeTruthy();
  expect(screen.container.querySelectorAll('.settings-section')).toHaveLength(0);
  await fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
  expect(screen.container.querySelectorAll('.settings-nav-item')).toHaveLength(10);
  expect(screen.container.querySelectorAll('.settings-section')).toHaveLength(10);
});

it("指路的话不许指向已经不存在的那一页", () => {
  // 「云端生成」曾经是一整页，现在缩成「模型API配置」里的一张卡。
  // 页名从目录里撤掉之后，任何还写着旧页名的提示都会把人支去一页不存在的东西，
  // 而这种话散在前端与后端六处，靠眼睛扫是扫不干净的。
  // 仓库里 CRLF 与 LF 混着放，不先把 EOL 统一掉，\n 锚点会整段匹配不上（踩过）
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const modal = read('../components/SettingsModal.svelte');
  const block = /const navGroups[\s\S]*?^\s*\];/m.exec(modal)?.[0] ?? '';
  const pages = [...block.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
  expect(block).not.toBe(''); // 上面的解析先钉住，别让它悄悄退化成空匹配
  expect(pages).toEqual(expect.arrayContaining(['模型API配置', '反推指令']));
  expect(pages).not.toContain('云端生成');
  expect(modal).not.toContain('settings-cloud');
  const files = [
    '../components/SettingsModal.svelte', '../components/CloneModal.svelte',
    '../lib/clone.ts',
    '../../../backend/app/cloud/engine.py', '../../../backend/app/cloud/accounts.py',
    '../../../backend/app/cloud/client.py', '../../../backend/app/clone_jobs.py',
  ];
  const stale: string[] = [];
  for (const rel of files) {
    for (const m of read(rel).matchAll(/设置 → (\S{2,12})/g)) {
      const page = m[1].replace(/[，。：、）)「」\"';,]+$/g, '');
      if (!pages.some((p) => page.startsWith(p))) stale.push(`${rel} → ${m[1]}`);
    }
  }
  expect(stale).toEqual([]);
});

it("云端那张卡撤干净了：设置页不许再长出第二个云端入口", () => {
  // 那张卡原来带一个默认关着的总开关。卡撤了，开关跟着撤（填了 Key 就是开了）——
  // 界面没有开关的闸门等于死路，所以这个词连同字段名一起钉在这里，别让下一次偷偷加回来。
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const files = [
    '../components/SettingsModal.svelte', '../components/ModelApiSettings.svelte', '../components/ReversePromptSettings.svelte',
    '../components/CloneModal.svelte', '../lib/clone.ts',
    '../../../backend/app/cloud/engine.py', '../../../backend/app/routes/clone.py',
  ];
  const hits: string[] = [];
  for (const rel of files) {
    const text = read(rel);
    for (const word of ['CloudServices', 'RunningHub 云端生成', '云端生成总开关', 'cloud_enabled']) {
      if (text.includes(word)) hits.push(`${rel} → ${word}`);
    }
  }
  expect(hits).toEqual([]);
});
