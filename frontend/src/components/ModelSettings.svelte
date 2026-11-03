<script lang="ts">
  import { onMount, tick } from "svelte";
  import { modelConfigs, reverseSettings, refreshReverseConfig, refreshProviderPresets, providerPresets, reverseApi, errorMessage } from "../lib/reverse-prompts";
  import type { ModelConfig, ModelDraft, ProviderModel, ProviderPreset, ReverseSettings } from "../lib/reverse-prompts";
import { H3_MODES, SEEDANCE_MODES, MODE_LABELS, videoPromptApi, videoPromptSettings, refreshVideoPromptSettings } from "../lib/video-prompts";
import type { VideoPromptSettings } from "../lib/video-prompts";
  import { cloudApi, takeCloudKeyEdit } from "../lib/clone";
  const CUSTOM = "custom";
  const blank = (): ModelDraft => ({ name: "", base_url: "", model: "", timeout: 120, provider: CUSTOM });
  let draft = $state<ModelDraft>(blank());
  let editingId = $state<number | undefined>();
  let keyInput = $state("");
  let clearKey = $state(false);
  let hasKey = $state(false);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let testingText = $state("");
  let confirmDelete = $state(false);
  let preferences = $state<ReverseSettings | null>(null);
  let videoPrefs = $state<VideoPromptSettings | null>(null);
  const providers = $derived($providerPresets);
  const isPreset = $derived(!!draft.provider && draft.provider !== CUSTOM);
  const preset = $derived($providerPresets.find(p => p.id === draft.provider));
  const providerModels = $derived(preset?.models ?? []);
  /**
   * RunningHub 这类服务商有两处不一样，界面跟着分叉：
   * - credential_scope=cloud：Key 的家在云端账号表（gen_accounts）那一行里，这条配置不另存一份；
   * - models_dynamic：模型清单由服务商自己报，代码里不抄一份会过期的表。
   */
  const sharedKey = $derived(preset?.credential_scope === "cloud");
  const dynamicModels = $derived(!!preset?.models_dynamic);
  /** 新建那条配置自己还不知道 Key 在不在，这时照服务商清单带回的布尔说。 */
  const keyReady = $derived(sharedKey ? (hasKey || !!preset?.shared_has_key) : hasKey);
  const cloudPreset = $derived($providerPresets.find(p => p.credential_scope === "cloud"));
  let modelList = $state<ProviderModel[]>([]);
  let modelListNote = $state("");
  let modelListError = $state("");
  let fetchingModels = $state(false);
  let keyInputEl = $state<HTMLInputElement | null>(null);
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
  /** 「设为默认站点」在我们这儿就是「这条模型是图片反推的默认模型」，点了直接存住。 */
  const canSetDefault = $derived(!!editingId && !!preferences);
  const isDefaultModel = $derived(!!editingId && preferences?.default_model_id === editingId);
  async function setDefaultModel() {
    // 先抓两份局部副本：$state 的属性在闭包里窄不掉，TS 不认「上面判过空」
    const current = preferences, id = editingId;
    if (!current || !id) return;
    await run(async () => {
      preferences = await reverseApi.saveSettings({ ...current, default_model_id: id });
      await refreshReverseConfig();
      notice = "已把这条模型设为图片反推的默认模型。";
    });
  }
  let workflowKeyInput = $state("");
  let clearWorkflowKey = $state(false);
  const configsFor = (id: string) => $modelConfigs.filter(c => c.provider === id);
  const presetReady = (item: ProviderPreset) => item.credential_scope === "cloud"
    ? !!(item.shared_has_key || item.shared_has_workflow_key || configsFor(item.id).some(c => c.has_api_key))
    : configsFor(item.id).some(c => c.has_api_key);
  const avatar = (name: string) => (name.trim().slice(0, 2) || "?").toUpperCase();
  function selectProvider(id: string) {
    const existing = configsFor(id)[0];
    workflowKeyInput = ""; clearWorkflowKey = false;
    if (existing) {
      choose(existing);
      if (providers.find(p => p.id === id)?.models_dynamic) void fetchModels();
    } else {
      choose();
      applyProvider(id);
    }
  }
  const endpoint = $derived((draft.base_url || "").trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "") + "/chat/completions");
  const canSave = $derived(!!draft.model?.trim() && (isPreset ? true : !!(draft.name?.trim() && draft.base_url?.trim())));
  // 两份偏好在两张卡片里各自渲染，所以任一半读失败都单独标记，卡片给「重新加载」而不是卡在「正在读取…」。
  let loadFailed = $state(false);
  async function loadReversePart() {
    await refreshProviderPresets();
    await refreshReverseConfig();
    preferences = $reverseSettings ? { ...$reverseSettings } : null;
    if (!editingId && draft.provider === CUSTOM && $providerPresets.length) {
      // 落点落在已经配好 Key 的那一家，而不是清单里排第一的 OpenAI：默认摊开一张没配的表单，
      // 等于每次进来都要重新找自己那家。这里不调 selectProvider——它会顺手去拉模型清单，
      // 那是拿真 Key 发的外部请求，不该由「打开设置」这个动作替你发。
      const ready = $providerPresets.find((item) => presetReady(item));
      const existing = ready ? configsFor(ready.id)[0] : undefined;
      if (existing) choose(existing);
      else applyProvider((ready ?? $providerPresets[0]).id, true);
    }
  }
  async function loadVideoPart() {
    try {
      await refreshVideoPromptSettings();
      videoPrefs = $videoPromptSettings ? { ...$videoPromptSettings } : null;
    } catch (e) { videoPrefs = null; throw e; }
  }
  function loadAll() {
    loadFailed = false;
    // 视频那半不等：它慢或挂了都不该让图片这半一直转圈、按钮一直禁用。
    void loadVideoPart().catch(() => { loadFailed = true; });
    return loadReversePart().catch(() => { loadFailed = true; });
  }
  const reloadSettings = () => run(loadAll);
  /** 向服务商现拉模型清单。拉不到不编一份：后端那句「可以手填模型 ID」原样说给人听。 */
  async function fetchModels() {
    if (!draft.provider) return;
    fetchingModels = true;
    modelListError = "";
    try {
      const out = await reverseApi.modelList(draft.provider);
      modelList = out.models;
      modelListNote = out.reason ?? "";
      if (!draft.model) draft.model = (out.models.find(m => m.recommended) ?? out.models[0])?.id ?? "";
    } catch (e) {
      modelList = []; modelListNote = ""; modelListError = errorMessage(e);
    } finally {
      fetchingModels = false;
    }
  }
  /** 一键同款 API 那屏的「设置 RunningHub 的 API Key」落到这里：切到共用 Key 那一家，光标停在 Key 那一格。 */
  async function editSharedKey() {
    if (!cloudPreset) return;
    // 已经有这一家的配置就改那一条：另起一张空表单会多出一条 RunningHub，之后没人说得清哪条是活的
    selectProvider(cloudPreset.id);
    await tick();
    keyInputEl?.focus();
    keyInputEl?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  onMount(() => {
    // 从一键同款那一屏过来时，等服务商清单读回来再跳：cloudPreset 还空着的时候跳等于没跳。
    void run(loadAll).then(() => { if (takeCloudKeyEdit()) void editSharedKey(); });
  });
  async function run(action: () => Promise<void>) {
    busy = true; error = ""; notice = "";
    try { await action(); } catch (e) { error = errorMessage(e); } finally { busy = false; }
  }
  /** quiet：这家是我们自己替用户选中的落点，不是他点的。现拉清单要拿真 Key 发外部请求，
      这种请求只由他手上这一下触发，不由「打开设置」替他触发。 */
  function applyProvider(id: string, quiet = false) {
    draft.provider = id;
    if (id !== CUSTOM) {
      const p = $providerPresets.find(x => x.id === id);
      const rec = p?.models.find(m => m.recommended) ?? p?.models[0];
      draft.model = rec?.id ?? "";
      draft.base_url = p?.base_url ?? "";
      draft.timeout = p?.default_timeout ?? 120;
      // 清单要现拉的那几家，一开始没有推荐项：名字先只写服务商，别留一个「· 」在那儿
      draft.name = p ? (rec ? `${p.name} · ${rec.label}` : p.name) : "";
      modelList = []; modelListNote = ""; modelListError = "";
      if (p?.models_dynamic && !quiet) void fetchModels();
    } else {
      draft.model = ""; draft.base_url = ""; draft.name = ""; draft.timeout = 120;
      modelList = []; modelListNote = ""; modelListError = "";
    }
    keyInput = ""; clearKey = false; hasKey = false;
  }
  function choose(config?: ModelConfig) {
    editingId = config?.id;
    draft = config ? { name: config.name, base_url: config.base_url, model: config.model, timeout: config.timeout, provider: config.provider ?? CUSTOM } : blank();
    keyInput = ""; clearKey = false; hasKey = !!config?.has_api_key;
    workflowKeyInput = ""; clearWorkflowKey = false;
    error = ""; notice = ""; testingText = ""; confirmDelete = false;
    modelList = []; modelListNote = ""; modelListError = "";
  }
  function payload(): ModelDraft {
    return {
      ...draft,
      provider: draft.provider ?? CUSTOM,
      ...(clearKey ? { api_key: "" } : keyInput ? { api_key: keyInput } : {}),
      ...(clearWorkflowKey ? { workflow_api_key: "" }
        : workflowKeyInput.trim() ? { workflow_api_key: workflowKeyInput.trim() } : {}),
    };
  }
  async function saveModel() {
    await run(async () => {
      const saved = await reverseApi.saveModel(payload(), editingId);
      choose(saved); await refreshReverseConfig(); await refreshProviderPresets();
      if (preferences) preferences.default_model_id = $reverseSettings?.default_model_id ?? null;
      notice = "模型配置已保存";
    });
  }
  async function remove() {
    if (!editingId) return;
    await run(async () => {
      await reverseApi.deleteModel(editingId!); choose(); await refreshReverseConfig();
      if (preferences) preferences.default_model_id = $reverseSettings?.default_model_id ?? null;
      notice = "模型配置已删除，历史记录已保留";
    });
  }
</script>
<section class="fill-interactions model-settings" aria-label="模型与反推">
  <h4 class="settings-group-label">模型服务API</h4>
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
                onclick={() => void setDefaultModel()}>{isDefaultModel ? "已是默认模型" : "设为默认模型"}</button>
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
          <!-- 自定义那家到底能干什么我们不知道，所以挑了具体能力时不摆它：
               挂一张「图像」卡进去，点进去却是猜，那是界面在替用户吹牛。 -->
          {#if !onlyBuiltin && capability === "all"}
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
        {#if isPreset && dynamicModels}
          <label>反推模型 ID
            <input aria-label="反推模型 ID" bind:value={draft.model} placeholder="点下面清单挑一个，或者直接手填" />
          </label>
          <div class="model-picks">
            <button class="setting-button setting-button-ghost" disabled={busy || fetchingModels} onclick={() => void fetchModels()}>
              {fetchingModels ? "正在拉取…" : "拉取模型清单"}
            </button>
            {#each modelList as item (item.id)}
              <button class="setting-button" aria-pressed={draft.model === item.id} disabled={busy}
                onclick={() => (draft.model = item.id)}>{item.label}</button>
            {/each}
          </div>
          <p class="settings-hint" role="status">
            {modelListError || modelListNote || (modelList.length ? `服务商自己报了 ${modelList.length} 个模型` : "还没拉清单：点上面那颗，或者直接把模型 ID 填在框里")}
          </p>
          <p class="settings-hint">反推只能挑看得懂图的那一个。挑错了这边会报「模型不支持图片」。</p>
        {:else if isPreset}
          <label>反推模型
            <select aria-label="反推模型" bind:value={draft.model}>
              {#each providerModels as m}<option value={m.id}>{m.label}{m.recommended ? "（推荐）" : ""}</option>{/each}
            </select>
          </label>
          {#if preset?.note}<p class="settings-hint">{preset.note}</p>{/if}
        {:else}
          <label>配置名称<input aria-label="配置名称" bind:value={draft.name} placeholder="例如：常用视觉模型" /></label>
          <label>Base URL<input aria-label="Base URL" bind:value={draft.base_url} placeholder="https://服务地址/v1" /></label>
          <p class="settings-hint break-all">请求地址：{draft.base_url ? endpoint : "填写 Base URL 后显示"}</p>
          <label>模型 ID<input aria-label="模型 ID" bind:value={draft.model} placeholder="服务商提供的模型名称" /></label>
        {/if}
        {#if workflowCapable}
          <div class="api-key-section">
            <p class="api-key-title">工作流 API 密钥（消费级-会员）</p>
            <p class="api-key-desc">调用云端工作流 / AI 应用，扣 RH币（账户积分）。</p>
            <input aria-label="工作流 API Key" type="password" autocomplete="new-password" bind:value={workflowKeyInput} disabled={clearWorkflowKey} />
            {#if workflowReady}
              <label class="flex gap-2"><input type="checkbox" aria-label="清除工作流密钥" bind:checked={clearWorkflowKey} />清掉这把（只影响云端工作流，模型那把不动）</label>
            {:else}
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
            {keyReady ? "已配置，这一格留空就是保留原来那把。" : ""}
          </p>
          <input aria-label="API Key" type="password" autocomplete="new-password" bind:this={keyInputEl} bind:value={keyInput} disabled={clearKey} />
          {#if keyReady}
            <label class="flex gap-2"><input type="checkbox" aria-label="清除已保存密钥" bind:checked={clearKey} />{sharedKey ? "清掉这把 Key（反推与一键同款同时失效）" : "清除已保存密钥"}</label>
          {/if}
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
      <span class="settings-hint">测试会向此服务发送内置测试图，产生一次 API 请求。</span>
      {#if editingId}<button class="setting-button setting-button-ghost" onclick={() => (confirmDelete = true)}>删除配置</button>{/if}
      <button class="setting-button" disabled={!canSave} onclick={() => run(async () => {
        const result = await reverseApi.test({ ...payload(), config_id: editingId });
        notice = result.message; testingText = result.text;
      })}>测试图片识别</button>
      <button class="setting-button bg-accent text-bg" onclick={saveModel} disabled={!canSave}>保存模型</button>
    </div>
  </div>

  <h4 class="settings-group-label">图片反推</h4>
  <div class="settings-card">
    <div class="settings-model-body">
      {#if preferences}
        <fieldset disabled={busy} class="space-y-3">
          <label>默认模型<select aria-label="默认模型" bind:value={preferences.default_model_id}>
            <option value={null}>请选择模型</option>
            {#each $modelConfigs as model}<option value={model.id}>{model.name} · {model.model}</option>{/each}
          </select></label>
          <label>反推指令<textarea aria-label="反推指令" rows="5" bind:value={preferences.instruction}></textarea></label>
          <p class="settings-hint">可修改内容和风格偏好，程序始终要求输出中文与英文两个版本。</p>
        </fieldset>
      {:else}
        <div class="settings-load-state" role="status"><p>{loadFailed ? "暂时读取不到图片反推设置，可以重试。" : "正在读取图片反推设置…"}</p>{#if loadFailed}<button class="setting-button" onclick={reloadSettings}>重新加载</button>{/if}</div>
      {/if}
    </div>
    {#if preferences}
      <div class="settings-card-footer">
        <span class="settings-hint">默认模型与指令一起保存</span>
        <button class="setting-button" onclick={() => { if (preferences) preferences.instruction = preferences.default_instruction; }}>恢复默认（图片指令）</button>
        <button class="setting-button bg-accent text-bg" onclick={() => run(async () => { if (preferences) { preferences = await reverseApi.saveSettings(preferences); await refreshReverseConfig(); notice = "反推偏好已保存"; } })}>保存反推偏好</button>
      </div>
    {/if}
  </div>

  <h4 class="settings-group-label">视频反推（Seedance 2.0 / MiniMax H3）</h4>
  <div class="settings-card">
    <div class="settings-model-body">
      {#if videoPrefs}
        <fieldset disabled={busy} class="space-y-3">
          <label>默认模型<select aria-label="视频反推默认模型" bind:value={videoPrefs.default_model_id}>
            <option value={null}>跟随图片反推默认模型</option>
            {#each $modelConfigs as model}<option value={model.id}>{model.name} · {model.model}</option>{/each}
          </select></label>
          <div class="grid grid-cols-2 gap-2">
            <label>默认 Seedance 模式<select aria-label="默认 Seedance 模式" bind:value={videoPrefs.default_mode_seedance}>
              {#each SEEDANCE_MODES as option}<option value={option}>{MODE_LABELS[option]}</option>{/each}
            </select></label>
            <label>默认 H3 模式<select aria-label="默认 H3 模式" bind:value={videoPrefs.default_mode_h3}>
              {#each H3_MODES as option}<option value={option}>{MODE_LABELS[option]}</option>{/each}
            </select></label>
          </div>
          <div class="grid grid-cols-3 gap-2">
            <label>帧数上限<input aria-label="视频帧数上限" type="number" min="4" max="16" bind:value={videoPrefs.frame_limit} /></label>
            <label>单元时长上限（秒）<input aria-label="单元时长上限" type="number" min="5" max="15" bind:value={videoPrefs.max_unit_seconds} /></label>
            <label>单元数上限<input aria-label="单元数上限" type="number" min="1" max="24" bind:value={videoPrefs.max_units} /></label>
          </div>
          <p class="settings-hint">每段按镜头切点装箱，不超单元时长上限；超过单元数上限会要求缩小区间或调大设置。帧数越多越贵。</p>
          <label>分镜方案指令
            <textarea aria-label="分镜方案指令" rows="4" bind:value={videoPrefs.instruction_plan}></textarea>
          </label>
          <button class="setting-button setting-button-ghost restore-plan" onclick={() => { if (videoPrefs) videoPrefs.instruction_plan = videoPrefs.defaults.instruction_plan; }}>恢复默认（分镜方案）</button>
          <label>Seedance 2.0 指令
            <textarea aria-label="Seedance 指令" rows="5" bind:value={videoPrefs.instruction_seedance}></textarea>
          </label>
          <button class="setting-button setting-button-ghost restore-seedance" onclick={() => { if (videoPrefs) videoPrefs.instruction_seedance = videoPrefs.defaults.instruction_seedance; }}>恢复默认（Seedance）</button>
          <label>MiniMax H3 指令
            <textarea aria-label="H3 指令" rows="5" bind:value={videoPrefs.instruction_h3}></textarea>
          </label>
          <button class="setting-button setting-button-ghost restore-h3" onclick={() => { if (videoPrefs) videoPrefs.instruction_h3 = videoPrefs.defaults.instruction_h3; }}>恢复默认（H3）</button>
        </fieldset>
      {:else}
        <div class="settings-load-state" role="status"><p>{loadFailed ? "暂时读取不到视频反推设置，可以重试。" : "正在读取视频反推设置…"}</p>{#if loadFailed}<button class="setting-button" onclick={reloadSettings}>重新加载</button>{/if}</div>
      {/if}
    </div>
    {#if videoPrefs}
      <div class="settings-card-footer">
        <span class="settings-hint">两种格式的正文各自独立保存，互不覆盖；正文语言由上面的指令决定</span>
        <button class="setting-button bg-accent text-bg" onclick={() => run(async () => {
          if (!videoPrefs) return;
          videoPrefs = await videoPromptApi.saveSettings(videoPrefs);
          await refreshVideoPromptSettings();
          notice = "视频反推偏好已保存";
        })}>保存视频反推偏好</button>
      </div>
    {/if}
  </div>

  {#if busy}<p class="settings-hint" role="status">处理中…</p>{/if}
  {#if error}<p class="model-error" role="alert">{error}</p>{/if}
  {#if notice}<p class="model-notice" role="status">{notice}</p>{/if}
  {#if testingText}<pre class="model-testing-text">{testingText}</pre>{/if}
</section>

<style>
  .model-settings { width: 100%; }
  /* 卡片内表单自己的内边距：保存条挂在卡片底部时要通到边，所以不能给整张卡片加 padding。 */
  .settings-model-body { padding: 20px; }
  /* 竖排表单铺满卡片：右边缘要和卡片、右下角保存条对齐（固定宽度会在右边留一条空白）。 */
  .model-settings fieldset { max-width: none; }
  /* 指令框里是长段文字：白字压黑底太刺眼，行距也偏挤，所以压灰一档、行距放到 1.9。 */
  .model-settings textarea { color: #c2c2ca; line-height: 1.9; letter-spacing: .01em; }
  .model-chips { display: flex; gap: 8px; flex-wrap: wrap; }
  /* 现拉的清单长短不由我们决定：给它一个会滚的筐，别把整张卡顶长。 */
  .model-picks { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; max-height: 132px; overflow: auto; }
  /* 服务商卡片区：一厂商一卡，状态写在卡上。清单长度不由我们决定，所以给它一个会滚的筐。 */
  .api-filter { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .api-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
  .api-filter-builtin { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: #a1a1aa; }
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
  input:not([type=checkbox]), textarea, select { display: block; width: 100%; margin-top: 6px; padding: 9px 12px; color: #e4e4e7; background: #18181b; border: 1px solid #3f3f46; border-radius: 6px; }
  button:disabled { opacity: .5; }
  .model-summary { cursor: pointer; }
  .model-confirm { display: flex; align-items: center; gap: 10px; margin-top: 16px; font-size: 12.5px; color: #b8b8c3; flex-wrap: wrap; }
  .model-error { margin-top: 14px; font-size: 13px; color: #fb7185; }
  .model-notice { margin-top: 14px; font-size: 13px; color: #a1a1aa; }
  .model-testing-text { margin-top: 12px; max-height: 160px; overflow: auto; font-size: 12px; white-space: pre-wrap; color: #a1a1aa; }
  @media (max-width: 860px) { .settings-model-body { padding: 16px; } }
</style>