import { shortcutBlocked } from './shortcut-settings';

export function registerContentShortcuts(switchTo: (type: 'image' | 'video' | 'text') => void, blocked = () => false) {
  const keys: Record<string, 'image' | 'video' | 'text'> = { i: 'image', v: 'video', t: 'text' };
  const handle = (e: KeyboardEvent) => {
    const type = keys[e.key.toLowerCase()];
    if (!type || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || shortcutBlocked(e) || blocked() || document.querySelector('[aria-modal="true"], [role="dialog"]')) return;
    e.preventDefault(); e.stopImmediatePropagation(); switchTo(type);
  };
  window.addEventListener('keydown', handle, true);
  return () => window.removeEventListener('keydown', handle, true);
}
