<script lang="ts">
  import { onMount } from "svelte";
  import { modelConfigs, reverseSettings, refreshReverseConfig, refreshProviderPresets, providerPresets, reverseApi, errorMessage } from "../lib/reverse-prompts";
  import type { ModelConfig, ModelDraft, ProviderPreset } from "../lib/reverse-prompts";
  import { cloudApi } from "../lib/clone";
  const CUSTOM = "custom";
  const blank = (): ModelDraft => ({ name: "", base_url: "", model: "", timeout: 120, provider: CUSTOM });
  let draft = $state<ModelDraft>(blank());
  let editingId = $state<number | undefined>();
  let keyInput = $state("");
  let hasKey = $state(false);
  // 挂载即在读：初始就置忙，卡片与按钮在服务商清单读回来之前一律按不住，测试也有一个「读完了」的判据。
  let busy = $state(true);
  let error = $state("");
  let notice = $state("");
  let confirmDelete = $state(false);
  const providers = $derived($providerPresets);
  const isPreset = $derived(!!draft.provider && draft.provider !== CUSTOM);
  const preset = $derived($providerPresets.find(p => p.id === draft.provider));
  /** RunningHub 这类服务商不一样：Key 的家在云端账号表（gen_accounts）那一行里，这条配置不另存一份。 */
  const sharedKey = $derived(preset?.credential_scope === "cloud");
  /** 新建那条配置自己还不知道 Key 在不在，这时照服务商清单带回的布尔说。 */
  const keyReady = $derived(sharedKey ? (hasKey || !!preset?.shared_has_key) : hasKey);
  const cloudPreset = $derived($providerPresets.find(p => p.credential_scope === "cloud"));
  /**
   * 服务商选择页。三件事：
   * - 按能力过滤：没接的路数后端不报，这里就不会画出一张点进去没用的卡；
   * - 只显示内置厂商：把「自定义」收起来，新手不必面对一屏看不懂的入口；
   * - 点卡片 = 选这家：已有配置就改那一条，没有才开空表单，别攒出第二份。
   */
  const CAPABILITIES = [
    { id: "all", label: "全部" }, { id: "text", label: "文本" }, { id: "image", label: "图像" },
    { id: "video", label: "视频" }, { id: "audio", label: "音频" },
  ];
  let capability = $state("all");
  let onlyBuiltin = $state(false);
  const visiblePresets = $derived(
    providers.filter(p => capability === "all" || (p.capabilities ?? ["text"]).includes(capability)),
  );
  /** 第二把 Key（工作流·消费级）只有那一家有；界面同样只认「有没有」。 */
  const workflowCapable = $derived(!!preset?.workflow_key);
  const workflowReady = $derived(!!preset?.shared_has_workflow_key);
  /** 参考页那个「已配置 1/2」角标：M = 这家有几把 Key，N = 已经填了几把。 */
  const keySlots = $derived(workflowCapable ? 2 : 1);
  const keyCount = $derived((keyReady ? 1 : 0) + (workflowReady ? 1 : 0));
  const keyCountLabel = $derived(keyCount ? `已配置 ${keyCount}/${keySlots}` : "还没配置");
  /**
   * 标题行右边那颗「测试连接」测的是云端那把 Key（顺带把余额带回来），所以走云端接口。
   * 只有点它才发请求：拿真 Key 打服务商不是「打开设置」该替你做的事。
   */
  let testingCloud = $state(false);
  let cloudTestText = $state("");
  async function testCloudKey() {
    testingCloud = true;
    cloudTestText = "";
    try {
      const status = await cloudApi.status();
      const row = (status.accounts ?? []).find((item) => item.is_shared) ?? (status.accounts ?? [])[0];
      if (!row) cloudTestText = "还没有可测的云端账号：先把 Key 粘在下面那一格并保存。";
      else {
        const out = await cloudApi.testAccount(row.id);
        cloudTestText = out.message || (out.ok ? "连通正常。" : "连不上，检查这把 Key。");
      }
    } catch (e) {
      cloudTestText = errorMessage(e);
    } finally {
      testingCloud = false;
    }
  }
  /**
   * 「设为默认服务商」在我们这儿就是「图片反推默认走这一家」，点了直接存住。
   * 默认值住在偏好里（隔壁「反推指令」那页的 select 也读它），所以这里不再抄一份
   * 本地副本：抄了就有人会拿着旧值把对方刚存的选择盖回去。
   */
  const canSetDefault = $derived(!!editingId && !!$reverseSettings);
  const isDefaultModel = $derived(!!editingId && $reverseSettings?.default_model_id === editingId);
  async function setDefaultModel() {
    const current = $reverseSettings, id = editingId;
    if (!current || !id) return;
    await run(async () => {
      await reverseApi.saveSettings({ ...current, default_model_id: id });
      await refreshReverseConfig();
      notice = "已把这一家设为图片反推的默认服务商。";
    });
  }
  let workflowKeyInput = $state("");
  const configsFor = (id: string) => $modelConfigs.filter(c => c.provider === id);
  const presetReady = (item: ProviderPreset) => item.credential_scope === "cloud"
    ? !!(item.shared_has_key || item.shared_has_workflow_key || configsFor(item.id).some(c => c.has_api_key))
    : configsFor(item.id).some(c => c.has_api_key);
  const avatar = (name: string) => (name.trim().slice(0, 2) || "?").toUpperCase();
  function selectProvider(id: string) {
    const existing = configsFor(id)[0];
    workflowKeyInput = "";
    if (existing) {
      choose(existing);
    } else {
      choose();
      applyProvider(id);
    }
  }
  const endpoint = $derived((draft.base_url || "").trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "") + "/chat/completions");
  // 存 Key 的门槛只剩「这家是谁、地址在哪」：模型不再是必填项，所以这里不看它。
  const canSave = $derived(isPreset ? true : !!(draft.name?.trim() && draft.base_url?.trim()));
  // 两份偏好在两张卡片里各自渲染，所以任一半读失败都单独标记，卡片给「重新加载」而不是卡在「正在读取…」。
  async function loadReversePart() {
    await refreshProviderPresets();
    await refreshReverseConfig();
    if (!editingId && draft.provider === CUSTOM && $providerPresets.length) {
      // 落点落在已经配好 Key 的那一家，而不是清单里排第一的 OpenAI：默认摊开一张没配的表单，
      // 等于每次进来都要重新找自己那家。
      const ready = $providerPresets.find((item) => presetReady(item));
      const existing = ready ? configsFor(ready.id)[0] : undefined;
      if (existing) choose(existing);
      else applyProvider((ready ?? $providerPresets[0]).id);
    }
  }
  function loadAll() {
    return loadReversePart();
  }
  /**
   * 「检查 API Key」问的是这家自己的模型清单：地址对、Key 对、它真在服务——一次模型调用都不产生。
   * 它顶掉了原来的「测试图片识别」：那颗按钮没有模型就按不了，可这一页现在只管 Key。
   */
  async function checkKey() {
    await run(async () => {
      const out = await reverseApi.checkKey({ ...payload(), config_id: editingId });
      notice = out.count
        ? `这把 Key 能用：读到 ${out.count} 个模型。去反推面板那两列里挑一个就行。`
        : "这把 Key 连上了，但那家没报回模型清单——在反推面板里直接输入模型 ID 也能用。";
    });
  }
  // 落点自己挑（已经配好 Key 的那一家）：再次创作那屏不再有跳过来的那颗按钮，
  // 所以这里不认「来意」，只管把配置读回来。
  onMount(() => void run(loadAll));
  async function run(action: () => Promise<void>) {
    busy = true; error = ""; notice = "";
    try { await action(); } catch (e) { error = errorMessage(e); } finally { busy = false; }
  }
  /** 选中一家＝填它自己的地址与超时，名字就用服务商的名字。
      模型不在这一页挑（那是反推面板那两列的事），所以新配置带着一个空模型进库。 */
  function applyProvider(id: string) {
    draft.provider = id;
    if (id !== CUSTOM) {
      const p = $providerPresets.find(x => x.id === id);
      draft.model = "";
      draft.base_url = p?.base_url ?? "";
      draft.timeout = p?.default_timeout ?? 120;
      draft.name = p?.name ?? "";
    } else {
      draft.model = ""; draft.base_url = ""; draft.name = ""; draft.timeout = 120;
    }
    keyInput = ""; hasKey = false;
  }
  function choose(config?: ModelConfig) {
    editingId = config?.id;
    draft = config ? { name: config.name, base_url: config.base_url, model: config.model, timeout: config.timeout, provider: config.provider ?? CUSTOM } : blank();
    keyInput = ""; hasKey = !!config?.has_api_key;
    workflowKeyInput = "";
    error = ""; notice = ""; confirmDelete = false;
  }
  function payload(): ModelDraft {
    // 没挑过模型就不带这个键：带一个空串过去 PATCH，会把面板里刚挑好的那个模型抹掉。
    const { model, ...rest } = draft;
    return {
      ...rest,
      provider: draft.provider ?? CUSTOM,
      ...(model ? { model } : {}),
      // 留空＝这把不换。清除不走这里，走 clearKeyNow() 那两条即时接口：
      // 这一格永远是空的（Key 存在库里，界面从不读回来），把留空当删除，改一次模型名就会把 Key 清掉。
      ...(keyInput ? { api_key: keyInput } : {}),
      ...(workflowKeyInput.trim() ? { workflow_api_key: workflowKeyInput.trim() } : {}),
    };
  }
  /**
   * 「清除」是即时的，不挂在「保存模型」上。三条理由：
   * - 这一格永远是空的（Key 存在库里，界面从不读回来），「把框清空」根本不是一个动作；
   *   真把留空当成删除，改一次模型名就会把 Key 清掉。
   * - 复选框那一行只在删除这一刻有用，其余时间白占一行，而且还得再点一次「保存」才真删。
   * - 清完角标立刻从「已配置 N/M」掉下去，所见即所得。
   * 走哪条接口看这把 Key 的家：共用那把在云端那一行账号，其余在配置自己身上。
   */
  async function clearKeyNow(kind: "model" | "workflow") {
    const shared = sharedKey, provider = preset, configId = editingId;
    await run(async () => {
      if (shared) {
        if (!provider) return;
        await reverseApi.clearProviderKey(provider.id, kind);
      } else {
        if (!configId) return;
        await reverseApi.clearModelKey(configId);
      }
      if (kind === "model") hasKey = false;
      await refreshReverseConfig();
      await refreshProviderPresets();
      notice = kind === "workflow"
        ? "工作流那把 Key 已清除，模型那一把没动。"
        : shared
          ? "这把 Key 已清除：图片反推与再次创作同时停用。想恢复就粘一把新的再保存。"
          : "这条配置的 Key 已清除。";
    });
  }
  async function saveModel() {
    await run(async () => {
      const saved = await reverseApi.saveModel(payload(), editingId);
      choose(saved); await refreshReverseConfig(); await refreshProviderPresets();
      notice = "模型配置已保存";
    });
  }
  async function remove() {
    if (!editingId) return;
    await run(async () => {
      await reverseApi.deleteModel(editingId!); choose(); await refreshReverseConfig();
      notice = "模型配置已删除，历史记录已保留";
    });
  }
