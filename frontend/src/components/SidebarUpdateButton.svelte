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
  // 有新版本就高亮：这一颗平时跟设置按钮同色（text-muted），有更新时它是侧栏里唯一发亮的东西。
  const highlighted = $derived(visible);
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
      class:is-active={highlighted}
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
  <!-- 下载与安装期间整屏糊掉、弹窗居中：和「一键同款」同一套背景虚化，侧栏也在糊掉的那一层里。
       这段过程没有可撤销的动作（装完就重启），所以底不做出声、也不给关闭按钮。 -->
  <div class="update-scrim">
    <div class="update-modal" role="status" aria-live="polite">
      <p class="update-card-kicker">闪寻空间 · 软件更新</p>
      <h4 class="update-card-title">{cardTitle}</h4>
      <p class="update-card-note">正在更新到 v{status?.version ?? ""}。安装完成后，闪寻空间 将重新启动。</p>
      <div class="update-card-row">
        <div class="update-progress-track" role="progressbar" aria-label={cardTitle}
          aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent ?? undefined}>
          <div class="update-progress-fill" class:indeterminate={percent === null}
            style:width={percent === null ? undefined : `${percent}%`}></div>
        </div>
        <span class="update-progress-state">{cardState}</span>
      </div>
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

  /* 有新版本 / 正在装：图标染成品牌色并铺一层底色，侧栏里一眼看到它。
     两条类的选择器比工具类 .text-muted 重，颜色压得住。 */
  .sidebar-update.is-active {
    color: #f24e4e;
    background: rgb(242 78 78 / 14%);
    box-shadow: inset 0 0 0 1px rgb(242 78 78 / 28%);
  }

  .sidebar-update.is-active:hover {
    color: #ff6a4d;
    background: rgb(242 78 78 / 20%);
  }

  /* 下载/安装中的弹窗：居中，背后整屏虚化（与一键同款 .cm-backdrop 同一套 blur）。
     遮罩 inset:0 且盖住侧栏——这段时间用户要看的只有这一件事。 */
  .update-scrim {
    position: fixed;
    inset: 0;
    z-index: 95;
    padding: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
    -webkit-backdrop-filter: blur(22px) saturate(112%);
    backdrop-filter: blur(22px) saturate(112%);
  }

  .update-modal {
    width: min(420px, 100%);
    padding: 20px 22px 22px;
    border-radius: 20px;
    border: 1px solid rgb(255 255 255 / 8%);
    background: rgba(19, 19, 22, 0.88);
    -webkit-backdrop-filter: blur(36px);
    backdrop-filter: blur(36px);
    box-shadow: 0 32px 90px rgba(0, 0, 0, 0.62);
  }

  .update-card-kicker {
    margin: 0 0 6px;
    font-size: 11.5px;
    letter-spacing: .02em;
    color: #7f7f87;
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
