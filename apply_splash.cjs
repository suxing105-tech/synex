// One-shot transformer: 把 splash overlay 落到 App.svelte 源码，
// 修复 Tauri M0-f 黑屏。dist 含 splash 代码但源码没有，下次 cargo tauri
// build 会再次黑屏。详见 materials/29-tauri-m0-delivery.md §7.1。
//
// 用法：node apply_splash.cjs
//      （幂等：重复跑会因 marker 已存在直接退出 0）

const fs = require('fs');
const D = String.fromCharCode(36);  // $
const N = String.fromCharCode(10);  // LF
const appPath = 'frontend/src/App.svelte';
let src = fs.readFileSync(appPath, 'utf8');
const isCrlf = src.includes('\r\n');
if (isCrlf) src = src.replace(/\r\n/g, '\n');
let out = src;
function show(label) { console.log(label, 'OK'); }

// ---------- Step 1: 加 tauri import ----------
{
  const libStoresImport =
    '  import { refreshFolders, refreshStats, refreshFeed, selectedId, comfyuiStatus, comfyuiEnabled, feedItems, tag, folderId, query, view, selectedDetail } from "./lib/stores";' + N;
  const tauriImport =
    '  import { isTauri, onSidecarReady, onSidecarDied } from "./lib/tauri";' + N;
  if (!out.includes(libStoresImport)) {
    throw new Error('Step1: lib/stores import marker not found');
  }
  if (out.includes(tauriImport)) {
    console.log('1) tauri import already present, skipping');
  } else {
    out = out.replace(libStoresImport, libStoresImport + tauriImport);
    show('1) tauri import added');
  }
}

// ---------- Step 2: 在 onMount 之前插入 splash state + doInit + markBackendReady/Failed ----------
// 注意：splashBlock 不带末尾缩进，由 anchor 自带的 `  ` 提供正确缩进
{
  const splashBlock =
    '  // ============ 后端就绪状态（Tauri sidecar 生命周期） ============' + N +
    '  // M0-f 修复：dist 产物的 App.svelte 含 splash overlay 但源码此前没有，' + N +
    '  // 下次 cargo tauri build 后必再次黑屏。把 splash 落到源码以确保 prod 可见。' + N +
    '  // - isTauri()：浏览器 dev / 静态托管为 false；Tauri WebView2 为 true。' + N +
    '  // - 浏览器路径直接 await doInit()（vite proxy / FastAPI 已在 8765）；' + N +
    '  // - Tauri 路径订阅 Rust 端 sidecar-ready / sidecar-died 事件，' + N +
    '  //   等到后端真正 READY 才允许主 UI 渲染，避免 #app 空 div 黑屏。' + N +
    '  let backendReady = ' + D + 'state(!isTauri());' + N +
    '  let backendError: string | null = ' + D + 'state(null);' + N +
    '  let initStarted = false;' + N +
    '  let sidecarReadyUnsub: (() => void) | null = null;' + N +
    '  let sidecarDiedUnsub: (() => void) | null = null;' + N +
    '  let backendBootTimeout: ReturnType<typeof setTimeout> | null = null;' + N +
    N +
    '  async function doInit() {' + N +
    '    if (initStarted) return;' + N +
    '    initStarted = true;' + N +
    '    try {' + N +
    '      await Promise.all([refreshFolders(), refreshStats(), refreshFeed()]);' + N +
    '      const cfg = await settingsApi.get();' + N +
    '      if (!cfg.watch_dirs || cfg.watch_dirs.length === 0) {' + N +
    '        onboardingOpen = true;' + N +
    '      }' + N +
    '    } catch (e) {' + N +
    '      console.error("init failed", e);' + N +
    '    }' + N +
    '    connectEvents();' + N +
    '  }' + N +
    N +
    '  function markBackendReady() {' + N +
    '    backendReady = true;' + N +
    '    backendError = null;' + N +
    '    if (backendBootTimeout) {' + N +
    '      clearTimeout(backendBootTimeout);' + N +
    '      backendBootTimeout = null;' + N +
    '    }' + N +
    '    void doInit();' + N +
    '  }' + N +
    N +
    '  function markBackendFailed(reason: string) {' + N +
    '    backendReady = false;' + N +
    '    backendError = reason;' + N +
    '    if (backendBootTimeout) {' + N +
    '      clearTimeout(backendBootTimeout);' + N +
    '      backendBootTimeout = null;' + N +
    '    }' + N +
    '  }' + N +
    N;
  const onMountAnchor = '  onMount(async () => {';
  if (!out.includes(onMountAnchor)) {
    throw new Error('Step2: onMount anchor not found');
  }
  if (out.includes('  let backendReady = ' + D + 'state(!isTauri());')) {
    console.log('2) splash state already present, skipping');
  } else {
    out = out.replace(onMountAnchor, splashBlock + onMountAnchor);
    show('2) splash state + doInit + markBackendReady/Failed inserted before onMount');
  }
}

