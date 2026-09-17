<script lang="ts">
  import { onMount } from "svelte";
  import { modelConfigs, reverseSettings, refreshReverseConfig, reverseApi, errorMessage } from "../lib/reverse-prompts";
  import type { ModelConfig, ModelDraft, ReverseSettings } from "../lib/reverse-prompts";
  const blank = (): ModelDraft => ({ name: "", base_url: "", model: "", timeout: 120 });
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
  const endpoint = $derived(draft.base_url.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "") + "/chat/completions");
  onMount(() => { run(async () => { await refreshReverseConfig(); preferences = $reverseSettings ? { ...$reverseSettings } : null; }); });
  async function run(action: () => Promise<void>) {
    busy = true; error = ""; notice = "";
    try { await action(); } catch (e) { error = errorMessage(e); } finally { busy = false; }
  }
  function choose(config?: ModelConfig) {
    editingId = config?.id;
    draft = config ? { name: config.name, base_url: config.base_url, model: config.model, timeout: config.timeout } : blank();
    keyInput = ""; clearKey = false; hasKey = !!config?.has_api_key;
    error = ""; notice = ""; testingText = ""; confirmDelete = false;
  }
  function payload(): ModelDraft {
    return { ...draft, ...(clearKey ? { api_key: "" } : keyInput ? { api_key: keyInput } : {}) };
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

<section class="model-settings space-y-4" aria-label="模型与反推">
  <div class="flex gap-2 flex-wrap">
    {#each $modelConfigs as model}
      <button class:chosen={editingId === model.id} disabled={busy} onclick={() => choose(model)}>{model.name}</button>
    {/each}
    <button disabled={busy} onclick={() => choose()}>＋ 添加模型</button>
  </div>
  <fieldset disabled={busy} class="space-y-3">
    <legend class="text-sm mb-2">{editingId ? "编辑模型配置" : "添加模型配置"}</legend>
    <label>配置名称<input aria-label="配置名称" bind:value={draft.name} placeholder="例如：常用视觉模型" /></label>
    <label>Base URL<input aria-label="Base URL" bind:value={draft.base_url} placeholder="https://服务地址/v1" /></label>
    <p class="text-xs text-muted break-all">请求地址：{draft.base_url ? endpoint : "填写 Base URL 后显示"}</p>
    <label>模型 ID<input aria-label="模型 ID" bind:value={draft.model} placeholder="服务商提供的模型名称" /></label>
    <label>API Key {hasKey ? "（已配置；留空保留）" : "（本地无认证服务可留空）"}
      <input aria-label="API Key" type="password" autocomplete="new-password" bind:value={keyInput} disabled={clearKey} />
    </label>
    {#if hasKey}<label class="flex gap-2"><input type="checkbox" bind:checked={clearKey} />清除已保存密钥</label>{/if}
    <p class="text-xs text-muted">Windows 按当前用户加密保存密钥；其他系统仅在当前运行期间保存。</p>
    <label>请求超时（秒）<input aria-label="请求超时" type="number" min="10" max="600" bind:value={draft.timeout} /></label>
    <div class="flex gap-2 flex-wrap">
      <button onclick={saveModel} disabled={!draft.name.trim() || !draft.base_url.trim() || !draft.model.trim()}>保存模型</button>
      <button disabled={!draft.base_url.trim() || !draft.model.trim() || !draft.name.trim()} onclick={() => run(async () => {
        const result = await reverseApi.test({ ...payload(), config_id: editingId });
        notice = result.message; testingText = result.text;
      })}>测试图片识别</button>
      {#if editingId}<button onclick={() => confirmDelete = true}>删除配置</button>{/if}
    </div>
    <p class="text-xs text-muted">测试会向此服务发送内置测试图，产生一次 API 请求。</p>
    {#if confirmDelete}
      <div class="flex gap-2 items-center text-xs"><span>删除此配置？历史记录仍会保留。</span><button onclick={remove}>确认删除</button><button onclick={() => confirmDelete = false}>取消</button></div>
    {/if}
  </fieldset>
  {#if preferences}
    <fieldset disabled={busy} class="space-y-3 border-t border-border pt-4">
      <label>默认模型<select aria-label="默认模型" bind:value={preferences.default_model_id}>
        <option value={null}>请选择模型</option>
        {#each $modelConfigs as model}<option value={model.id}>{model.name} · {model.model}</option>{/each}
      </select></label>
      <label>反推指令<textarea aria-label="反推指令" rows="5" bind:value={preferences.instruction}></textarea></label>
      <p class="text-xs text-muted">可修改内容和风格偏好，程序始终要求输出中文与英文两个版本。</p>
      <div class="flex gap-2">
        <button onclick={() => { if (preferences) preferences.instruction = preferences.default_instruction; }}>恢复默认指令</button>
        <button onclick={() => run(async () => { if (preferences) { preferences = await reverseApi.saveSettings(preferences); await refreshReverseConfig(); notice = "反推偏好已保存"; } })}>保存反推偏好</button>
      </div>
    </fieldset>
  {/if}
  {#if busy}<p class="text-xs text-muted" role="status">处理中…</p>{/if}
  {#if error}<p class="text-sm text-danger" role="alert">{error}</p>{/if}
  {#if notice}<p class="text-sm" role="status">{notice}</p>{/if}
  {#if testingText}<pre class="text-xs whitespace-pre-wrap max-h-40 overflow-auto">{testingText}</pre>{/if}
</section>

<style>
  label { display: block; font-size: 12px; color: #b8b8c3; }
  input:not([type=checkbox]), textarea, select { display: block; width: 100%; margin-top: 6px; padding: 8px 10px; color: #e4e4e7; background: #18181b; border: 1px solid #3f3f46; border-radius: 6px; }
  button { font-size: 12px; padding: 6px 10px; border: 1px solid #3f3f46; border-radius: 6px; }
  button:hover, button.chosen { border-color: #f24e4e; }
  button:disabled { opacity: .5; }
</style>
