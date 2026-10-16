// 缩略图工作流标签页清理，和 comfyui_bridge.js 在同一个 IIFE 里，共用 request。
// 桥接每次 loadGraphData 都会在 ComfyUI 标签栏里新建一个临时工作流，窗口关掉之后
// 标签还留在 localStorage 里，开得越多积得越多。这里把「我们打开过的」标签名记在
// 自己的键里，在下次打开工作流时、以及本窗口关闭时，从 ComfyUI 持久化的标签列表里
// 摘掉。只摘我们自己打开的那几个名字，用户自己保存的工作流标签不碰。
if (location.origin === request.origin) {
  const TRACKED = 'SeekX.OpenedWorkflowTabs';
  // ComfyUI 新旧两版持久化键都覆盖：值都是「打开的标签」路径列表
  const PATH_LIST_KEYS = ['Comfy.OpenWorkflowsPaths', 'Comfy.Workflow.DraftOrder'];
  const PATH_LIST_PREFIXES = ['Comfy.Workflow.OpenPaths:', 'Comfy.Workflow.DraftIndex.v2:'];
  const ACTIVE_PATH_PREFIXES = ['Comfy.Workflow.ActivePath:'];
  const ACTIVE_INDEX_KEYS = ['Comfy.ActiveWorkflowIndex'];
  const baseName = (path) => String(path === null || path === undefined ? '' : path).split('/').pop().trim();
  const myTab = baseName(request.name) + '.json';
  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const drop = (key) => { try { localStorage.removeItem(key); } catch {} };
  const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
  const keys = () => { try { return Object.keys(localStorage); } catch { return []; } };
  const tracked = () => {
    const list = parse(read(TRACKED));
    return Array.isArray(list) ? list.filter((name) => typeof name === 'string') : [];
  };
  // 数组可能是路径字符串列表，也可能是 { path } 这样的对象列表，两种都按名字过滤
  const filterEntries = (list, gone) => list.filter((entry) => {
    const path = typeof entry === 'string' ? entry : entry && entry.path;
    return !gone.has(baseName(path));
  });
  const isPathListKey = (key) => PATH_LIST_KEYS.includes(key) || PATH_LIST_PREFIXES.some((p) => key.startsWith(p));
  let forgot = false;
  const forgetTabs = (names) => {
    const gone = new Set(names.map(baseName).filter((name) => name && name !== '.json'));
    if (!gone.size) return;
    for (const key of keys()) {
      if (isPathListKey(key)) {
        const list = parse(read(key));
        if (!Array.isArray(list)) continue;
        const kept = filterEntries(list, gone);
        if (kept.length === list.length) continue;
        write(key, JSON.stringify(kept));
        forgot = true;
      }
    }
    for (const key of keys()) {
      if (ACTIVE_PATH_PREFIXES.some((p) => key.startsWith(p))) {
        const active = parse(read(key)) ?? read(key);
        if (gone.has(baseName(active))) { drop(key); forgot = true; }
      }
    }
    // 标签列表变短了，旧的下标可能越界，直接让 ComfyUI 回到第一个标签
    if (forgot) ACTIVE_INDEX_KEYS.forEach(drop);
  };

  // 先清掉上一次留下的标签：本脚本是 document-start 注入，跑在 ComfyUI 恢复标签之前
  forgetTabs(tracked());
  forgot = false;
  // 记住这次打开的标签名（含同名的重复打开），供下次清理
  const remembered = [...new Set([...tracked(), myTab])].slice(-100);
  write(TRACKED, JSON.stringify(remembered));
  // 窗口关闭时把自己的标签摘掉，这是「关掉之后不应该越积越多」的直接兑现
  window.addEventListener('pagehide', () => forgetTabs([myTab]));
}
