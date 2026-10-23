// 打开文件 / 目录所在位置。
//
// 桌面版必须走桌面壳的 `reveal_path` 命令：Windows 的前台锁只让「当前前台进程」
// 把别的窗口提到最前面。以前的路径是后台 sidecar 叫出资源管理器，于是那个窗口
// 永远开在应用后面，用户看到的是「点了没反应」。
import { isTauri } from "./tauri";

export type RevealVia = "desktop" | "backend";

/**
 * @param path     文件或目录的绝对路径（桌面版用它）
 * @param select   是否选中该文件；传目录时给 false
 * @param fallback 浏览器版回退，通常是后端 `/reveal` 接口
 */
export async function revealLocation(
  path: string | null | undefined,
  select: boolean,
  fallback?: () => Promise<unknown>,
): Promise<RevealVia> {
  if (isTauri() && path) {
    await (window as any).__TAURI__.core.invoke("reveal_path", { path, select });
    return "desktop";
  }
  if (fallback) {
    await fallback();
    return "backend";
  }
  throw new Error("路径已失效，无法打开所在文件夹");
}