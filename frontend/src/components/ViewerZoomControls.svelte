<script lang="ts">
  /**
   * 顶栏缩放开关：图片和视频共用这一份，保证图标、高亮态、百分比读数完全一致。
   *
   * 图标只在 .viewer-icon-btn 里当图形用，名字一律走 aria-label + title：
   * 屏幕阅读器、hover 提示和测试都靠这两个字面，不会跟着图标一起被换掉。
   *
   * 用法约束：必须排在宿主顶栏所有原生 button 之后（Svelte 5 事件委托里，
   * 组件排在同分支兄弟按钮之前会让后面的按钮点不动）。
   */
  import Icon from "./Icon.svelte";
  import type { ViewerZoom } from "../lib/viewer-zoom.svelte";

  interface Props {
    zoom: ViewerZoom;
  }
  let { zoom }: Props = $props();
</script>

<button type="button" class="viewer-icon-btn" aria-label="适应窗口" aria-pressed={zoom.mode === "fit"} title="适应窗口（按画面比例缩到画布内）" onclick={() => zoom.setFit()}>
  <Icon name="fit-screen" size={15} />
</button>
<button type="button" class="viewer-icon-btn" aria-label="100%" aria-pressed={zoom.mode === "zoom"} title="原始像素显示（100%），可拖动查看细节" onclick={() => zoom.setZoom100()}>
  <Icon name="actual-size" size={15} />
</button>
<span class="viewer-zoom-readout">{zoom.percent}%</span>
