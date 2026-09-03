<script lang="ts">
  /**
   * 扁平化线性图标（Feather/Lucide 风）。
   * 实际 inner-SVG 路径抽到 lib/icons.ts，方便纯函数测试 + 跨组件复用。
   * 用法：<Icon name="folder" size={14} />
   */
  import { ICON_PATHS } from "../lib/icons";

  interface Props {
    name: string;
    size?: number;
    class?: string;
  }
  let { name, size = 14, class: cls = "" }: Props = $props();

  // 用 {#if} 而不是 {@html}：避免 XSS 风险（icon 数据来自 lib/icons.ts，硬编码）
  let path = $derived(ICON_PATHS[name] ?? "");
</script>

{#if path}
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class={cls}
    aria-hidden="true"
  >
    {@html path}
  </svg>
{/if}