</script>
<section class="fill-interactions model-settings" aria-label="模型API配置">
  <div class="settings-card">
    <div class="settings-model-body">
      {#if $modelConfigs.length}
        <!-- 只有库里真有多份配置时才摆这一排：新建的入口是下面的厂商卡片，
             再留一颗「＋ 添加模型」等于给「自定义（手动填写）」那张卡安第二个入口。 -->
        <div class="model-chips">
          {#each $modelConfigs as model}
            <button class="setting-button" aria-pressed={editingId === model.id} disabled={busy} onclick={() => choose(model)}>{model.name}</button>
          {/each}
        </div>
      {/if}
      <fieldset disabled={busy} class="space-y-3">
        <!-- legend 只留给读屏；界面上的标题行是下面这一行（照苏醒贴的那张参考页）。 -->
        <legend class="api-legend">当前服务商：{preset ? preset.name : "自定义（手动填写）"}</legend>
        <div class="api-provider-head">
          <span class="api-avatar" aria-hidden="true">{preset ? avatar(preset.name) : "＋"}</span>
          <span class="api-provider-name">{preset ? preset.name : "自定义（手动填写）"}</span>
          <span class="api-provider-badge" class:api-provider-set={keyCount > 0} role="status">{keyCountLabel}</span>
          <span class="api-provider-actions">
            {#if sharedKey}
              <button class="setting-button setting-button-ghost" disabled={busy || testingCloud}
                onclick={() => void testCloudKey()}>{testingCloud ? "测试中…" : "测试连接"}</button>
            {/if}
            {#if canSetDefault}
              <button class="setting-button setting-button-ghost" disabled={busy || isDefaultModel}
                onclick={() => void setDefaultModel()}>{isDefaultModel ? "已是默认服务商" : "设为默认服务商"}</button>
            {/if}
            {#if preset?.console_url}
              <a class="setting-button setting-button-ghost api-console" href={preset.console_url}
                target="_blank" rel="noreferrer">获取 API Key ↗</a>
            {/if}
          </span>
        </div>
        {#if sharedKey}
          <details class="api-help">
            <summary>新手使用教程：这两把 Key 各管什么</summary>
            <ul>
              <li>模型 API 密钥（企业级-共享）：图片反推与出图、出片、出声音都走它，花的是钱包余额。</li>
              <li>工作流 API 密钥（消费级-会员）：跑云端工作流用它，花的是账户积分（RH币）。这条链路还没接上，先存住就行。</li>
              <li>两把都在控制台各自生成，分别粘在下面对应的格子里；保存后不回显，改一把不动另一把。</li>
              <li>格子里留空＝这把不换。要删掉哪一把，点它右边那颗「清除」，当场生效，不用再点保存。</li>
            </ul>
          </details>
        {/if}
        {#if cloudTestText}<p class="settings-hint" role="status">{cloudTestText}</p>{/if}
        <div class="api-filter">
          <div class="api-tabs" role="group" aria-label="按能力筛选服务商">
            {#each CAPABILITIES as tab (tab.id)}
              <button class="setting-button" aria-pressed={capability === tab.id} disabled={busy}
                onclick={() => (capability = tab.id)}>{tab.label}</button>
            {/each}
          </div>
          <label class="api-filter-builtin"><input type="checkbox" aria-label="只显示内置厂商" bind:checked={onlyBuiltin} />只显示内置厂商</label>
        </div>
        <!-- 一厂商一卡：点谁就只填谁。下拉里挑一家再往下找 Key，是把一件事拆成两个地方。 -->
        <div class="api-grid">
          {#each visiblePresets as item (item.id)}
            <button class="api-card" data-provider={item.id} aria-pressed={draft.provider === item.id}
              disabled={busy} onclick={() => selectProvider(item.id)}>
              <span class="api-avatar" aria-hidden="true">{avatar(item.name)}</span>
              <span class="api-card-body">
                <span class="api-card-name">{item.name}</span>
                <span class="api-card-state" class:api-card-set={presetReady(item)}>{presetReady(item) ? "已配置" : "未配置"}</span>
              </span>
            </button>
          {/each}
          <!-- 这张卡在每个能力 tab 下都要在。之前只在「全部」里露面的结果是：
               切到「文本」它直接消失，看起来像功能被删了。它也不替自己吹牛——
               状态那行只说「自己的 Base URL」，能不能出图由填进去的地址负责。 -->
          {#if !onlyBuiltin}
            <button class="api-card" data-provider="custom" aria-pressed={draft.provider === CUSTOM}
              disabled={busy} onclick={() => selectProvider(CUSTOM)}>
              <span class="api-avatar" aria-hidden="true">＋</span>
              <span class="api-card-body">
                <span class="api-card-name">自定义（手动填写）</span>
                <span class="api-card-state">自己的 Base URL</span>
              </span>
            </button>
          {/if}
        </div>
        {#if !visiblePresets.length}
          <p class="settings-hint" role="status">这一类目前没有接进来的服务商，切回「全部」看其余几家。</p>
        {/if}
        {#if !isPreset}
          <label>配置名称<input aria-label="配置名称" bind:value={draft.name} placeholder="例如：常用视觉模型" /></label>
          <label>Base URL<input aria-label="Base URL" bind:value={draft.base_url} placeholder="https://服务地址/v1" /></label>
          <p class="settings-hint break-all">请求地址：{draft.base_url ? endpoint : "填写 Base URL 后显示"}</p>
        {:else if preset?.note}
          <p class="settings-hint">{preset.note}</p>
        {/if}
        <!-- 这一页不再摆「识别模型」那一格：Key 是这家的入场券，用哪个模型是用的时候挑。
             挑模型的入口在图片/视频反推面板那两列（先点服务商、再点它报回的模型），
             那儿还留了一条直接输入模型 ID 的路，所以清单拉不到也不堵。 -->
        <p class="settings-hint">模型不用在这里选：到图片详情页的反推面板里，先点服务商、再点它家的模型。</p>
        {#if workflowCapable}
          <div class="api-key-section">
            <p class="api-key-title">工作流 API 密钥（消费级-会员）</p>
            <p class="api-key-desc">调用云端工作流 / AI 应用，扣 RH币（账户积分）。</p>
            <div class="api-key-row">
              <input class="secret" type="text" autocomplete="off" spellcheck="false"
                     aria-label="工作流 API Key" bind:value={workflowKeyInput}
                     placeholder={workflowReady ? "已存过一把：留空就是不换" : "粘贴工作流 API 密钥"} />
              {#if workflowReady}
                <button class="setting-button setting-button-ghost api-key-clear"
                        aria-label="清除工作流这把 Key" onclick={() => void clearKeyNow("workflow")}>清除</button>
              {/if}
            </div>
            {#if !workflowReady}
              <p class="settings-hint">这把还没有也不要紧：模型那一把照常用。工作流这条链路还没接上，先存住，接上就直接能用。</p>
            {/if}
          </div>
        {/if}
        <div class="api-key-section">
          <p class="api-key-title">{sharedKey ? "模型 API 密钥（企业级-共享）" : "API Key"}</p>
          <p class="api-key-desc">
            {#if sharedKey}
              RunningHub 一把 Key 走天下：图片反推与出图、出片、出声音共用这一把，只存一份。都扣钱包余额（反推按 token，媒体按张）。
            {:else}
              本地无认证服务可以留空。Windows 按当前用户加密保存密钥；其他系统仅在当前运行期间保存。
            {/if}
            {keyReady ? "已配置：这一格留空就是不换，要删掉点右边的「清除」。" : ""}
          </p>
          <div class="api-key-row">
            <input class="secret" type="text" autocomplete="off" spellcheck="false"
                   aria-label="API Key" bind:value={keyInput}
                   placeholder={keyReady ? "已存过一把：留空就是不换" : "粘贴 API Key"} />
            {#if keyReady}
              <button class="setting-button setting-button-ghost api-key-clear"
                      aria-label="清除这把 Key" onclick={() => void clearKeyNow("model")}>清除</button>
            {/if}
          </div>
        </div>
        {#if isPreset}
          <details class="space-y-2">
            <summary class="settings-hint model-summary">高级设置</summary>
            <label>配置名称<input aria-label="配置名称" bind:value={draft.name} /></label>
            <label>Base URL<input aria-label="Base URL" bind:value={draft.base_url} /></label>
            <p class="settings-hint break-all">请求地址：{draft.base_url ? endpoint : "填写 Base URL 后显示"}</p>
            <label>请求超时（秒）<input aria-label="请求超时" type="number" min="10" max="600" bind:value={draft.timeout} /></label>
          </details>
        {:else}
          <label>请求超时（秒）<input aria-label="请求超时" type="number" min="10" max="600" bind:value={draft.timeout} /></label>
        {/if}
      </fieldset>
      {#if confirmDelete}
        <div class="model-confirm">
          <span>删除此配置？历史记录仍会保留。</span>
          <button class="setting-button bg-accent text-bg" onclick={remove}>确认删除</button>
          <button class="setting-button" onclick={() => (confirmDelete = false)}>取消</button>
        </div>
      {/if}
    </div>
    <div class="settings-card-footer">
      <span class="settings-hint">「检查」只读这家的模型清单，不产生模型调用费用。</span>
      {#if editingId}<button class="setting-button setting-button-ghost" onclick={() => (confirmDelete = true)}>删除配置</button>{/if}
      <button class="setting-button" disabled={!canSave || busy} onclick={() => void checkKey()}>检查 API Key</button>
      <button class="setting-button bg-accent text-bg" onclick={saveModel} disabled={!canSave}>保存配置</button>
    </div>
  </div>

  {#if busy}<p class="settings-hint" role="status">处理中…</p>{/if}
  {#if error}<p class="model-error" role="alert">{error}</p>{/if}
  {#if notice}<p class="model-notice" role="status">{notice}</p>{/if}
</section>

<style>
  .model-settings { width: 100%; }
  /* 卡片内表单自己的内边距：保存条挂在卡片底部时要通到边，所以不能给整张卡片加 padding。 */
  .settings-model-body { padding: 20px; }
  /* 竖排表单铺满卡片：右边缘要和卡片、右下角保存条对齐（固定宽度会在右边留一条空白）。 */
  .model-settings fieldset { max-width: none; }
  .model-chips { display: flex; gap: 8px; flex-wrap: wrap; }
  /* 服务商卡片区：一厂商一卡，状态写在卡上。清单长度不由我们决定，所以给它一个会滚的筐。 */
  .api-filter { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .api-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
  /* 无障碍：那颗方框只有 13×13，够不着 24（WCAG 2.5.8）。label 包着方框和文字，
     整行都是命中区，所以把整行抬到 24 高，方框本身的大小不动。 */
  .api-filter-builtin { display: inline-flex; align-items: center; gap: 6px; min-height: 24px; font-size: 12.5px; color: #a1a1aa; }
  .api-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(196px, 1fr)); gap: 8px; max-height: 272px; overflow: auto; }
  .api-card { display: flex; align-items: center; gap: 10px; padding: 10px 12px; text-align: left; border: 1px solid #2a2a30; border-radius: 10px; background: #17171b; color: #e6e6ea; cursor: pointer; }
  .api-card:hover:not(:disabled) { border-color: #3f3f46; }
  /* 必须自己写 color：全局 .fill-interactions button[aria-pressed="true"] 会把选中按钮的字涂成
     近黑（那是给红底胶囊用的），它只覆盖背景不覆盖文字，选中那张卡的名字就会糊在深红底上。 */
  .api-card[aria-pressed="true"] { border-color: #ef4444; background: #1d1416; color: #fafafa; }
  .api-card:disabled { opacity: .55; cursor: default; }
  .api-avatar { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 7px; background: #26262c; font-size: 11px; font-weight: 600; color: #d4d4d8; flex: none; }
  .api-card-body { display: grid; gap: 2px; min-width: 0; }
  .api-card-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .api-card-state { font-size: 11.5px; color: #fbbf24; }
  .api-card-set { color: #4ade80; }
  .api-key-section { display: grid; gap: 6px; padding-top: 12px; border-top: 1px solid rgb(255 255 255 / 7%); }
  .api-key-title { margin: 0; font-size: 13px; font-weight: 600; color: #e4e4e7; }
  .api-key-desc { margin: 0; font-size: 12px; line-height: 1.6; color: #8b8b94; }
  .api-legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .api-provider-head { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 10px; }
  .api-provider-name { font-size: 14px; font-weight: 600; color: #fafafa; }
  .api-provider-badge { padding: 2px 8px; border-radius: 999px; font-size: 11.5px; color: #fbbf24; background: rgb(251 191 36 / 12%); }
  .api-provider-set { color: #4ade80; background: rgb(74 222 128 / 12%); }
  .api-provider-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-wrap: wrap; }
  .api-help { margin-bottom: 4px; font-size: 12px; color: #a1a1aa; }
  .api-help summary { cursor: pointer; color: #93c5fd; }
  .api-help ul { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 4px; line-height: 1.6; }
  .api-console { color: #93c5fd; text-decoration: none; }
  fieldset { margin-top: 18px; }
  fieldset:first-child { margin-top: 0; }
  legend { margin-bottom: 10px; font-size: 14px; font-weight: 500; color: #e6e6ea; }
  label { display: block; font-size: 13px; color: #b8b8c3; }
  /* 这一页既没有长文本框（指令都在「反推指令」那一页），也没有下拉了（模型不在这里挑），
     所以选择器里不留 textarea 和 select。 */
  input:not([type=checkbox]) { display: block; width: 100%; margin-top: 6px; padding: 9px 12px; color: #e4e4e7; background: #18181b; border: 1px solid #3f3f46; border-radius: 6px; }
  button:disabled { opacity: .5; }
  .model-summary { cursor: pointer; }
  .model-confirm { display: flex; align-items: center; gap: 10px; margin-top: 16px; font-size: 12.5px; color: #b8b8c3; flex-wrap: wrap; }
  .model-error { margin-top: 14px; font-size: 13px; color: #fb7185; }
  .model-notice { margin-top: 14px; font-size: 13px; color: #a1a1aa; }
  @media (max-width: 860px) { .settings-model-body { padding: 16px; } }
  /* Key 那一格不能是 type=password：Chrome 把它当登录密码，先问你要不要存，下次再自动填一串点进来，
     看着就像「这格里存了一把看不见的 Key」（苏醒就是被这串点骗过一回，键盘删干净以为把 Key 清了）。
     打点交给 CSS，密码管理器就不认它；要删有「清除」那颗，不靠「把框清空」这个假动作。 */
  .api-key-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .api-key-row input { flex: 1; min-width: 0; margin-top: 0; }
  .api-key-row .api-key-clear { flex: none; }
  .secret { -webkit-text-security: disc; }
</style>