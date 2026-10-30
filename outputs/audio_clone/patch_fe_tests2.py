# -*- coding: utf-8 -*-
"""补弹窗与设置页的音频一族用例。"""
import io, os

def append(path, text):
    s = io.open(path, encoding="utf-8").read().rstrip("\n") + "\n" + text
    tmp = path + ".tmp"
    io.open(tmp, "w", encoding="utf-8", newline="\n").write(s)
    os.replace(tmp, path)
    print("appended", path)


MODAL = r"frontend\src\__tests__\clone-modal.test.ts"
append(MODAL, '''
/* ── 音频一键同款（Qwen3 音色克隆）────────────────────────────────────── */

/** 真机那条音色克隆的形状：两个提示词位（要说的话 + 参考音频的原话）+ 一台 LoadAudio + 语言下拉。 */
const TTS = {
  ...TPL, id: 12, name: '闪寻音频克隆', media_kind: 'audio', modes: ['single', 'multi'],
  prompt_count: 2, reference_count: 1, control_count: 1,
  slots: [
    { kind: 'prompt', node: '45', input: 'ref_text', label: '参考音频的文本' },
    { kind: 'prompt', node: '45', input: 'text', label: '完整提示词' },
    { kind: 'audio', node: '44', input: 'audio', label: '加载音频' },
    { kind: 'select', node: '45', input: 'language', label: '语言', options: ['Auto', 'Chinese'], value: 'Auto' },
  ],
};

const audioRoutes = () => ({
  ...baseRoutes(),
  '/api/clone/sources/22': NO_SOURCES,
  '/api/images/22/reverse-prompts': { items: [] },
  '/api/images/22': { id: 22, filename: 'bgm.mp3', positive_prompt: '' },
});

it('音频卡点开默认吃出声音那条；这一族没有就退回库里现有的', async () => {
  routes({ ...audioRoutes(), '/api/clone/templates': { items: [TPL, { ...TTS, is_active: false }] } });
  const screen = await ready({ image: AUDIO });
  expect(screen.getByRole('heading', { name: '闪寻音频克隆' })).toBeTruthy();
  cleanup();
  routes({ ...audioRoutes(), '/api/clone/templates': { items: [TPL] } });
  const again = await ready({ image: AUDIO });
  expect(again.getByRole('heading', { name: 'Qwen 多图编辑' })).toBeTruthy();
});

it('音频卡的左边是波形加一条播放器：写词的时候能就地听这段音色', async () => {
  routes({ ...audioRoutes(), '/api/clone/templates': { items: [TTS] } });
  const screen = await ready({ image: AUDIO });
  const wave = screen.container.querySelector('img.cm-hero-wave') as HTMLImageElement;
  expect(wave).toBeTruthy();
  expect(wave.getAttribute('src')).toContain('/api/audio/22/waveform');
  const player = screen.container.querySelector('audio.cm-hero-audio') as HTMLAudioElement;
  expect(player).toBeTruthy();
  expect(player.getAttribute('controls')).not.toBeNull();
  expect(player.getAttribute('src')).toContain('/api/audio/22/file');
});

it('音频工作流的参考行只有一格「音频1」，被点的那段自己站在里面', async () => {
  routes({ ...audioRoutes(), '/api/clone/templates': { items: [TTS] } });
  const screen = await ready({ image: AUDIO });
  expect(document.querySelectorAll('.cm-ref-row')).toHaveLength(1);
  expect(document.querySelector('[aria-label="参考音频（参考音色克隆）"]')).toBeTruthy();
  expect(screen.getByTitle(/｜bgm\\.mp3$/)).toBeTruthy();
  // 量词与称呼都跟着族走，不冒出「这张图」
  expect(screen.queryByText(/这张图/)).toBeNull();
});

it('工作流菜单三族并列：徽标是图片/视频/音频，选哪条就换哪条', async () => {
  routes({ ...audioRoutes(), '/api/clone/templates': { items: [{ ...TPL, is_active: true }, { ...TTS, is_active: true }] } });
  const screen = await ready({ image: AUDIO });
  await fireEvent.click(screen.getByRole('button', { name: /切换同款工作流|闪寻音频克隆/ }));
  const options = await screen.findAllByRole('menuitem');
  expect(options.map((el) => el.textContent)).toEqual(
    expect.arrayContaining([expect.stringContaining('图片'), expect.stringContaining('音频')]));
});

it('产出是音频时 chip 上挂播放角标，点它就地播而不是进图片对比', async () => {
  routes({ ...audioRoutes(), '/api/clone/templates': { items: [TTS] } });
  const screen = await ready({ image: AUDIO });
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '换一段台词' } });
  const go = screen.getByRole('button', { name: '生成' }) as HTMLButtonElement;
  await vi.waitFor(() => expect(go.disabled).toBe(false));
  await fireEvent.click(go);
  applyCloneProgress({
    active: true, job_id: 'j1', state: 'done', running: false, template_id: 12,
    image_ids: [88], outputs: [{ id: 88, kind: 'audio', filename: '闪寻音频克隆_00001.flac', thumbnail_url: '/api/audio/88/waveform' }],
  } as never);
  await tick();
  const chip = screen.getByRole('button', { name: /打开生成的/ });
  expect(chip.querySelector('img')?.getAttribute('src')).toContain('/api/audio/88/waveform');
  expect(chip.querySelector('.cm-out-play')).toBeTruthy();
});
''')

