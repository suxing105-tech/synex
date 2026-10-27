<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * 设置页的一行：左边标题＋说明，右边控件（开关 / 按钮 / 下拉 / 状态）。
   * children 横跨整行，用来摆列表、输入框、状态条这类放不进右侧的内容。
   */
  interface Props {
    title: string;
    description?: string;
    control?: Snippet;
    children?: Snippet;
    /** 说明或附带内容较长时改成顶部对齐，避免标题被拉行的控件顶歪。 */
    top?: boolean;
  }
  let { title, description = "", control, children, top = false }: Props = $props();
</script>

<div class="setting-row" class:setting-row-top={top}>
  <div class="setting-row-main">
    <span class="setting-row-title">{title}</span>
    {#if description}<span class="setting-row-desc">{description}</span>{/if}
  </div>
  {#if control}<div class="setting-row-side">{@render control?.()}</div>{/if}
  {#if children}<div class="setting-row-extra">{@render children?.()}</div>{/if}
</div>
