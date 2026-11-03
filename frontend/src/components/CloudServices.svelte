<script lang="ts">
  /**
   * 设置 → 模型与反推 里的「RunningHub 云端生成」。
   *
   * 为什么从独立一页缩成这一张卡（第一版是一整页、三节、外加一张账号表）：
   * 走这条路只要一把 Key。账号名、服务商、代理方式填对了没人会再看第二眼，
   * 把它们摆出来就等于把「填一把 Key 就能用」变成「先理解一套账号模型」。
   * 多账号仍然留在后端与库里（API 支持），UI 只管第一把 Key；代理固定跟随系统
   * ——云端是公网请求，跟随系统是对的，真被本机代理挡住时改库里那个字段就够，
   * 不值得为它占一行设置。
   *
   * API Key 只写不读：后端任何接口都只回 has_api_key 这个布尔。不回显不是靠这个
   * 组件小心，是数据里根本没有。输入框永远从空开始，保存后也不把 key 放进任何
   * 长生命周期状态。
   */
  import { onMount } from "svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import {
    cloudApi, cloneError, coinsLabel, WF_KIND_WORDS,
    type CloudPendingTask, type CloudStatus, type CloudTestResult,
    type MediaKind,
  } from "../lib/clone";

  let status = $state<CloudStatus | null>(null);
  let loading = $state(true);
  let failed = $state(false);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");

  let maxSingle = $state(0);
  let maxDaily = $state(0);
  let enabled = $state(true);
  let testing = $state(false);
  let testResult = $state<CloudTestResult | null>(null);
  let refetching = $state<number | null>(null);

  /**
   * 「这把 Key」指哪一行，照后端标的那一条说（is_shared = 引擎真正会用的那行）。
   * 库里可以多账号，界面只认一把：按下标取第一条，一旦前面排着空账号，
   * 卡片就会说「已配置」、测的是 A、出图用的是 B——这种分叉查起来最费劲。
   */
  const account = $derived<CloudStatus["accounts"][number] | null>(
    (status?.accounts ?? []).find((item) => item.is_shared) ?? (status?.accounts ?? [])[0] ?? null,
  );
  const pending = $derived(status?.pending ?? []);
  const spend = $derived(status?.spend ?? null);
  const presets = $derived(status?.presets ?? []);
  const unverified = $derived(presets.filter((item) => !item.verified));
  /** 三条 API 只报一行：它们真正的家在「一键同款」的切换清单里，这里只需说清挂着哪几条。 */
  const presetLine = $derived(presets.map((item) => `${item.name}（${item.model_label}）`).join(" · "));
  /**
   * 只在真有一把 Key 落在那里时谈「重启还在不在」：还没有 Key 时渲染器压根不知道
   * 这台机器有没有系统级加密，照默认分支说「重启要重填」就是编的。
   */
  const keyPersistence = $derived(!account?.has_api_key
    ? ""
    : account.key_persistence === "encrypted"
      ? "Key 按当前 Windows 用户加密存在本机，重启应用不用重填。"
      : "这台机器上没有系统级加密：Key 只存在本次运行里，重启应用要重填一次。");

  function fillFromStatus(next: CloudStatus) {
    status = next;
    enabled = next.cloud_enabled;
    maxSingle = next.cloud_max_single_coins;
    maxDaily = next.cloud_max_daily_coins;
    loading = false;
  }

  async function reload(quiet = false) {
    if (!quiet) loading = true;
    try {
      fillFromStatus(await cloudApi.status());
      failed = false;
    } catch (e) {
      failed = true;
      loading = false;
      error = cloneError(e);
    }
  }
  onMount(() => {
    void reload();
    // 上面那张卡（服务商选 RunningHub 那一格）改了这把 Key，这里跟着改口，别各说各话。
    const onKeyChange = () => void reload(true);
    window.addEventListener("cloud-credentials-changed", onKeyChange);
    return () => window.removeEventListener("cloud-credentials-changed", onKeyChange);
  });

  /**
   * Key 的输入口在上面那张卡——服务商选 RunningHub 那一格。RunningHub 本来就是一把 Key 走天下，
   * 这里再摆一个输入框等于给同一把 Key 安第二个家，迟早一边新一边旧。
   */
  function gotoKey() {
    window.dispatchEvent(new Event("edit-cloud-key"));
  }

  /** 一串动作统一收在这里：busy 一处管，错误一律说人话，成功话由调用方给。 */
  async function run(fn: () => Promise<void>, okMessage = "") {
    busy = true;
    error = "";
    notice = "";
    try {
      await fn();
      if (okMessage) notice = okMessage;
    } catch (e) {
      error = cloneError(e);
    } finally {
      busy = false;
    }
  }

  /** 这是这张卡唯一会往外发请求的一颗按钮，只有你点它才发。 */
  async function testConnection() {
    const current = account;
    if (!current) {
      error = "先在上面「反推模型」填这把 API Key，才能测连通。";
      return;
    }
    testing = true;
    testResult = null;
    try {
      testResult = await cloudApi.testAccount(current.id);
    } catch (e) {
      testResult = { ok: false, reason_code: "error", message: cloneError(e) };
    } finally {
      testing = false;
    }
  }

  /**
   * 总开关一拨就写回库里。一个布尔不该「点了像没生效，还要再点一次保存」——
   * 花费闸那两头数字要留着一起填，所以它们仍走自己那颗保存按钮。
   */
  function saveEnabled() {
    void run(async () => {
      await cloudApi.saveSettings({ cloud_enabled: enabled });
      await reload(true);
    }, enabled ? "云端生成已启用。" : "云端生成已停用：三条 API 还挂在切换清单里，随时能开回来。");
  }

  function saveLimits() {
    void run(async () => {
      await cloudApi.saveSettings({
        cloud_enabled: enabled,
        cloud_max_single_coins: Number(maxSingle) || 0,
        cloud_max_daily_coins: Number(maxDaily) || 0,
      });
      await reload(true);
    }, "花费上限已保存。");
  }

  function refetchTask(task: CloudPendingTask) {
    refetching = task.id;
    void run(async () => {
      const out = await cloudApi.refetch(task.id);
      await reload(true);
      notice = `取回 ${out.count} 个产物，已经收进图库的 generated 目录。`;
    }, "").finally(() => { refetching = null; });
  }

  function syncShortcuts() {
    void run(async () => {
      await cloudApi.syncTemplates();
      await reload(true);
    }, "三条 API 已恢复到「一键同款」的切换清单里。Key 一个都没动。");
  }

  /** 差哪一步就说哪一步：只报一句「不可用」等于把人赶去自己猜。 */
  const blockers = $derived.by(() => {
    if (!status) return [];
    const out: string[] = [];
    if (!status.cloud_enabled) out.push("云端生成总开关是关的");
    const first = account;
    if (!first) out.push("还没填 RunningHub 的 API Key：在上面「反推模型」把服务商选成 RunningHub，粘 Key 保存");
    else if (!first.has_api_key) out.push("这把 API Key 还没填：在上面「反推模型」里填，或点「去填 Key」");
    else if (!first.enabled) out.push("这个账号被停用了");
    return out;
  });
