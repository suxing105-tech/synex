/**
 * 弹层焦点管理：打开时把焦点收进弹层并锁 Tab，关闭时还给触发元素。
 *
 * 弹层里的 Escape 由调用方的 capture 监听统一处理（阅读层要先判「有弹层就先关弹层」），
 * 这里不再自己吞 Esc，避免两处抢同一个键。
 */
export function modalFocus(node: HTMLElement) {
  const previous = document.activeElement as HTMLElement | null;
  node.focus();
  function keys(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;
    const focusable = Array.from(node.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,textarea,[tabindex="0"]'));
    const first = focusable[0], last = focusable.at(-1);
    if (e.shiftKey && (document.activeElement === first || document.activeElement === node)) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || document.activeElement === node)) { e.preventDefault(); first?.focus(); }
  }
  node.addEventListener('keydown', keys);
  return { destroy() { node.removeEventListener('keydown', keys); previous?.focus(); } };
}

/** 键盘事件是不是打在输入控件里 —— 决定 ← / → 是翻文档还是移光标。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return true;
  return target.isContentEditable;
}