<script lang="ts">
  import { updateStatus, updateError, oneClickUpdating, installLatestUpdate, isUpdateBusy, downloadPercent } from '../lib/updates';
  import { pushToast } from '../lib/toast';
  const busy = $derived($oneClickUpdating || isUpdateBusy($updateStatus?.phase ?? ''));
  const percent = $derived(downloadPercent($updateStatus?.downloaded ?? 0, $updateStatus?.total ?? null));
  const label = $derived(!$updateStatus?.installable ? '请使用完整安装包更新' :
    $updateStatus?.phase === 'downloading' ? `正在下载更新${percent === null ? '' : ` ${percent}%`}` :
    $updateStatus?.phase === 'installing' ? '正在安装更新' :
    busy ? '正在准备更新' : `一键更新到 v${$updateStatus?.version}`);
  async function update() {
    await installLatestUpdate();
    if ($updateError) pushToast($updateError, { kind: 'error' });
  }
</script>

{#if $updateStatus?.version && !['idle', 'latest'].includes($updateStatus.phase)}
  <button class="sidebar-update w-10 h-10 flex items-center justify-center rounded-lg text-accent shrink-0 disabled:opacity-50"
    aria-label={label} title={`${label}；安装时将备份数据并关闭应用`} aria-busy={busy}
    disabled={busy || !$updateStatus.installable || !$updateStatus.configured} onclick={update}>
    {#if $updateStatus.phase === 'downloading' && percent !== null}
      <span class="text-[10px]">{percent}%</span>
    {:else}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" />
      </svg>
    {/if}
  </button>
{/if}
