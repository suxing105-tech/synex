import { afterEach, expect, it, vi } from 'vitest';
import { textListDrag } from '../lib/text-list-drag';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = ''; });
function setup() {
  vi.useFakeTimers();
  const list = document.createElement('div');
  list.innerHTML = '<div data-text-id="1">甲</div><div data-text-id="2">乙</div>';
  document.body.append(list);
  const a = list.children[0] as HTMLElement, b = list.children[1] as HTMLElement;
  const drop = vi.fn(), change = vi.fn(); const action = textListDrag(list, { change, drop });
  const point = vi.spyOn(document, 'elementFromPoint').mockReturnValue(b);
  vi.spyOn(b, 'getBoundingClientRect').mockReturnValue({ top:40, height:30 } as DOMRect);
  const event = (target: EventTarget, name: string, x=10, y=10) => target.dispatchEvent(new PointerEvent(name, { bubbles:true, pointerId:1, button:0, clientX:x, clientY:y }));
  return { list,a,b,drop,change,action,event,point };
}
it('短按、双击与按下即移动不改变顺序；长按后下方放置触发排序', () => {
  const { a,drop,action,event } = setup();
  event(a,'pointerdown'); vi.advanceTimersByTime(100); event(window,'pointerup');
  event(a,'pointerdown'); event(window,'pointermove',30,30); vi.advanceTimersByTime(400); event(window,'pointerup');
  expect(drop).not.toHaveBeenCalled();
  event(a,'pointerdown'); vi.advanceTimersByTime(350); event(window,'pointermove',10,65); event(window,'pointerup',10,65);
  expect(drop).toHaveBeenCalledWith(1,2,true); action.destroy();
});
it('Escape、窗口失焦、取消指针或放到列表之外均不排序', () => {
  const { a,drop,action,event,point } = setup();
  for (const cancel of [() => window.dispatchEvent(new KeyboardEvent('keydown',{ key:'Escape' })), () => window.dispatchEvent(new Event('blur')), () => window.dispatchEvent(new Event('pointercancel'))]) {
    event(a,'pointerdown'); vi.advanceTimersByTime(400); event(window,'pointermove',10,45); cancel(); event(window,'pointerup');
  }
  event(a,'pointerdown'); vi.advanceTimersByTime(400); point.mockReturnValue(null); event(window,'pointermove',10,500); event(window,'pointerup');
  expect(drop).not.toHaveBeenCalled(); action.destroy();
});
