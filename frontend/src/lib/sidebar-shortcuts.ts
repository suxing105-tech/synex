import { matchesAction, shortcutBlocked } from './shortcut-settings';

/**
 * 焦点是不是落在「Tab 归右栏」的那一列：中间这一列 = 图库工具条 + 素材网格（标记在 App.svelte）。
 * 工具条也算：点过「收起右侧栏」那颗按钮之后焦点停在按钮上，这时候按 Tab 必须还能把它展开回来，
 * 否则同一个手势时灵时不灵，看着就像坏了。
 */
function tabZoneHasFocus(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLElement && el.closest('[data-tab-sidebar]') !== null;
}

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
    // Tab 只在中间这一列（工具条 + 素材网格）归右栏（2026-11-16 苏醒：右栏默认键要回 Tab）。
    // 这一列之外一律不接管：左侧目录树、右侧详情栏、设置页里按 Tab 必须照旧走到下一个控件；
    // 应用刚打开、焦点还在 body 上也不接管，否则键盘根本进不来（2026-11-11 撤 Tab 就是因为这个：WCAG 2.1.1 / 2.1.2）。
    // 输入框 / 下拉 / 富文本由上面 shortcutBlocked 挡在前面，搜索框里按 Tab 仍然是走焦点。
    // 剩下的那一列里 Tab 前进遍历被占了，退路留着：Shift+Tab 从来不接管（下面 matchesAction 认的是裸 tab），
    // 键盘用户永远能倒着走出去；卡片之间本来也用方向键走（见 lib/grid-nav.ts）。
    if (e.key === 'Tab' && !tabZoneHasFocus()) return;
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
