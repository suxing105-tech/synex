// 闪寻空间 Seek-X — 外部链接：桌面版交给系统默认浏览器
//
// 为什么要这一层：桌面版跑在 WebView2 里，没有新窗口宿主，`a[target="_blank"]` 和 window.open
// 都被 webview 直接吞掉，表现就是「点了没反应」（ComfyUI 那一侧早就踩过，看 comfyui-window.ts
// 顶上那段）。2026-11-16 苏醒在「模型API配置」页又撞同一堵墙：那颗「获取 API Key」在 APP 里
// 打不开网页。
//
// 为什么挂在文档上、而不是每颗按钮各写一遍：外链不是一个入口——那一页的「获取 API Key」和
// 文本阅读器里 Markdown 渲染出来的链接（text-markdown.ts 给 http 链接挂 target="_blank"）
// 是同一件事。逐个组件补 onclick 下次新增链接照样漏，两份实现还迟早分叉。
//
// 只管跨源的 http/https：本应用自己的源（dev 的 localhost、壳里的 tauri.localhost）不接管，
// mailto / tel / javascript 也不接管——外壳那条 Rust 命令本来就只放行 http/https，
// 在这儿先挡下来比让它回一句「链接无效」清楚。

import { isTauri } from "./tauri";

/** 用系统默认浏览器打开一个链接：桌面版走 Rust 命令，浏览器版开新标签。 */
export function openExternalUrl(url: string): void {
  if (typeof window === "undefined") return;
  if (isTauri()) {
    void (window as any).__TAURI__.core.invoke("open_external_url", { url }).catch(() => {});
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * 这个链接该不该交给外部浏览器：解析后的地址是 http/https，且不是本应用自己的源。
 * 返回空串＝按原生行为走（同源导航、mailto 等等都交回给浏览器）。
 */
export function externalHref(anchor: HTMLAnchorElement): string {
  if (typeof window === "undefined") return "";
  const href = anchor.href;          // a.href 是解析过的，相对地址在这儿已经是绝对 URL
  if (!/^https?:\/\//i.test(href)) return "";
  try {
    return new URL(href).origin === window.location.origin ? "" : href;
  } catch {
    return "";
  }
}

/**
 * 这个点击该不该由我们接管：左键、没按修饰键、也没人先把默认行为摁掉。
 * 中键和 Ctrl/Shift/Alt+左键都是「开新标签/新窗口」的原生手势，不抢；
 * 组件自己 preventDefault 过的也不抢（监听挂在冒泡段，就是为了把这个优先权留给组件）。
 */
export function isPlainLeftClick(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  return !(event.ctrlKey || event.metaKey || event.shiftKey || event.altKey);
}

function onClick(event: MouseEvent): void {
  if (!isPlainLeftClick(event)) return;
  const target = event.target as Element | null;
  const anchor = target && target.closest ? target.closest("a[href]") as HTMLAnchorElement | null : null;
  if (!anchor) return;
  const url = externalHref(anchor);
  if (!url) return;
  event.preventDefault();
  openExternalUrl(url);
}

let installed = false;

/** 装一次文档级委托监听（main.ts 挂载前调用一次）。 */
export function installExternalLinkHandler(): void {
  if (typeof document === "undefined" || installed) return;
  installed = true;
  document.addEventListener("click", onClick);
}

/** 只给测试用：撤掉监听，不把拦截留给后面的用例。 */
export function uninstallExternalLinkHandler(): void {
  if (typeof document === "undefined" || !installed) return;
  installed = false;
  document.removeEventListener("click", onClick);
}
