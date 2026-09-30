<script lang="ts">
  import { onMount } from 'svelte';
  import { pushToast } from '../lib/toast';

  let { maximized = $bindable(false) }: { maximized?: boolean } = $props();
  const appWindow = () => (window as any).__TAURI__.window.getCurrentWindow();
  async function refreshMaximized() {
    try { maximized = await appWindow().isMaximized(); } catch { /* Keep window controls available during startup. */ }
  }
  async function windowAction(action: 'minimize' | 'toggleMaximize' | 'close') {
    try {
      await appWindow()[action]();
      if (action === 'toggleMaximize') await refreshMaximized();
    } catch {
      pushToast('窗口操作失败，请重试', { kind: 'error' });
    }
  }
  onMount(() => {
    let disposed = false;
    let stopResize: (() => void) | undefined;
    void refreshMaximized();
    void appWindow().onResized(refreshMaximized).then((unlisten: () => void) => {
      if (disposed) unlisten(); else stopResize = unlisten;
    }).catch(() => {});
    return () => { disposed = true; stopResize?.(); };
  });
</script>

<header class="desktop-titlebar" class:compact={maximized} aria-label="窗口标题栏">
  <div class="titlebar-drag" data-tauri-drag-region>
    <img src="/logo.png" alt="" width="22" height="22" draggable="false" />
    <span>闪寻空间</span>
  </div>
  <div class="window-controls">
    <button aria-label="最小化窗口" title="最小化" onclick={() => windowAction('minimize')}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="M3 8h10" /></svg>
    </button>
    <button aria-label={maximized ? '还原窗口' : '最大化窗口'} title={maximized ? '还原' : '最大化'} onclick={() => windowAction('toggleMaximize')}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
        {#if maximized}<path d="M5 5V3h8v8h-2" /><rect x="3" y="5" width="8" height="8" />{:else}<rect x="3" y="3" width="10" height="10" />{/if}
      </svg>
    </button>
    <button class="window-close" aria-label="关闭窗口" title="关闭" onclick={() => windowAction('close')}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="m3 3 10 10M13 3 3 13" /></svg>
    </button>
  </div>
</header>

<style>
  .desktop-titlebar { position: fixed; top: 0; left: 0; right: 0; height: var(--desktop-titlebar-height, 36px); display: flex; align-items: stretch; background: #202020; color: #e8e8e8; border-bottom: 1px solid #2e2e33; z-index: 200; user-select: none; }
  .titlebar-drag { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 0 18px; }
  .titlebar-drag img, .titlebar-drag span { pointer-events: none; }
  .titlebar-drag img { object-fit: contain; }
  .titlebar-drag span { font-size: 14px; font-weight: 500; }
  .compact .titlebar-drag { gap: 8px; padding-inline: 12px; }
  .compact .titlebar-drag img { width: 16px; height: 16px; }
  .compact .titlebar-drag span { font-size: 12px; }
  .window-controls { display: flex; flex-shrink: 0; }
  button { display: flex; align-items: center; justify-content: center; width: 48px; height: 100%; border: 0; color: #c8c8c8; background: transparent; }
  button:hover { background: #ffffff12; color: #fff; }
  button:focus-visible { outline: none; background: #ffffff20; box-shadow: inset 0 -2px #f24e4e; }
  .window-close:hover, .window-close:focus-visible { background: #c42b1c; color: #fff; }
</style>
