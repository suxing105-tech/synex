import { shortcutBlocked } from './shortcut-settings';

export type SwitchableScope = 'all' | 'image' | 'video' | 'audio' | 'text';

/** 0 = 所有素材，a = 音频；i / v / t 沿用多年的肌肉记忆。 */
export const SCOPE_BY_KEY: Record<string, SwitchableScope> = {
  '0': 'all',
  a: 'audio',
  i: 'image',
  v: 'video',
  t: 'text',
};

export function registerContentShortcuts(switchTo: (type: SwitchableScope) => void, blocked = () => false) {
  const keys = SCOPE_BY_KEY;
  const handle = (e: KeyboardEvent) => {
    const type = keys[e.key.toLowerCase()];
    if (!type || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || shortcutBlocked(e) || blocked() || document.querySelector('[aria-modal="true"], [role="dialog"]')) return;
    e.preventDefault(); e.stopImmediatePropagation(); switchTo(type);
  };
  window.addEventListener('keydown', handle, true);
  return () => window.removeEventListener('keydown', handle, true);
}