// ---------- Step 3: 替换 onMount 整块 ----------
{
  const newOnMount =
    '  onMount(async () => {' + N +
    '    if (isTauri()) {' + N +
    '      // Tauri 路径：等 Rust 端的 sidecar-ready 事件，否则一直显示 splash。' + N +
    '      // 30s 超时切错误卡（一般 1~2s 就能 ready；30s 留给冷启动 / 防卡死）。' + N +
    '      sidecarReadyUnsub = await onSidecarReady(() => markBackendReady());' + N +
    '      sidecarDiedUnsub = await onSidecarDied((p) => {' + N +
    '        markBackendFailed(p?.reason || "sidecar died");' + N +
    '      });' + N +
    '      backendBootTimeout = setTimeout(() => {' + N +
    '        if (!backendReady) {' + N +
    '          markBackendFailed(backendError || "后端进程启动超时（30s）");' + N +
    '        }' + N +
    '      }, 30000);' + N +
    '      return;' + N +
    '    }' + N +
    '    // 浏览器 dev / 静态托管：直接 init（vite proxy / FastAPI 已在 8765）' + N +
    '    await doInit();' + N +
    '    await refreshComfyuiStatus();' + N +
    '    comfyuiTimer = setInterval(refreshComfyuiStatus, 30000);' + N +
    '    const onVis = () => {' + N +
    '      if (document.visibilityState === "visible") refreshComfyuiStatus();' + N +
    '    };' + N +
    '    document.addEventListener("visibilitychange", onVis);' + N +
    '    window.addEventListener("open-lightbox", handleOpenLightbox);' + N +
    '    window.addEventListener("open-tag-search", handleTagSearch);' + N +
    '    checkNarrow();' + N +
    '    window.addEventListener("resize", checkNarrow);' + N +
    '  });';
  const onMountRe = /  onMount\(async \(\) => \{[\s\S]*?\n  \}\);/;
  if (!onMountRe.test(out)) {
    throw new Error('Step3: onMount block regex not found');
  }
  if (out.includes('    if (isTauri()) {' + N + '      // Tauri 路径')) {
    console.log('3) onMount already replaced, skipping');
  } else {
    out = out.replace(onMountRe, newOnMount);
    show('3) onMount replaced (Tauri-aware)');
  }
}

// ---------- Step 4: onDestroy 开头插 cleanup ----------
{
  const onDestroyOld =
    '  onDestroy(() => {' + N +
    '    disconnectEvents();';
  const onDestroyNew =
    '  onDestroy(() => {' + N +
    '    if (sidecarReadyUnsub) sidecarReadyUnsub();' + N +
    '    if (sidecarDiedUnsub) sidecarDiedUnsub();' + N +
    '    if (backendBootTimeout) clearTimeout(backendBootTimeout);' + N +
    '    disconnectEvents();';
  if (!out.includes(onDestroyOld)) {
    throw new Error('Step4: onDestroy original block not found');
  }
  if (out.includes('if (sidecarReadyUnsub) sidecarReadyUnsub();')) {
    console.log('4) onDestroy cleanup already present, skipping');
  } else {
    out = out.replace(onDestroyOld, onDestroyNew);
    show('4) onDestroy cleanup inserted');
  }
}

