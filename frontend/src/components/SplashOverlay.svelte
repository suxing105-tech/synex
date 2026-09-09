<script lang="ts">
  /**
   * Splash Overlay 组件 — Tauri 启动期间显示。
   *
   * 用途：当 backendReady === false 时渲染全屏遮罩，
   * 显示品牌 logo + 旋转 spinner（或错误卡）。
   * 一旦 ready === true 切换为 false，整个 overlay 立即卸载。
   *
   * 设计要点：
   * - 受控组件（pure presentation）：App.svelte 拥有 backendReady / backendError 状态
   *   并订阅 sidecar-ready / sidecar-died 事件，本组件只负责把状态映射到 UI
   * - z-index: 80 盖在主 UI 上方（Toast 是 z-[100] 仍能浮在上面）
   * - aria-live="polite"：屏幕阅读器在 ready/error 变化时会朗读
   * - 颜色用 hex literal 而不是 tailwind class，因为 Tailwind 编译器不一定
   *   能识别动态字符串，且和 dist 产物里现有 splash CSS 完全一致
   */
  interface Props {
    ready: boolean;
    error: string | null;
  }
  let { ready, error }: Props = $props();
</script>

{#if !ready}
  <div class="splash-overlay" role="alert" aria-live="polite">
    <div class="splash-card">
      <div class="splash-logo">苏醒图库</div>
      {#if error}
        <div class="splash-err">后端进程异常：{error}</div>
        <div class="splash-hint">
          请关闭应用并重试；若反复失败，运行 <code>build-sidecar.ps1</code> 重建 sidecar 后再启。
        </div>
      {:else}
        <div class="splash-spinner"></div>
        <div class="splash-hint">正在启动后端进程…</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .splash-overlay {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #18181b;
    color: #fafafa;
  }
  .splash-card {
    background: #2e2e33;
    border: 1px solid #27272a;
    border-radius: 12px;
    padding: 32px 40px;
    min-width: 320px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  }
  .splash-logo {
    font-size: 22px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: #f24e4e;
  }
  .splash-spinner {
    width: 28px;
    height: 28px;
    border: 3px solid #27272a;
    border-top-color: #f24e4e;
    border-radius: 50%;
    animation: splash-spin 0.9s linear infinite;
  }
  .splash-hint {
    font-size: 12px;
    color: #8a8a8e;
    text-align: center;
    line-height: 1.5;
  }
  .splash-hint code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    background: #18181b;
    padding: 1px 6px;
    border-radius: 4px;
    color: #fb7185;
  }
  .splash-err {
    font-size: 13px;
    color: #fb7185;
    text-align: center;
    font-weight: 500;
  }
  @keyframes splash-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>