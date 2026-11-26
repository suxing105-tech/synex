import { removeImageFromFeed, markNew, refreshFolders, refreshFeed, refreshScanProgress, refreshStats } from "./stores";

import { eventsUrl } from "./backend-url";
import { applyCloneProgress } from "./clone";
import { pushToast } from "./toast";

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** 恢复提示复用同一条：监听反复掉线时不该把角落堆满同一句话 */
let watcherToastId = 0;

export function connectEvents() {
  if (socket && socket.readyState <= 1) return;
  const url = eventsUrl();
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => { void Promise.all([refreshFeed(), refreshFolders(), refreshStats()]).catch(console.warn); };
  ws.onmessage = async (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      if (payload.type === 'texts_changed') {
        window.dispatchEvent(new CustomEvent('texts-changed'));
      } else if (payload.type === "image_indexed") {
        // 拉一次最新 feed（保持倒序）
        await refreshFeed();
        await Promise.all([refreshStats(), refreshFolders()]);
        markNew([payload.id]);
      } else if (payload.type === "images_indexed") {
        // 后端补扫回来的一批（重启前丢的事件、监听漏掉的）：一次刷新收口。
        // 逐条 image_indexed 会让前端为每张图串行发三个请求 + 重排一次瀑布流。
        await refreshFeed();
        await Promise.all([refreshStats(), refreshFolders()]);
        markNew(Array.isArray(payload.ids) ? payload.ids.slice(0, 50) : []);
      } else if (payload.type === "image_removed") {
        // 乐观更新本地 feedItems（filter 掉该 id），避免 refreshFeed 重排导致滚动条跳顶。
        removeImageFromFeed(payload.id);
        await Promise.all([refreshStats(), refreshFolders()]);
      } else if (payload.type === "folders_changed") {
        // 来源目录镜像文件夹被清理（磁盘目录删除）→ 刷新左侧目录树
        await Promise.all([refreshFolders(), refreshStats()]);
      } else if (payload.type === "clone_progress") {
        // 再次创作：进度只进内存 store。产出的图片会另外发 image_indexed，
        // 所以图库列表照常刷新，弹窗这里只负责显示状态与结果 chips。
        applyCloneProgress(payload);
      } else if (payload.type === "scan_progress") {
        // 后端会发 scan 进度；用单独轮询补上
        await refreshScanProgress();
      } else if (payload.type === "watcher_restarted") {
        // 监听掉线又被后台修好。不吭声的话，用户只会以为「这软件不收图了」；
        // 漏掉的文件反正由补扫收回，这里只负责让人知道发生过什么。
        watcherToastId = pushToast("文件监听中断过，已自动恢复。这期间漏掉的文件由后台补扫收回", {
          kind: "info",
          ttl: 5000,
          placement: "center",
          id: watcherToastId || undefined,
        });
      }
    } catch (e) {
      console.warn("ws message parse failed", e);
    }
  };
  ws.onclose = () => {
    socket = null;
    reconnectTimer = setTimeout(connectEvents, 2000);
  };
  ws.onerror = () => {
    ws.close();
  };
}

export function disconnectEvents() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) {
    socket.close();
    socket = null;
  }
}

// ---------- 复制工具 ----------


export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 后备方案
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }
}

// ---------- 格式化 ----------


export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 日期时间全站只有一支笔（2026-11-13 oil-ui 评审第三刀 T14）。
 *
 * 动手前三套写法并存：详情栏 formatDate() 走 toLocaleString("zh-CN")（单日不补零，
 * 2026-11-9）、卡片页脚 footerTimeLabel() 走补零斜杠的 MM/DD、反推与视频面板那 7 处
 * 裸 toLocaleString() 连 locale 都不给，跟着宿主 UI locale 走 —— 非中文系统上同一份
 * 数据会渲染成 "11/9/2026, 6:49:39 PM"。toLocaleString 的产物还取决于 ICU 版本。
 * 这里锁死成 YYYY-MM-DD HH:mm:ss（每段补零），不再依赖 locale 与 ICU。
 * 入参两种都收：秒级时间戳（mtime / created）与后端 SQLite 的 ISO 串（created_at）。
 */
export function dateTimeLabel(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatDate(mtime: number): string {
  return dateTimeLabel(mtime);
}

export function paramsToKv(params: Record<string, unknown>): [string, string][] {
  return Object.entries(params).map(([k, v]) => [k, String(v)]);
}

export function allParamsText(detail: {
  positive_prompt: string;
  negative_prompt: string;
  parameters: Record<string, unknown>;
  seed: number | null;
  model: string | null;
  sampler: string | null;
  steps: number | null;
  cfg: number | null;
}): string {
  const lines: string[] = [];
  if (detail.positive_prompt) lines.push(detail.positive_prompt);
  if (detail.negative_prompt) lines.push(`Negative prompt: ${detail.negative_prompt}`);
  const extras: string[] = [];
  if (detail.seed !== null) extras.push(`Seed: ${detail.seed}`);
  if (detail.sampler) extras.push(`Sampler: ${detail.sampler}`);
  if (detail.steps !== null) extras.push(`Steps: ${detail.steps}`);
  if (detail.cfg !== null) extras.push(`CFG scale: ${detail.cfg}`);
  if (detail.model) extras.push(`Model: ${detail.model}`);
  for (const [k, v] of Object.entries(detail.parameters)) {
    extras.push(`${k}: ${v}`);
  }
  if (extras.length) lines.push(extras.join(", "));
  return lines.join("\n");
}

// 防止重复加载
export const _noDuplicate = refreshFolders;
