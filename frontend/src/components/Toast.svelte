<script lang="ts">
  /**
   * 全局 Toast 容器。订阅 lib/toast.ts 的 toasts store。
   *
   * 两种呈现（同一套 store，只是 placement 不同）：
   * - corner（默认）：右下角垂直堆叠卡片，最多 4 个
   *   · info / success 1.5s、error 4s 带 ×、progress 长驻 + 进度条
   * - center：底部居中浮动药丸，带图标与行内操作（「已归档 · 查看 · 撤销」）
   *   · 悬停暂停倒计时，离开后按剩余时间继续 —— 自动消失不能把撤销按钮抽走
   */
  import { toasts, dismissToast, pauseToast, resumeToast, type ToastItem } from "../lib/toast";
  import Icon from "./Icon.svelte";

  function accentClass(t: ToastItem): string {
    switch (t.kind) {
      case "error":
        return "border-l-danger";
      case "success":
        return "border-l-success";
      case "progress":
        return "border-l-accent";
      default:
        return "border-l-muted";
    }
  }

  let centerToasts = $derived($toasts.filter((t) => t.placement === "center"));
  let cornerToasts = $derived($toasts.filter((t) => t.placement !== "center"));
</script>

<div
  class="fixed bottom-6 right-6 z-[100] flex flex-col-reverse gap-2 items-end pointer-events-none"
  aria-live="polite"
  aria-atomic="false"
>
  {#each cornerToasts as t (t.id)}
    <div
      class="toast-card pointer-events-auto bg-surface-2 border border-border border-l-4 {accentClass(t)} rounded-md px-3 py-2 text-[12px] shadow-lg min-w-[180px] max-w-[360px] flex items-start gap-2"
      role={t.kind === "error" ? "alert" : "status"}
    >
      {#if t.kind === "progress"}
        <span class="inline-block w-3 h-3 mt-0.5 border-2 border-accent border-t-transparent rounded-full animate-spin shrink-0"></span>
      {/if}
      <div class="flex-1 min-w-0">
        <div class="break-words">{t.message}</div>
        {#if t.progress !== undefined}
          <div class="mt-1 h-1 bg-surface-3 rounded overflow-hidden">
            <div
              class="h-full bg-accent transition-[width] duration-200"
              style="width: {Math.max(0, Math.min(100, t.progress))}%"
            ></div>
          </div>
        {/if}
      </div>
      <button
        type="button"
        class="text-muted hover:text-zinc-200 shrink-0"
        aria-label="关闭"
        onclick={() => dismissToast(t.id)}
      >
        <Icon name="x" size={11} />
      </button>
    </div>
  {/each}
</div>

{#if centerToasts.length}
  <div class="toast-center" aria-live="polite">
    {#each centerToasts as t (t.id)}
      <div
        class="toast-pill"
        role="status"
        onmouseenter={() => pauseToast(t.id)}
        onmouseleave={() => resumeToast(t.id)}
      >
        {#if t.icon}
          <Icon name={t.icon} size={15} />
        {/if}
        <span class="toast-pill-text">{t.message}</span>
        {#if t.actions}
          {#each t.actions as action (action.label)}
            <button
              type="button"
              class="pill-action"
              class:pill-action-primary={action.primary}
              onclick={() => {
                action.onClick();
                dismissToast(t.id);
              }}
            >{action.label}</button>
          {/each}
        {/if}
        <button type="button" class="pill-close" aria-label="关闭" onclick={() => dismissToast(t.id)}>
          <Icon name="x" size={13} />
        </button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-card {
    animation: toastSlideIn 0.18s ease-out;
  }
  @keyframes toastSlideIn {
    from { opacity: 0; transform: translateX(20px); }
    to   { opacity: 1; transform: translateX(0); }
  }

  /* 底部居中提示条：深色药丸浮在内容上方，不挡操作区 */
  .toast-center {
    position: fixed;
    left: 50%;
    bottom: 26px;
    transform: translateX(-50%);
    z-index: 100;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    pointer-events: none;
  }
  .toast-pill {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    max-width: min(92vw, 620px);
    padding: 7px 8px 7px 14px;
    border-radius: 999px;
    background: #232326;
    border: 1px solid #3a3a40;
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.5);
    color: #e8e8ec;
    font-size: 12.5px;
    animation: toastPillIn 0.18s ease-out;
  }
  .toast-pill-text { min-width: 0; }
  .pill-action {
    flex: none;
    height: 26px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid #4a4a52;
    background: transparent;
    color: #d6d6dc;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .pill-action:hover,
  .pill-action:focus-visible { background: #ffffff14; color: #f4f4f6; }
  .pill-action-primary {
    background: #e8e8ec;
    border-color: #e8e8ec;
    color: #17171a;
    font-weight: 600;
  }
  .pill-action-primary:hover,
  .pill-action-primary:focus-visible { background: #ffffff; border-color: #ffffff; color: #17171a; }
  .pill-close {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: #8a8a8e;
    cursor: pointer;
  }
  .pill-close:hover,
  .pill-close:focus-visible { color: #f4f4f6; background: #ffffff14; }
  @keyframes toastPillIn {
    from { opacity: 0; transform: translateY(10px); }
    to   { opacity: 1; transform: translateY(0); }
  }
</style>
