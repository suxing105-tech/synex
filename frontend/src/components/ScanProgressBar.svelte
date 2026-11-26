<script lang="ts">
  import { scanProgress, refreshScanProgress } from "../lib/stores";
  import { onMount } from "svelte";

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    refreshScanProgress();
    pollTimer = setInterval(refreshScanProgress, 1500);
    return () => {
      if (pollTimer) clearInterval(pollTimer);
    };
  });

  // 两套计数，一条进度条。全量扫描优先：补扫在 running 时本来就会跳过，
  // 真撞上也是先显示更重的那件（用户点的那一下才是他关心的事）。
  let sweeping = $derived(!$scanProgress.running && $scanProgress.sweeping);
  let done = $derived(sweeping ? $scanProgress.sweep_indexed : $scanProgress.indexed);
  let all = $derived(sweeping ? $scanProgress.sweep_total : $scanProgress.total);
</script>

{#if $scanProgress.running || $scanProgress.sweeping}
  <div class="bg-surface border-b border-border py-2 px-5 text-2xs flex items-center gap-3">
    <span class="live-dot on"></span>
    <span class="text-muted">{sweeping ? "补录漏收的文件" : "扫描中"}</span>
    <span class="font-mono">{done} / {all}</span>
    <div class="flex-1 max-w-[300px] h-1 bg-bg rounded overflow-hidden">
      <div class="h-full bg-accent transition-all" style="width: {all ? (done / all) * 100 : 0}%"></div>
    </div>
    {#if !sweeping}
      <span class="text-muted truncate flex-1" title={$scanProgress.current_path}>{$scanProgress.current_path}</span>
    {/if}
  </div>
{/if}
