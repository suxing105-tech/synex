<script lang="ts">
  /**
   * 顶栏缩放开关：图片和视频共用这一份，保证按钮文案、高亮态、百分比读数完全一致。
   *
   * 用法约束：必须排在宿主顶栏所有原生 button 之后（Svelte 5 事件委托里，
   * 组件排在同分支兄弟按钮之前会让后面的按钮点不动）。
   */
  import type { ViewerZoom } from "../lib/viewer-zoom.svelte";

  interface Props {
    zoom: ViewerZoom;
  }
  let { zoom }: Props = $props();
</script>

<button class="rounded-lg px-3 py-2 text-xs" aria-pressed={zoom.mode === "fit"} title="按画面比例缩到画布内" onclick={() => zoom.setFit()}>适应窗口</button>
<button class="rounded-lg px-3 py-2 text-xs" aria-pressed={zoom.mode === "zoom"} title="按原始像素显示，可拖动查看细节" onclick={() => zoom.setZoom100()}>100%</button>
<span class="text-xs text-muted">{zoom.percent}%</span>