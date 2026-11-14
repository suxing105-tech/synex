<script lang="ts">
  import { onMount } from "svelte";
  import { modelConfigs, promptModelConfigs, reverseSettings, reverseJobs, refreshReverseConfig, reverseApi, generateReverse, errorMessage } from "../lib/reverse-prompts";
  import type { ReverseRecord } from "../lib/reverse-prompts";
  import { copyText } from "../lib/ws";
  import { pushToast } from "../lib/toast";
  import ModelPicker from "./ModelPicker.svelte";
  import Icon from "./Icon.svelte";
  let { imageId }: { imageId: number } = $props();
  let modelId = $state<number | null>(null);   // 哪一家（一条配置 = 一家的地址与 Key）
  let modelName = $state("");                  // 这一家当前用哪个模型；空串＝还没挑
  let records = $state<ReverseRecord[]>([]);
  let total = $state(0);
  let loading = $state(false);
  let error = $state("");
  let selectedVersion = $state<number | null>(null);
  let outputLanguage = $state<"zh" | "en">("zh");
  let historyOpen = $state(false);
  let editing = $state(false);
  let editZh = $state(""); let editEn = $state("");
  let saving = $state(false);
  let serverRunning = $state(false);
  /** 删除要二次确认：confirmId 记着"哪一条已经点过一次删除"。 */
  let confirmId = $state<number | null>(null);
  let removing = $state<number | null>(null);
  let loadSequence = 0;
  const job = $derived($reverseJobs[imageId]);
  const running = $derived(job?.running || serverRunning);
  const current = $derived(records.find(r => r.id === selectedVersion) || records[0]);
  // 正文当前展示哪种语言，单语复制就复制哪一种（展示英文时复制出来得是英文，不能永远是中文那条）。
  const shownPrompt = $derived(current ? (outputLanguage === "zh" ? current.prompt_zh : current.prompt_en) : "");
  const shownCopyLabel = $derived(outputLanguage === "zh" ? "复制中文提示词" : "复制英文提示词");
  const textConfigs = $derived(promptModelConfigs($modelConfigs));
  $effect(() => {
    if (!modelId || !textConfigs.some(m => m.id === modelId)) {
      const preferred = textConfigs.find(m => m.id === $reverseSettings?.default_model_id);
      modelId = preferred?.id ?? textConfigs[0]?.id ?? null;
    }
  });
  // 模型跟着这条配置走：它记住哪个就用哪个；没记住就空着，让人先挑，绝不拿空串去发请求。
  $effect(() => {
    modelName = textConfigs.find(m => m.id === modelId)?.model ?? "";
  });
  $effect(() => {
    const id = imageId;
    records = []; total = 0; editing = false; selectedVersion = null; historyOpen = false; serverRunning = false;
    confirmId = null; removing = null;
    void loadHistory(id);
  });
  $effect(() => {
    const result = job?.result;
    if (result && result.image_id === imageId) { void loadHistory(imageId); }
  });
  $effect(() => {
    if (serverRunning) {
      const id = imageId;
      const interval = setInterval(() => { void loadHistory(id); }, 2000);
      return () => clearInterval(interval);
    }
  });
  onMount(() => { refreshReverseConfig().catch(e => error = errorMessage(e)); });
  async function loadHistory(id: number, more = false) {
    const sequence = ++loadSequence;
    loading = true;
    try {
      const result = await reverseApi.history(id, more ? records.length : 0);
      if (imageId !== id || sequence !== loadSequence) return;
      records = more ? [...records, ...result.items] : result.items;
      total = result.total; serverRunning = result.running;
    } catch (e) { if (imageId === id && sequence === loadSequence) error = errorMessage(e); }
    finally { if (imageId === id && sequence === loadSequence) loading = false; }
  }
  async function copy(text: string) {
    const ok = await copyText(text); pushToast(ok ? "提示词已复制" : "复制失败", { kind: ok ? "success" : "error" });
  }
  async function removeVersion(record: ReverseRecord) {
    if (confirmId !== record.id) { confirmId = record.id; return; }
    const id = imageId;
    removing = record.id; error = "";
    try {
      await reverseApi.remove(id, record.id);
      if (imageId !== id) return;
      if (selectedVersion === record.id) selectedVersion = null;  // 回到最新版
      confirmId = null;
      await loadHistory(id);
    } catch (e) { if (imageId === id) error = errorMessage(e); }
    finally { removing = null; }
  }
  async function saveEdit() {
    if (!current) return;
    const id = imageId; const parent = current.id;
    saving = true; error = "";
    try {
      const record = await reverseApi.edit(id, parent, editZh, editEn);
      if (imageId !== id) return;
      editing = false; selectedVersion = record.id; await loadHistory(id);
    } catch (e) { if (imageId === id) error = errorMessage(e); }
    finally { saving = false; }
  }
