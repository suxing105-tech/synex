import { afterEach, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { get } from 'svelte/store';
import Feed from '../components/Feed.svelte';
import { feedItems, feedLoading, multiSelectedIds } from '../lib/stores';
const drag = vi.hoisted(() => vi.fn());
vi.mock('../lib/original-drag', () => ({ beginOriginalDrag: drag }));
vi.mock('../lib/api', () => ({
  imagesApi: { list: vi.fn(async () => ({ items: get(feedItems), total: get(feedItems).length })), detail: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) }, statsApi: { get: vi.fn() }, scanApi: { progress: vi.fn() }, comfyuiApi: {}, videosApi: {},
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); drag.mockReset(); });
it('dragging from the video play icon passes the original and does not start playback', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  feedLoading.set(false); multiSelectedIds.set(new Set());
  feedItems.set([{ id: 1, filename: 'clip.mp4', path: 'D:/视频/clip.mp4', kind: 'video', playable: true, width: 64, height: 48 }] as any);
  drag.mockImplementation((_e, _paths, started) => { started(); return () => {}; });
  const played = vi.fn(); window.addEventListener('open-video-player', played);
  try {
    const ui = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
    const play = ui.getByLabelText('播放 clip.mp4');
    await fireEvent.pointerDown(play, { button: 0 });
    expect(drag.mock.calls[0][1]).toEqual(['D:/视频/clip.mp4']);
    await fireEvent.click(play);
    expect(played).not.toHaveBeenCalled();
  } finally { window.removeEventListener('open-video-player', played); }
});
