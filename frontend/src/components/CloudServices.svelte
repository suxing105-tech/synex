<script lang="ts">
  /**
   * 设置 → 云端生成：把「一键同款」的第二条执行通道接上（RunningHub 的收费模型 API）。
   *
   * 为什么是一张卡三节而不是三张卡：三族共用同一个账号、同一把 Key、同一个代理，
   * 拆成三张卡就要填三遍同样的东西，还会让人以为可以三族各用一家服务商。
   *
   * API Key 在这里只写不读：后端任何接口都只回 has_api_key 这个布尔，
   * 所以「不回显」不是靠这个组件小心，是靠数据根本没有。输入框永远从空开始，
   * 保存后也只说「已保存」，不把 key 放回任何状态里。
   */
  import { onMount } from "svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import {
    cloudApi, cloneError, coinsLabel,
    type CloudAccount, type CloudPendingTask, type CloudPresetItem, type CloudStatus, type CloudTestResult,
  } from "../lib/clone";
  import { WF_KIND_WORDS, type MediaKind } from "../lib/clone";

  let status = $state<CloudStatus | null>(null);
  let loading = $state(true);
  let failed = $state(false);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");

  // Key 只在这一个局部状态里待着，保存成功后立刻清空——不进 status，不进任何长生命周期状态。
  let keyInput = $state("");
  let revealKey = $state(false);
  let nameInput = $state("");
  let proxyMode = $state("system");
  let maxSingle = $state(0);
  let maxDaily = $state(0);
  let enabled = $state(true);
  let testing = $state(false);
  let testResult = $state<CloudTestResult | null>(null);
  let refetching = $state<number | null>(null);

  const account = $derived<CloudAccount | null>((status?.accounts ?? [])[0] ?? null);
  const presets = $derived(status?.presets ?? []);
  const pending = $derived(status?.pending ?? []);
  const spend = $derived(status?.spend ?? null);
  /**
   * 只在真有一把 Key 落在那里时谈「重启还在不在」：还没有账号时渲染器压根不知道
   * 这台机器有没有系统级加密，照默认分支说「重启要重填」就是编的。
   */
  const keyPersistence = $derived(!account?.has_api_key
    ? ""
    : account.key_persistence === "encrypted"
      ? "Key 按当前 Windows 用户加密存在库里，重启不用重填。"
      : "这台机器上没有系统级加密：Key 只存在本次运行里，重启应用要重填一次。");

  function fillFromStatus(next: CloudStatus) {
    status = next;
    enabled = next.cloud_enabled;
    maxSingle = next.cloud_max_single_coins;
    maxDaily = next.cloud_max_daily_coins;
    const first = (next.accounts ?? [])[0];
    if (first) {
      nameInput = first.name;
      proxyMode = first.proxy_mode;
    }
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
  onMount(() => { void reload(); });

  /** 一串动作统一收在这里： busy 一处管，错误一律说人话，成功话由调用方给。 */
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

  /** 存账号。有就 PATCH、没有就 POST；Key 为空串时不发这个字段（发了就是清掉）。 */
  async function saveAccount() {
    await run(async () => {
      const patch: { name?: string; api_key?: string; proxy_mode?: string; enabled?: boolean } = {
        name: nameInput.trim() || "RunningHub",
        proxy_mode: proxyMode,
      };
      if (keyInput.trim()) patch.api_key = keyInput.trim();
      const current = (status?.accounts ?? [])[0];
      const saved = await cloudApi.saveAccount(patch, current?.id ?? null);
      keyInput = "";
      revealKey = false;
      testResult = null;
      await reload(true);
      notice = current ? "云端账号已更新。" : `已添加 ${saved.provider_label} 账号。填好 Key 记得点「测试连通」。`;
    });
  }

  async function clearKey() {
    const current = (status?.accounts ?? [])[0];
    if (!current) return;
    await run(async () => {
      await cloudApi.saveAccount({ api_key: "" }, current.id);
      keyInput = "";
      testResult = null;
      await reload(true);
      notice = "已清掉这把 API Key。三条 API 快捷方式还在，填回来就能继续用。";
    }, "");
  }

  async function testConnection() {
    const current = (status?.accounts ?? [])[0];
    if (!current) {
      error = "先保存账号，才能测连通。";
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
   * 花费闸那两头数字要留着批量填，所以它们仍然走「保存云端设置」。
   */
  function saveEnabled() {
    void run(async () => {
      await cloudApi.saveSettings({ cloud_enabled: enabled });
      await reload(true);
    }, enabled ? "云端生成已启用。" : "云端生成已停用：三条 API 快捷方式还在，随时能开回来。");
  }

  function saveLimits() {
    void run(async () => {
      await cloudApi.saveSettings({
        cloud_enabled: enabled,
        cloud_max_single_coins: Number(maxSingle) || 0,
        cloud_max_daily_coins: Number(maxDaily) || 0,
      });
      await reload(true);
    }, "云端开关与花费上限已保存。");
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
    }, "三条 API 快捷方式已恢复。账号与 Key 一个都没动。");
  }

  /** 这一族配了没有：设置页要说「差哪一步」，不能只报一句笼统的「不可用」。 */
  const blockers = $derived.by(() => {
    if (!status) return [];
    const out: string[] = [];
    if (!status.cloud_enabled) out.push("云端生成总开关是关的");
    const first = (status.accounts ?? [])[0];
    if (!first) out.push("还没有添加云端账号");
    else if (!first.has_api_key) out.push("这个账号还没填 API Key");
    else if (!first.enabled) out.push("这个账号被停用了");
    return out;
  });
</script>

<div class="settings-card cloud-card">
  <SettingsRow
    title="云端生成"
    top
    description="一键同款的第二条通道：不放本机 ComfyUI，直接调 RunningHub 的收费模型 API。画质与模型由平台维护，代价是每出一张都花 RH币。"
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
            现在还不能生成：{status?.availability?.reason || blockers.join("；")}
          {/if}
        </p>
        {#if blockers.length && !status?.availability?.available}
          <ul class="cloud-blockers">
            {#each blockers as line (line)}<li>{line}</li>{/each}
          </ul>
        {/if}

        <!-- ── 第一节：账号与 Key ── -->
        <p class="cloud-section">账号与 API Key</p>
        <label class="cloud-field">服务商
          <input aria-label="服务商" value={status?.accounts?.[0]?.provider_label || "RunningHub"} disabled />
        </label>
        <label class="cloud-field">账号名称
          <input aria-label="云端账号名称" bind:value={nameInput} placeholder="RunningHub" maxlength="40" />
        </label>
        <label class="cloud-field">API Key {account?.has_api_key ? "（已配置；留空表示不改）" : "（在 RunningHub 控制台生成）"}
          <input
            aria-label="云端 API Key"
            type={revealKey ? "text" : "password"}
            autocomplete="new-password"
            bind:value={keyInput}
            disabled={busy}
          />
        </label>
        <div class="cloud-inline">
          <label class="cloud-check"><input type="checkbox" aria-label="显示 API Key" bind:checked={revealKey} />显示出来核对一眼</label>
          <!-- 已经有账号了就不该逼 person 重贴一次 Key 才能改名字或代理：
               Key 留空 = 不动它，这条 saveAccount 里本来就是这么发的。 -->
          <button class="setting-button"
            disabled={busy || (!account && !keyInput.trim())} onclick={() => void saveAccount()}>
            {account && keyInput.trim() ? "保存账号与 Key" : "保存账号"}
          </button>
          {#if account?.has_api_key}
            <button class="setting-button" disabled={busy} onclick={() => void clearKey()}>清掉这把 Key</button>
          {/if}
        </div>
        <p class="settings-hint">{keyPersistence}</p>
        <label class="cloud-field">代理方式
          <!-- 不用 bind:value：happy-dom 里 querySelector(":checked") 认不出选中的 option，
               测试驱动不了这颗下拉；改成 value + onchange，跟同款页/提示词面板一个写法 -->
          <select aria-label="云端请求代理方式" value={proxyMode} disabled={busy}
            onchange={(e) => proxyMode = (e.currentTarget as HTMLSelectElement).value}>
            <option value="system">跟随系统代理</option>
            <option value="direct">直连（不走系统代理）</option>
          </select>
        </label>
        <p class="settings-hint">云端是公网请求，跟随系统代理是对的；只有你确定本机代理会挡这类请求时才选直连。</p>
        <div class="cloud-inline">
          <button class="setting-button" disabled={busy || testing || !account} onclick={() => void testConnection()}>
            {testing ? "测试中…" : "测试连通与余额"}
          </button>
          {#if testResult}
            <span class="cloud-test" class:cloud-ok={testResult.ok} class:cloud-bad={!testResult.ok} role="status">
              {testResult.message}
            </span>
          {/if}
        </div>

        <!-- ── 第二节：三条模型 ── -->
        <p class="cloud-section">三条 API</p>
        <ul class="cloud-models">
          {#each presets as item (item.key)}
              <li>
              <span class="cloud-model-kind cloud-model-kind-{item.capability}">{WF_KIND_WORDS[item.capability as MediaKind] ?? item.capability_word}</span>
              <span class="cloud-model-name">{item.name}</span>
              <span class="cloud-model-label">{item.model_label}</span>
              {#if !item.verified}<span class="cloud-tag">待实测</span>{/if}
              <p class="settings-hint">{item.blurb}</p>
              {#if item.notes?.length}
                <details class="cloud-notes">
                  <summary>还没核实的地方（{item.notes.length} 条）</summary>
                  <ul>{#each item.notes as note (note)}<li>{note}</li>{/each}</ul>
                </details>
              {/if}
            </li>
          {/each}
        </ul>
        <div class="cloud-inline">
          <button class="setting-button" disabled={busy} onclick={syncShortcuts}>恢复这三条快捷方式</button>
          <span class="settings-hint">删掉了想再要回来。账号与 Key 不动。</span>
        </div>

        <!-- ── 第三节：花钱的闸与流水 ── -->
        <p class="cloud-section">花费上限与流水</p>
        <div class="cloud-limits">
          <label class="cloud-field">单次上限（RH币，0 = 不限）
            <input aria-label="单次花费上限" type="number" min="0" max="1000000" step="1" bind:value={maxSingle} disabled={busy} />
          </label>
          <label class="cloud-field">当日上限（RH币，0 = 不限）
            <input aria-label="当日花费上限" type="number" min="0" max="1000000" step="1" bind:value={maxDaily} disabled={busy} />
          </label>
        </div>
        <div class="cloud-inline">
          <button class="setting-button bg-accent text-bg" disabled={busy} onclick={saveLimits}>保存云端设置</button>
          <span class="settings-hint">
            今天已花 {coinsLabel(spend?.today_coins)} · {spend?.month ?? "本月"} 共 {coinsLabel(spend?.month_coins)}
          </span>
        </div>
        <p class="settings-hint">上限是闸，不是预算：超过就拦在提交之前，钱不会花出去。花费按余额差值记账，没实测出差值的条目算 0——宁可少报，不编数。</p>

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
  .cloud-field input, .cloud-field select { width: 100%; max-width: 420px; }
  .cloud-inline { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .cloud-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: #a1a1aa; }
  .cloud-test { font-size: 12.5px; }
  .cloud-ok { color: #4ade80; }
  .cloud-bad { color: #f87171; }
  .cloud-models, .cloud-pending { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; }
  .cloud-models li, .cloud-pending li {
    display: grid; gap: 2px; padding: 8px 10px; font-size: 12.5px; color: #d4d4d8;
    background: rgb(255 255 255 / 3%); border-radius: 10px;
  }
  .cloud-pending li { grid-template-columns: auto 1fr auto; align-items: center; gap: 10px; }
  .cloud-model-kind {
    justify-self: start; padding: 1px 8px; font-size: 10.5px; color: #93c5fd;
    background: rgb(59 130 246 / 14%); border-radius: 999px;
  }
  .cloud-model-kind-video { color: #fbbf24; background: rgb(245 158 11 / 16%); }
  .cloud-model-kind-audio { color: #c4b5fd; background: rgb(139 92 246 / 16%); }
  .cloud-model-name { font-weight: 600; color: #fafafa; }
  .cloud-model-label { color: #a1a1aa; }
  .cloud-tag {
    justify-self: start; padding: 1px 7px; font-size: 10.5px; color: #fbbf24;
    background: rgb(251 191 36 / 14%); border-radius: 999px;
  }
  .cloud-notes { font-size: 12px; color: #a1a1aa; }
  .cloud-notes ul { margin: 4px 0 0; padding-left: 16px; display: grid; gap: 2px; }
  .cloud-limits { display: flex; flex-wrap: wrap; gap: 12px; }
  .cloud-limits .cloud-field { flex: 1 1 180px; max-width: 220px; }
  .cloud-pending-main { font-weight: 600; color: #fafafa; }
  .cloud-error { margin: 0; font-size: 12.5px; color: #f87171; }
  .cloud-notice { margin: 0; font-size: 12.5px; color: #4ade80; }
</style>