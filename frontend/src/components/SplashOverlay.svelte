<script lang="ts">
  // 展示层：启动完成与异常状态由 App 的 splash gate 控制。
  interface Props {
    ready: boolean;
    error: string | null;
  }
  let { ready, error }: Props = $props();
</script>

{#if !ready}
  <div class="splash-overlay" class:has-error={!!error} role="status" aria-live="polite" aria-busy={!error}>
    <div class="splash-stage">
      <div class="splash-emblem">
        {#if !error}<div class="splash-orbit" aria-hidden="true"></div>{/if}
        <img class="splash-logo" src="/logo.png" alt="闪寻空间" width="72" height="72" />
      </div>
      {#if error}
        <div class="splash-err" role="alert">启动未完成：{error}</div>
        <p class="splash-hint">请关闭应用后重新打开。如果仍无法启动，请联系支持并提供此错误信息。</p>
      {:else}
        <div class="splash-track" aria-hidden="true"><span></span></div>
        <span class="sr-only">正在启动，请稍候</span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .splash-overlay {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: grid;
    place-items: center;
    overflow: hidden;
    background: radial-gradient(ellipse at 50% 46%, #251a1e 0%, #151517 38%, #101012 75%);
    color: #fafafa;
  }
  .splash-stage {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: min(480px, calc(100% - 48px));
    text-align: center;
    animation: splash-arrive 600ms ease-out both;
  }
  .splash-emblem {
    position: relative;
    width: 160px;
    height: 160px;
    display: grid;
    place-items: center;
  }
  .splash-logo {
    object-fit: contain;
    filter: drop-shadow(0 0 22px #f24e4e28);
    animation: splash-breathe 3.2s ease-in-out infinite;
  }
  .splash-orbit {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 1px solid #f24e4e12;
    border-top-color: #f24e4e80;
    border-right-color: #f24e4e30;
    animation: splash-orbit 3.6s linear infinite;
  }
  .splash-track {
    width: 104px;
    height: 2px;
    margin-top: 36px;
    border-radius: 2px;
    overflow: hidden;
    background: #ffffff0a;
  }
  .splash-track span {
    display: block;
    width: 48%;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, transparent, #f24e4e, transparent);
    animation: splash-travel 2.2s ease-in-out infinite;
  }
  .splash-err { margin-top: 24px; font-size: 14px; line-height: 1.7; color: #fb7185; overflow-wrap: anywhere; }
  .splash-hint { margin-top: 12px; font-size: 12px; line-height: 1.8; color: #a1a1aa; }
  .has-error .splash-logo { animation: none; }
  @keyframes splash-arrive { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes splash-breathe { 0%, 100% { opacity: .82; transform: scale(.97); } 50% { opacity: 1; transform: scale(1); } }
  @keyframes splash-orbit { to { transform: rotate(360deg); } }
  @keyframes splash-travel { 0% { transform: translateX(-110%); } 100% { transform: translateX(320%); } }
  @media (prefers-reduced-motion: reduce) {
    .splash-stage, .splash-logo, .splash-orbit, .splash-track span { animation: none; }
    .splash-track span { margin: 0 auto; }
  }
</style>
