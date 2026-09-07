<script lang="ts">
  /**
   * 全局 Toast 容器。订阅 lib/toast.ts 的 toasts store，
   * 自动渲染堆叠卡片（最多 4 个，右下角垂直堆叠）。
   *
   * 视觉规范：
   * - info / success：默认 1.5s 自动消失，带左边色条
   * - error：4s，红色左边条，带 × 关闭按钮
   * - progress：长驻，可选进度条，调用方负责 updateToast 推进 / 完成
   */
  import { toasts, dismissToast, type ToastItem } from "../lib/toast";
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
</script>

<div
  class="fixed bottom-6 right-6 z-[100] flex flex-col-reverse gap-2 items-end pointer-events-none"
  aria-live="polite"
  aria-atomic="false"
>
  {#each $toasts as t (t.id)}
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

<style>
  .toast-card {
    animation: toastSlideIn 0.18s ease-out;
  }
  @keyframes toastSlideIn {
    from { opacity: 0; transform: translateX(20px); }
    to   { opacity: 1; transform: translateX(0); }
  }
</style>
