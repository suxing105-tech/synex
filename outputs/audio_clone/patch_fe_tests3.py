# -*- coding: utf-8 -*-
import io, os
P = r"frontend\src\__tests__\clone-modal.test.ts"
s = io.open(P, encoding="utf-8").read()
def rep(old, new):
    global s
    assert s.count(old) == 1, old[:70]
    s = s.replace(old, new)

rep('''  await fireEvent.click(screen.getByRole('button', { name: /切换同款工作流|闪寻音频克隆/ }));
  const options = await screen.findAllByRole('menuitem');
  expect(options.map((el) => el.textContent)).toEqual(
    expect.arrayContaining([expect.stringContaining('图片'), expect.stringContaining('音频')]));''',
    '''  await fireEvent.click(screen.getByRole('button', { name: '同款工作流' }));
  const options = await screen.findAllByRole('menuitemradio');
  // 一张清单不分家，但族徽必须一眼分得清：图片卡挂上出声音的那条，等半天才知道选错
  expect(options.map((el) => el.querySelector('.cm-wf-kind')?.textContent)).toEqual(['图片', '音频']);
  expect(options[1].querySelector('.cm-wf-kind')?.classList.contains('cm-wf-kind-audio')).toBe(true);''')

rep('''  const chip = screen.getByRole('button', { name: /打开生成的/ });
  expect(chip.querySelector('img')?.getAttribute('src')).toContain('/api/audio/88/waveform');
  expect(chip.querySelector('.cm-out-play')).toBeTruthy();''',
    '''  const chip = screen.getByRole('button', { name: '打开生成的第 88 条' });
  expect(chip.querySelector('img')?.getAttribute('src')).toContain('/api/audio/88/waveform');
  // 产出是音频：chip 上挂着播放角标，点下去交给父组件就地播，不是进图片对比
  expect(chip.classList.contains('cm-chip-video')).toBe(true);
  expect(chip.querySelector('.cm-chip-play')).toBeTruthy();
  await fireEvent.click(chip);
  expect(onOpen).toHaveBeenCalledWith(88, 'audio');''')

rep('''  const screen = await ready({ image: AUDIO });
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '换一段台词' } });''',
    '''  const onOpen = vi.fn();
  const screen = await ready({ image: AUDIO, onOpenImage: onOpen });
  await fireEvent.input(screen.getByLabelText('提示词'), { target: { value: '换一段台词' } });''')

tmp = P + ".tmp"
io.open(tmp, "w", encoding="utf-8", newline="\n").write(s)
os.replace(tmp, P)
print("ok")
