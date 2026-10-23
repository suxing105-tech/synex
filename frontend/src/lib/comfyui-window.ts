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
 * - 桌面版（Tauri / WebView2）没有新窗口宿主：``window.open`` 会被 webview 直接
 *   吞掉，表现就是「点了没反应」。所以桌面版改走 Rust 命令
 *   ``open_external_url``，交给系统默认浏览器打开。
 */

import { isTauri } from "./tauri";

const WINDOW_NAME = "suxing_comfyui";
const DEFAULT_COMFYUI_URL = "http://127.0.0.1:8188";

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
 * @returns 新打开 / 复用的 Window 引用；桌面版或浏览器拦截弹窗时为 null。
 */
export function openOrReuseComfyuiTab(url: string): Window | null {
  if (typeof window === "undefined") return null;
  if (isTauri()) {
    // 桌面版：WebView2 没有新窗口宿主，window.open 静默失效 -> 交给系统默认浏览器。
    void (window as any).__TAURI__.core
      .invoke("open_external_url", { url })
      .catch(() => {});
    return null;
  }
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
  if (!result.workflow) throw new Error('该媒体没有可加载的工作流');
  await (window as any).__TAURI__.core.invoke('open_comfy_workflow', {
    url: result.comfyui_url,
    name: filename.replace(/\.[^.]+$/, ''),
    workflow: result.workflow,
  });
}

/**
 * 打开媒体的 ComfyUI 工作流：图片和视频同一条路。
 *
 * - 桌面版：后端把 workflow 落到临时文件，Rust 开应用内 ComfyUI 窗口并注入
 *   ``loadGraphData``，用户不需要再 File → Open。
 * - 浏览器版：没有 Rust 壳，只能复用标签页 + 落临时文件，用户自己打开。
 *   ``window.open`` 必须在点击手势的同步段调用，所以这里先开标签再 await。
 *
 * @returns 给 toast 用的提示语
 */
export async function openWorkflowForMedia(
  id: number,
  filename: string,
  comfyuiUrl: string,
): Promise<string> {
  if (!isTauri()) {
    openOrReuseComfyuiTab(comfyuiUrl || DEFAULT_COMFYUI_URL);
    const { comfyuiApi } = await import("./api");
    const r = await comfyuiApi.openWorkflow(id);
    return `${r.workflow_name}.json 已写入 ${r.file_path}，在 ComfyUI 里 File → Open 加载`;
  }
  await loadComfyWorkflow(id, filename);
  return "已在 ComfyUI 中打开工作流";
}
