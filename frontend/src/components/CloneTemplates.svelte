<script lang="ts">
  /**
   * 设置 → 再次创作：工作流模板的导入与确认。
   *
   * 为什么导入要人确认一遍槽位：自动检测只能猜「哪个输入框是提示词、哪个节点收参考图、
   * 哪两个控件值得放进弹窗」。猜错的代价是生成出来的图不对，而用户在弹窗里根本看不出
   * 是哪个节点没被写。所以这里先把检测结果摊开给人勾选，确认后才落库。
   *
   * 工作流随时可换：再导一份新的，旧模板留着，切哪一条在列表里点「设为当前」。
   */
  import { onMount } from "svelte";
  import { basenameOnly } from "../lib/media-format";
  import { isTauri, selectWorkflowJsonPath } from "../lib/tauri";
  import SettingsRow from "./SettingsRow.svelte";
  import {
    cloneApi, cloneError, promptSlots, imageSlots, controlSlots, referenceCells, slotKey, templateDisplayName,
    familyCells, isAudioTemplate, isVideoTemplate, referenceFamilies, REF_KIND_NAMES,
    templateMediaKind, WF_KIND_WORDS, WF_OUTPUT_WORDS,
    type CloneHiddenBuiltin, type CloneInspect, type CloneSlot, type CloneTemplate,
  } from "../lib/clone";

  let templates = $state<CloneTemplate[]>([]);
  let loading = $state(true);
  let failed = $state(false);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  // 删掉的内置工作流。以前删了就是永别，这一栏是后悔药；老后端没这个接口时留空。
  let hidden = $state<CloneHiddenBuiltin[]>([]);

  // 导入口只有「选文件」这一条：桌面版走原生文件框（只回路径，读文件是后端的活），
  // 浏览器 dev 没有原生框，退化成一颗 display:none 的文件框——真机上它不进版面。
  let pickedFile = $state("");
  let fileEl = $state<HTMLInputElement | null>(null);

  // 导入预览：pending 保存原始工作流，确认后才带着勾选过的 slots 落库。
  let pending = $state<{ inspect: CloneInspect; workflow?: unknown; path?: string } | null>(null);
  let pendingName = $state("");
  let picked = $state<Record<string, boolean>>({});

  async function reload(quiet = false) {
    if (!quiet) loading = true;
    try {
      const res = await cloneApi.templates();
      // 后端答话形状不对也不该白屏：当成「没有模板」，右下角给提示。
      templates = Array.isArray(res?.items) ? res.items : [];
      failed = false;
      // 隐藏列表读不到不能牵连模板本身（老后端根本没这个接口），单独吞掉。
      hidden = await cloneApi.hiddenTemplates().catch(() => []);
    } catch (e) {
      failed = true;
      if (!quiet) error = cloneError(e);
    } finally {
      loading = false;
    }
  }
  onMount(() => void reload());

  /**
   * 槽位确认的分组。参考位按族分开列（图片 / 音频 / 视频）：H3 那种工作流一次冒出
   * 十几条参考槽，混在「参考图」一栏里，谁看得出哪三条其实是音频加载器。
   */
  const groups = $derived.by(() => {
    if (!pending) return [];
    const all = [...pending.inspect.slots, ...pending.inspect.candidates];
    const groupOf = (slot: CloneSlot) => (slot.kind === "prompt" ? "提示词"
      : slot.kind === "image" ? "参考图片"
      : slot.kind === "audio" ? "参考音频"
      : slot.kind === "video" ? "参考视频" : "弹窗控件");
    return ["提示词", "参考图片", "参考音频", "参考视频", "弹窗控件"].map((label) => ({
      label,
      items: all.filter((slot) => groupOf(slot) === label),
    })).filter((group) => group.items.length);
  });

  /** 导入完成后报的各族格数；只有图片一族时不罗嗦。 */
  function refSummary(tpl: CloneTemplate): string {
    const cells = referenceCells(tpl);
    const fams = referenceFamilies(tpl);
    if (!fams.length) return "没认出参考位";
    if (fams.length === 1 && fams[0] === "image" && !isVideoTemplate(tpl) && !isAudioTemplate(tpl)) return `${cells.length} 个参考位`;
    return fams.map((kind) => `${REF_KIND_NAMES[kind]} ${familyCells(cells, kind).length} 格`).join(" / ");
  }

  /**
   * 那颗「选择工作流 JSON」。桌面版开原生框，浏览器 dev 点隐藏的文件框。
   *
   * 原生框取消返回 null，那是用户改了主意，不许报错也不许动已经确认到一半的那份。
   */
  async function pickWorkflowJson() {
    if (busy) return;
    error = "";
    if (!isTauri()) {
      fileEl?.click();
      return;
    }
    let path: string | null = null;
    try {
      path = await selectWorkflowJsonPath();
    } catch (e) {
      error = cloneError(e);
      return;
    }
    if (!path) return;
    pickedFile = path;
    void inspect({ path });
  }

  /** 浏览器版那条文件框：网页里拿不到磁盘路径，只能读成正文直接交后端。 */
  async function onWorkflowFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || busy) return;
    error = "";
    let workflow: unknown;
    try {
      workflow = JSON.parse(await file.text());
    } catch {
      error = "这份文件读不成 JSON，检查一下是不是 ComfyUI「Workflow → Export (API)」导出的那一份。";
      return;
    }
    pickedFile = file.name;
    void inspect({ workflow });
  }
  async function reloadAfter<T>(fn: () => Promise<T>): Promise<void> {
    await fn();
    await reload(true);
  }

  async function inspect(payload: { workflow?: unknown; path?: string }) {
    error = "";
    busy = true;
    try {
      const result = await cloneApi.inspect(payload);
      pending = { inspect: result, ...payload };
      pendingName = templateDisplayName(result.suggested_name) || "未命名工作流";
      // 检测出来的槽位默认全留；candidates（步数、采样器之类）默认不加，避免弹窗一上来全是旋钮。
      picked = {};
      for (const slot of result.slots) picked[slotKey(slot)] = true;
      for (const slot of result.candidates) picked[slotKey(slot)] = false;
      notice = "";
    } catch (e) {
      error = cloneError(e);
      pending = null;
    } finally {
      busy = false;
    }
  }

  /** 原生框那条只回路径，读文件与认格式全在后端，坏格式回来的那句中文原样贴给用户。 */
  async function savePending() {
    if (!pending) return;
    const chosen = [...pending.inspect.slots, ...pending.inspect.candidates]
      .filter((slot) => picked[slotKey(slot)])
      .map((slot) => ({ kind: slot.kind, node: slot.node, input: slot.input, label: slot.label,
                        ...(slot.options ? { options: slot.options } : {}),
                        ...(slot.value !== undefined && slot.value !== null ? { value: slot.value } : {}),
                        ...(slot.min !== undefined && slot.min !== null ? { min: slot.min } : {}),
                        ...(slot.max !== undefined && slot.max !== null ? { max: slot.max } : {}),
                        ...(slot.step !== undefined && slot.step !== null ? { step: slot.step } : {}),
                        // 时长那档的单位与档位是检测出来的：丢了就退成「0.5 秒」这种没人跑得动的预设
                        ...(slot.unit ? { unit: slot.unit } : {}),
                        ...(slot.presets?.length ? { presets: slot.presets } : {}),
                        // 多图参考的扩位信息必须原样带回去：在这儿丢一次，弹窗就只剩一个参考位
                        ...(slot.grow ? { grow: slot.grow } : {}),
                        // 遮罩那四条约定同样是检测出来的，丢一次就少一样：丢了 mask 那颗「画遮罩」
                        // 就不出现；丢了 allow_empty / empty_hint，「提示词留空＝移除」那个模式退回
                        // 成「必须填提示词」；丢了 sync_to，一台采样器的步数不再带动另一台
                        ...(slot.mask ? { mask: slot.mask } : {}),
                        ...(slot.allow_empty ? { allow_empty: true } : {}),
                        ...(slot.empty_hint ? { empty_hint: slot.empty_hint } : {}),
                        ...(slot.sync_to?.length ? { sync_to: slot.sync_to } : {}) }));
    if (!chosen.some((s) => s.kind === "prompt")) {
      error = "至少留一个提示词槽，否则弹窗里没有可改的文案，再次创作就只是重复出一样的图。";
      return;
    }
    busy = true;
    error = "";
    try {
      const saved = await cloneApi.create({
        name: pendingName.trim() || "未命名工作流",
        workflow: pending.workflow,
        path: pending.path,
        slots: chosen,
        // 出片还是出图跟着检测结果走：判错了在这儿改判，别让用户自己猜哪条会出片子
        media_kind: pending.inspect.media_kind ?? "image",
      });
      pending = null;
      pickedFile = "";
      notice = `已导入「${templateDisplayName(saved.name)}」：${refSummary(saved)}。` 
        + `${WF_KIND_WORDS[templateMediaKind(saved)]}卡右下角的图标就是它。`;
      await reload(true);
    } catch (e) {
      error = cloneError(e);
    } finally {
      busy = false;
    }
  }

  /** 恢复一条内置工作流。产出族别的中文名自己判：隐藏项没有模板那些字段。 */
  function hiddenKindWord(kind: string): string {
    return kind === "video" || kind === "audio" || kind === "image"
      ? WF_KIND_WORDS[kind as "image" | "video" | "audio"] : kind;
  }

  async function run(fn: () => Promise<void>, okMessage = "") {
    busy = true;
    error = "";
    try {
      await fn();
      if (okMessage) notice = okMessage;
    } catch (e) {
      error = cloneError(e);
    } finally {
      busy = false;
    }
  }

  let renaming = $state<number | null>(null);
  let renameValue = $state("");
  let confirmDelete = $state<number | null>(null);

  /** 导出走 Blob：图库不新增上传接口，也不该替用户决定文件存哪儿。 */
  async function exportTemplate(tpl: CloneTemplate) {
    await run(async () => {
      const raw = await cloneApi.workflow(tpl.id);
      const blob = new Blob([JSON.stringify(raw, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${templateDisplayName(tpl.name)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  function counts(tpl: CloneTemplate): string {
    const cells = referenceCells(tpl);
    const fams = referenceFamilies(tpl);
    // 三族参考位分开报，混成「15 个参考位」没人知道那是 9 图 + 3 音频 + 3 视频；
    // 只有图片一族时保持原来那句，顺带说清工作流原生能吃几张。
    let refs: string;
    if (fams.length > 1 || isVideoTemplate(tpl) || isAudioTemplate(tpl)) {
      refs = fams.map((kind) => `${REF_KIND_NAMES[kind]} ${familyCells(cells, kind).length}`).join(" / ") || "没有参考位";
    } else {
      const slots = imageSlots(tpl).length || tpl.reference_count || cells.length;
      refs = cells.length > slots ? `${slots} 个参考位（最多吃 ${cells.length} 张）` : `${slots} 个参考位`;
    }
    return [
      `${tpl.node_count} 个节点`,
      `${promptSlots(tpl).length || tpl.prompt_count} 个提示词位`,
      refs,
      `${controlSlots(tpl).length || tpl.control_count} 个弹窗控件`,
    ].join(" · ");
  }
</script>

<div class="settings-card">
  <SettingsRow title="工作流" description="图片卡、视频卡与音频卡右下角的图标都是这个入口：每一族各自记住「当前」那一条——图片卡用出图的，视频卡用出片的，音频卡用出声音的。导一次 ComfyUI 的 API 格式工作流，之后随时替换。" top>
    {#snippet control()}
      <button class="setting-button" disabled={busy} onclick={() => void reload()}>重新读取</button>
    {/snippet}
    {#if loading}
      <div class="clone-load" role="status"><p>正在读取工作流…</p></div>
    {:else if failed}
      <div class="clone-load" role="status"><p>暂时读不到模板，可以重试。</p><button class="setting-button" onclick={() => void reload()}>重新加载</button></div>
    {:else if !templates.length}
      <p class="settings-hint">还没有模板。下面导出一份 ComfyUI 的 API 格式工作流（菜单 Workflow → Export (API)）。</p>
    {:else}
      <ul class="clone-tpl-list">
        {#each templates as tpl (tpl.id)}
          <li class="clone-tpl" class:is-active={tpl.is_active}>
            <div class="clone-tpl-main">
              {#if renaming === tpl.id}
                <input class="setting-control" aria-label="模板名称" bind:value={renameValue}
                  onkeydown={(e) => { if (e.key === "Enter") { void run(async () => { await cloneApi.update(tpl.id, { name: renameValue.trim() }); renaming = null; await reload(true); }); } if (e.key === "Escape") renaming = null; }} />
                <button class="setting-button" disabled={busy || !renameValue.trim()} onclick={() => void run(async () => { await cloneApi.update(tpl.id, { name: renameValue.trim() }); renaming = null; await reload(true); })}>存名</button>
              {:else}
                <span class="clone-tpl-name" title={tpl.name}>{templateDisplayName(tpl.name)}</span>
                <!-- 出片还是出图直接写在行首：它决定这条工作流给哪一类卡片当默认，
                     混在提示词位/参考位那串数字里根本看不见。 -->
                <span class="clone-tpl-kind" class:is-video={templateMediaKind(tpl) === "video"}
                  class:is-audio={templateMediaKind(tpl) === "audio"}>{WF_KIND_WORDS[templateMediaKind(tpl)]}</span>
                {#if tpl.is_active}<span class="clone-tpl-tag">当前</span>{/if}
                {#if tpl.is_builtin}<span class="clone-tpl-tag clone-tpl-tag-builtin"
                  title="安装包自带的官方工作流。删掉后不再自动装回来，设置页下方可以恢复；自己改过之后，版本更新也不会覆盖你这份。">内置</span>{/if}
                <span class="settings-hint">{counts(tpl)}</span>
              {/if}
            </div>
            <div class="clone-tpl-actions">
              {#if !tpl.is_active}
                <button class="setting-button" disabled={busy} onclick={() => void run(() => reloadAfter(() => cloneApi.update(tpl.id, { is_active: true })), `已把「${templateDisplayName(tpl.name)}」设为当前模板`)}>设为当前</button>
              {/if}
              <!-- 内置那几条不给重检：随包那份的槽位约定（哪一格吃遮罩、提示词留空算哪个模式、
                   哪几颗旋钮是一组）是写好并测过的，重扫一遍会把它们冲掉，后端对这条直接回 409。
                   按钮留着说清为什么点不动，比让人以为程序坏了强。 -->
              <button class="setting-button" disabled={busy || tpl.is_builtin}
                title={tpl.is_builtin
                  ? "内置工作流的槽位是随包定好的（包括哪一格能吃遮罩、提示词留空算哪个模式），重新检测会把它们冲掉，所以点不动。要改就「导出 JSON」，改完再导入一条自己的。"
                  : "按这份工作流重新检测一遍提示词位、参考位和参数（手动改过的绑定会被冲掉）。导入时 ComfyUI 没开，比例/分辨率没认出来的话就点这个。"}
                onclick={() => void run(async () => {
                  const saved = await cloneApi.redetect(tpl.id);
                  await reload(true);
                  notice = `已重新检测「${templateDisplayName(saved.name)}」：${controlSlots(saved).length} 个弹窗控件、${referenceCells(saved).length} 个参考位。`;
                })}>重新检测槽位</button>
              <!-- 自动判定看的是产出节点（SaveVideo / VHS_VideoCombine 之类），绝大多数时候是对的；
                   万一用户的工作流末端是个自定义节点，就在这儿改判，不用重导。 -->
              <select class="setting-button clone-tpl-kind-set" aria-label={`「${templateDisplayName(tpl.name)}」的产出类型`}
                title="出图的挂到图片卡，出片的挂到视频卡，出声音的挂到音频卡。自动判定错了就在这儿改。"
                value={templateMediaKind(tpl)} disabled={busy}
                onchange={(e) => void run(async () => {
                  const picked = (e.target as HTMLSelectElement).value;
                  await cloneApi.update(tpl.id, {
                    media_kind: picked === "video" || picked === "audio" ? picked : "image",
                  });
                  await reload(true);
                }, "已改判产出类型：三类卡片各认自己那一族的「当前」工作流。")}>
                <option value="image">{WF_OUTPUT_WORDS.image}</option>
                <option value="video">{WF_OUTPUT_WORDS.video}</option>
                <option value="audio">{WF_OUTPUT_WORDS.audio}</option>
              </select>
              <button class="setting-button" disabled={busy} onclick={() => { renaming = tpl.id; renameValue = templateDisplayName(tpl.name); }}>改名</button>
              <button class="setting-button" disabled={busy} onclick={() => void exportTemplate(tpl)}>导出 JSON</button>
              {#if confirmDelete === tpl.id}
                <button class="setting-button bg-danger text-bg" disabled={busy} onclick={() => void run(async () => { await cloneApi.remove(tpl.id); confirmDelete = null; await reload(true); }, tpl.is_builtin ? "内置模板已删除，启动不会再自动装回来；下面「已隐藏的内置工作流」里可以恢复。已生成的素材不受影响。" : "模板已删除。已生成的图不受影响。")}>确认删除</button>
                <button class="setting-button" onclick={() => (confirmDelete = null)}>取消</button>
              {:else}
                <button class="setting-button setting-button-ghost" disabled={busy} onclick={() => (confirmDelete = tpl.id)}>删除</button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
    {#if hidden.length}
      <!-- 删内置工作流以前是单向门：拉黑名单看不见也没有反悔，删错只能进库改。
           v0.2.31 那次「音频少一种模式」就是这个洞，所以这栏既是列表也是解药。 -->
      <p class="settings-hint clone-hidden-title">已隐藏的内置工作流 {hidden.length} 条：删掉之后启动不会再自动装回来，要用的话在这里恢复。</p>
      <ul class="clone-tpl-list">
        {#each hidden as one (one.key)}
          <li class="clone-tpl clone-tpl-hidden">
            <div class="clone-tpl-main">
              <span class="clone-tpl-name" title={one.name}>{templateDisplayName(one.name)}</span>
              <span class="clone-tpl-kind" class:is-video={one.media_kind === "video"}
                class:is-audio={one.media_kind === "audio"}>{hiddenKindWord(one.media_kind)}</span>
            </div>
            <div class="clone-tpl-actions">
              <button class="setting-button" disabled={busy}
                onclick={() => void run(async () => {
                  await cloneApi.restoreHidden(one.key);
                  await reload(true);
                }, `已恢复「${templateDisplayName(one.name)}」，弹窗里重新能选它了。`)}>恢复</button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </SettingsRow>
</div>

<div class="settings-card">
  <SettingsRow title="导入工作流" description="只接受 API 格式（顶层是节点号 → 节点内容）。ComfyUI 里用「Workflow → Export (API)」导出。要换一条工作流就是再导一次，导完在上面的列表点「设为当前」。" top>
    {#snippet control()}
      <button class="setting-button bg-accent text-bg" disabled={busy} onclick={() => void pickWorkflowJson()}>选择工作流 JSON</button>
    {/snippet}
    {#if pickedFile}
      <p class="clone-picked">已选：<b title={pickedFile}>{basenameOnly(pickedFile)}</b>
        <span class="clone-picked-note">读完先在下面确认槽位，确认后才落库。</span></p>
    {:else}
      <p class="settings-hint">点「选择工作流 JSON」挑一份 ComfyUI 导出的 .json，读完先给你确认哪些槽位进弹窗。</p>
    {/if}
  </SettingsRow>
  <!-- 浏览器 dev 没有原生文件框（isTauri() 为 false）时那颗「选择工作流 JSON」就点它。
       display:none 不进版面，真机上永远走原生框，所以桌面上没有第三条导入路。
       它挂在卡片自己身上而不是 SettingsRow 的正文里：那颗 change 事件是 Svelte 委托到
       组件根元素上的，塞进子组件的 snippet 里就脱了委托链（测试里点了没反应就是这个坑）。 -->
  <input bind:this={fileEl} class="clone-file" type="file" accept=".json" aria-label="工作流 JSON 文件"
    onchange={(e) => void onWorkflowFile(e)} />

  {#if pending}
    <div class="clone-confirm">
      <div class="clone-confirm-head">
        <div>
          <span class="clone-confirm-title">确认槽位</span>
          <span class="settings-hint">勾上的才会出现在弹窗里。参考位数量由加载器节点决定：LoadImage＝图片位、LoadAudio＝音频位、VHS_LoadVideo＝视频位，工作流里没接那一台就没有那一族。</span>
        </div>
        <input class="setting-control" type="text" aria-label="模板名称" bind:value={pendingName} />
        <button class="setting-button bg-accent text-bg" disabled={busy} onclick={() => void savePending()}>保存模板</button>
        <button class="setting-button setting-button-ghost" onclick={() => (pending = null)}>取消导入</button>
      </div>
      {#if pending.inspect.warnings.length}
        <ul class="clone-warnings" role="status">
          {#each pending.inspect.warnings as warning, i (i)}
            <li>{warning}</li>
          {/each}
        </ul>
      {/if}
      {#each groups as group (group.label)}
        <div class="clone-group">
          <span class="clone-group-label">{group.label}</span>
          {#each group.items as slot (slotKey(slot))}
            <label class="clone-slot">
              <input type="checkbox" checked={picked[slotKey(slot)] ?? false}
                onchange={(e) => (picked = { ...picked, [slotKey(slot)]: (e.target as HTMLInputElement).checked })} />
              <span>{slot.label || slotKey(slot)}</span>
              <code>{slotKey(slot)}</code>
            </label>
          {/each}
        </div>
      {/each}
      <p class="settings-hint">内置提示词：{pending.inspect.default_prompt ? pending.inspect.default_prompt.slice(0, 80) : "（没有）"}</p>
    </div>
  {/if}

  {#if error}<p class="settings-hint text-danger" role="alert">{error}</p>{/if}
  {#if notice}<p class="settings-hint" role="status">{notice}</p>{/if}
</div>

<style>
  .clone-load { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; color: #a1a1aa; font-size: var(--fs-sm); }
  .clone-tpl-list { display: flex; flex-direction: column; gap: var(--sp-2); margin: 0; padding: 0; list-style: none; }
  .clone-tpl { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border: 1px solid #2c2c31; border-radius: var(--r-1); background: #1d1d21; }
  .clone-tpl.is-active { border-color: rgb(242 78 78 / 60%); }
  .clone-tpl-main { display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--sp-2); min-width: 0; }
  .clone-tpl-name { font-weight: 600; color: #ececed; }
  .clone-hidden-title { margin: var(--sp-4) 0 var(--sp-2); }
  .clone-tpl-hidden { background: #17171a; }
  .clone-tpl-hidden .clone-tpl-name { font-weight: 500; color: #a1a1aa; }
  .clone-tpl-tag { padding: 1px var(--sp-2); border-radius: var(--r-pill); background: rgb(242 78 78 / 18%); color: #ff8f8f; font-size: var(--fs-2xs); }
  .clone-tpl-tag-builtin { background: rgb(59 130 246 / 16%); color: #93c5fd; }
  .clone-tpl-kind { padding: 1px var(--sp-2); border-radius: var(--r-pill); background: rgb(59 130 246 / 16%); color: #93c5fd; font-size: var(--fs-2xs); }
  .clone-tpl-kind.is-video { background: rgb(245 158 11 / 16%); color: #fbbf24; }
  .clone-tpl-kind.is-audio { background: rgb(139 92 246 / 16%); color: #c4b5fd; }
  .clone-tpl-kind-set { padding: var(--sp-05) var(--sp-2); font-size: var(--fs-xs); }
  .clone-tpl-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
  .clone-picked { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-1); margin: 0; font-size: var(--fs-sm); color: var(--text-1); }
  .clone-picked b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40ch; }
  .clone-picked-note { font-size: var(--fs-xs); color: var(--text-3); }
  .clone-file { display: none; }
  .clone-group { display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-3); }
  .clone-group-label { color: #9a9aa1; font-size: var(--fs-2xs); letter-spacing: var(--track-label); }
  .clone-slot { display: flex; align-items: center; gap: var(--sp-2); color: #d8d8dc; font-size: var(--fs-sm); }
  .clone-slot code { color: #8a8a90; font-size: var(--fs-2xs); }
  /* 槽位确认这块不用 SettingsRow：它的 control snippet 和正文里的 {#each} 撞在一起会渲染崩，
     而且这一屏本来就是一张密集的清单表，左右分栏反而放不下。 */
  .clone-confirm { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-3) 0 0; border-top: 1px solid #2a2a2f; margin-top: var(--sp-3); }
  .clone-confirm-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
  .clone-confirm-head > div { display: flex; flex-direction: column; gap: var(--sp-05); margin-right: auto; }
  .clone-confirm-title { font-size: var(--fs-sm); font-weight: 500; color: #e6e6ea; }
  .clone-warnings { margin: var(--sp-2) 0 0; padding-left: var(--sp-5); color: #ffc36b; font-size: var(--fs-xs); }
</style>
