# -*- coding: utf-8 -*-
"""更新音频卡与一键同款入口两组测试到「三类共用角标 + 播放挪到左下角」。"""
import io, os

def patch(path, pairs):
    s = io.open(path, encoding="utf-8").read()
    before = s
    for old, new in pairs:
        assert s.count(old) == 1, (path, s.count(old), old[:80])
        s = s.replace(old, new)
    assert s != before
    tmp = path + ".tmp"
    io.open(tmp, "w", encoding="utf-8", newline="\n").write(s)
    os.replace(tmp, path)
    print("patched", path)


FEED = r"frontend\src\__tests__\feed-audio-card.test.ts"
patch(FEED, [
    # 1) 悬停才出现播放角标；右下角常驻的是与图片/视频同一颗一键同款
    ('''  it("hover 层有播放入口", async () => {
    const { container } = renderFeed();
    await tick();
    const play = container.querySelector('[aria-label="播放 氛围底噪.mp3"]');
    expect(play).not.toBeNull();
    expect(play?.getAttribute("title")).toBe("播放音频");
  });''',
     '''  it("悬停时播放入口出现在画面左下角，右下角常驻的是「一键同款」", async () => {
    const { container } = renderFeed();
    await tick();
    const card = thumbOf(container, "氛围底噪.mp3").closest("button") as HTMLElement;
    // 右下角那颗不再是播放键：三类卡在同一个位置共用同一颗一键同款
    expect(container.querySelector('[aria-label="播放 氛围底噪.mp3"]')).toBeNull();
    const cloneBtn = container.querySelector<HTMLElement>(".media-clone-btn");
    expect(cloneBtn).toBeTruthy();
    expect(cloneBtn?.closest(".media-card-media")).toBeNull();
    await fireEvent.mouseEnter(card);
    await tick();
    const play = container.querySelector<HTMLElement>('[aria-label="播放 氛围底噪.mp3"]');
    expect(play).not.toBeNull();
    expect(play?.getAttribute("title")).toBe("播放音频");
    // 它挂在画面里（左下角），不再坐页脚那一格
    expect(play?.closest(".media-card-media")).toBeTruthy();
  });'''),

    # 2) 点播放要先悬停
    ('''  it("点播放三角就地播放，不落进图片 Lightbox", async () => {
    const { container } = renderFeed();
    await tick();
    await fireEvent.click(container.querySelector('[aria-label="播放 氛围底噪.mp3"]') as Element);
    expect(get(playingAudio)?.id).toBe(7);
  });''',
     '''  it("点播放三角就地播放，不落进图片 Lightbox", async () => {
    const { container } = renderFeed();
    await tick();
    const card = thumbOf(container, "氛围底噪.mp3").closest("button") as HTMLElement;
    await fireEvent.mouseEnter(card);
    await tick();
    await fireEvent.click(container.querySelector('[aria-label="播放 氛围底噪.mp3"]') as Element);
    expect(get(playingAudio)?.id).toBe(7);
  });'''),

    # 3) 角标归属反过来了：必须在图区里、带 --media 修饰
    ('''    // 角标属于卡片、不属于图区：它坐在页脚右端，跟文件名那两行并排
    const playBtn = container.querySelector<HTMLElement>(".audio-play-btn");
    expect(playBtn).toBeTruthy();
    expect(playBtn?.parentElement?.classList.contains("media-card")).toBe(true);
    expect(playBtn?.closest(".media-card-media")).toBeNull();
    expect(container.querySelector(".audio-play-icon")).toBeTruthy();''',
     '''    // 播放角标挪进画面左下角：右下角那一颗交给三类共用的「一键同款」
    await fireEvent.mouseEnter(card);
    await tick();
    const playBtn = container.querySelector<HTMLElement>(".audio-play-btn");
    expect(playBtn).toBeTruthy();
    expect(playBtn?.classList.contains("audio-play-btn--media")).toBe(true);
    expect(playBtn?.closest(".media-card-media")).toBeTruthy();
    expect(container.querySelector(".audio-play-icon")).toBeTruthy();
    expect(container.querySelector(".media-clone-btn")).toBeTruthy();'''),

    # 4) 播放中角标不消失，换暂停
    ('''  it("播放三角在播放时换成暂停图标并改文案", async () => {
    const { container } = renderFeed();
    await tick();
    await fireEvent.click(container.querySelector('[aria-label="播放 氛围底噪.mp3"]') as Element);
    await tick();
    expect(container.querySelector('[aria-label="播放 氛围底噪.mp3"]')).toBeNull();
    expect(container.querySelector('[aria-label="暂停 氛围底噪.mp3"]')?.getAttribute("title")).toBe("暂停音频");
  });''',
     '''  it("播放三角在播放时换成暂停图标并改文案，而且不用把鼠标留在卡片上", async () => {
    const { container } = renderFeed();
    await tick();
    const card = thumbOf(container, "氛围底噪.mp3").closest("button") as HTMLElement;
    await fireEvent.mouseEnter(card);
    await tick();
    await fireEvent.click(container.querySelector('[aria-label="播放 氛围底噪.mp3"]') as Element);
    await tick();
    expect(container.querySelector('[aria-label="播放 氛围底噪.mp3"]')).toBeNull();
    expect(container.querySelector('[aria-label="暂停 氛围底噪.mp3"]')?.getAttribute("title")).toBe("暂停音频");
    // 鼠标移开也留得下来：正在播就是它的常驻理由，否则暂停只能靠再点一次卡片
    await fireEvent.mouseLeave(card);
    await tick();
    expect(container.querySelector('[aria-label="暂停 氛围底噪.mp3"]')).toBeTruthy();
  });'''),
])

