<script lang="ts">
  import { onMount } from "svelte";
  import { modelConfigs, reverseSettings, reverseJobs, refreshReverseConfig, reverseApi, generateReverse, errorMessage } from "../lib/reverse-prompts";
  import type { ReverseRecord } from "../lib/reverse-prompts";
  import { copyText } from "../lib/ws";
  import { pushToast } from "../lib/toast";
  let { imageId }: { imageId: number } = $props();
  let modelId = $state<number | null>(null);
  let records = $state<ReverseRecord[]>([]);
  let total = $state(0);
  let loading = $state(false);
  let error = $state("");
  let selectedVersion = $state<number | null>(null);
  let tab = $state<"zh" | "en">("zh");
  let historyOpen = $state(false);
  let editing = $state(false);
  let editZh = $state(""); let editEn = $state("");
  let saving = $state(false);
  let serverRunning = $state(false);
  let loadSequence = 0;
  const job = $derived($reverseJobs[imageId]);
  const running = $derived(job?.running || serverRunning);
  const current = $derived(records.find(r => r.id === selectedVersion) || records[0]);
  $effect(() => {
    if (!modelId || !$modelConfigs.some(m => m.id === modelId)) modelId = $reverseSettings?.default_model_id ?? $modelConfigs[0]?.id ?? null;
  });
  $effect(() => {
    const id = imageId;
    records = []; total = 0; editing = false; selectedVersion = null; historyOpen = false; serverRunning = false;
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

<section class="fill-interactions reverse-panel group rounded-md border border-border bg-surface-2 p-3 space-y-3" aria-label="AI 反推提示词">
  <div class="flex justify-between items-center"><h4 class="text-[13px] font-semibold">AI 反推提示词</h4><span class="text-[10px] text-muted">中英双语</span></div>
  {#if !$modelConfigs.length}
    <button onclick={() => window.dispatchEvent(new CustomEvent("open-model-settings"))}>配置模型</button>
  {:else}
    <div class="flex gap-2">
      <select aria-label="反推模型" class="min-w-0 flex-1" bind:value={modelId} disabled={running}>
        {#each $modelConfigs as model}<option value={model.id}>{model.name}</option>{/each}
      </select>
      <button disabled={running || !modelId || editing} onclick={() => { error = ""; selectedVersion = null; if (modelId) void generateReverse(imageId, modelId); }}>
        {running ? "正在反推…" : current ? "重新反推" : "反推提示词"}
      </button>
    </div>
  {/if}
  <p class="text-[10px] text-muted">点击反推会将图片发送至所选 API 服务。结果是画面描述，不保证还原原始提示词。</p>
  {#if error || job?.error}<p class="text-xs text-danger" role="alert">{error || job?.error}</p>{/if}
  {#if current}
    <div class="text-[10px] text-muted break-all">{current.model_name} · {current.model}<br />{new Date(current.created_at).toLocaleString()} · {current.source === "edited" ? "手动编辑" : "模型生成"}</div>
    {#if current.image_changed}<p class="text-xs text-amber-400">图片内容已变化或文件不可用，此版本对应此前图片。</p>{/if}
    {#if editing}
      <label class="text-xs">中文<textarea aria-label="编辑中文提示词" rows="6" bind:value={editZh}></textarea></label>
      <label class="text-xs">English<textarea aria-label="编辑英文提示词" rows="6" bind:value={editEn}></textarea></label>
      <div class="flex gap-2"><button disabled={saving || !editZh.trim() || !editEn.trim()} onclick={saveEdit}>保存为新版本</button><button disabled={saving} onclick={() => editing = false}>取消编辑</button></div>
    {:else}
      <div class="space-y-3">
      {#if current.status === "complete"}
        <div class="flex gap-2"><button aria-pressed={tab === "zh"} onclick={() => tab = "zh"}>中文</button><button aria-pressed={tab === "en"} onclick={() => tab = "en"}>English</button></div>
        <div class="text-xs leading-6 whitespace-pre-wrap break-words max-h-80 overflow-auto">{tab === "zh" ? current.prompt_zh : current.prompt_en}</div>
        <div class="flex gap-2"><button onclick={() => copy(tab === "zh" ? current.prompt_zh : current.prompt_en)}>复制{tab === "zh" ? "中文" : "英文"}</button><button onclick={() => copy(`中文\n${current.prompt_zh}\n\nEnglish\n${current.prompt_en}`)}>复制双语</button></div>
      {:else}
        <p class="text-xs text-amber-400">返回内容未符合双语格式，可复制原文或编辑整理。</p>
        <div class="text-xs whitespace-pre-wrap break-words max-h-80 overflow-auto">{current.raw_text}</div>
        <button onclick={() => copy(current.raw_text)}>复制原文</button>
      {/if}
      <div class="flex gap-2">
        <button disabled={running} onclick={() => { editZh = current.prompt_zh; editEn = current.prompt_en; editing = true; }}>编辑</button><button onclick={() => historyOpen = !historyOpen}>历史版本（{total}）</button>
      </div>
      </div>
    {/if}
    {#if historyOpen && !editing}
      <div class="space-y-1 max-h-48 overflow-auto" aria-label="历史版本">
        {#each records as record}
          <button class="block w-full text-left" aria-pressed={current.id === record.id} onclick={() => selectedVersion = record.id}>
            {new Date(record.created_at).toLocaleString()} · {record.source === "edited" ? "手动编辑" : "模型生成"} · {record.model_name}
          </button>
        {/each}
        {#if records.length < total}<button disabled={loading} onclick={() => loadHistory(imageId, true)}>加载更多</button>{/if}
      </div>
    {/if}
  {:else if loading}<p class="text-xs text-muted">正在读取历史…</p>
  {:else}<p class="text-xs text-muted">尚无反推记录，生成后会自动保存。</p>{/if}
</section>

<style>
  .reverse-panel {
    transition: background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
  }
  .reverse-panel:hover {
    background-color: rgba(242, 78, 78, 0.10);
    border-color: rgba(242, 78, 78, 0.40);
    box-shadow: inset 3px 0 0 #f24e4e;
  }
  .reverse-panel:hover h4 { color: #ffb3b3; }
  button, select { font-size: 11px; padding: 5px 8px; border: 1px solid #3f3f46; border-radius: 5px; background: #202024; }
  button:disabled { opacity: .5; cursor: default; }
  textarea { display: block; width: 100%; margin-top: 6px; padding: 8px; font-size: 12px; color: #e4e4e7; background: #18181b; border: 1px solid #3f3f46; border-radius: 5px; }
</style>
