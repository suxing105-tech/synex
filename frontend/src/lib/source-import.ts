// 添加来源目录：只登记监听目录 + 触发一次扫描，不复制、不移动任何文件。
// 与首次引导走的是同一条后端路（POST /api/directories/import），
// 差别只是入口挪到侧栏「来源目录」标题右边 —— 想加目录不该先去设置里翻。
import { scanApi, settingsApi } from './api';
import { refreshFolders, refreshStats } from './stores';
import { selectImportDirectory } from './tauri';

const LAST_DIRECTORY_KEY = 'suxing.lastImportDirectory';

/** 取末级目录名，用于提示文案；正斜杠 / 反斜杠 / 盘符根都能吃。 */
export function directoryBaseName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * 选一个本地文件夹登记为来源目录并开始扫描。
 * 取消返回 null；失败抛错，由调用方决定怎么向用户说明（浏览器版没有原生选择框）。
 */
export async function addSourceDirectory(): Promise<string | null> {
  let previous = '';
  try { previous = localStorage.getItem(LAST_DIRECTORY_KEY) ?? ''; } catch { /* 禁用存储就算了 */ }
  if (!previous) {
    try { previous = (await settingsApi.get()).watch_dirs.at(-1) ?? ''; } catch { /* 选目录不该被后台卡住 */ }
  }
  const selected = await selectImportDirectory('', previous);
  if (!selected) return null;
  const result = await scanApi.importDirectory(selected);
  try { localStorage.setItem(LAST_DIRECTORY_KEY, result.path); } catch { /* 记不上不影响导入 */ }
  await Promise.all([refreshFolders(), refreshStats()]);
  return result.path;
}
