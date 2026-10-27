<script lang="ts">
  /**
   * 对比方式切换：图片和视频共用这一个控件、这一份偏好。
   *
   * 位置固定在顶栏正中。以前视频的开关在画面底下、图片的在顶上，
   * 同一件事两套位置，用户按 S 之前得先想一下自己在看哪种素材。
   */
  import { compareMode } from "../lib/compare-mode";

  let { label = "对比方式" }: { label?: string } = $props();
</script>

<div class="compare-mode-switch" role="group" aria-label={label}>
  <button type="button" class:active={$compareMode === "split"} aria-label="分割对比" aria-pressed={$compareMode === "split"}
    onclick={() => compareMode.set("split")}>分割对比</button>
  <button type="button" class:active={$compareMode === "side"} aria-label="左右对比" aria-pressed={$compareMode === "side"}
    onclick={() => compareMode.set("side")}>左右对比</button>
</div>

<style>
  .compare-mode-switch { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); display:flex; gap:3px; padding:3px; border:1px solid #343438; border-radius:9px; background:#111113; }
  .compare-mode-switch button { padding:5px 12px; border:0; border-radius:6px; color:#a1a1aa; background:transparent; font-size:12px; cursor:pointer; white-space:nowrap; }
  .compare-mode-switch button:hover { color:#f4f4f5; }
  .compare-mode-switch button.active { color:#fff; background:#3f3f46; }
</style>
