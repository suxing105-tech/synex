/**
 * ComfyUI 浏览器标签页复用工具。
 *
 * 设计要点：
 * - 用固定 window name（``suxing_comfyui``）调用 ``window.open``，浏览器会自动
 *   复用同名的标签页 / 窗口，后续调用只是导航该标签页，不再新开。
 * - ``window.open`` 必须在用户手势（点击事件）处理函数里**同步**调用，浏览器
 *   才会放行弹窗；调用栈里一旦 ``await`` 再调用，就会被当成异步弹窗拦掉。
 *   所以本工具只做打开 / 复用，不做任何异步操作；调用方在同步阶段先调用本工具，
 *   再 ``await`` 后续的 fetch。
 * - ComfyUI 与本应用是不同 origin（端口不同），所以不能直接 ``ref.location = url``，
 *   只能借助 ``window.open(url, name)`` 让浏览器自己跨域导航。
 */

const WINDOW_NAME = "suxing_comfyui";

let comfyuiWindow: Window | null = null;

/**
 * 打开或复用 ComfyUI 标签页。
 *
 * - 首次调用：在新标签页打开 ``url``，记录引用。
 * - 后续调用：浏览器发现已有同名窗口，直接导航到 ``url``，并尝试聚焦。
 *
 * 必须在用户点击事件的同步执行段调用，不能在 ``await`` 之后调用，否则会被
 * 浏览器弹窗拦截器拦掉。
 *
 * @returns 新打开 / 复用的 Window 引用；如果浏览器拦截弹窗则为 null。
 */
export function openOrReuseComfyuiTab(url: string): Window | null {
  if (typeof window === "undefined") return null;
  const w = window.open(url, WINDOW_NAME);
  if (w) {
    comfyuiWindow = w;
    try {
      w.focus();
    } catch {
      // 跨源时 focus 可能抛错，吞掉即可
    }
  }
  return w;
}

/** 仅用于测试 / 调试：清空模块级窗口引用。 */
export function _resetComfyuiWindow(): void {
  comfyuiWindow = null;
}

export async function loadComfyWorkflow(id: number, filename: string): Promise<void> {
  const { isTauri } = await import('./tauri');
  const { comfyuiApi } = await import('./api');
  if (!isTauri()) throw new Error('自动加载工作流请使用桌面版');
  const result = await comfyuiApi.openWorkflow(id);
  if (!result.workflow) throw new Error('图片没有可加载的工作流');
  await (window as any).__TAURI__.core.invoke('open_comfy_workflow', {
    url: result.comfyui_url,
    name: filename.replace(/\.[^.]+$/, ''),
    workflow: result.workflow,
  });
}
