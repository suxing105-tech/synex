// 把 splash overlay 从 App.svelte 内联抽出到独立组件 SplashOverlay.svelte
// 三处替换：
//   1) 加 import SplashOverlay
//   2) 把模板里的 {#if !backendReady} ... {/if} 替换成 <SplashOverlay ready={backendReady} error={backendError} />
//   3) 从 <style> 里删掉 .splash-* 规则（移到组件里）
//
// 用法：node extract_splash.cjs（幂等：marker 已替换则 no-op）

const fs = require('fs');
const D = String.fromCharCode(36);
const N = String.fromCharCode(10);
const appPath = 'frontend/src/App.svelte';
let src = fs.readFileSync(appPath, 'utf8');
const isCrlf = src.includes('\r\n');
if (isCrlf) src = src.replace(/\r\n/g, '\n');
let out = src;
function show(label) { console.log(label, 'OK'); }

// ---------- Step 1: 加 SplashOverlay import（按字母顺序插在 ScanProgressBar 之后）----------
{
  const anchor =
    '  import ScanProgressBar from "./components/ScanProgressBar.svelte";' + N;
  const importLine =
    '  import SplashOverlay from "./components/SplashOverlay.svelte";' + N;
  if (!out.includes(anchor)) {
    throw new Error('Step1: ScanProgressBar import anchor not found');
  }
  if (out.includes(importLine)) {
    console.log('1) SplashOverlay import already present, skipping');
  } else {
    out = out.replace(anchor, anchor + importLine);
    show('1) SplashOverlay import added (after ScanProgressBar)');
  }
}

// ---------- Step 2: 把内联 overlay 替换成 <SplashOverlay> 调用 ----------
{
  const inlineOverlay =
    '<Toast />' + N + N +
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
    '{/if}' + N + N;
  const componentCall =
    '<Toast />' + N + N +
    '<SplashOverlay ready={backendReady} error={backendError} />' + N + N;
  if (!out.includes(inlineOverlay)) {
    throw new Error('Step2: inline overlay block not found');
  }
  if (out.includes('<SplashOverlay ready={backendReady} error={backendError} />')) {
    console.log('2) <SplashOverlay> already wired up, skipping');
  } else {
    out = out.replace(inlineOverlay, componentCall);
    show('2) inline overlay replaced with <SplashOverlay>');
  }
}

// ---------- Step 3: 从 <style> 删除 .splash-* CSS（移到组件里）----------
{
  const splashCssBlock =
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
    '  }' + N;
  if (!out.includes(splashCssBlock)) {
    throw new Error('Step3: splash CSS block not found in App.svelte');
  }
  if (!out.includes('@keyframes splash-spin')) {
    console.log('3) splash CSS already removed, skipping');
  } else {
    out = out.replace(splashCssBlock, '');
    show('3) splash CSS removed from App.svelte (moved to component)');
  }
}

if (out === src) {
  console.log('App.svelte already extracted (no-op)');
} else {
  if (isCrlf) out = out.replace(/\n/g, '\r\n');
  fs.writeFileSync(appPath, out, 'utf8');
  console.log('App.svelte updated');
}