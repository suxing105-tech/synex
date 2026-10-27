<script lang="ts">
  import { onMount } from "svelte";
  import { modelConfigs, refreshReverseConfig } from "../lib/reverse-prompts";
  import {
    MODES_BY_TARGET, MODE_LABELS, MODE_HINTS, MODE_BADGES, TARGETS, TARGET_LABELS, TRANSLATION_LABELS,
    cjkCount, elapsedText, SEEDANCE_CHAR_GUIDE, slotLimitText,
    errorMessage, generatePlan,
    generateSegments, planKey,
    refreshVideoPromptSettings, secondText, secondsInputToMs, secondsRangeText, segmentKey, segmentQueue,
    translatePrompt, translationJobs, translationKey, translationOf, videoPromptApi, videoPromptJobs,
    videoPromptSettings, wholeSecond,
  } from "../lib/video-prompts";
  import type { PromptMode, PromptRun, PromptTarget, PromptUnit, SegmentRecord } from "../lib/video-prompts";
  import type { PromptReference } from "../lib/video-prompts";
  import { copyText } from "../lib/ws";
  import VideoFrameThumb from "./VideoFrameThumb.svelte";
  import { countSlots, overSlots, plannedReferences, refFileTag, SLOT_LABELS, unitFrameAt } from "../lib/video-prompts";
  import { pushToast } from "../lib/toast";

  let { videoId, filename = "", durationSeconds = null }:
    { videoId: number; filename?: string; durationSeconds?: number | null } = $props();

  let modelId = $state<number | null>(null);
  /** 每种格式各记各的模式：Seedance 换模式不该把 H3 的选择改掉。 */
  let mode = $state<Record<PromptTarget, PromptMode>>({ seedance2: "t2v", h3: "t2va" });
  /** number 输入框绑出来可能是 number，交给 secondsInputToMs 统一处理。 */
  let startText = $state<string | number>("");
  let endText = $state<string | number>("");
  let soundNote = $state("");
  let runs = $state<PromptRun[]>([]);
  let total = $state(0);
  let activeRunId = $state<number | null>(null);
  let tab = $state<PromptTarget>("seedance2");
  let serverRunning = $state(false);
  let loading = $state(false);
  let error = $state("");
  let runsOpen = $state(false);
  let editingKey = $state<string | null>(null);
  let editText = $state("");
  let saving = $state(false);
  let versionsKey = $state<string | null>(null);
  let versions = $state<SegmentRecord[]>([]);
  /** 正在看某段的历史版本：key → 那一版。没有就是看当前版。整表刷新后清空，不会停在被删掉的版本上。 */
  let viewed = $state<Record<string, SegmentRecord>>({});
  /** 删除要二次确认，记的是"哪一段的哪一版已经点过一次删除"。 */
  let confirmKey = $state<string | null>(null);
  let deletingId = $state<number | null>(null);
  let openFrames = $state<Record<string, boolean>>({});
  /** 模式说明收在问号里：悬停/聚焦自动展开，点一下也能打开（触屏没有 hover）。 */
  let modeHelpOpen = $state(false);
  /** 队列在跑时被点的是哪个"全部生成"，让那个按钮自己亮起来转圈。 */
  let allScope = $state<"tab" | "both" | null>(null);
  /** 每段每种格式各自决定看不看译文，切段切格式互不影响。 */
  let shownTranslation = $state<Record<string, boolean>>({});
  let loadSequence = 0;

  const prefs = $derived($videoPromptSettings);
  const planJob = $derived($videoPromptJobs[planKey(videoId)]);
  const planRunning = $derived(!!planJob?.running);
  const queue = $derived($segmentQueue);
  const run = $derived(runs.find(item => item.id === activeRunId) ?? runs[0] ?? null);
  const units = $derived(run?.units ?? []);
  const running = $derived(!!planJob?.running || !!queue || serverRunning);
  const planError = $derived(error || planJob?.error || (run && run.status === "failed" ? run.error : ""));
  /** 等待计时靠这个 tick 走（只在有任务在跑时启动定时器），界面才知道"没卡住"。 */
  let now = $state(Date.now());
  const secondsText = $derived(durationSeconds ? `时长 ${secondText(durationSeconds * 1000)} 秒` : "整段视频");
  const baseName = $derived(filename.replace(/\.[^.]+$/, "") || `视频${videoId}`);

  $effect(() => {
    if (modelId === null || !$modelConfigs.some(m => m.id === modelId)) {
      modelId = prefs?.default_model_id ?? $modelConfigs[0]?.id ?? null;
    }
  });
  $effect(() => {
    if (prefs) mode = { seedance2: prefs.default_mode_seedance, h3: prefs.default_mode_h3 };
  });
  $effect(() => {
    const id = videoId;
    runs = []; total = 0; activeRunId = null; error = ""; runsOpen = false; openFrames = {};
    editingKey = null; versionsKey = null; versions = []; serverRunning = false;
    shownTranslation = {}; viewed = {}; confirmKey = null; deletingId = null;
    void loadHistory(id);
  });
  $effect(() => {
    const fresh = planJob?.run;
    if (fresh && fresh.id !== activeRunId) { activeRunId = fresh.id; void loadHistory(videoId); }
  });
  $effect(() => {
    if (!running) return;
    now = Date.now();
    const timer = setInterval(() => { now = Date.now(); }, 250);
    return () => clearInterval(timer);
  });
  $effect(() => {
    if (!serverRunning) return;
    const id = videoId;
    const timer = setInterval(() => { void loadHistory(id); }, 2500);
    return () => clearInterval(timer);
  });
  onMount(() => {
    void (async () => {
      try {
        await Promise.all([refreshReverseConfig(), refreshVideoPromptSettings()]);
      } catch (e) { error = errorMessage(e); }
    })();
  });

  async function loadHistory(id: number, more = false) {
    const sequence = ++loadSequence;
    loading = true;
    try {
      const result = await videoPromptApi.history(id, 10, more ? runs.length : 0);
      if (videoId !== id || sequence !== loadSequence) return;
      runs = more ? [...runs, ...result.runs] : result.runs;
      total = result.total; serverRunning = result.running;
      if (!more) { viewed = {}; confirmKey = null; }  // 列表换了一批，停看的旧版本不再有效
      if (activeRunId === null || !runs.some(item => item.id === activeRunId)) activeRunId = runs[0]?.id ?? null;
    } catch (e) {
      if (videoId === id && sequence === loadSequence) error = errorMessage(e);
    } finally {
      if (videoId === id && sequence === loadSequence) loading = false;
    }
  }

  async function buildPlan() {
    if (!modelId) return;
    error = "";
    const plan = await generatePlan(videoId, {
      model_config_id: modelId,
      sound_note: soundNote.trim() || null,
      start_ms: secondsInputToMs(startText),
      end_ms: secondsInputToMs(endText),
    });
    if (plan) { activeRunId = plan.id; await loadHistory(videoId); }
  }

  function jobFor(index: number, target: PromptTarget) {
    return run ? $videoPromptJobs[segmentKey(run.id, index, target)] : undefined;
  }
  /** 这一段这个格式是不是正在生成（按钮上的小转圈与卡片高亮都看它）。 */
  function busyFor(index: number, target: PromptTarget) {
    return !!jobFor(index, target)?.running;
  }
  function elapsedOf(startedAt?: number) {
    return elapsedText(startedAt, now);
  }
  /** 串行队列里当前是第几项：已完成数 + 1，就是正在跑的那一项。 */
  function queuePosition() {
    return queue && queue.total > 1 ? Math.min(queue.done + 1, queue.total) : 0;
  }
  function recordFor(index: number, target: PromptTarget): SegmentRecord | undefined {
    const unit = units.find(item => item.index === index);
    const stored = unit?.current?.[target];
    const job = jobFor(index, target);
    return stored ?? job?.result;
  }
  function keyOf(index: number, target: PromptTarget): string {
    return run ? segmentKey(run.id, index, target) : "";
  }
  /** 正在看的历史版本，没有就返回 undefined（看当前版）。 */
  function viewedOf(index: number, target: PromptTarget): SegmentRecord | undefined {
    const key = keyOf(index, target);
    return key ? viewed[key] : undefined;
  }
  /** 面板显示的正文：点了历史版本就显示那一版，否则显示当前版。 */
  function shownRecord(index: number, target: PromptTarget): SegmentRecord | undefined {
    return viewedOf(index, target) ?? recordFor(index, target);
  }
  function toggleView(version: SegmentRecord) {
    const key = keyOf(version.segment_index, version.target);
    if (!key) return;
    // 点的就是当前版：回到当前版；再点自己一次也是回到当前版
    if (viewed[key]?.id === version.id || recordFor(version.segment_index, version.target)?.id === version.id) {
      delete viewed[key];
    } else {
      viewed[key] = version;
    }
  }
  function backToCurrent(index: number, target: PromptTarget) {
    const key = keyOf(index, target);
    if (key) delete viewed[key];
  }
  /** 删一个版本：第一次点击只进入确认态，第二次真删，然后刷新这段的版本与当前版。 */
  async function removeVersion(version: SegmentRecord) {
    if (!run) return;
    const key = keyOf(version.segment_index, version.target);
    const armed = `${key}:${version.id}`;
    if (confirmKey !== armed) { confirmKey = armed; return; }
    const runId = run.id;
    deletingId = version.id; error = "";
    try {
      await videoPromptApi.removeRecord(videoId, runId, version.segment_index, version.target, version.id);
      if (viewed[key]?.id === version.id) delete viewed[key];
      confirmKey = null;
      const rest = await videoPromptApi.versions(videoId, runId, version.segment_index, version.target);
      versions = rest.records;
      if (!rest.records.length) versionsKey = null;
      await loadHistory(videoId);
    } catch (e) { error = errorMessage(e); }
    finally { deletingId = null; }
  }

  async function generate(indexes: number[], targets: PromptTarget[], scope: "tab" | "both" | null = null) {
    if (!run || !modelId) return;
    error = ""; allScope = scope;
    const failures = await generateSegments(videoId, run.id, indexes, targets, {
      modes: mode, model_config_id: modelId,
    });
    await loadHistory(videoId);
    if (failures.length) error = `${failures.length} 段生成失败，可单独重试该段。`;
  }

  async function copy(text: string, label = "提示词") {
    const ok = await copyText(text);
    pushToast(ok ? `${label}已复制` : "复制失败", { kind: ok ? "success" : "error" });
  }

  function startEdit(record: SegmentRecord) {
    editingKey = segmentKey(run!.id, record.segment_index, record.target);
    editText = record.status === "unstructured" ? record.raw_text : record.prompt;
  }
  async function saveEdit(record: SegmentRecord) {
    if (!run) return;
    saving = true; error = "";
    try {
      await videoPromptApi.edit(videoId, run.id, record.segment_index,
        { target: record.target, prompt: editText, parent_id: record.id });
      editingKey = null;
      await loadHistory(videoId);
    } catch (e) { error = errorMessage(e); }
    finally { saving = false; }
  }
  // ---------- 译文：点一下就换成译文，再点换回原文 ----------

  function originalOf(record: SegmentRecord): string {
    return record.status === "unstructured" ? record.raw_text : record.prompt;
  }
  function trKey(record: SegmentRecord): string {
    return run ? translationKey(run.id, record.segment_index, record.target) : "";
  }
  function trJob(record: SegmentRecord) {
    const key = trKey(record);
    return key ? $translationJobs[key] : undefined;
  }
  function translationFor(record: SegmentRecord) {
    const key = trKey(record);
    return key ? translationOf(record, key, $translationJobs) : null;
  }
  function showingTranslation(record: SegmentRecord): boolean {
    const key = trKey(record);
    return !!key && !!translationFor(record) && !!shownTranslation[key];
  }
  async function toggleTranslation(record: SegmentRecord) {
    const key = trKey(record);
    if (!key || !run) return;
    if (shownTranslation[key]) { shownTranslation[key] = false; return; }
    if (translationFor(record)) { shownTranslation[key] = true; return; }  // 已有译文，不再花调用
    const value = await translatePrompt(videoId, run.id, record.segment_index, record.target,
      { model_config_id: modelId });
    if (value) shownTranslation[key] = true;
  }

  /**
   * 这段要备哪些参考：正文的模式和当前选中的模式一致时按正文解析出的清单，
   * 换了模式（或还没正文）就按当前模式给计划——用户切模式时想知道"这样生成要备什么"。
   */
  function referencesOf(record: SegmentRecord | undefined, unit: PromptUnit): PromptReference[] {
    const matches = !record || record.mode == null || record.mode === mode[tab];
    return matches && record ? record.references : plannedReferences(tab, mode[tab], unit);
  }

  const slotCounts = countSlots;
  const tooMany = overSlots;

  async function toggleVersions(record: SegmentRecord) {
    const key = segmentKey(run!.id, record.segment_index, record.target);
    confirmKey = null;
    if (versionsKey === key) { versionsKey = null; versions = []; return; }
    versionsKey = key; versions = [];
    try { versions = (await videoPromptApi.versions(videoId, run!.id, record.segment_index, record.target)).records; }
    catch (e) { error = errorMessage(e); }
  }