ENTRY = r"frontend\src\__tests__\clone-entry.test.ts"
patch(ENTRY, [
    ('''it('视频卡挂同一颗一键同款角标，音频卡不挂：音频没有能喂给工作流的加载器', async () => {
  const screen = await openFeed([
    card({ id: 2, kind: 'video', filename: 'v.mp4', original_url: null, thumbnail_url: '/api/videos/2/thumb', playable: false }),
    card({ id: 3, kind: 'audio', filename: 'a.mp3', original_url: '/api/images/3/file' }),
  ]);
  const btn = screen.getByRole('button', { name: '用同款工作流再生成一条' });
  // 入口的几何、常驻规则、is-cloneable 让位规则全部照图片卡，不另立一套
  expect(btn.closest('.media-card')?.classList.contains('is-cloneable')).toBe(true);
  expect(btn.closest('.media-card-footer')).toBeNull();
  await fireEvent.click(btn);
  await tick();
  expect(screen.getByRole('dialog', { name: '一键同款' })).toBeTruthy();
  // 一整屏只有视频卡这一颗：音频卡没有入口，也不会冒出「再生成一段」这种第三种量词
  expect(screen.getAllByRole('button', { name: /用同款工作流再生成/ })).toHaveLength(1);
});''',
     '''it('三类卡挂同一颗一键同款角标，量词按族：一张 / 一条 / 一段', async () => {
  const screen = await openFeed([
    card({ id: 2, kind: 'video', filename: 'v.mp4', original_url: null, thumbnail_url: '/api/videos/2/thumb', playable: false }),
    card({ id: 3, kind: 'audio', filename: 'a.mp3', original_url: '/api/audio/3/file', thumbnail_url: '/api/audio/3/waveform' }),
  ]);
  // 入口的几何、常驻规则、is-cloneable 让位规则全部照图片卡，不另立一套
  for (const name of ['用同款工作流再生成一条', '用同款工作流再生成一段']) {
    const btn = screen.getByRole('button', { name });
    expect(btn.closest('.media-card')?.classList.contains('is-cloneable')).toBe(true);
    expect(btn.closest('.media-card-footer')).toBeNull();
    await fireEvent.click(btn);
    await tick();
    expect(screen.getByRole('dialog', { name: '一键同款' })).toBeTruthy();
    await fireEvent.keyDown(document, { key: 'Escape' });
    await tick();
    expect(screen.queryByRole('dialog', { name: '一键同款' })).toBeNull();
  }
});

it('音频卡的播放角标挪进画面，右下角只留一键同款那一个控件', async () => {
  const screen = await openFeed([
    card({ id: 3, kind: 'audio', filename: 'a.mp3', original_url: '/api/audio/3/file', thumbnail_url: '/api/audio/3/waveform' }),
  ]);
  const cardEl = screen.getByRole('button', { name: '用同款工作流再生成一段' }).closest('.media-card') as HTMLElement;
  await fireEvent.mouseEnter(cardEl);
  await tick();
  const play = screen.getByRole('button', { name: '播放 a.mp3' }) as HTMLElement;
  expect(play.closest('.media-card-media')).toBeTruthy();
  const clone = screen.getByRole('button', { name: '用同款工作流再生成一段' }) as HTMLElement;
  expect(clone.closest('.media-card-media')).toBeNull();
});

it('窄列页脚不渲染时，音频卡也没有角标（与图片/视频同一条规则）', async () => {
  const screen = await openFeed([
    card({ id: 3, kind: 'audio', filename: 'a.mp3', original_url: '/api/audio/3/file', thumbnail_url: '/api/audio/3/waveform' }),
  ], 300);
  expect(screen.queryByRole('button', { name: /用同款工作流再生成/ })).toBeNull();
});

it('窄列下音频卡的右键菜单也能进一键同款', async () => {
  const screen = await openFeed([
    card({ id: 3, kind: 'audio', filename: 'a.mp3', original_url: '/api/audio/3/file', thumbnail_url: '/api/audio/3/waveform' }),
  ], 300);
  await fireEvent.contextMenu(screen.container.querySelector('.thumb')!, { clientX: 10, clientY: 10 });
  await tick();
  await fireEvent.click(screen.getByRole('menuitem', { name: '一键同款' }));
  await tick();
  expect(screen.getByRole('dialog', { name: '一键同款' })).toBeTruthy();
});'''),

    # 角标几何那条源码断言：音频播放键已挪走，不再拿它当右下角的参照
    ('''it('角标的尺寸与位置照抄音频播放键：同尺寸公式、同右下角、在页脚高度里同垂直居中', () => {''',
     '''it('角标的尺寸沿用音频角标那套公式，位置是页脚右下角（播放键已挪进画面左下角）', () => {'''),
])
