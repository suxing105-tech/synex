import { matchesAction, shortcutBlocked } from './shortcut-settings';

export function registerSidebarShortcuts(
  toggleLeft: () => void,
  toggleRight: () => void,
  blocked = () => false,
  rightAvailable = () => true,
) {
  const handle = (e: KeyboardEvent) => {
    if (e.defaultPrevented || shortcutBlocked(e) || blocked() ||
        document.querySelector('[aria-modal="true"], [role="dialog"], [role="menu"]') ||
        (e.target instanceof HTMLElement && e.target.closest('[contenteditable]:not([contenteditable="false"])'))) return;
    const toggle = matchesAction(e, 'leftSidebar') ? toggleLeft :
      rightAvailable() && matchesAction(e, 'rightSidebar') ? toggleRight : null;
    if (!toggle) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toggle();
  };
  window.addEventListener('keydown', handle, true);
  return () => window.removeEventListener('keydown', handle, true);
}