</script>

<section class="rounded-md border border-border bg-surface-2 p-3 space-y-3" aria-label="AI 反推视频提示词">
  <div class="flex items-baseline justify-between gap-2">
    <h4 class="text-[11px] uppercase tracking-wider text-muted">AI 反推视频提示词</h4>
    <span class="text-[10px] text-muted">{secondsText}</span>
  </div>

  {#if !$modelConfigs.length}
    <button class="vp-button" onclick={() => window.dispatchEvent(new CustomEvent("open-model-settings"))}>配置模型</button>
    <p class="text-[10px] text-muted">需要先在「设置 · 模型与反推」里配置一个支持图片输入的模型。</p>
  {:else}
    <div class="space-y-2">
      <label class="block text-[11px] text-muted">反推模型
        <select class="vp-field" aria-label="视频反推模型" value={modelId ?? ""} disabled={running}
          onchange={(e) => modelId = Number((e.currentTarget as HTMLSelectElement).value)}>
          {#each $modelConfigs as model}<option value={model.id}>{model.name} · {model.model}</option>{/each}
        </select>
      </label>
      <div class="flex gap-2">
        <label class="flex-1 text-[11px] text-muted">起始秒（整数）
          <input class="vp-field" aria-label="反推起始秒" type="number" min="0" step="1" placeholder="0" bind:value={startText} disabled={running} />
        </label>
        <label class="flex-1 text-[11px] text-muted">结束秒（整数）
          <input class="vp-field" aria-label="反推结束秒" type="number" min="0" step="1" placeholder={durationSeconds ? secondText(durationSeconds * 1000) : "结尾"} bind:value={endText} disabled={running} />
        </label>
      </div>
      <label class="block text-[11px] text-muted">听到的声音 / 台词原文（选填，避免猜错口型与配乐）
        <textarea class="vp-field" aria-label="声音与台词" rows="2" placeholder="例：女声普通话说「……」，无背景音乐" bind:value={soundNote} disabled={running}></textarea>
      </label>
      <button class="vp-button vp-primary" disabled={running || !modelId}
        data-busy={planRunning ? "true" : undefined} onclick={buildPlan}>
        {#if planRunning}<span class="vp-spin vp-spin-sm" aria-hidden="true"></span>{/if}
        {planRunning ? "正在拆分镜方案…" : "反推分镜方案"}
      </button>
      {#if planRunning}
        <div class="vp-progress" role="status" aria-live="polite" data-testid="plan-progress">
          <div class="vp-progress-top">
            <span class="vp-spin" aria-hidden="true"></span>
            <span class="vp-progress-title">正在反推分镜方案</span>
            {#if elapsedOf(planJob?.startedAt)}<span class="vp-progress-time">已等 {elapsedOf(planJob?.startedAt)}</span>{/if}
          </div>
          <p class="vp-progress-note">镜头切点已由本机 ffmpeg 算好，模型正在写全局锚点与每段职责——这是 1 次模型调用，通常十几到几十秒。</p>
          <span class="vp-bar" aria-hidden="true"><i></i></span>
          <span class="vp-skeleton" aria-hidden="true"><i style="width:86%"></i><i style="width:64%"></i></span>
        </div>
      {/if}
      <p class="text-[10px] text-muted">
        方案与格式无关：1 次调用；之后每段正文每种格式各 1 次调用。画面按镜头切点自动分段，每段不超 {prefs?.max_unit_seconds ?? 15} 秒。
      </p>
    </div>
  {/if}

  {#if planError}<p class="text-xs text-danger" role="alert">{planError}</p>{/if}
  {#if !run && loading}<p class="text-xs text-muted">正在读取历史…</p>
  {:else if !run}<p class="text-xs text-muted">还没有分镜方案。点「反推分镜方案」先做镜头切分。</p>{/if}

  {#if run && run.status === "planned"}
    <div class="space-y-2 border-t border-border pt-3">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-[10px] text-muted">
          {new Date(run.created_at).toLocaleString()} · {run.model_name} · {units.length} 段
        </span>
        {#if run.video_changed}<span class="vp-badge vp-warn">视频文件已变化</span>{/if}
        {#if run.sound_note}<span class="vp-badge">已提供参考声音</span>
        {:else}<span class="vp-badge">声音为画面推测</span>{/if}
      </div>
      <div class="rounded border border-border bg-surface p-2">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[10px] uppercase tracking-wider text-muted">全局锚点</span>
          <button class="vp-button" onclick={() => copy(run?.anchors_text ?? "", "锚点已")}>复制锚点</button>
        </div>
        <div class="vp-body mt-1 max-h-40">{run.anchors_text}</div>
      </div>
      {#if run.risk_terms.length}
        <details class="text-[11px]">
          <summary class="cursor-pointer text-amber-400">敏感词提示（{run.risk_terms.length}）</summary>
          <ul class="mt-1 space-y-0.5 text-amber-400">
            {#each run.risk_terms as term}<li>{term}</li>{/each}
          </ul>
        </details>
      {/if}

      <div class="flex gap-2 flex-wrap items-center">
        <div class="flex rounded border border-border overflow-hidden">
          {#each TARGETS as format}
            <button class="vp-tab" aria-pressed={tab === format} onclick={() => tab = format}>{TARGET_LABELS[format]}</button>
          {/each}
        </div>
        <button class="vp-button" disabled={running || !units.length || !modelId}
          data-busy={queue && allScope === "tab" ? "true" : undefined}
          onclick={() => generate(units.map(u => u.index), [tab], "tab")}>{#if queue && allScope === "tab"}<span class="vp-spin vp-spin-sm" aria-hidden="true"></span>{/if}全部生成（{TARGET_LABELS[tab]}）</button>
        <button class="vp-button" disabled={running || !units.length || !modelId}
          data-busy={queue && allScope === "both" ? "true" : undefined}
          onclick={() => generate(units.map(u => u.index), ["seedance2", "h3"], "both")}>{#if queue && allScope === "both"}<span class="vp-spin vp-spin-sm" aria-hidden="true"></span>{/if}全部生成（两种）</button>
        {#if queue && queue.total > 1}
          <div class="vp-queue" role="status" aria-live="polite" data-testid="queue-progress">
            <span class="vp-spin" aria-hidden="true"></span>
            <span class="vp-queue-text">串行生成 {queue.done}/{queue.total}</span>
            <span class="vp-queue-bar" aria-hidden="true">
              <i style="width:{Math.round((queue.done / Math.max(1, queue.total)) * 100)}%"></i>
            </span>
          </div>
        {/if}
      </div>

      <div class="flex items-center gap-2">
        <span class="vp-label">{tab === "h3" ? "H3 模式" : "Seedance 模式"}</span>
        <select class="vp-field vp-field-inline min-w-0 flex-1"
          aria-label={tab === "h3" ? "H3 模式" : "Seedance 模式"} value={mode[tab]} disabled={running}
          onchange={(e) => mode = { ...mode, [tab]: (e.currentTarget as HTMLSelectElement).value as PromptMode }}>
          {#each MODES_BY_TARGET[tab] as option}
            <option value={option}>{MODE_LABELS[option]}</option>
          {/each}
        </select>
        <span class="vp-help" class:open={modeHelpOpen}>
          <button class="vp-help-button" type="button" aria-label={tab === "h3" ? "H3 模式说明" : "Seedance 模式说明"}
            onclick={() => modeHelpOpen = !modeHelpOpen} onpointerleave={() => modeHelpOpen = false}>?</button>
          <span class="vp-help-card" role="tooltip" data-testid="mode-hints">
            {#each MODES_BY_TARGET[tab] as option}
              <span class="vp-help-row" data-testid={`mode-hint-${option}`}>
                <b>{MODE_LABELS[option]}</b>
                <span>{MODE_HINTS[option]}</span>
              </span>
            {/each}
            {#if mode[tab] !== "t2v" && mode[tab] !== "t2va"}
              <span class="vp-help-note">每段下方「本段需要的参考」按编号列出要上传的素材；带缩略图的帧本工具能直接给，复制或存成 <code>{baseName}-图片1-P02-first.jpg</code> 这类文件名再上传。</span>
            {/if}
            {#if tab === "seedance2"}
              <span class="vp-help-note">官方口径：2.0 不认秒级时间轴，只认镜头序号，所以【分镜】写「镜头1：」不写「0-3 秒：」；一个镜头只用一种运镜；正文建议 {SEEDANCE_CHAR_GUIDE} 字以内。</span>
            {/if}
          </span>
        </span>
      </div>

      <div class="space-y-2">
        {#each units as unit}
          {@const record = shownRecord(unit.index, tab)}
          {@const viewing = viewedOf(unit.index, tab)}
          {@const job = jobFor(unit.index, tab)}
          {@const tag = `P${String(unit.index).padStart(2, "0")}`}
          {@const framesKey = `${run.id}:` + unit.index}
          {@const refs = referencesOf(record, unit)}
          {@const framesOpen = openFrames[framesKey] ?? !!record}
          <article class="rounded border border-border bg-surface p-2 space-y-2"
            data-running={job?.running ? "true" : undefined}>
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="text-[11px] font-semibold">
                  {tag}｜{secondText(unit.end_ms - unit.start_ms)} 秒｜原片 {secondsRangeText(unit.start_ms, unit.end_ms)}
                </div>
                <div class="text-[11px] text-muted">{unit.role || "（未给出职责）"}</div>
                <div class="flex gap-1 flex-wrap mt-1">
                  {#if unit.warn}<span class="vp-badge vp-warn">{unit.warn}</span>{/if}
                  {#if unit.shots.length > 1}<span class="vp-badge">{unit.shots.length} 个镜头</span>{/if}
                  {#if unit.shots.some(s => s.synthetic)}<span class="vp-badge">含等分点</span>{/if}
                </div>
              </div>
              <div class="flex gap-1 shrink-0">
                <button class="vp-button" disabled={running || !modelId}
                  data-busy={busyFor(unit.index, "seedance2") ? "true" : undefined}
                  onclick={() => generate([unit.index], ["seedance2"])}>
                  {#if busyFor(unit.index, "seedance2")}<span class="vp-spin vp-spin-sm" aria-hidden="true"></span>{/if}Seedance</button>
                <button class="vp-button" disabled={running || !modelId}
                  data-busy={busyFor(unit.index, "h3") ? "true" : undefined}
                  onclick={() => generate([unit.index], ["h3"])}>
                  {#if busyFor(unit.index, "h3")}<span class="vp-spin vp-spin-sm" aria-hidden="true"></span>{/if}H3</button>
                <button class="vp-button" disabled={running || !modelId}
                  data-busy={busyFor(unit.index, "seedance2") || busyFor(unit.index, "h3") ? "true" : undefined}
                  onclick={() => generate([unit.index], ["seedance2", "h3"])}>
                  {#if busyFor(unit.index, "seedance2") || busyFor(unit.index, "h3")}
                    <span class="vp-spin vp-spin-sm" aria-hidden="true"></span>{/if}两种都要</button>
              </div>
            </div>

            {#if refs.length}
              <details class="vp-frames" open={framesOpen}
                ontoggle={(e) => openFrames[framesKey] = (e.currentTarget as HTMLDetailsElement).open}>
                <summary class="vp-frames-summary">
                  本段需要的参考（图 {slotCounts(refs).picture} · 视频 {slotCounts(refs).video} · 音频 {slotCounts(refs).audio}）
                  · 原片帧 @{wholeSecond(unitFrameAt(unit, "first"))}–@{wholeSecond(unitFrameAt(unit, "last"))} 秒
                </summary>
                {#if framesOpen}
                  <ul class="mt-1 space-y-2">
                    {#each refs as ref}
                      <li class="vp-ref" aria-label={`${tag} ${ref.label}`} data-testid={`ref-${unit.index}-${ref.label}`}>
                        <div class="flex items-baseline gap-2 flex-wrap">
                          <code class="vp-ref-label">{ref.label}</code>
                          <!-- 说明一律中文；正文里的英文原文收进悬停提示，不让英文占据清单 -->
                          <span class="text-[10px] text-muted {ref.what_en ? "cursor-help" : ""}"
                            title={ref.what_en || undefined}>{ref.what}</span>
                        </div>
                        {#if ref.frame}
                          <VideoFrameThumb {videoId} runId={run.id} index={ref.frame.index} edge={ref.frame.edge}
                            at={unitFrameAt(unit, ref.frame.edge)} fileBase={baseName + "-" + refFileTag(ref.label)}
                            usage={refFileTag(ref.label)} />
                        {:else}
                          <p class="text-[10px] text-muted">
                            {#if ref.slot === "video"}需要自备视频：本工具不生成视频，按上面的说明导出成品后按这个编号上传。
                            {:else if ref.slot === "audio"}需要自备音频：按上面的说明准备音频文件后按这个编号上传。
                            {:else}需要自备图片：本工具拿不到这张图，按上面的说明准备后按这个编号上传。{/if}
                          </p>
                        {/if}
                        {#if ref.warn}<p class="text-[10px] text-amber-400">{ref.warn}</p>{/if}
                      </li>
                    {/each}
                  </ul>
                  {#if tooMany(refs).length}
                    <p class="mt-1 text-[10px] text-danger" role="alert">
                      {tooMany(refs, tab).map((slot) => `${SLOT_LABELS[slot]} ${slotCounts(refs)[slot]} 个`).join("、")}
                      超过{slotLimitText(tab)}，请合并素材后编辑正文。
                    </p>
                  {/if}
                {/if}
              </details>
            {/if}

            {#if job?.running}
              <div class="vp-progress" role="status" aria-live="polite" data-testid={`progress-${unit.index}-${tab}`}>
                <div class="vp-progress-top">
                  <span class="vp-spin" aria-hidden="true"></span>
                  <span class="vp-progress-title">正在生成 {TARGET_LABELS[tab]} 正文</span>
                  {#if elapsedOf(job.startedAt)}<span class="vp-progress-time">已等 {elapsedOf(job.startedAt)}</span>{/if}
                </div>
                <p class="vp-progress-note">
                  {#if queuePosition()}队列第 {queuePosition()}/{queue?.total} 项 · {/if}
                  本段 {secondText(unit.end_ms - unit.start_ms)} 秒 · 1 次模型调用，通常十几到几十秒 ·
                  其余段排队中，可以切到另一种格式先做别的
                </p>
                <span class="vp-bar" aria-hidden="true"><i></i></span>
                <span class="vp-skeleton" aria-hidden="true">
                  <i style="width:92%"></i><i style="width:78%"></i><i style="width:52%"></i>
                </span>
              </div>
            {:else if job?.error && !record}
              <div class="flex items-center gap-2 text-[11px] text-danger">
                <span>{job.error}</span>
                <button class="vp-button" disabled={running} onclick={() => generate([unit.index], [tab])}>重试本段</button>
              </div>
            {:else if record}
              <div class="space-y-1.5">
                {#if viewing}
                  <div class="flex items-center gap-2 flex-wrap text-[10px] text-amber-400">
                    <span>
                      正在看历史版本 #{viewing.id}（{new Date(viewing.created_at).toLocaleString()}），
                      当前版本 #{recordFor(unit.index, tab)?.id}。复制与编辑都针对这一版；编辑会存成新版本。
                    </span>
                    <button class="vp-button" onclick={() => backToCurrent(unit.index, tab)}>回到当前版本</button>
                  </div>
                {/if}
                <div class="flex items-center gap-2 flex-wrap text-[10px] text-muted">
                  <span>{record.model_name} · {record.model}</span>
                  <span>{record.source === "edited" ? "手动编辑" : "模型生成"}</span>
                  {#if record.mode}<span class="vp-badge">{MODE_BADGES[record.mode]}</span>{/if}
                  {#if record.target === "seedance2" && cjkCount(originalOf(record)) > SEEDANCE_CHAR_GUIDE}
                    <span class="vp-badge vp-warn" title="Seedance 官方建议单条正文不超过 500 字，太长模型会丢细节">
                      {cjkCount(originalOf(record))} 字 · 超建议 {SEEDANCE_CHAR_GUIDE} 字
                    </span>
                  {/if}
                  {#if record.video_changed}<span class="vp-badge vp-warn">对应此前视频文件</span>{/if}
                  {#if record.status !== "complete"}<span class="vp-badge vp-warn">
                    {record.status === "format_warning" ? "格式不完整" : "未结构化"}</span>{/if}
                </div>
                {#if record.status !== "complete"}
                  <p class="text-[11px] text-amber-400">
                    {record.status === "format_warning"
                      ? "正文缺了必需的段落或首行不符，可编辑补齐，或复制原文自行整理。"
                      : "模型没按 JSON 返回，下面是原文。"}
                  </p>
                {/if}
                {#if editingKey === segmentKey(run.id, unit.index, tab)}
                  <textarea class="vp-field" rows="10" aria-label={`编辑 ${tag} ${TARGET_LABELS[tab]}`} bind:value={editText}></textarea>
                  <div class="flex gap-1">
                    <button class="vp-button" disabled={saving || !editText.trim()} onclick={() => record && saveEdit(record)}>保存为新版本</button>
                    <button class="vp-button" disabled={saving} onclick={() => editingKey = null}>取消编辑</button>
                  </div>
                {:else}
                  {@const original = originalOf(record)}
                  {@const translation = translationFor(record)}
                  {@const showing = showingTranslation(record)}
                  <div class="vp-body max-h-72">{showing ? translation?.text : original}</div>
                  {#if showing}
                    <p class="text-[10px] text-muted">
                      译文（{TRANSLATION_LABELS[translation?.language ?? "zh"]}）由 {translation?.model_name} 机器翻译，只用于阅读；
                      时间戳、结构标记与画面文字按原样保留。
                    </p>
                  {:else if trJob(record)?.error}
                    <p class="text-[11px] text-danger" role="alert">{trJob(record)?.error}</p>
                  {/if}
                  <div class="flex gap-1 flex-wrap">
                    <button class="vp-button" onclick={() => copy(original, TARGET_LABELS[tab])}>
                      复制{TARGET_LABELS[tab]}
                    </button>
                    {#if showing}
                      <button class="vp-button" onclick={() => copy(translation?.text ?? "", "译文已")}>复制译文</button>
                    {/if}
                    {#if record.status !== "complete" && record.raw_text}
                      <button class="vp-button" onclick={() => copy(record?.raw_text ?? "", "原文已")}>复制原文</button>
                    {/if}
                    <button class="vp-button" disabled={running} onclick={() => record && startEdit(record)}>编辑</button>
                    <button class="vp-button" aria-label={`查看 ${tag} ${TARGET_LABELS[tab]} 历史版本`}
                      onclick={() => record && toggleVersions(record)}>
                      版本（{unit.versions?.[record.target] ?? run.versions[record.target]}）
                    </button>
                    <button class="vp-button" disabled={running} onclick={() => generate([unit.index], [tab])}>重跑本段</button>
                    {#if viewing}
                      <span class="text-[10px] text-muted self-center">译文只针对当前版本</span>
                    {/if}
                    <button class="vp-button vp-translate" aria-pressed={showing}
                      aria-label={`${showing ? "显示原文" : "翻译"} ${tag} ${TARGET_LABELS[tab]}`}
                      title="中英互译：译文只用于阅读，复制走的仍是原文"
                      hidden={!!viewing}
                      disabled={running || !original.trim() || !!trJob(record)?.running}
                      onclick={() => toggleTranslation(record)}>
                      <svg class="vp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                        <rect x="2" y="2.5" width="11" height="11" rx="2.5" />
                        <rect x="11" y="10.5" width="11" height="11" rx="2.5" fill="#202024" />
                        <text x="7.5" y="11.6" text-anchor="middle" font-size="8" fill="currentColor" stroke="none">中</text>
                        <text x="16.5" y="19.6" text-anchor="middle" font-size="8" fill="currentColor" stroke="none">A</text>
                      </svg>
                      {#if trJob(record)?.running}<span class="vp-spin vp-spin-sm" aria-hidden="true"></span>{/if}
                      <span>{trJob(record)?.running ? "翻译中" : showing ? "原文" : "译文"}</span>
                    </button>
                  </div>
                  {#if record.risk_terms.length}
                    <details class="text-[11px]">
                      <summary class="cursor-pointer text-amber-400">本段敏感词（{record.risk_terms.length}）</summary>
                      <ul class="mt-1 space-y-0.5 text-amber-400">{#each record.risk_terms as term}<li>{term}</li>{/each}</ul>
                    </details>
                  {/if}
                {/if}
                {#if versionsKey === segmentKey(run.id, unit.index, tab)}
                  <div class="space-y-1 max-h-48 overflow-auto" aria-label={`${tag} 历史版本`}>
                    <p class="text-[10px] text-muted">点某一版就地查看它的正文；不需要的可以直接删除，删掉最新版会自动退回次新一版。</p>
                    {#each versions as version}
                      {@const armed = `${segmentKey(run.id, unit.index, tab)}:${version.id}`}
                      <div class="flex items-center gap-1">
                        <button class="vp-version min-w-0 flex-1 text-left" aria-pressed={record?.id === version.id}
                          title="查看这一版正文" onclick={() => toggleView(version)}>
                          #{version.id} {new Date(version.created_at).toLocaleString()} ·
                          {version.source === "edited" ? "手动编辑" : "模型生成"} · {version.model_name}
                          {#if version.id === recordFor(unit.index, tab)?.id}<span class="vp-badge">当前</span>{/if}
                        </button>
                        {#if confirmKey === armed}
                          <span class="text-[10px] text-amber-400 whitespace-nowrap">删除这版？</span>
                          <button class="vp-button vp-danger" aria-label="确认删除这一版"
                            disabled={deletingId !== null} onclick={() => removeVersion(version)}>确认删除</button>
                          <button class="vp-button" onclick={() => confirmKey = null}>取消</button>
                        {:else}
                          <button class="vp-button" title="删除这一版" aria-label={`删除 ${tag} 版本 ${version.id}`}
                            disabled={deletingId !== null || running || job?.running}
                            onclick={() => removeVersion(version)}>{deletingId === version.id ? "删除中…" : "删除"}</button>
                        {/if}
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {:else}
              <p class="text-[11px] text-muted">该段还没有 {TARGET_LABELS[tab]} 正文。</p>
            {/if}
          </article>
        {/each}
      </div>
    </div>
  {/if}

  {#if total > 1 || (run && run.status === "failed")}
    <div class="border-t border-border pt-2">
      <button class="vp-button" onclick={() => runsOpen = !runsOpen}>历史方案（{total}）</button>
      {#if runsOpen}
        <div class="mt-2 space-y-1 max-h-48 overflow-auto" aria-label="历史分镜方案">
          {#each runs as item}
            <button class="block w-full text-left text-[11px]" aria-pressed={run?.id === item.id}
              onclick={() => activeRunId = item.id}>
              {new Date(item.created_at).toLocaleString()} ·
              {item.status === "planned" ? `${item.units.length} 段` : "失败"} ·
              {item.model_name} · {TARGET_LABELS.seedance2}{item.versions.seedance2}/H3{item.versions.h3}
            </button>
          {/each}
          {#if runs.length < total}
            <button class="vp-button" disabled={loading} onclick={() => loadHistory(videoId, true)}>加载更多</button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .vp-field {
    display: block; width: 100%; margin-top: 4px; padding: 6px 8px; font-size: 11px;
    color: #e4e4e7; background: #18181b; border: 1px solid #3f3f46; border-radius: 5px;
  }
  /* 与标签同行时去掉 margin-top 与 100% 宽，否则"H3 模式"会被挤成两行 */
  .vp-field-inline { display: inline-block; width: auto; margin-top: 0; }
  .vp-label { font-size: 11px; color: #a1a1aa; flex: none; white-space: nowrap; }
  .vp-version { font-size: 10px; padding: 4px 6px; border: 1px solid #3f3f46; border-radius: 5px; background: #18181b; }
  .vp-version[aria-pressed="true"] { border-color: #f24e4e; color: #fda4a4; }
  .vp-danger { color: #f87171; border-color: #7f1d1d; background: #2a1414; }
  .vp-button {
    font-size: 11px; padding: 5px 8px; border: 1px solid #3f3f46; border-radius: 5px; background: #202024;
  }
  .vp-button:disabled { opacity: .5; cursor: default; }
  /* 正在跑的那颗按钮不变灰，反而亮起来：一眼看出"你点的这一下确实开始了"。 */
  .vp-button[data-busy="true"]:disabled {
    opacity: 1; color: #fda4a4; border-color: #f24e4e; background: #241416;
  }
  .vp-primary:enabled:hover, .vp-primary:enabled:focus-visible {
    background-color: #f24e4e; color: #0e0e10; border-color: #f24e4e;
  }
  .vp-tab { font-size: 11px; padding: 5px 10px; background: #202024; }
  .vp-tab[aria-pressed="true"] { background: #f24e4e; color: #0e0e10; }
  .vp-badge {
    font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid #3f3f46; color: #a1a1aa;
  }
  .vp-translate { display: inline-flex; align-items: center; gap: 4px; }
  .vp-icon { width: 15px; height: 15px; flex: none; }
  .vp-warn { color: #fbbf24; border-color: #78500f; }
  /* H3 模式说明：一个问号 + 悬停浮层，四种模式各一行，不再占一整块正文 */
  .vp-help { position: relative; display: inline-flex; flex: none; }
  .vp-help-button {
    width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid #3f3f46; border-radius: 999px; background: #202024; color: #a1a1aa;
    font-size: 11px; font-weight: 600; line-height: 1;
  }
  .vp-help-button:hover, .vp-help-button:focus-visible { border-color: #f24e4e; color: #fda4a4; }
  .vp-help-card {
    position: absolute; top: calc(100% + 6px); right: 0; z-index: 40; width: 268px;
    display: flex; flex-direction: column; gap: 6px; padding: 8px; background: #0e0e10;
    border: 1px solid #3f3f46; border-radius: 6px; box-shadow: 0 10px 28px rgba(0, 0, 0, .55);
    opacity: 0; visibility: hidden; pointer-events: none; transition: opacity .12s ease;
  }
  .vp-help:hover .vp-help-card, .vp-help:focus-within .vp-help-card, .vp-help.open .vp-help-card {
    opacity: 1; visibility: visible; pointer-events: auto;
  }
  .vp-help-row { display: flex; flex-direction: column; gap: 1px; font-size: 10px; line-height: 1.5; color: #a1a1aa; }
  .vp-help-row b { color: #e4e4e7; }
  .vp-help-note { font-size: 10px; line-height: 1.5; color: #71717a; }
  .vp-frames { border: 1px solid #2e2e33; border-radius: 5px; background: #121215; padding: 6px 8px; }
  .vp-frames-summary { font-size: 10px; color: #a1a1aa; cursor: pointer; user-select: none; }
  .vp-ref { display: flex; flex-direction: column; gap: 4px; }
  .vp-ref-label {
    font-size: 10px; padding: 1px 6px; border-radius: 4px; color: #fbbf24;
    background: #1f1a10; border: 1px solid #4a3a12; width: fit-content;
  }
  /* 生成中的反馈：转圈 + 走秒 + 进度条 + 骨架线。一次模型调用没有可上报的百分比，
     所以"仍在推进"的证据靠动画与计时，队列进度条才是真百分比。 */
  .vp-spin {
    width: 12px; height: 12px; flex: none; display: inline-block; border-radius: 999px;
    border: 2px solid rgba(242, 78, 78, .22); border-top-color: #f24e4e;
    animation: vp-spin .7s linear infinite; vertical-align: -2px;
  }
  .vp-spin-sm { width: 10px; height: 10px; border-width: 1.5px; }
  @keyframes vp-spin { to { transform: rotate(360deg); } }
  .vp-progress {
    display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 6px;
    border: 1px solid #5d3a1a; background: linear-gradient(180deg, #1c1510, #14110f);
  }
  .vp-progress-top { display: flex; align-items: center; gap: 6px; }
  .vp-progress-title { font-size: 11px; font-weight: 600; color: #fda4a4; }
  .vp-progress-time { margin-left: auto; font-size: 10px; color: #a1a1aa; font-variant-numeric: tabular-nums; }
  .vp-progress-note { font-size: 10px; line-height: 1.5; color: #a1a1aa; }
  .vp-bar { position: relative; display: block; height: 3px; border-radius: 999px; background: #2a2a30; overflow: hidden; }
  .vp-bar i {
    position: absolute; top: 0; bottom: 0; left: 0; width: 34%; border-radius: 999px;
    background: linear-gradient(90deg, transparent, #f24e4e, transparent);
    animation: vp-sweep 1.2s ease-in-out infinite;
  }
  @keyframes vp-sweep { 0% { transform: translateX(-110%); } 100% { transform: translateX(320%); } }
  .vp-skeleton { display: flex; flex-direction: column; gap: 4px; }
  .vp-skeleton i {
    height: 8px; border-radius: 3px; background: linear-gradient(90deg, #1d1d21 0%, #2e2e36 50%, #1d1d21 100%);
    background-size: 200% 100%; animation: vp-shimmer 1.4s linear infinite;
  }
  @keyframes vp-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  .vp-queue { display: flex; align-items: center; gap: 6px; flex: 1 1 160px; min-width: 150px; }
  .vp-queue-text { font-size: 10px; color: #fda4a4; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .vp-queue-bar { flex: 1; height: 3px; border-radius: 999px; background: #2a2a30; overflow: hidden; }
  .vp-queue-bar i { display: block; height: 100%; background: #f24e4e; transition: width .25s ease; }
  article[data-running="true"] { border-color: #f24e4e; animation: vp-breathe 1.7s ease-in-out infinite; }
  @keyframes vp-breathe { 0%, 100% { box-shadow: 0 0 0 0 rgba(242, 78, 78, .22); } 50% { box-shadow: 0 0 0 3px rgba(242, 78, 78, .1); } }
  @media (prefers-reduced-motion: reduce) {
    .vp-spin, .vp-bar i, .vp-skeleton i, article[data-running="true"] { animation: none; }
  }
  .vp-body {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 11.5px; line-height: 1.7; white-space: pre-wrap; word-break: break-word;
    color: #e4e4e7; background: #121215; border: 1px solid #2e2e33; border-radius: 5px; padding: 8px;
    overflow-y: auto;
  }
</style>