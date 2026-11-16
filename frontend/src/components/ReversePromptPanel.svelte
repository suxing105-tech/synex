<script lang="ts">
  import { onMount } from "svelte";
  import { autoPickModel, modelConfigs, promptModelConfigs, reverseSettings, reverseJobs, refreshReverseConfig, reverseApi, generateReverse, errorMessage } from "../lib/reverse-prompts";
  import type { ReverseRecord } from "../lib/reverse-prompts";
  import { copyText, dateTimeLabel } from "../lib/ws";
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
  // 模型不用人挑：这一家没记住模型，就拿它自己报回来的清单认一个（认的规则在后端 fetch_models）。
  // 认完顺手记回配置，视频那一侧读同一份；每家只试一次，清单拉不到就留提示，不反复敲它。
  let autoTried = $state<number | null>(null);
  $effect(() => {
    const id = modelId;
    if (!id || modelName || autoTried === id) return;
    if (!textConfigs.some(m => m.id === id)) return;
    autoTried = id;
    void autoPickModel(id)
      .then((picked) => { if (picked && modelId === id) modelName = picked; })
      .catch((e) => { if (modelId === id) error = errorMessage(e); });
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

<section class="fill-interactions reverse-panel space-y-2" aria-label="反推提示词">
  <!-- 分区只靠标题字重和留白，不再铺一块底色、也不再往里缩一格（2026-11-15 苏醒：不用底色区分，内容要对齐）。
       头部那颗「中英双语」删了：正文上面就有「中文 / EN」两颗切换，同一件事在同一块里说两遍。 -->
  <h4 class="section-title is-card">反推提示词</h4>
  {#if !textConfigs.length}
    <button onclick={() => window.dispatchEvent(new CustomEvent("open-model-settings"))}>配置模型</button>
  {:else}
    <div class="flex items-center gap-2">
      <ModelPicker value={modelId} model={modelName} label="反推模型" disabled={running}
        onpick={(configId, picked) => { modelId = configId; modelName = picked; }} />
      <button class="generate-reverse" disabled={running || !modelId || !modelName || editing}
        onclick={() => { error = ""; selectedVersion = null; if (modelId && modelName) void generateReverse(imageId, modelId, modelName); }}>
        {running ? "正在反推…" : current ? "重新反推" : "开始反推"}
      </button>
    </div>
    {#if !modelName}
      <p class="text-2xs text-amber-400">没认出这家的语言模型：打开上面的下拉能看到原因，或到设置里检查这把 Key。</p>
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
          <button class="language-label" class:language-active={outputLanguage === "en"} aria-pressed={outputLanguage === "en"} onclick={() => outputLanguage = "en"}>EN</button>
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
              {dateTimeLabel(record.created_at)} · {record.source === "edited" ? "手动编辑" : "模型生成"} · {record.model_name}
            </button>
            {#if confirmId === record.id}
              <span class="text-2xs text-amber-400 whitespace-nowrap">删除这版？</span>
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
  /* 两颗语种：未选中的压一档控件底（--ink-3，与面板底差一级），选中的整颗品牌红 + 墨字。
     先前未选中是 transparent，两颗一样灰，看不出「现在读的是哪一版」。
     对比度：--text-2 压在 --ink-3 上 5.3:1，--accent-ink 压在 --accent 上 5.5:1，都在正文地板之上。 */
  .language-label { color:var(--text-2); font-size:var(--fs-2xs); padding:4px 6px; min-width:34px; text-align:center; border-color:transparent; background:var(--ink-3); }
  .language-label:enabled:hover { background:var(--ink-4); color:var(--text-1); }
  .language-label.language-active { color:var(--accent-ink); background:var(--accent); }
  .language-label.language-active:enabled:hover,
  .language-label.language-active:enabled:focus-visible { background:var(--accent-strong); color:var(--accent-ink); }
  .icon-button { display:inline-flex; align-items:center; gap:4px; }
  .icon-button span { font-size:var(--fs-2xs); }
  .reverse-prompt-content { min-width:0; }
  /* 350px 起手 + 纵向可拖高是 2026-11-14 定的（长提示词要一眼读完），留着。
     去掉的是底色，描边要回来（2026-11-15 苏醒：这个提示词框还是需要描边的）——
     这是一块能滚动、能拖高、能双击复制的正文区，不给边界人就不知道它是一块区域。
     分区靠描边，不靠第二层底色。 */
  .prompt-copy { height:350px; min-height:56px; max-height:40vh; overflow:auto; resize:vertical; padding:8px; border:1px solid var(--line); border-radius:var(--r-1); color:var(--text-1); text-align:justify; text-justify:inter-ideograph; }
  button:disabled { opacity: .5; cursor: default; }
  /* 删除是不可逆的，按钮与二次确认都要压成红色，别和"选择版本"混在一起 */
  button.danger { color: var(--danger); border-color: rgb(var(--danger-rgb) / 45%); background: rgb(var(--danger-rgb) / 8%); }
  /* 历史版本这一列只是"当前在看哪一版"，不该靠底色喊：全局 .fill-interactions button[aria-pressed="true"]
     会把选中项整颗刷成品牌红底黑字，所以选中态改走 aria-current，底色保持普通按钮底，
     只用字重区分、不描边不铺色（2026-11-15 苏醒：统一不要描边，白字即可）。 */
  .reverse-panel button.version-item,
  .reverse-panel button.version-item[aria-current="true"] {
    border-color: transparent;
    color: var(--text-1);
  }
  .reverse-panel button.version-item[aria-current="true"] { font-weight: 600; }
  textarea { display: block; width: 100%; margin-top: 6px; padding: 8px; font-size: 12px; color: #e4e4e7; background: #18181b; border: 1px solid #3f3f46; border-radius: 5px; }
</style>