</script>

<div class="settings-card cloud-card">
  <SettingsRow
    title="RunningHub 云端生成"
    top
    description="一键同款的第二条路：不放本机 ComfyUI，直接调 RunningHub 的收费模型出图、出片、出声音。填一把 Key 就能用，代价是每出一张都花 RH币。"
  >
    {#snippet control()}
      <label class="settings-switch">
        <input type="checkbox" aria-label="启用云端生成" bind:checked={enabled} disabled={busy}
          onchange={() => void saveEnabled()} />
        <span class="switch-track"></span>
      </label>
    {/snippet}
    <div class="cloud-body">
      {#if loading}
        <p class="settings-hint" role="status">正在读取云端设置…</p>
      {:else if failed}
        <p class="settings-hint">读不到云端设置，确认图库后台在跑。<button class="setting-button" onclick={() => void reload()}>重新加载</button></p>
      {:else}
        <p class="cloud-state" class:cloud-ready={status?.availability?.available} role="status">
          {#if status?.availability?.available}
            云端可用：{status.availability.reason || "三条 API 都能跑"}。
          {:else}
            <!-- 这里不照抄 availability.reason：那句是给「一键同款」弹窗写的，里面带
                 「去设置 → 模型与反推里打开」，而这张卡就在那一页里，开关还在它头顶二十像素处。
                 本页只说自己在屏幕上看得见的原因；后端那句留作兜底。 -->
            现在还不能生成：{blockers.join("；") || status?.availability?.reason || "还说不准差哪一步"}
          {/if}
        </p>
        {#if blockers.length > 1 && !status?.availability?.available}
          <ul class="cloud-blockers">
            {#each blockers as line (line)}<li>{line}</li>{/each}
          </ul>
        {/if}

        <p class="cloud-key" class:cloud-key-set={account?.has_api_key} role="status">
          API Key：{account?.has_api_key ? "已配置" : "还没填"}
          <span class="settings-hint">与上面的「反推模型」共用同一把，只存一份。</span>
          <button class="setting-button setting-button-ghost" disabled={busy} onclick={gotoKey}>
            {account?.has_api_key ? "改 Key" : "去填 Key"}
          </button>
        </p>
        <div class="cloud-inline">
          <button class="setting-button" disabled={busy || testing || !account?.has_api_key} onclick={() => void testConnection()}>
            {testing ? "测中…" : "测一下连通与余额"}
          </button>
          {#if testResult}
            <span class="cloud-test" class:cloud-ok={testResult.ok} class:cloud-bad={!testResult.ok} role="status">
              {testResult.message}
            </span>
          {/if}
        </div>
        <p class="settings-hint">这把 Key 从不被读回来显示：任何接口都只回「有没有配过」，所以复制不走它。</p>

        <details class="cloud-more">
          <summary>花费上限、三条 API 与记账</summary>
          <div class="cloud-limits">
            <label class="cloud-field">单次上限（RH币，0 = 不限）
              <input aria-label="单次花费上限" type="number" min="0" max="1000000" step="1" bind:value={maxSingle} disabled={busy} />
            </label>
            <label class="cloud-field">当日上限（RH币，0 = 不限）
              <input aria-label="当日花费上限" type="number" min="0" max="1000000" step="1" bind:value={maxDaily} disabled={busy} />
            </label>
            <button class="setting-button cloud-limits-save" disabled={busy} onclick={saveLimits}>保存花费上限</button>
          </div>
          <p class="settings-hint">
            上限是闸，不是预算：超过就拦在提交之前，钱不会花出去。花费按余额差值记账 ·
            今天已花 {coinsLabel(spend?.today_coins)} · {spend?.month ?? "本月"} 共 {coinsLabel(spend?.month_coins)}
          </p>

          <p class="settings-hint">
            三条 API 挂在「一键同款」的切换清单里：{presetLine || "一条都没装，点下面恢复"}。
            <button class="setting-button" disabled={busy} onclick={syncShortcuts}>恢复这三条</button>
          </p>
          {#if keyPersistence}<p class="settings-hint">{keyPersistence}</p>{/if}
          {#if unverified.length}
            <details class="cloud-notes">
              <summary>{presets.length} 条里有 {unverified.length} 条端点还没在真账号上实测过</summary>
              <ul>
                {#each unverified as item (item.key)}
                  <li>{item.name}：{item.notes?.join("；") || "字段未实测"}</li>
                {/each}
              </ul>
            </details>
          {/if}
        </details>

        {#if pending.length}
          <p class="cloud-section">待取回的产物</p>
          <ul class="cloud-pending">
            {#each pending as task (task.id)}
              <li>
                <span class="cloud-pending-main">{WF_KIND_WORDS[task.capability as MediaKind] ?? task.capability} · {task.state_label || task.state}</span>
                <span class="settings-hint">{task.error || "云端还在跑，或者产物链接过期了"}</span>
                <button class="setting-button" disabled={busy || refetching === task.id} onclick={() => refetchTask(task)}>
                  {refetching === task.id ? "取回中…" : "取回结果"}
                </button>
              </li>
            {/each}
          </ul>
          <p class="settings-hint">钱已经花出去、产物挂在会过期的链接上的那些任务。取回只重新查一次任务，不重新生成、不二次扣费。</p>
        {/if}

        {#if error}<p class="cloud-error" role="status">{error}</p>{/if}
        {#if notice}<p class="cloud-notice" role="status">{notice}</p>{/if}
      {/if}
    </div>
  </SettingsRow>
</div>

<style>
  .cloud-body { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }
  .cloud-state { margin: 0; font-size: 12.5px; color: #a1a1aa; }
  .cloud-ready { color: #4ade80; }
  .cloud-blockers { margin: 0; padding-left: 18px; font-size: 12.5px; color: #fbbf24; display: grid; gap: 2px; }
  .cloud-section {
    margin: 8px 0 0; padding-top: 10px; font-size: 12px; font-weight: 600; color: #e4e4e7;
    border-top: 1px solid rgb(255 255 255 / 7%);
  }
  .cloud-field { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: #a1a1aa; }
  .cloud-field input { width: 100%; max-width: 420px; }
  .cloud-inline { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .cloud-key { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 0; font-size: 12.5px; color: #fbbf24; }
  .cloud-key-set { color: #4ade80; }
  .cloud-more { display: grid; gap: 10px; font-size: 12.5px; color: #a1a1aa; }
  .cloud-more > summary { cursor: pointer; color: #d4d4d8; }
  .cloud-test { font-size: 12.5px; }
  .cloud-ok { color: #4ade80; }
  .cloud-bad { color: #f87171; }
  .cloud-pending { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; }
  .cloud-pending li {
    display: grid; gap: 2px; padding: 8px 10px; font-size: 12.5px; color: #d4d4d8;
    background: rgb(255 255 255 / 3%); border-radius: 10px;
  }
  .cloud-pending li { grid-template-columns: auto 1fr auto; align-items: center; gap: 10px; }
  .cloud-notes { font-size: 12px; color: #a1a1aa; }
  .cloud-notes ul { margin: 4px 0 0; padding-left: 16px; display: grid; gap: 2px; }
  .cloud-limits { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; }
  .cloud-limits .cloud-field { flex: 1 1 150px; max-width: 200px; }
  .cloud-limits-save { flex: none; }
  .cloud-pending-main { font-weight: 600; color: #fafafa; }
  .cloud-error { margin: 0; font-size: 12.5px; color: #f87171; }
  .cloud-notice { margin: 0; font-size: 12.5px; color: #4ade80; }
</style>
