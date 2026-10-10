<script lang="ts">
  import { updateStatus, updateError, oneClickUpdating, installLatestUpdate, isUpdateBusy, downloadPercent } from "../lib/updates";
  import { pushToast } from "../lib/toast";

  const status = $derived($updateStatus);
  const busy = $derived($oneClickUpdating || isUpdateBusy(status?.phase ?? ""));
  const percent = $derived(downloadPercent(status?.downloaded ?? 0, status?.total ?? null));
  const visible = $derived(!!status?.version && !["idle", "latest"].includes(status.phase));
  // 后台自动检查不该弹出进度卡片，只有用户点了更新、或真的在下/装包时才显示。
  const cardVisible = $derived($oneClickUpdating || ["downloading", "installing"].includes(status?.phase ?? ""));
  const unsupported = $derived(!!status && !status.installable);
  const tooltip = $derived(unsupported ? "请使用完整安装包更新" : "有可用更新");
  const entryLabel = $derived(unsupported ? "请使用完整安装包更新" :
    status?.phase === "downloading" ? `正在下载更新${percent === null ? "" : ` ${percent}%`}` :
    status?.phase === "installing" ? "正在安装更新" : `有可用更新 v${status?.version}`);
  const cardTitle = $derived(status?.phase === "downloading" ? "正在下载更新" :
    status?.phase === "installing" ? "正在安装更新" : "正在准备更新");
  const cardState = $derived(status?.phase === "downloading" ? (percent === null ? "正在下载…" : `正在下载 ${percent}%`) :
    status?.phase === "installing" ? "正在安装…" : "正在准备…");

  async function update() {
    await installLatestUpdate();
    if ($updateError) pushToast($updateError, { kind: "error" });
  }
</script>

{#if visible}
  <span class="sidebar-update-wrap relative inline-flex shrink-0">
    <button class="sidebar-update w-10 h-10 flex items-center justify-center rounded-lg text-muted shrink-0 disabled:opacity-50"
      aria-label={entryLabel} aria-busy={busy}
      disabled={busy || unsupported || !status?.configured} onclick={update}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </button>
    {#if !busy}
      <span class="update-tooltip" aria-hidden="true">{tooltip}</span>
    {/if}
  </span>
{/if}

{#if cardVisible}
  <div class="update-progress-card" role="status" aria-live="polite">
    <h4 class="update-card-title">{cardTitle}</h4>
    <p class="update-card-note">安装完成后，闪寻空间 将重新启动。</p>
    <div class="update-card-row">
      <div class="update-progress-track" role="progressbar" aria-label={cardTitle}
        aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent ?? undefined}>
        <div class="update-progress-fill" class:indeterminate={percent === null}
          style:width={percent === null ? undefined : `${percent}%`}></div>
      </div>
      <span class="update-progress-state">{cardState}</span>
    </div>
  </div>
{/if}

<style>
  /* 侧栏入口与设置按钮同款 (w-10 h-10 text-muted)，悬停出深色 tooltip；配色沿用应用现有深色主题。 */
  .sidebar-update-wrap:hover .update-tooltip,
  .sidebar-update-wrap:focus-within .update-tooltip {
    opacity: 1;
    transform: none;
  }

  /* 按钮禁用时（便携版不能自更新）让指针穿透到外层，hover 仍能出 tooltip。 */
  .sidebar-update:disabled {
    pointer-events: none;
  }

  .update-tooltip {
    position: absolute;
    left: calc(100% + 8px);
    bottom: 6px;
    z-index: 70;
    padding: 7px 10px;
    border-radius: 8px;
    border: 1px solid #2e2e33;
    background: #0b0b0d;
    color: #fafafa;
    font-size: 12px;
    line-height: 1;
    white-space: nowrap;
    box-shadow: 0 8px 24px rgb(0 0 0 / 45%);
    opacity: 0;
    transform: translateY(2px);
    transition: opacity 0.12s ease, transform 0.12s ease;
    pointer-events: none;
  }

  /* 下载/安装中的卡片：标题 + 说明 + 进度条 + 右侧状态文字。 */
  .update-progress-card {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: calc(var(--desktop-titlebar-height, 0px) + 74px);
    z-index: 70;
    width: min(360px, calc(100vw - 32px));
    padding: 14px 16px 16px;
    border-radius: 14px;
    border: 1px solid #2e2e33;
    background: rgb(24 24 27 / 96%);
    box-shadow: 0 18px 40px rgb(0 0 0 / 50%);
    backdrop-filter: blur(6px);
  }

  .update-card-title {
    font-size: 15px;
    font-weight: 600;
    line-height: 22px;
    color: #fafafa;
  }

  .update-card-note {
    margin-top: 2px;
    font-size: 12px;
    line-height: 18px;
    color: #8a8a8e;
  }

  .update-card-row {
    margin-top: 12px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .update-progress-track {
    position: relative;
    flex: 1 1 auto;
    height: 6px;
    border-radius: 999px;
    background: #323237;
    overflow: hidden;
  }

  .update-progress-fill {
    height: 100%;
    min-width: 6%;
    border-radius: 999px;
    background: #f24e4e;
    transition: width 0.2s ease;
  }

  .update-progress-fill.indeterminate {
    width: 34%;
    animation: update-indeterminate 1.15s ease-in-out infinite;
  }

  @keyframes update-indeterminate {
    0% { margin-left: -34%; }
    100% { margin-left: 100%; }
  }

  .update-progress-state {
    flex: 0 0 auto;
    font-size: 12px;
    line-height: 1;
    color: #8a8a8e;
    white-space: nowrap;
  }
</style>
