<script lang="ts">
  import { onMount } from "svelte";
  import { modelConfigs, reverseSettings, refreshReverseConfig, refreshProviderPresets, providerPresets, reverseApi, errorMessage } from "../lib/reverse-prompts";
  import type { ModelConfig, ModelDraft, ReverseSettings } from "../lib/reverse-prompts";
import { H3_MODES, SEEDANCE_MODES, MODE_LABELS, videoPromptApi, videoPromptSettings, refreshVideoPromptSettings } from "../lib/video-prompts";
import type { VideoPromptSettings } from "../lib/video-prompts";
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
  const endpoint = $derived((draft.base_url || "").trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "") + "/chat/completions");
  const canSave = $derived(!!draft.model?.trim() && (isPreset ? true : !!(draft.name?.trim() && draft.base_url?.trim())));
  onMount(() => {
    run(async () => {
      await refreshProviderPresets();
      await refreshReverseConfig();
      preferences = $reverseSettings ? { ...$reverseSettings } : null;
      videoPrefs = $videoPromptSettings ? { ...$videoPromptSettings } : null;
      refreshVideoPromptSettings()
        .then(() => { videoPrefs = $videoPromptSettings ? { ...$videoPromptSettings } : null; })
        .catch(() => { videoPrefs = null; });
      if (!editingId && draft.provider === CUSTOM && $providerPresets.length) {
        applyProvider($providerPresets[0].id);
      }
    });
  });
  async function run(action: () => Promise<void>) {
    busy = true; error = ""; notice = "";
    try { await action(); } catch (e) { error = errorMessage(e); } finally { busy = false; }
  }
  function applyProvider(id: string) {
    draft.provider = id;
    if (id !== CUSTOM) {
      const p = $providerPresets.find(x => x.id === id);
      const rec = p?.models.find(m => m.recommended) ?? p?.models[0];
      draft.model = rec?.id ?? "";
      draft.base_url = p?.base_url ?? "";
      draft.timeout = p?.default_timeout ?? 120;
      draft.name = p ? `${p.name} · ${rec?.label ?? ""}` : "";
    } else {
      draft.model = ""; draft.base_url = ""; draft.name = ""; draft.timeout = 120;
    }
    keyInput = ""; clearKey = false; hasKey = false;
  }
  function choose(config?: ModelConfig) {
    editingId = config?.id;
    draft = config ? { name: config.name, base_url: config.base_url, model: config.model, timeout: config.timeout, provider: config.provider ?? CUSTOM } : blank();
    keyInput = ""; clearKey = false; hasKey = !!config?.has_api_key;
    error = ""; notice = ""; testingText = ""; confirmDelete = false;
  }
  function payload(): ModelDraft {
    return {
      ...draft,
      provider: draft.provider ?? CUSTOM,
      ...(clearKey ? { api_key: "" } : keyInput ? { api_key: keyInput } : {}),
    };
  }
  async function saveModel() {
    await run(async () => {
      const saved = await reverseApi.saveModel(payload(), editingId);
      choose(saved); await refreshReverseConfig();
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
  <h4 class="settings-group-label">反推模型</h4>
  <div class="settings-card">
    <div class="settings-model-body">
      <div class="model-chips">
        {#each $modelConfigs as model}
          <button class="setting-button" aria-pressed={editingId === model.id} disabled={busy} onclick={() => choose(model)}>{model.name}</button>
        {/each}
        <button class="setting-button" aria-pressed={editingId === undefined} disabled={busy} onclick={() => choose()}>＋ 添加模型</button>
      </div>
      <fieldset disabled={busy} class="space-y-3">
        <legend>{editingId ? "编辑模型配置" : "添加模型配置"}</legend>
        <label>服务商
          <select aria-label="服务商" value={draft.provider} onchange={(e) => applyProvider((e.currentTarget as HTMLSelectElement).value)}>
            {#each providers as p}<option value={p.id}>{p.name}</option>{/each}
            <option value={CUSTOM}>自定义（手动填写）</option>
          </select>
        </label>
        {#if isPreset}
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
        <label>API Key {hasKey ? "（已配置；留空保留）" : "（本地无认证服务可留空）"}
          <input aria-label="API Key" type="password" autocomplete="new-password" bind:value={keyInput} disabled={clearKey} />
        </label>
        {#if hasKey}<label class="flex gap-2"><input type="checkbox" aria-label="清除已保存密钥" bind:checked={clearKey} />清除已保存密钥</label>{/if}
        <p class="settings-hint">Windows 按当前用户加密保存密钥；其他系统仅在当前运行期间保存。</p>
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

  <h4 class="settings-group-label">反推指令</h4>
  <div class="settings-card">
    <div class="settings-model-body">
      {#if preferences || videoPrefs}
        <div class="settings-card-body">
          {#if preferences}
            <fieldset disabled={busy} class="space-y-3">
              <legend>图片反推</legend>
              <label>默认模型<select aria-label="默认模型" bind:value={preferences.default_model_id}>
                <option value={null}>请选择模型</option>
                {#each $modelConfigs as model}<option value={model.id}>{model.name} · {model.model}</option>{/each}
              </select></label>
              <label>反推指令<textarea aria-label="反推指令" rows="5" bind:value={preferences.instruction}></textarea></label>
              <p class="settings-hint">可修改内容和风格偏好，程序始终要求输出中文与英文两个版本。</p>
            </fieldset>
          {/if}
          {#if videoPrefs}
            <fieldset disabled={busy} class="space-y-3">
              <legend>视频反推（Seedance 2.0 / MiniMax H3）</legend>
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
          {/if}
        </div>
      {:else}
        <div class="settings-load-state" role="status"><p>正在读取反推指令…</p></div>
      {/if}
    </div>
    <div class="settings-card-footer">
      <span class="settings-hint">图片与视频的正文各自独立保存，互不覆盖</span>
      {#if preferences}
        <button class="setting-button" onclick={() => { if (preferences) preferences.instruction = preferences.default_instruction; }}>恢复默认（图片指令）</button>
        <button class="setting-button bg-accent text-bg" onclick={() => run(async () => { if (preferences) { preferences = await reverseApi.saveSettings(preferences); await refreshReverseConfig(); notice = "反推偏好已保存"; } })}>保存反推偏好</button>
      {/if}
      {#if videoPrefs}
        <button class="setting-button bg-accent text-bg" onclick={() => run(async () => {
          if (!videoPrefs) return;
          videoPrefs = await videoPromptApi.saveSettings(videoPrefs);
          await refreshVideoPromptSettings();
          notice = "视频反推偏好已保存";
        })}>保存视频反推偏好</button>
      {/if}
    </div>
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
  /* 卡片变宽了，表单本身仍按可读宽度收着，别拉成一整条。 */
  .model-settings fieldset { max-width: 620px; }
  .model-chips { display: flex; gap: 8px; flex-wrap: wrap; }
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