</script>

<section class="fill-interactions reverse-panel rounded-lg border border-border bg-surface-2 p-3 space-y-3" aria-label="AI 反推提示词">
  <div class="flex justify-between items-center"><h4 class="text-[13px] font-semibold">AI 反推提示词</h4><span class="text-[10px] text-muted">中英双语</span></div>
  {#if !textConfigs.length}
    <button onclick={() => window.dispatchEvent(new CustomEvent("open-model-settings"))}>配置模型</button>
  {:else}
    <div class="flex gap-2">
      <ModelPicker value={modelId} model={modelName} label="反推模型" disabled={running}
        onpick={(configId, picked) => { modelId = configId; modelName = picked; }} />
      <button class="generate-reverse" disabled={running || !modelId || !modelName || editing}
        onclick={() => { error = ""; selectedVersion = null; if (modelId && modelName) void generateReverse(imageId, modelId, modelName); }}>
        {running ? "正在反推…" : current ? "重新反推" : "反推提示词"}
      </button>
    </div>
    {#if !modelName}
      <p class="text-[10px] text-amber-400">还没挑模型：点上面那个下拉，先选服务商、再点它家的模型。</p>
    {/if}
  {/if}
  {#if error || job?.error}<p class="text-xs text-danger" role="alert">{error || job?.error}</p>{/if}
  {#if current}
    {#if current.image_changed}<p class="text-xs text-amber-400">图片内容已变化或文件不可用，此版本对应此前图片。</p>{/if}
    {#if editing}
      <label class="text-xs">中文<textarea aria-label="编辑中文提示词" rows="6" bind:value={editZh}></textarea></label>
      <label class="text-xs">English<textarea aria-label="编辑英文提示词" rows="6" bind:value={editEn}></textarea></label>
      <div class="flex gap-2"><button disabled={saving || !editZh.trim() || !editEn.trim()} onclick={saveEdit}>保存为新版本</button><button disabled={saving} onclick={() => editing = false}>取消编辑</button></div>
    {:else}
      <div class="space-y-2">
      {#if current.status === "complete"}
        <div class="flex items-center gap-1.5 flex-wrap">
          <button class="language-label" class:language-active={outputLanguage === "zh"} aria-pressed={outputLanguage === "zh"} onclick={() => outputLanguage = "zh"}>中文</button>
          <button class="language-label" class:language-active={outputLanguage === "en"} aria-pressed={outputLanguage === "en"} onclick={() => outputLanguage = "en"}>English</button>
          <button class="icon-button ml-auto" aria-label={shownCopyLabel} title={shownCopyLabel} onclick={() => copy(shownPrompt)}><Icon name="copy" size={12} /></button>
          <button class="icon-button" aria-label="复制双语提示词" title="复制双语提示词" onclick={() => copy(`中文\n${current.prompt_zh}\n\nEnglish\n${current.prompt_en}`)}><Icon name="copy" size={12} /><span>双语</span></button>
        </div>
        <div class="reverse-prompt-content">
          {#if outputLanguage === "zh"}
            <div aria-label="中文反推提示词" class="prompt-copy text-xs leading-6 whitespace-pre-wrap break-words">{current.prompt_zh}</div>
          {:else}
            <div aria-label="English reverse prompt" class="prompt-copy text-xs leading-6 whitespace-pre-wrap break-words">{current.prompt_en}</div>
          {/if}
        </div>
      {:else}
        <p class="text-xs text-amber-400">返回内容未符合双语格式，可复制原文或编辑整理。</p>
        <div class="prompt-copy text-xs whitespace-pre-wrap break-words">{current.raw_text}</div>
        <div class="flex items-center gap-2"><button onclick={() => copy(current.raw_text)}>复制原文</button></div>
      {/if}
      <div class="flex gap-2 justify-end">
        <button disabled={running} onclick={() => { editZh = current.prompt_zh; editEn = current.prompt_en; editing = true; }}>编辑</button><button onclick={() => historyOpen = !historyOpen}>历史版本（{total}）</button>
      </div>
      </div>
    {/if}
    {#if historyOpen && !editing}
      <div class="space-y-1 max-h-48 overflow-auto" aria-label="历史版本">
        {#each records as record}
          <div class="flex items-center gap-1">
            <button class="version-item block min-w-0 flex-1 text-left truncate" aria-current={current.id === record.id ? "true" : undefined}
              onclick={() => selectedVersion = record.id}>
              {new Date(record.created_at).toLocaleString()} · {record.source === "edited" ? "手动编辑" : "模型生成"} · {record.model_name}
            </button>
            {#if confirmId === record.id}
              <span class="text-[10px] text-amber-400 whitespace-nowrap">删除这版？</span>
              <button class="danger" aria-label="确认删除这一版" disabled={removing !== null} onclick={() => removeVersion(record)}>确认删除</button>
              <button onclick={() => confirmId = null}>取消</button>
            {:else}
              <button title="删除这一版提示词" aria-label={`删除版本 ${record.id}`} disabled={removing !== null}
                onclick={() => removeVersion(record)}>删除</button>
            {/if}
          </div>
        {/each}
        {#if records.length < total}<button disabled={loading} onclick={() => loadHistory(imageId, true)}>加载更多</button>{/if}
      </div>
    {/if}
  {:else if loading}<p class="text-xs text-muted">正在读取历史…</p>
  {:else}<p class="text-xs text-muted">尚无反推记录，生成后会自动保存。</p>{/if}
</section>

<style>
  button { font-size: 11px; padding: 5px 8px; border: 1px solid #3f3f46; border-radius: 5px; background: #202024; }
  .reverse-panel button.generate-reverse {
    background-color: #f24e4e;
    color: #fff;
    border-color: #f24e4e;
    font-weight: 600;
  }
  .reverse-panel button.generate-reverse:enabled:hover,
  .reverse-panel button.generate-reverse:enabled:focus-visible { background-color: #ff6262; border-color: #ff6262; color:#09090b; }
  .language-label { color:var(--text-2); font-size:10px; padding:3px 6px; border-color:transparent; background:transparent; }
  .language-label.language-active { color:var(--text-1); background:#303036; }
  .icon-button { display:inline-flex; align-items:center; gap:4px; }
  .icon-button span { font-size:10px; }
  .reverse-prompt-content { min-width:0; }
  .prompt-copy { height:350px; min-height:56px; max-height:40vh; overflow:auto; resize:vertical; padding:7px; border:1px solid #303036; border-radius:5px; background:#18181b; text-align:justify; text-justify:inter-ideograph; }
  button:disabled { opacity: .5; cursor: default; }
  /* 删除是不可逆的，按钮与二次确认都要压成红色，别和"选择版本"混在一起 */
  button.danger { color: #f87171; border-color: #7f1d1d; background: #2a1414; }
  /* 历史版本这一列只是"当前在看哪一版"，不该靠底色喊：全局 .fill-interactions button[aria-pressed="true"]
     会把选中项整颗刷成品牌红底黑字，所以选中态改走 aria-current，底色保持普通按钮底，
     只用描边和字色区分——颜色一律引 :root token，别再新造裸 hex。 */
  .reverse-panel button.version-item[aria-current="true"] {
    border-color: var(--accent);
    color: var(--accent-strong);
  }
  textarea { display: block; width: 100%; margin-top: 6px; padding: 8px; font-size: 12px; color: #e4e4e7; background: #18181b; border: 1px solid #3f3f46; border-radius: 5px; }
</style>
