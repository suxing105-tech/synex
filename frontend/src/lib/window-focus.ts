/**
 * F 键的沉浸循环：收起两侧 → 最大化 → 全屏 → 还原，然后从头再来。
 *
 * 为什么是这个顺序：从「少一点干扰」到「全占满」，最后一步才回原样，
 * 用户随时知道下一次按下去会发生什么。侧栏那一步归前端，窗口那三步
 * 必须走 Tauri 的窗口 API（浏览器 dev 里没有窗口可操作，只收起侧栏）。
 */
export type FocusStage = "sidebars" | "maximized" | "fullscreen" | "normal";

export const FOCUS_STAGES: readonly FocusStage[] = ["sidebars", "maximized", "fullscreen", "normal"];

export const FOCUS_STAGE_LABEL: Record<FocusStage, string> = {
  sidebars: "收起左右侧栏",
  maximized: "最大化窗口",
  fullscreen: "全屏",
  normal: "还原窗口与原侧栏",
};

export function nextFocusStage(current: FocusStage): FocusStage {
  const at = FOCUS_STAGES.indexOf(current);
  return FOCUS_STAGES[(at + 1) % FOCUS_STAGES.length];
}

interface WindowApi {
  maximize(): Promise<void>;
  unmaximize(): Promise<void>;
  setFullscreen(value: boolean): Promise<void>;
  isMaximized?(): Promise<boolean>;
}

function appWindow(): WindowApi | null {
  const tauri = (globalThis as { __TAURI__?: { window?: { getCurrentWindow(): WindowApi } } }).__TAURI__;
  return tauri?.window ? tauri.window.getCurrentWindow() : null;
}

/** 进入循环前先记下窗口原本是不是最大化：第四次按 F 要回到「原来的大小」，不是统统缩成普通窗口。 */
export async function windowIsMaximized(): Promise<boolean> {
  const win = appWindow();
  if (!win?.isMaximized) return false;
  try {
    return await win.isMaximized();
  } catch {
    return false;
  }
}

/** @returns 失败时给用户的中文提示，成功或浏览器环境返回 null。 */
export async function applyFocusStage(stage: FocusStage, restoreMaximized = false): Promise<string | null> {
  const win = appWindow();
  if (!win) return null;
  try {
    if (stage === "maximized") await win.maximize();
    else if (stage === "fullscreen") await win.setFullscreen(true);
    else if (stage === "normal") {
      await win.setFullscreen(false);
      // 退出全屏不保证回到进全屏前的尺寸，所以显式回到进入循环前的样子：
      // 原本最大化就最大化，原本普通窗口就取消最大化。
      if (restoreMaximized) await win.maximize();
      else await win.unmaximize();
    }
    return null;
  } catch {
    return "窗口操作失败，请重试";
  }
}
