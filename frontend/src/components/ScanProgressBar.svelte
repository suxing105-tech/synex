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
</script>

{#if $scanProgress.running}
  <div class="bg-surface border-b border-border py-1.5 px-5 text-[11px] flex items-center gap-3">
    <span class="live-dot on"></span>
    <span class="text-muted">扫描中</span>
    <span class="font-mono">{$scanProgress.indexed} / {$scanProgress.total}</span>
    <div class="flex-1 max-w-[300px] h-1 bg-bg rounded overflow-hidden">
      <div class="h-full bg-accent transition-all" style="width: {$scanProgress.total ? ($scanProgress.indexed / $scanProgress.total) * 100 : 0}%"></div>
    </div>
    <span class="text-muted truncate flex-1" title={$scanProgress.current_path}>{$scanProgress.current_path}</span>
  </div>
{/if}
