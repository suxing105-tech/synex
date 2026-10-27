<script lang="ts">
  import { updateStatus, updateError, updateAction, isUpdateBusy, downloadPercent } from "../lib/updates";
  import SettingsRow from "./SettingsRow.svelte";
  let confirmInstall = $state(false);
  const busy = $derived(isUpdateBusy($updateStatus?.phase ?? ""));
  const percent = $derived(downloadPercent($updateStatus?.downloaded ?? 0, $updateStatus?.total ?? null));
  const downloadedLabel = $derived($updateStatus && $updateStatus.total === null ? `${($updateStatus.downloaded / 1048576).toFixed(1)} MB` : "");
  // 自动更新要先把检查打开；安装位置没确认（便携版）时永远不自动装。
  const autoHint = $derived(
    !$updateStatus?.automatic ? "需要先打开「自动检查更新」，才知道有没有新版本。"
      : !$updateStatus?.installable ? "便携版或安装位置未确认时不会自动安装，请用完整安装包升级。"
      : $updateStatus?.auto_update ? "安装会先备份图库数据，再关闭并重启应用；正在导入素材时建议先关掉。"
      : "打开后，检查到新版本的下一步就是下载并安装，不再弹窗询问。",
  );
</script>

<section class="update-settings" aria-label="软件更新">
  <div class="settings-card">
    <div class="settings-card-body">
      {#if $updateStatus}
        <SettingsRow title="当前版本" description={$updateStatus.message}>
          {#snippet control()}
            <span class="setting-row-mono">v{$updateStatus.current_version}</span>
          {/snippet}
        </SettingsRow>
        <SettingsRow title="自动检查更新" description="只提醒，由你决定何时下载安装；检查失败会自动退避重试。">
          {#snippet control()}
            <label class="settings-switch"><input type="checkbox" aria-label="自动检查更新" checked={$updateStatus.automatic} disabled={busy || !$updateStatus.configured}
              onchange={(e) => updateAction("set_update_automatic", { enabled: e.currentTarget.checked })} /><span class="switch-track"></span></label>
          {/snippet}
        </SettingsRow>
        <SettingsRow title="自动更新" description="发现新版本后不用点：自动下载、校验并安装，装完自动重启图库。">
          {#snippet control()}
            <label class="settings-switch"><input type="checkbox" aria-label="发现新版本后自动更新" checked={$updateStatus.auto_update} disabled={busy || !$updateStatus.configured || !$updateStatus.automatic}
              onchange={(e) => updateAction("set_update_auto_update", { enabled: e.currentTarget.checked })} /><span class="switch-track"></span></label>
          {/snippet}
          {#snippet children()}
            <p class="settings-hint">{autoHint}</p>
          {/snippet}
        </SettingsRow>
        {#if !$updateStatus.installable}
          <SettingsRow title="安装位置未确认" description="便携运行或安装位置未确认，升级请使用完整安装包。" />
        {/if}
        {#if $updateStatus.last_check}
          <SettingsRow title="上次检查" description="发现新版本时，左侧栏会出现更新入口。">
            {#snippet control()}
              <span>{new Date($updateStatus.last_check * 1000).toLocaleString("zh-CN")}</span>
            {/snippet}
          </SettingsRow>
        {/if}
        {#if $updateStatus.version}
          <SettingsRow title={`新版本 v${$updateStatus.version}`} top>
            {#if $updateStatus.notes}
              {#snippet children()}
                <pre class="release-notes">{$updateStatus.notes}</pre>
              {/snippet}
            {/if}
          </SettingsRow>
        {/if}
        {#if $updateStatus.phase === "downloading"}
          <SettingsRow title="正在下载更新" description="安装完成后，闪寻空间将重新启动。" top>
            {#snippet control()}
              <span>{percent !== null ? `${percent}%` : downloadedLabel}</span>
            {/snippet}
            {#snippet children()}
              <progress class="download-bar" value={percent ?? undefined} max="100"></progress>
            {/snippet}
          </SettingsRow>
        {/if}
        {#if $updateError}
          <p class="update-error" role="alert">{$updateError}</p>
        {/if}
        {#if confirmInstall && $updateStatus.phase === "ready"}
          <div class="update-confirm">
            <p>现在安装会先备份图库数据，再关闭应用。图片原文件保留；如正在导入，请完成后再安装。</p>
            <div class="update-confirm-actions">
              <button class="setting-button bg-accent text-bg" onclick={() => { confirmInstall = false; void updateAction("install_update"); }}>确认安装并关闭图库</button>
              <button class="setting-button" onclick={() => (confirmInstall = false)}>稍后</button>
            </div>
          </div>
        {/if}
        <div class="settings-card-footer">
          <span class="settings-hint">更新不会动你的素材文件</span>
          <button class="setting-button" disabled={busy || !$updateStatus.configured}
            onclick={() => { confirmInstall = false; void updateAction("check_update", { automatic: false }); }}>检查更新</button>
          {#if $updateStatus.version && $updateStatus.phase !== "ready"}
            <button class="setting-button bg-accent text-bg" disabled={busy || !$updateStatus.installable}
              onclick={() => updateAction("download_update")}>下载更新</button>
          {/if}
          {#if $updateStatus.phase === "ready"}
            <button class="setting-button bg-accent text-bg" disabled={!$updateStatus.installable}
              onclick={() => (confirmInstall = true)}>安装更新</button>
          {/if}
        </div>
      {:else}
        <SettingsRow title="没有可用的更新服务" description="自动更新仅在桌面版中提供；网页版请用完整安装包更新。" />
      {/if}
    </div>
  </div>
</section>

<style>
  .update-settings { display: block; }
  .release-notes { max-height: 148px; overflow: auto; font-family: inherit; font-size: 12px; line-height: 1.7; color: #a1a1aa; white-space: pre-wrap; }
  .download-bar { width: 100%; height: 6px; accent-color: #f24e4e; }
  .update-error { padding: 12px 20px; font-size: 12.5px; color: #fb7185; border-top: 1px solid #26262b; }
  .update-confirm { display: flex; flex-direction: column; gap: 12px; padding: 16px 20px; font-size: 12.5px; line-height: 1.7; color: #b8b8c3; border-top: 1px solid #26262b; }
  .update-confirm-actions { display: flex; gap: 10px; flex-wrap: wrap; }
</style>