SETTINGS = r"frontend\src\__tests__\clone-settings.test.ts"
append(SETTINGS, '''
describe('音频一族在设置页', () => {
  const AUDIO_TPL = {
    id: 3, name: '闪寻音频克隆', is_active: true, default_prompt: '', created_at: '', updated_at: '',
    node_count: 4, prompt_count: 2, reference_count: 1, control_count: 1, media_kind: 'audio',
    slots: [
      { kind: 'prompt', node: '45', input: 'ref_text', label: '参考音频的文本' },
      { kind: 'prompt', node: '45', input: 'text', label: '完整提示词' },
      { kind: 'audio', node: '44', input: 'audio', label: '加载音频' },
      { kind: 'select', node: '45', input: 'language', label: '语言', options: ['Auto', 'Chinese'], value: 'Auto' },
    ],
  };

  it('三族徽标各自上色，音频那条分开报「音频 1」', async () => {
    routes({ '/api/clone/templates': { items: [TPL, VIDEO_TPL, AUDIO_TPL] } });
    const screen = render(CloneTemplates, {});
    await screen.findByText('旧的同款');
    const badges = [...screen.container.querySelectorAll('.clone-tpl-kind')];
    expect(badges.map((el) => el.textContent)).toEqual(['图片', '视频', '音频']);
    expect(badges.map((el) => [...el.classList].includes('is-audio'))).toEqual([false, false, true]);
    const li = screen.getByText('闪寻音频克隆').closest('li')!;
    expect(li.textContent).toContain('音频 1');
  });

  it('改判下拉三个选项都在：判错族别不必删了重导', async () => {
    routes({
      '/api/clone/templates': { items: [AUDIO_TPL] },
      '/api/clone/templates/3': (init?: RequestInit) => ({ ...AUDIO_TPL, ...JSON.parse(String(init?.body)) }),
    });
    const screen = render(CloneTemplates, {});
    await screen.findByText('闪寻音频克隆');
    const select = screen.getByLabelText('「闪寻音频克隆」的产出类型') as HTMLSelectElement;
    expect(select.value).toBe('audio');
    expect([...select.querySelectorAll('option')].map((o) => [o.value, o.textContent]))
      .toEqual([['image', '出图'], ['video', '出片'], ['audio', '出声音']]);
    await fireEvent.change(select, { target: { value: 'image' } });
    await tick();
    await tick();
    const patch = http.mock.calls.find(([path, init]) => path === '/api/clone/templates/3' && (init as RequestInit)?.method === 'PATCH');
    expect(JSON.parse(String((patch?.[1] as RequestInit)?.body))).toEqual({ media_kind: 'image' });
  });
});
''')
