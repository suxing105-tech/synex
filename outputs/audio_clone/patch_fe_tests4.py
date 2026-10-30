# -*- coding: utf-8 -*-
import io, os
P = r"frontend\src\__tests__\clone-modal.test.ts"
s = io.open(P, encoding="utf-8").read()
def rep(old, new):
    global s
    assert s.count(old) == 1, old[:70]
    s = s.replace(old, new)

rep('''  routes({ ...audioRoutes(), '/api/clone/templates': { items: [TTS] } });
  const onOpen = vi.fn();
  const screen = await ready({ image: AUDIO, onOpenImage: onOpen });''',
    '''  routes({
    ...audioRoutes(),
    '/api/clone/templates': { items: [TTS] },
    '/api/clone/generate': { ...EMPTY_CLONE_JOB, active: true, job_id: 'j1', state: 'queued', running: true },
  });
  const onOpen = vi.fn();
  const screen = await ready({ image: AUDIO, onOpenImage: onOpen });''')

rep('''    active: true, job_id: 'j1', state: 'done', running: false, template_id: 12,
    image_ids: [88], outputs: [{ id: 88, kind: 'audio', filename: '闪寻音频克隆_00001.flac', thumbnail_url: '/api/audio/88/waveform' }],
  } as never);
  await tick();''',
    '''    active: true, job_id: 'j1', state: 'done', running: false, template_id: 12, media_kind: 'audio',
    outputs: [{ id: 88, kind: 'audio', filename: '闪寻音频克隆_00001.flac', thumbnail_url: '/api/audio/88/waveform' }],
  });
  await tick();''')

tmp = P + ".tmp"
io.open(tmp, "w", encoding="utf-8", newline="\n").write(s)
os.replace(tmp, P)
print("ok")