// ---------- Step 5: 模板 `<style>` 之前插入 splash overlay ----------
{
  const styleAnchor = '<style>';
  if (!out.includes(styleAnchor)) {
    throw new Error('Step5: <style> anchor not found');
  }
  const splashOverlay =
    '{#if !backendReady}' + N +
    '  <div class="splash-overlay" role="alert" aria-live="polite">' + N +
    '    <div class="splash-card">' + N +
    '      <div class="splash-logo">苏醒图库</div>' + N +
    '      {#if backendError}' + N +
    '        <div class="splash-err">后端进程异常：{backendError}</div>' + N +
    '        <div class="splash-hint">请关闭应用并重试；若反复失败，运行 <code>build-sidecar.ps1</code> 重建 sidecar 后再启。</div>' + N +
    '      {:else}' + N +
    '        <div class="splash-spinner"></div>' + N +
    '        <div class="splash-hint">正在启动后端进程…</div>' + N +
    '      {/if}' + N +
    '    </div>' + N +
    '  </div>' + N +
    '{/if}' + N +
    N;
  if (out.includes('class="splash-overlay"')) {
    console.log('5) splash overlay already present, skipping');
  } else {
    out = out.replace(styleAnchor, splashOverlay + styleAnchor);
    show('5) splash overlay inserted before <style>');
  }
}

// ---------- Step 6: `</style>` 之前插入 splash CSS ----------
{
  const cssBlock =
    '  .splash-overlay {' + N +
    '    position: fixed;' + N +
    '    inset: 0;' + N +
    '    z-index: 80;' + N +
    '    display: flex;' + N +
    '    align-items: center;' + N +
    '    justify-content: center;' + N +
    '    background: #18181b;' + N +
    '    color: #fafafa;' + N +
    '  }' + N +
    '  .splash-card {' + N +
    '    background: #2e2e33;' + N +
    '    border: 1px solid #27272a;' + N +
    '    border-radius: 12px;' + N +
    '    padding: 32px 40px;' + N +
    '    min-width: 320px;' + N +
    '    display: flex;' + N +
    '    flex-direction: column;' + N +
    '    align-items: center;' + N +
    '    gap: 16px;' + N +
    '    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);' + N +
    '  }' + N +
    '  .splash-logo {' + N +
    '    font-size: 22px;' + N +
    '    font-weight: 600;' + N +
    '    letter-spacing: 0.04em;' + N +
    '    color: #f24e4e;' + N +
    '  }' + N +
    '  .splash-spinner {' + N +
    '    width: 28px;' + N +
    '    height: 28px;' + N +
    '    border: 3px solid #27272a;' + N +
    '    border-top-color: #f24e4e;' + N +
    '    border-radius: 50%;' + N +
    '    animation: splash-spin 0.9s linear infinite;' + N +
    '  }' + N +
    '  .splash-hint {' + N +
    '    font-size: 12px;' + N +
    '    color: #8a8a8e;' + N +
    '    text-align: center;' + N +
    '    line-height: 1.5;' + N +
    '  }' + N +
    '  .splash-hint code {' + N +
    '    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;' + N +
    '    font-size: 11px;' + N +
    '    background: #18181b;' + N +
    '    padding: 1px 6px;' + N +
    '    border-radius: 4px;' + N +
    '    color: #fb7185;' + N +
    '  }' + N +
    '  .splash-err {' + N +
    '    font-size: 13px;' + N +
    '    color: #fb7185;' + N +
    '    text-align: center;' + N +
    '    font-weight: 500;' + N +
    '  }' + N +
    '  @keyframes splash-spin {' + N +
    '    to { transform: rotate(360deg); }' + N +
    '  }' + N +
    N;
  const closeStyle = '</style>';
  if (!out.includes(closeStyle)) {
    throw new Error('Step6: </style> close tag not found');
  }
  if (out.includes('@keyframes splash-spin')) {
    console.log('6) splash CSS already present, skipping');
  } else {
    out = out.replace(closeStyle, cssBlock + closeStyle);
    show('6) splash CSS inserted before </style>');
  }
}

if (out === src) {
  console.log('App.svelte already transformed (no-op)');
} else {
  if (isCrlf) out = out.replace(/\n/g, '\r\n');
  fs.writeFileSync(appPath, out, 'utf8');
  console.log('App.svelte updated');
}
