<script lang="ts">
  import { updateStatus, updateError, updateAction, isUpdateBusy, downloadPercent } from "../lib/updates";
  let confirmInstall = $state(false);
  const busy = $derived(isUpdateBusy($updateStatus?.phase ?? ""));
  const percent = $derived(downloadPercent($updateStatus?.downloaded ?? 0, $updateStatus?.total ?? null));
</script>

<section class="space-y-3 mb-5 rounded-lg border border-border p-4" aria-label="软件更新">
  <div class="flex justify-between items-center">
    <h3 class="text-sm font-semibold">软件更新</h3>
    <span class="text-xs text-muted">{$updateStatus ? `v${$updateStatus.current_version}` : "网页版"}</span>
  </div>
  {#if $updateStatus}
    <p class="text-xs text-muted" role="status">{$updateStatus.message}</p>
    {#if !$updateStatus.installable}
      <p class="text-xs text-muted">便携运行或安装位置未确认，升级请使用完整安装包。</p>
    {/if}
    <label class="flex gap-2 text-xs items-center">
      <input type="checkbox" checked={$updateStatus.automatic} disabled={busy || !$updateStatus.configured}
        onchange={(e) => updateAction("set_update_automatic", { enabled: e.currentTarget.checked })} />
      自动检查更新（只提醒，由你决定何时下载安装）
    </label>
    {#if $updateStatus.last_check}
      <p class="text-xs text-muted">上次检查：{new Date($updateStatus.last_check * 1000).toLocaleString("zh-CN")}</p>
    {/if}
    {#if $updateStatus.version}
      <p class="text-sm">新版本 v{$updateStatus.version}</p>
      {#if $updateStatus.notes}<pre class="text-xs text-muted whitespace-pre-wrap max-h-36 overflow-auto font-sans">{$updateStatus.notes}</pre>{/if}
    {/if}
    {#if $updateStatus.phase === "downloading"}
      <progress class="w-full accent-accent" value={percent ?? undefined} max="100"></progress>
      <p class="text-xs">{percent !== null ? `${percent}%` : `${($updateStatus.downloaded / 1048576).toFixed(1)} MB`}</p>
    {/if}
    {#if $updateError}<p class="text-xs text-danger" role="alert">{$updateError}</p>{/if}
    <div class="flex gap-2 flex-wrap">
      <button class="text-xs px-3 py-2 rounded border border-border disabled:opacity-40" disabled={busy || !$updateStatus.configured}
        onclick={() => { confirmInstall = false; void updateAction("check_update", { automatic: false }); }}>检查更新</button>
      {#if $updateStatus.version && $updateStatus.phase !== "ready"}
        <button class="text-xs px-3 py-2 rounded bg-accent text-bg disabled:opacity-40" disabled={busy || !$updateStatus.installable}
          onclick={() => updateAction("download_update")}>下载更新</button>
      {/if}
      {#if $updateStatus.phase === "ready"}
        <button class="text-xs px-3 py-2 rounded bg-accent text-bg disabled:opacity-40" disabled={!$updateStatus.installable}
          onclick={() => (confirmInstall = true)}>安装更新</button>
      {/if}
    </div>
    {#if confirmInstall && $updateStatus.phase === "ready"}
      <div class="text-xs space-y-3 border-t border-border pt-3">
        <p>现在安装会先备份图库数据，再关闭应用。图片原文件保留；如正在导入，请完成后再安装。</p>
        <button class="px-3 py-2 rounded bg-accent text-bg mr-2" onclick={() => { confirmInstall = false; void updateAction("install_update"); }}>确认安装并关闭图库</button>
        <button class="px-3 py-2 rounded border border-border" onclick={() => (confirmInstall = false)}>稍后</button>
      </div>
    {/if}
  {:else}
    <p class="text-xs text-muted">自动更新仅在桌面版中提供。</p>
  {/if}
</section>
