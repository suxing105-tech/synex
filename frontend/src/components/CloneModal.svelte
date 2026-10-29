<script lang="ts">
  /**
   * 一键同款弹窗：左边这张图，右边「同款工作流 + 参考位 + 提示词 + 比例/分辨率 + 生成」。
   *
   * 三条约束都是从用户角度定的：
   * 1. 提示词默认带这张图自己的（ComfyUI 写回的 → 反推的 → 空）；工作流内置那条只给按钮，
   *    因为换完参考图之后原文十有八九对不上画面。
   * 2. 参考位数量由工作流决定（LoadImage 节点数），默认全部填被点的这张图：最常见的用法
   *    就是「拿这张图再抽一张」，一次点击就能出图。
   * 3. 弹窗里不放「在 ComfyUI 中打开」：这是后台出图的入口，调试去设置页看模板 JSON。
   */
  import { get } from "svelte/store";
  import { tick } from "svelte";
  import { comfyuiApi, imagesApi } from "../lib/api";
  import { backendUrl } from "../lib/backend-url";
  import { basenameOnly } from "../lib/media-format";
  import { comfyuiStatus, overlayMuted } from "../lib/stores";
  import { pushToast } from "../lib/toast";
  import { modalFocus } from "../lib/modal-focus";
  import Icon from "./Icon.svelte";
  import MediaPickerModal from "./MediaPickerModal.svelte";
  import {
    applyCloneProgress, buildGenerateRequest, cloneApi, cloneError, cloneJob, cloneStatusLabel,
    allowsTextMode, controlSlots, controlSummary, defaultControlValues, defaultReferences, latestReversePrompt,
    modeFromRefCount, modeLabel, numberPresets, numberUnit, promptSlots, promptSourceLabel,
    ratioShape, referenceCells, referenceIssues, resolvePromptSource, shouldOfferWorkflowPrompt, slotKey, visibleRefCells,
    CLONE_SETTINGS_TAB,
    applyMention, caretCoordinates, mentionChunks, mentionItems as buildMentionItems, mentionToken,
    templateDisplayName,
    type MentionItem, type MentionToken,
    type CloneJob, type CloneSources, type CloneTemplate,
  } from "../lib/clone";
  import type { ImageSummary, MediaFeedItem } from "../lib/types";

  interface Props {
    open: boolean;
    /** 被点的那张图；关掉弹窗时父组件会置空，所以允许 null */
    image: MediaFeedItem | null;
    onClose: () => void;
    /** 打开设置页某个分区（没有同款工作流时要去导入） */
    onOpenSettings?: (tab: string) => void;
    /** 点本次产出的缩略图 → 跳到图库里那张 */
    onOpenImage?: (id: number) => void;
  }
  let { open, image, onClose, onOpenSettings, onOpenImage }: Props = $props();

  let templates = $state<CloneTemplate[]>([]);
  let templatesLoaded = $state(false);
  let templateId = $state<number | null>(null);
  const template = $derived(templates.find((t) => t.id === templateId) ?? null);

  let prompt = $state("");
  let promptOrigin = $state("");
  let promptLoading = $state(false);
  let refs = $state<Record<string, ImageSummary | null>>({});
  /**
   * 这张图当初喂的参考图。一键同款生成过的才有；读回来之后参考位照它重摆。
   * 用两张参考做出来的画面，点开同款就该看到那两张，而不是让人重新选一遍。
   */
  let sources = $state<CloneSources | null>(null);
  let controls = $state<Record<string, string | number>>({});
  let pickerSlot = $state<string | null>(null);
  let error = $state("");
  let submitting = $state(false);
  let jobId = $state("");
  let probing = $state(false);
  let popOpen = $state(false);
  let wfOpen = $state(false);
  /** 一次只让一条删除在飞：删完要重读列表，中途再点会去删已经不存在的 id。 */
  let wfDeleting = $state(false);
  let workflowLoading = $state(false);
  let wfInput = $state<HTMLInputElement | null>(null);

  /* ── @ 引用素材：提示词里打 @ 弹出参考图菜单，选完把 @图片N 插回正文。 */
  let promptEl = $state<HTMLTextAreaElement | null>(null);
  /** 提示词背后的文字镜像：@图片N 的高亮画在这里，textarea 自己把字涂透明 */
  let promptBg = $state<HTMLDivElement | null>(null);
  let mentionOpen = $state(false);
  let mentionQuery = $state("");
  let mentionAt = $state<MentionToken | null>(null);
  let mentionIndex = $state(0);
  let mentionBox = $state({ left: 0, top: 0 });
  /** 从 @ 菜单点「再挂一张」时记住落在哪个参考位，图挑好了顺手把标签插回提示词 */
  let mentionPickKey = $state<string | null>(null);

  const job = $derived.by<CloneJob | null>(() => {
    const current = $cloneJob;
    if (!current.active || !current.state) return null;
    // 只认自己这次的任务；没提交过时，允许接管一个还在跑的任务
    if (jobId) return current.job_id === jobId ? current : null;
    return current.running ? current : null;
  });
  const busy = $derived(Boolean(job && job.running));
  const done = $derived(Boolean(job && job.state === "done"));
  const workflowPrompt = $derived(template?.default_prompt ?? "");
  const cells = $derived(referenceCells(template));

  /**
   * 参考位上那是成图自己、不是当初的参考图——只在「这张确实是 AI 出的图、参考图却没认出来、
   * 而第一格还没被用户动过」时说一次。用户一换图这句就该消失，否则就成了瞎报。
   */
  const lostItsReferences = $derived(
    !!sources && !sources.references.length && sources.origin === "unrecorded"
    && cells.length > 0 && refs[cells[0]!.key]?.id === image?.id,
  );
  const refCount = $derived(cells.filter((cell) => refs[cell.key]).length);
  // 生成方式是参考图数量的函数，不是一个开关：0 张文生图 / 1 张单图编辑 / 2 张以上多图编辑。
  const mode = $derived(modeFromRefCount(refCount));
  const canText = $derived(allowsTextMode(template));
  const issues = $derived(referenceIssues(template, refs, canText));
  const visibleCells = $derived(visibleRefCells(cells, refs));
  const mentionOptions = $derived(mentionOpen ? buildMentionItems(cells, refs, mentionQuery) : []);
  // 参数面板：combo 走带方框的比例网格，数值走档位 + 自定义输入。
  const selectSlots = $derived(controlSlots(template).filter((slot) => slot.kind === "select"));
  const numberSlots = $derived(controlSlots(template).filter((slot) => slot.kind !== "select"));
  const hasParams = $derived(selectSlots.length + numberSlots.length > 0);
  const summary = $derived(controlSummary(template, controls));
  /** 工作流名给用户看的那一份：本地导入的名字尾巴上的 .json 不是名字的一部分。 */
  const wfName = $derived(templateDisplayName(template?.name));

  const canGenerate = $derived(Boolean(template) && prompt.trim().length > 0 && issues.length === 0 && !busy && !submitting);

  /** 移除一张就把后面的参考往前挪：图片序号就是接线顺序，中间不能留洞。 */
  function removeRef(key: string) {
    const kept = cells
      .filter((cell) => cell.key !== key && refs[cell.key])
      .map((cell) => refs[cell.key]);
    const next: Record<string, ImageSummary | null> = {};
    cells.forEach((cell, index) => { next[cell.key] = kept[index] ?? null; });
    refs = next;
  }

  /** 拖放/粘贴落在哪算哪：没指定就填第一个参考位。 */
  function targetSlot(slot?: string | null): string | null {
    if (slot) return slot;
    return cells[0]?.key ?? null;
  }

  /** 打 @ 就弹菜单。读 DOM 里的实时值：bind:value 比 input 慢一拍，读 prompt 会漏掉刚敲的那个字符。 */
  function onPromptInput(e: Event) {
    const el = e.currentTarget as HTMLTextAreaElement;
    const token = mentionToken(el.value, el.selectionStart ?? el.value.length);
    if (!token || !cells.length) { mentionOpen = false; return; }
    const items = buildMentionItems(cells, refs, token.query);
    if (!items.length) { mentionOpen = false; return; }
    const caretBox = caretCoordinates(el, token.start);
    const menuWidth = 236;
    const menuHeight = Math.min(items.length * 34 + 44, 214);
    mentionAt = token;
    mentionQuery = token.query;
    mentionIndex = 0;
    // 菜单不许跑出输入框：横向贴左边，纵向快到底就往上收，省得把整块面板顶出滚动条
    mentionBox = {
      left: Math.max(0, Math.min(caretBox.left, el.clientWidth - menuWidth)),
      top: Math.max(0, Math.min(caretBox.top + caretBox.height + 4, el.clientHeight - menuHeight)),
    };
    mentionOpen = true;
  }

  function onPromptKeydown(e: KeyboardEvent) {
    if (!mentionOpen) return;
    if (e.key === "Escape") {
      // 不截住的话 Esc 一路冒泡到 window，菜单和整层弹窗一起没
      e.preventDefault();
      e.stopPropagation();
      mentionOpen = false;
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const total = mentionOptions.length;
      if (!total) return;
      mentionIndex = (mentionIndex + (e.key === "ArrowDown" ? 1 : total - 1)) % total;
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      const picked = mentionOptions[mentionIndex];
      if (!picked) return;
      // 这里的回车是「选中」，不是换行
      e.preventDefault();
      void chooseMention(picked);
    }
  }

  /** 已经挂上的图直接插标签；还没有合适的图，就先走一遍图库选择器再插。 */
  async function chooseMention(item: MentionItem) {
    if (item.add) {
      mentionPickKey = item.key;
      pickerSlot = item.key;
      return;
    }
    await commitMention(item.label);
  }

  /** 高亮层是 textarea 背后的镜像，滚动位置必须跟着走，否则一滚就错位。 */
  function syncPromptBg() {
    if (promptBg && promptEl) promptBg.scrollTop = promptEl.scrollTop;
  }

  $effect(() => {
    // 内容变了浏览器可能自己挪 textarea 的 scrollTop（插入标签、自动滚到光标），跟着补一次
    void prompt;
    syncPromptBg();
  });

  /** 换掉 caret 前那段 @xxx，再把焦点和光标放回原处，接着打下面的字。 */
  async function commitMention(label: string) {
    const el = promptEl;
    const token = mentionAt;
    mentionOpen = false;
    mentionPickKey = null;
    if (!el || !token) return;
    const next = applyMention(el.value, token, label);
    prompt = next.text;
    await tick();
    el.focus();
    el.setSelectionRange(next.caret, next.caret);
    syncPromptBg();
  }

  async function loadTemplates() {
    try {
      const res = await cloneApi.templates();
      const items = Array.isArray(res?.items) ? res.items : [];
      templates = items;
      const keep = templateId !== null && items.some((t) => t.id === templateId);
      if (!keep) templateId = (items.find((t) => t.is_active) ?? items[0])?.id ?? null;
      error = "";
    } catch (e) {
      error = cloneError(e);
      templates = [];
    } finally {
      templatesLoaded = true;
    }
  }

  /** 提示词来源：图片自带 → 最新一条反推 → 空。两个请求并行，读不到也不挡弹窗。 */
  async function loadPrompt(id: number) {
    promptLoading = true;
    try {
      const [detail, history] = await Promise.all([
        cloneApi.detail(id).catch(() => null),
        cloneApi.reverseHistory(id).catch(() => ({ items: [] })),
      ]);
      const resolved = resolvePromptSource({
        imagePrompt: detail?.positive_prompt,
        reversePrompt: latestReversePrompt(history.items),
      });
      prompt = resolved.text;
      promptOrigin = resolved.origin === "image" ? promptSourceLabel("image") : "";
    } finally {
      promptLoading = false;
    }
  }

  /** 读这张图的来源。没记过就是空：在 ComfyUI 里手动出的图本来就没有来源可说。 */
  async function loadSources(id: number) {
    let next: CloneSources | null = null;
    try {
      const res = await cloneApi.sources(id);
      next = Array.isArray(res?.references) ? res : null;
    } catch {
      next = null; // 读不到就当没有：来源只是省一次重新选图，不该拦住弹窗
    }
    // 请求在飞的这段时间里用户可能已经关弹窗或换了一张图，迟到回来的那份不能作数
    if (open && image?.id === id) sources = next;
  }

  /**
   * 换工作流 = 换一整套槽位，参考位重新按新模板摆一遍（默认只填被点的那张＝单图编辑）。
   * 这里不收工作流弹层：loadTemplates 每次重读列表都会让这个 effect 再跑一次，
   * 收弹层的话删一条工作流就把弹层一起带走，连着清第二条得先把弹层点开。
   * 该收的地方自己收（pickTemplate / 加载本地 JSON / 遮罩 / Esc）。
   *
   * 参考位先按这张图的来源摆（多图编辑的图就该摆两张），没有来源才退回只放被点的这张。
   * 这里读 sources 是故意的：来源通常比模板晚到一步，读过一次，它到位那次 effect 才会重摆。
   */
  function bindTemplate(next: CloneTemplate | null) {
    refs = defaultReferences(next, image, sources?.references ?? []);
    controls = defaultControlValues(next);
    popOpen = false;
  }

  function pickTemplate(id: number) {
    templateId = id;
    closeWorkflowPop();
  }

  function closeWorkflowPop() {
    wfOpen = false;
  }

  /**
   * 点 X 直接删掉库里那份 API JSON，不再问第二遍：X 只在悬停那一下才出现，本来就误点不了，
   * 中间插一层「确认删除 / 取消」只是把清理工作流变成两次点击。已经生成过的图不受影响。
   * 删的正好是当前这条也没关系：后端会把另一条顶成 is_active，loadTemplates 顺势切过去。
   * 删完弹层保持打开——清工作流一般是连着清好几条，收起来等于逼人多点一次；
   * 只有最后一条被删光、整块面板换成空态（那颗 pill 已经不在页面上）时才收。
   */
  async function removeTemplate(id: number) {
    if (wfDeleting) return;
    wfDeleting = true;
    try {
      await cloneApi.remove(id);
      await loadTemplates();
      pushToast("工作流已删除，之前生成的图不受影响");
    } catch (e) {
      error = cloneError(e);
    } finally {
      wfDeleting = false;
      if (templateId === null) closeWorkflowPop();
    }
  }

  /**
   * 重名不问用户，直接加序号：这个名字只是给人认的，问一句反而打断「一键」。
   * 比对走显示口径——库里已经躺着一条「x.json」时，再导一次「x.json」不该变成
   * 两条都叫「x」，那用户在切换列表里根本分不出哪条是哪条。
   */
  function uniqueName(base: string): string {
    const wanted = templateDisplayName(base) || "同款工作流";
    const names = new Set(templates.map((item) => templateDisplayName(item.name)));
    if (!names.has(wanted)) return wanted;
    let n = 2;
    while (names.has(`${wanted} (${n})`)) n += 1;
    return `${wanted} (${n})`;
  }

  /** 弹窗里直接加载本地 JSON：读文本 → 后端解析槽位 → 落库 → 立刻切到新模板。 */
  async function onWorkflowFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // 清掉再选同一个文件也要能触发 change
    closeWorkflowPop();
    if (!file) return;
    workflowLoading = true;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const inspect = await cloneApi.inspect({ workflow: parsed });
      const saved = await cloneApi.create({
        name: uniqueName(templateDisplayName(inspect.suggested_name || basenameOnly(file.name))),
        workflow: parsed,
        slots: inspect.slots,
      });
      await loadTemplates();
      templateId = saved.id;
      error = "";
      pushToast(`已载入「${templateDisplayName(saved.name)}」：${promptSlots(saved).length} 个提示词位 / ${referenceCells(saved).length} 个参考位`);
    } catch (e2) {
      error = e2 instanceof SyntaxError ? "这个文件不是合法的 JSON，请从 ComfyUI 重新导出 API 格式。" : cloneError(e2);
    } finally {
      workflowLoading = false;
    }
  }

  /**
   * 冷启动那次探测经常赶上 ComfyUI 还在装模型，于是缓存里留下一个假的「没在跑」。
   * 开弹窗时补测一次。这里必须用 get() 而不是 $comfyuiStatus：直接读 store 会把这条
   * effect 挂在状态上，之后每轮状态轮询都会重跑，把用户刚敲的提示词冲回预填值。
   */
  let probedThisOpen = false;

  $effect(() => {
    if (!open || !image) {
      probedThisOpen = false;
      return;
    }
    const id = image.id;
    error = "";
    jobId = "";
    sources = null;
    void loadTemplates();
    void loadPrompt(id);
    void loadSources(id);
    void adoptRunningJob();
    const status = get(comfyuiStatus);
    if (!probedThisOpen && status.enabled && !status.running) {
      probedThisOpen = true
      void refreshComfyui();
    }
  });

  $effect(() => {
    if (!open) return;
    bindTemplate(template);
  });

  /* 背景虚化时把右侧栏的分割线和折叠箭头一起藏掉（样式在 App.svelte，糊成一条灰竖杠很难看）。 */
  $effect(() => {
    overlayMuted.set(open);
    // 卸载时也清干净：弹窗还开着就被整棵树换掉，右侧栏不该一直缺分割线。
    return () => overlayMuted.set(false);
  });

  /** 弹窗重开时接手正在跑的任务：状态在后端内存里，关弹窗不会让它停下。 */
  async function adoptRunningJob() {
    try {
      const current = applyCloneProgress(await cloneApi.currentJob());
      if (current.running) jobId = current.job_id;
    } catch {
      /* 后端没答话就算了，弹窗照样能填 */
    }
  }

  async function refreshComfyui() {
    probing = true;
    try {
      comfyuiStatus.set(await comfyuiApi.status());
    } catch {
      pushToast("探测 ComfyUI 失败，确认设置 → ComfyUI 里的服务地址对不对");
    } finally {
      probing = false;
    }
  }

  async function generate() {
    if (!template) return;
    if (issues.length) {
      error = `参考图还没放好：${issues.join("、")}`;
      return;
    }
    submitting = true;
    error = "";
    // 提交那一刻收掉两个弹层：不然菜单会盖在跑动的界面上，而且它里面的条目马上要全部禁用
    popOpen = false;
    closeWorkflowPop();
    try {
      const started = await cloneApi.generate(buildGenerateRequest({
        templateId: template.id,
        prompt,
        references: refs,
        controls,
        sourceImageId: image?.id ?? null,
        cellOrder: cells.map((cell) => cell.key),
      }));
      jobId = started.job_id;
      applyCloneProgress(started);
    } catch (e) {
      error = cloneError(e);
    } finally {
      submitting = false;
    }
  }

  async function cancel() {
    try {
      applyCloneProgress(await cloneApi.cancelJob());
    } catch (e) {
      pushToast(cloneError(e));
    }
  }

  /**
   * 本地文件 / 剪贴板图片：走现成导入接口先落收件箱再当参考位，语义和拖进图库一致。
   * 一次拖进来几张就依次占满后面的参考位——多张图一张张拖太慢了。
   */
  async function importFiles(files: File[], slot?: string | null) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    const wanted = targetSlot(slot);
    try {
      const res = await imagesApi.import(images, null);
      if (!res.saved.length) {
        pushToast(res.skipped?.[0] ? `这些图没能入库（${res.skipped[0].reason}）` : "这些图没能入库");
        return;
      }
      const free = cells.map((cell) => cell.key).filter((key) => !refs[key]);
      const targets = wanted && free.includes(wanted) ? [wanted, ...free.filter((key) => key !== wanted)] : free;
      const next = { ...refs };
      let used = 0;
      for (const item of res.saved) {
        const key = targets[used];
        if (!key) break;
        next[key] = { ...item, kind: "image" } as ImageSummary;
        used += 1;
      }
      refs = next;
      pushToast(used > 1
        ? `已把 ${used} 张图收进图库并选为参考图`
        : `已把「${res.saved[0].filename}」收进图库并选为参考图`);
      if (res.saved.length > used) pushToast(`参考位满了，多出的 ${res.saved.length - used} 张只收进了图库`);
    } catch (e) {
      pushToast(cloneError(e));
    }
  }

  function onKey(e: KeyboardEvent) {
    if (!open || pickerSlot !== null) return;
    if (e.key === "Escape") {
      // 弹出的菜单开着时 Esc 先收菜单，别一下把整个弹窗关掉。
      if (mentionOpen || popOpen || wfOpen) {
        e.preventDefault();
        mentionOpen = false;
        popOpen = false;
        closeWorkflowPop();
        return;
      }
      e.preventDefault();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="cm-backdrop" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="cm-panel" role="dialog" aria-modal="true" aria-label="一键同款" use:modalFocus>
      <header class="cm-top">
        <div class="cm-top-text">
          <span class="cm-kicker">一键同款</span>
          {#if template}
            <!-- 切换与导入收在底部那颗「工作流」按钮里，顶栏只报当前在用哪一份。 -->
            <h3 class="cm-title" title={`${wfName} · ${template.node_count} 个节点`}>{wfName}</h3>
          {/if}
        </div>
        <button class="cm-close" aria-label="关闭一键同款" onclick={onClose}><Icon name="x" size={16} /></button>
      </header>

      {#if !$comfyuiStatus.enabled || !$comfyuiStatus.running}
        <div class="cm-banner" role="status">
          <span>{$comfyuiStatus.enabled ? `连不上 ComfyUI（${$comfyuiStatus.url}），先把它启动起来才能出图。` : "ComfyUI 集成没打开，去设置 → ComfyUI 里启用。"}</span>
          <button class="cm-btn" disabled={probing} onclick={() => void refreshComfyui()}>{probing ? "探测中…" : "重新探测"}</button>
        </div>
      {/if}

      <div class="cm-body">
        <div class="cm-left">
          {#if image?.original_url || image?.thumbnail_url}
            <img class="cm-hero" src={backendUrl(image.original_url || image.thumbnail_url!)} alt={image.filename} />
          {:else}
            <div class="cm-hero cm-hero-empty">没有预览</div>
          {/if}
          <p class="cm-hero-name" title={image?.filename}>{basenameOnly(image?.filename ?? "")}</p>
        </div>

        <div class="cm-right">
          {#if !templatesLoaded}
            <p class="cm-note">正在读取同款工作流…</p>
          {:else if !template}
            <div class="cm-empty">
              <p>还没有同款工作流。导出一份 ComfyUI 的 API 格式工作流 JSON，之后每张图点一下就能出同款。</p>
              <button class="cm-btn cm-btn-accent" disabled={workflowLoading} onclick={() => wfInput?.click()}>
                {workflowLoading ? "正在读取…" : "加载本地工作流 JSON"}
              </button>
              {#if onOpenSettings}
                <button class="cm-btn" onclick={() => onOpenSettings(CLONE_SETTINGS_TAB)}>去设置里看说明</button>
              {/if}
            </div>
          {:else}
            <!-- 这层 display:contents 的壳不是多余的：happy-dom 里「以注释锚点开头的
                 模板片段」一旦被渲染成 if 分支，Svelte 取子节点就会错位并抛错，
                 测试环境整个弹窗直接白屏。包一层容器让片段的第一个节点变成元素。 -->
            <div class="cm-form">
            <!-- 生成方式不做成开关：放了几个参考就是哪种方式（0 文生图 / 1 单图 / 2+ 多图），
                 开关能和实际画面打架，数量不会。当前方式只在标题里报一下。 -->
            <section class="cm-block">
              <p class="cm-block-title">{mode === "text" ? "参考图" : "替换或上传参考"}</p>
              <!-- 生成方式不再是看得见的标签（红框小字全删），但它仍是真实状态：
                   挂在参考图这一组的可访问名里，读屏和测试都还拿得到。 -->
              <div
                class="cm-ref-row"
                role="group"
                aria-label={`参考图（${modeLabel(mode)}）`}
                onpaste={(e) => {
                  const files = Array.from(e.clipboardData?.files ?? []);
                  if (files.length) { e.preventDefault(); void importFiles(files, pickerSlot); }
                }}
              >
                {#each visibleCells as cell (cell.key)}
                  {@const picked = refs[cell.key]}
                  <div
                    class="cm-ref-cell"
                    role="group"
                    aria-label={cell.label}
                    ondragover={(e) => e.preventDefault()}
                    ondrop={(e) => {
                      const files = Array.from(e.dataTransfer?.files ?? []);
                      if (files.length) { e.preventDefault(); void importFiles(files, cell.key); }
                    }}
                  >
                    {#if picked}
                      <div class="cm-tile media-chip" title={`${cell.slotLabel}｜${picked.filename}`}>
                        <img class="cm-tile-img" src={backendUrl(picked.thumbnail_url || picked.original_url!)} alt={picked.filename} />
                        <button class="cm-tile-swap" aria-label={`替换${cell.label}`} onclick={() => (pickerSlot = cell.key)}>
                          <Icon name="swap" size={15} />
                        </button>
                        <button class="cm-tile-x" aria-label={`移除${cell.label}`} onclick={() => removeRef(cell.key)}>
                          <Icon name="x" size={12} />
                        </button>
                      </div>
                    {:else}
                      <button class="cm-tile cm-tile-add" aria-label={`添加${cell.label}参考图`} title={`再加一张参考图（这份工作流最多吃 ${cells.length} 张）`} onclick={() => (pickerSlot = cell.key)}>
                        <Icon name="plus" size={20} />
                        <span>参考</span>
                      </button>
                    {/if}
                    <span class="cm-ref-caption" class:cm-ref-caption-empty={!picked}>{cell.label}</span>
                  </div>
                {/each}
              </div>
              {#if sources && sources.dropped > 0}
                <!-- 来源里认不出来的那几张要明说：默默少摆一张，用户会以为当初就只喂了这些 -->
                <p class="cm-note">这张图当初还用了 {sources.dropped} 张参考图，已经不在图库里了，重新生成前补一张。</p>
              {:else if lostItsReferences}
                <!-- 认不出参考图时，参考位里摆的是被点的这张成图自己（默认就这么填的）。
                     不说明就是骗人：用户会以为当初只喂了这一张、就是这一张。 -->
                <p class="cm-note">没找到这张图当初用的参考图，先放了它自己当参考。要原来那几张，手动换一下。</p>
              {/if}
            </section>

            <section class="cm-block">
              <p class="cm-block-title">完整提示词</p>
              <div class="cm-prompt-wrap">
                <div class="cm-prompt-bg" bind:this={promptBg} aria-hidden="true">
                  {#each mentionChunks(prompt) as chunk, i (i)}
                    <span class:cm-mention-hl={chunk.mention}>{chunk.text}</span>
                  {/each}
                </div>
                <textarea id="clone-prompt" class="cm-textarea" bind:this={promptEl} oninput={onPromptInput} onkeydown={onPromptKeydown} onscroll={syncPromptBg} rows="12" aria-label="提示词" placeholder="要生成什么画面，打 @ 可以引用参考图" bind:value={prompt}></textarea>
                {#if mentionOpen && mentionOptions.length}
                  <div class="cm-pop-scrim" role="presentation" onclick={() => (mentionOpen = false)}></div>
                  <div class="cm-mention" style="left: {mentionBox.left}px; top: {mentionBox.top}px;" role="listbox" aria-label="引用素材">
                    <p class="cm-mention-title">引用素材</p>
                    {#each mentionOptions as item, index (item.add ? "add" : item.key)}
                      <button class="cm-mention-item" class:is-on={index === mentionIndex} class:cm-mention-add={item.add}
                        role="option" aria-selected={index === mentionIndex}
                        onmousedown={(e) => e.preventDefault()} onclick={() => void chooseMention(item)}>
                        <span class="cm-mention-icon">
                          {#if item.thumb && !item.add}
                            <img class="cm-mention-thumb" src={backendUrl(item.thumb)} alt="" />
                          {:else}
                            <Icon name={item.add ? "plus" : "image"} size={13} />
                          {/if}
                        </span>
                        <span class="cm-mention-label">{item.add ? "从图库再挂一张参考图" : item.label}</span>
                        <span class="cm-mention-file" title={item.filename}>{item.add ? "" : basenameOnly(item.filename)}</span>
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
              <div class="cm-field-foot">
                <span class="cm-note">{promptLoading ? "正在读这张图的提示词…" : (promptOrigin || promptSourceLabel("none"))}</span>
                {#if shouldOfferWorkflowPrompt(prompt, workflowPrompt)}
                  <button class="cm-btn" onclick={() => (prompt = workflowPrompt)}>填入工作流内置提示词</button>
                {/if}
              </div>
            </section>

            <div class="cm-foot">
              <div class="cm-foot-left">
                {#if hasParams}
                  <div class="cm-pop-wrap">
                    <button class="cm-pill" aria-label="画面参数" aria-haspopup="dialog" aria-expanded={popOpen} onclick={() => { closeWorkflowPop(); popOpen = !popOpen; }}>
                      <span class="cm-pill-text">{summary || "设置画面参数"}</span>
                      <span class="cm-chevron" class:is-open={popOpen} aria-hidden="true"><Icon name="chevron-down" size={12} /></span>
                    </button>
                    {#if popOpen}
                      <div class="cm-pop-scrim" role="presentation" onclick={() => (popOpen = false)}></div>
                      <div class="cm-pop" role="dialog" aria-label="画面参数">
                        {#each selectSlots as slot (slotKey(slot))}
                          {@const key = slotKey(slot)}
                          <p class="cm-pop-title">{slot.label}</p>
                          <div class="cm-ratio-grid" role="group" aria-label={`${slot.label}选项`}>
                            {#each slot.options ?? [] as option (option)}
                              {@const shape = ratioShape(option)}
                              <button
                                class="cm-ratio"
                                class:is-on={controls[key] === option}
                                title={option}
                                aria-label={option}
                                aria-pressed={controls[key] === option}
                                onclick={() => (controls[key] = option)}
                              >
                                {#if shape.ratio}
                                  <span class="cm-ratio-box" style="width: {shape.box.w}px; height: {shape.box.h}px;" aria-hidden="true"></span>
                                {:else}
                                  <span class="cm-ratio-flat" aria-hidden="true">•</span>
                                {/if}
                                <span class="cm-ratio-label">{shape.label}</span>
                              </button>
                            {/each}
                          </div>
                        {/each}
                        {#each numberSlots as slot (slotKey(slot))}
                          {@const key = slotKey(slot)}
                          <p class="cm-pop-title">{slot.label}</p>
                          <div class="cm-seg" role="group" aria-label={`${slot.label}档位`}>
                            {#each numberPresets(slot) as preset (preset)}
                              <button
                                class="cm-seg-item"
                                class:is-on={Number(controls[key]) === preset}
                                aria-label={`${preset}${numberUnit(slot)}`}
                                aria-pressed={Number(controls[key]) === preset}
                                onclick={() => (controls[key] = preset)}
                              >{preset}</button>
                            {/each}
                          </div>
                          <label class="cm-custom" for={`clone-${key}`}>
                            <span>自定义{numberUnit(slot) ? `（${numberUnit(slot)}）` : ""}</span>
                            <input
                              id={`clone-${key}`}
                              type="number"
                              aria-label={slot.label}
                              min={slot.min ?? undefined}
                              max={slot.max ?? undefined}
                              step={slot.step ?? undefined}
                              bind:value={controls[key]}
                            />
                          </label>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/if}
                <div class="cm-pop-wrap cm-fill">
                  <!-- 生成中不藏这颗：一藏这一行就空出一块，还看不出正在用哪份工作流出图。
                       但生成期间不给换：中途换工作流会把参考位和参数冲成另一份的，
                       而正在跑的那张既看不见也撤不回。理由写在 title 里，别让人对着点不动的按钮猜。
                       名字长到挤不下时，让位的是这颗胶囊（名字截断 + 收箭头），不是右边的取消和生成。 -->
                  <button class="cm-pill" class:is-busy={busy} aria-label="同款工作流" aria-haspopup="menu" aria-expanded={wfOpen}
                    disabled={busy} title={busy ? `生成中，等这张图画完再换工作流：${wfName}` : wfName}
                    onclick={() => { popOpen = false; wfOpen = !wfOpen; }}>
                    <Icon name="layers" size={13} />
                    <span class="cm-pill-text">{wfName}</span>
                    <span class="cm-chevron" class:is-open={wfOpen} aria-hidden="true"><Icon name="chevron-down" size={12} /></span>
                  </button>
                  {#if wfOpen}
                    <div class="cm-pop-scrim" role="presentation" onclick={closeWorkflowPop}></div>
                    <div class="cm-pop cm-pop-wf" role="menu" aria-label="同款工作流">
                      <p class="cm-pop-title">切换工作流</p>
                      {#each templates as item (item.id)}
                        <div class="cm-wf-row">
                          <button class="cm-wf" role="menuitemradio" aria-checked={item.id === templateId} disabled={busy}
                            title={`${templateDisplayName(item.name)} · ${item.node_count} 个节点 · ${item.control_count} 个参数`}
                            onclick={() => pickTemplate(item.id)}>
                            <span class="cm-wf-name">{templateDisplayName(item.name)}</span>
                            {#if item.id === templateId}<span class="cm-wf-tag">当前</span>{/if}
                          </button>
                          <button class="cm-wf-del" aria-label={`删除工作流 ${templateDisplayName(item.name)}`} title="删除这个工作流"
                            disabled={busy || wfDeleting} onclick={() => void removeTemplate(item.id)}>
                            <Icon name="x" size={13} />
                          </button>
                        </div>
                      {/each}
                      <div class="cm-pop-sep"></div>
                      <button class="cm-wf cm-wf-add" role="menuitem" disabled={workflowLoading} onclick={() => wfInput?.click()}>
                        <Icon name="plus" size={13} />
                        <span class="cm-wf-name">{workflowLoading ? "正在读取…" : "加载本地工作流 JSON"}</span>
                      </button>
                    </div>
                  {/if}
                </div>
              </div>
              <div class="cm-actions">
                {#if busy}
                  <button class="cm-btn cm-btn-quiet" onclick={() => void cancel()}>取消</button>
                {:else}
                  <!-- 同宽的隐形占位，不是第二颗按钮：aria-hidden，也点不到 -->
                  <span class="cm-btn cm-btn-quiet cm-cancel-slot" aria-hidden="true">取消</span>
                {/if}
                <button class="cm-go" class:is-busy={busy} disabled={!canGenerate} onclick={() => void generate()}>
                  <span class="cm-go-shine" aria-hidden="true"></span>
                  <span class="cm-go-dot" aria-hidden="true"></span>
                  <span class="cm-go-text">{busy ? "生成中…" : "生成"}</span>
                </button>
              </div>
            </div>
            {#if error}
              <p class="cm-foot-note cm-error" role="status">{error}</p>
            {:else if job && job.state === "error"}
              <p class="cm-foot-note cm-error" role="status">{job.error || job.message}</p>
            {:else if job && (done || job.state === "cancelled")}
              <!-- 生成中不再单独显示这一行：那颗按钮本身就是进度（转圈 + 扫光 + 「生成中…」），下面再说一遍是噪声。
                   跑完之后才需要的信息（已取消 / 已生成 N 张）照旧留着。 -->
              <p class="cm-foot-note cm-status" role="status">{cloneStatusLabel(job)}</p>
            {/if}

            {#if done && job && job.image_ids.length}
              <div class="cm-results">
                <span class="cm-results-label">本次产出</span>
                {#each job.image_ids as id (id)}
                  <button class="cm-chip media-chip" aria-label={`打开生成的第 ${id} 张`} onclick={() => onOpenImage?.(id)}>
                    <img src={backendUrl(`/api/images/${id}/file?max=256`)} alt="" />
                  </button>
                {/each}
              </div>
            {/if}
            </div>
          {/if}
        </div>
        <!-- 常驻的隐藏文件框：底部那颗「工作流」按钮和空态共用它，所以不能只在菜单开着的时候存在。
             位置别挪到组件模板最外层：实测挪出去之后元素还在 DOM 里，但 change 事件不再进 handler。 -->
        <input
          bind:this={wfInput}
          class="cm-file"
          type="file"
          accept="application/json,.json"
          aria-label="选择本地工作流 JSON"
          onchange={(e) => void onWorkflowFile(e)}
        />
      </div>
    </div>
  </div>
{/if}

<MediaPickerModal
  open={open && pickerSlot !== null}
  title="选一张参考图"
  onPick={(picked) => {
    const key = pickerSlot;
    if (!key) return;
    refs = { ...refs, [key]: picked };
    const cell = cells.find((item) => item.key === key);
    // 从 @ 菜单里点「再挂一张」进来的：图挂上了，顺手把 @图片N 插回提示词
    if (cell && mentionPickKey === key) void commitMention(cell.label);
    mentionPickKey = null;
  }}
  onClose={() => (pickerSlot = null)}
/>

<style>
  /* 背景虚化：整个图库画面糊在身后，注意力留在弹窗里（图5 那张版式就是这个感觉）。 */
  .cm-backdrop {
    position: fixed; inset: 0; z-index: 65; padding: 20px;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.5);
    -webkit-backdrop-filter: blur(22px) saturate(112%);
    backdrop-filter: blur(22px) saturate(112%);
  }
  .cm-panel {
    position: relative; width: min(1080px, 100%); max-height: 88vh; overflow: auto; padding: 20px 22px;
    border: 1px solid rgb(255 255 255 / 8%); border-radius: 20px;
    background: rgba(19, 19, 22, 0.86);
    -webkit-backdrop-filter: blur(36px); backdrop-filter: blur(36px);
    box-shadow: 0 32px 90px rgba(0, 0, 0, 0.62); color: #e4e4e7;
  }

  .cm-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
  .cm-top-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .cm-kicker { font-size: 12px; color: #7f7f87; letter-spacing: .02em; }
  .cm-title { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cm-close { flex: none; display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 9px; color: #8a8a8e; background: transparent; }
  .cm-close:hover { color: #fafafa; background: rgb(255 255 255 / 10%); }

  .cm-banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; padding: 9px 12px; font-size: 12.5px; color: #f7d9a8; background: #2a2318; border: 1px solid #4a3c22; border-radius: 10px; }

  .cm-body { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(340px, 470px); gap: 22px; align-items: start; }
  .cm-left { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .cm-hero { width: 100%; max-height: 74vh; object-fit: contain; border-radius: 16px; background: #0c0c0e; }
  .cm-hero-empty { display: flex; align-items: center; justify-content: center; min-height: 220px; font-size: 12.5px; color: #71717a; }
  .cm-hero-name { margin: 0; font-size: 12px; color: #8a8a8e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .cm-right { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .cm-block { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .cm-block-title { margin: 0; font-size: 14px; font-weight: 600; color: #ececef; }

  /* 参考素材条：方形缩略图 + 悬停出现的替换/关闭，末尾是空的「+ 参考」位。
     横向一条而不是换行铺满：多图工作流最多能给 16 格，铺下去提示词框就被顶出弹窗了。 */
  .cm-ref-row { display: flex; flex-wrap: nowrap; gap: 10px; overflow-x: auto; padding: 2px 2px 6px; scrollbar-width: thin; scroll-snap-type: x proximity; }
  .cm-ref-cell { scroll-snap-align: start; flex: none; }
  .cm-ref-cell { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; }
  .cm-tile { position: relative; width: 84px; height: 84px; overflow: hidden; border-radius: 14px; background: #141417; border: 1px solid rgb(255 255 255 / 7%); }
  .cm-tile-img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; object-fit: cover; }
  .cm-tile-add { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 0; font-size: 12.5px; color: #d4d4d8; background: #1a1a1e; cursor: pointer; transition: background-color 140ms ease, border-color 140ms ease; }
  .cm-tile-add:hover { background: #232327; border-color: rgb(255 255 255 / 14%); }
  .cm-tile-swap,
  .cm-tile-x { position: absolute; display: flex; align-items: center; justify-content: center; color: #fafafa; background: rgba(18, 18, 20, 0.78); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); opacity: 0; transition: opacity 140ms ease, background-color 140ms ease; cursor: pointer; }
  .cm-tile-swap { left: 50%; top: 50%; width: 30px; height: 30px; border-radius: 50%; transform: translate(-50%, -50%); }
  .cm-tile-x { top: 5px; right: 5px; width: 20px; height: 20px; border-radius: 50%; }
  .cm-tile:hover .cm-tile-swap,
  .cm-tile:hover .cm-tile-x,
  .cm-tile:focus-within .cm-tile-swap,
  .cm-tile:focus-within .cm-tile-x { opacity: 1; }
  .cm-tile-swap:hover,
  .cm-tile-x:hover { background: rgba(38, 38, 42, 0.95); }
  .cm-tile-x:hover { color: #f87171; }
  .cm-ref-caption { max-width: 84px; font-size: 11.5px; color: #a1a1aa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cm-ref-caption-empty { color: #6b6b73; }

  /* 标题右边那个只读标签：告诉他现在是哪种生成方式，但它不是按钮。 */
  .cm-form { display: contents; }

  /* 高亮遮罩和 textarea 是叠在一起的两层字，盒模型 / 字体 / 折行规则必须一字不差，
     所以两边写进同一条规则：谁要改排版就一起改，拆开改第一次滚动就会看见高亮在飘。 */
  .cm-prompt-bg, .cm-textarea { display: block; box-sizing: border-box; width: 100%; padding: 11px 12px; border: 1px solid transparent; font-family: inherit; font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; }
  .cm-prompt-bg { position: absolute; inset: 0; z-index: 0; overflow: hidden; pointer-events: none; border-radius: 12px; color: #e4e4e7; background: rgba(0, 0, 0, 0.35); }
  .cm-textarea { position: relative; z-index: 1; color: transparent; caret-color: #f24e4e; background: transparent; border-color: rgb(255 255 255 / 8%); border-radius: 12px; resize: vertical; }
  /* 提示词框跟着窗口高矮走：窗口矮的时候先让提示词框让出高度，而不是把下面那排按钮挤出弹窗 ——
     「生成中」和「取消」看不见、要滚动才点得到的弹窗，不算能用。 */
  .cm-textarea { height: clamp(132px, 24vh, 264px); }
  .cm-textarea:focus { border-color: rgb(255 255 255 / 22%); outline: none; }
  .cm-textarea::placeholder { color: #62626a; opacity: 1; }
  /* 高亮只许动颜色和背景：padding / border / font-weight 都会推字节，一改高亮就和光标错位。 */
  .cm-mention-hl { color: #ff6a4d; }
  .cm-field-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 22px; }
  .cm-note { margin: 0; font-size: 11.5px; color: #71717a; }
  .cm-empty { display: flex; flex-direction: column; gap: 10px; padding: 16px; font-size: 12.5px; color: #a1a1aa; background: #1b1b1f; border: 1px dashed #33333a; border-radius: 12px; }

  /* 让位顺序写死在这一行：右边按钮组不参与压缩（「取消」那一格连静止时都提前占好，
     按下生成的一瞬间右边宽度不变），左边每一格 min-width:0 可以被压缩；
     容器真装不下就整排换行，让位的永远是左边那排胶囊，不是右边的「取消」和「生成」（苏醒 Round 15 截图）。 */
  .cm-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px 12px; flex-wrap: wrap; }
  /* flex-basis 定死 240px（不是 auto）：auto 的话这一格的基准＝内容宽度，工作流名字一长整排就换行，
     换一份工作流按钮就跳一次位置（苏醒截图里「生成」掉到第二行就是这么来的）。定死之后，这一排
     要不要换行只跟容器宽度有关，跟名字长短、跟是不是在生成，都无关。 */
  .cm-foot-left { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1 1 240px; }
  /* min-width:0：flex 子项默认 min-width:auto，长名字会把这一格顶穿，压到右边的按钮上 */
  .cm-pop-wrap { position: relative; min-width: 0; }
  /* 工作流那颗的宽度由这一格说了算，不由名字长短说了算：基准 132px + 吃掉剩余。
     于是换一份工作流、或者按下「生成」把右边撑宽，这一排的几何一律不许动——名字长短决定不了布局。
     长名字在胶囊里截断，全名在弹窗顶部标题和悬浮提示里都还在。 */
  .cm-foot-left > .cm-fill { flex: 1 1 132px; }
  .cm-fill .cm-pill { width: 100%; }
  .cm-pill:disabled { opacity: .62; cursor: default; }
  .cm-pill { position: relative; z-index: 5; flex: 0 1 auto; min-width: 0; display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 13px; font-size: 12.5px; color: #e4e4e7; background: rgb(255 255 255 / 7%); border: 1px solid rgb(255 255 255 / 9%); border-radius: 999px; cursor: pointer; }
  .cm-pill:hover { background: rgb(255 255 255 / 11%); }
  .cm-pill-text { min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 箭头不参与压缩，被挤的只许是中间那段名字（svg 自带尺寸，压不动） */
  .cm-chevron { display: inline-flex; flex: none; transition: transform 160ms ease; }
  .cm-chevron.is-open { transform: rotate(180deg); }
  /* 生成中这颗点不开，箭头是句假话；只收画面不撤位置，胶囊宽度不随生成状态抖 */
  .cm-pill.is-busy .cm-chevron { visibility: hidden; }

  .cm-pop-scrim { position: fixed; inset: 0; z-index: 4; }
  .cm-pop {
    position: absolute; left: 0; bottom: calc(100% + 10px); z-index: 5; width: 328px; max-height: 46vh; overflow: auto;
    display: flex; flex-direction: column; gap: 10px; padding: 14px;
    border: 1px solid rgb(255 255 255 / 9%); border-radius: 16px; background: #1a1a1e;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  }
  .cm-pop-title { margin: 2px 0 0; font-size: 12.5px; color: #a1a1aa; }
  /* 这颗胶囊靠着右列的右边缘，弹层左对齐会被顶出弹窗（窄窗口实测错位）。贴着胶囊右边往左长才稳。 */
  .cm-pop-wf { left: auto; right: 0; width: 268px; gap: 3px; }
  .cm-pop-sep { height: 1px; margin: 5px 0; background: rgb(255 255 255 / 8%); }
  .cm-wf { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; font-size: 12.5px; color: #d4d4d8; text-align: left; background: transparent; border-radius: 10px; cursor: pointer; }
  .cm-wf:hover:not(:disabled) { background: rgb(255 255 255 / 7%); color: #fafafa; }
  .cm-wf:disabled { opacity: .5; cursor: default; }
  .cm-wf-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cm-wf-tag { flex: none; padding: 1px 7px; font-size: 10.5px; color: #f87171; background: rgb(242 78 78 / 16%); border-radius: 999px; }
  /* 一行一条工作流：整行就是一颗胶囊，名字和那颗 X 在同一个亮面上，不再像并排的两个控件 */
  .cm-wf-row { display: flex; align-items: center; gap: 2px; padding-right: 4px; border-radius: 10px; transition: background-color 120ms ease; }
  .cm-wf-row:hover { background: rgb(255 255 255 / 7%); }
  /* 名字自己不再画底，底色归整行；不然名字亮一块、X 亮另一块，看着还是分开的 */
  .cm-wf-row > .cm-wf { flex: 1; min-width: 0; padding-right: 0; border-radius: 10px 0 0 10px; }
  .cm-wf-row > .cm-wf:hover:not(:disabled) { background: transparent; }
  .cm-wf-row:hover > .cm-wf:not(:disabled) { color: #fafafa; }
  /* 删除是一颗中性灰的 X 图标：这里整片菜单都是深色中性调，红色（品牌色）摆上来太抢 */
  .cm-wf-del {
    flex: none; display: grid; place-items: center; width: 24px; height: 24px;
    color: #8f8f96; background: transparent;
    border-radius: 8px; cursor: pointer; opacity: 0; visibility: hidden;
    transition: opacity 120ms ease, color 120ms ease, background 120ms ease;
  }
  .cm-wf-row:hover .cm-wf-del, .cm-wf-del:focus-visible { opacity: 1; visibility: visible; }
  .cm-wf-del:hover:not(:disabled) { color: #fafafa; background: rgb(255 255 255 / 10%); }
  .cm-wf-del:disabled { cursor: default; }
  .cm-file { display: none; }
  .cm-ratio-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
  .cm-ratio { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 8px 2px; border-radius: 10px; color: #b8b8bf; background: transparent; cursor: pointer; transition: background-color 120ms ease, color 120ms ease; }
  .cm-ratio:hover { background: rgb(255 255 255 / 6%); color: #e4e4e7; }
  .cm-ratio.is-on { background: rgb(255 255 255 / 13%); color: #fafafa; }
  .cm-ratio-box { border: 1.5px solid currentColor; border-radius: 3px; opacity: .85; }
  .cm-ratio-flat { height: 26px; display: flex; align-items: center; font-size: 14px; }
  .cm-ratio-label { font-size: 11.5px; white-space: nowrap; }
  .cm-seg { display: flex; flex-wrap: wrap; gap: 6px; }
  .cm-seg-item { min-width: 46px; height: 30px; padding: 0 10px; font-size: 12.5px; color: #b8b8bf; background: rgb(255 255 255 / 5%); border-radius: 8px; cursor: pointer; }
  .cm-seg-item:hover { background: rgb(255 255 255 / 9%); }
  .cm-seg-item.is-on { background: rgb(255 255 255 / 15%); color: #fafafa; font-weight: 600; }
  .cm-custom { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 11.5px; color: #7c7c84; }
  .cm-custom input { width: 92px; height: 28px; padding: 0 8px; font-size: 12.5px; color: #e4e4e7; background: rgba(0, 0, 0, 0.4); border: 1px solid rgb(255 255 255 / 9%); border-radius: 8px; }

  /* 按钮组画在胶囊之上：哪天再溢出，被压住的也不许是「取消」和「生成」 */
  .cm-actions { position: relative; z-index: 6; display: flex; align-items: center; gap: 8px; margin-left: auto; flex: none; }
  .cm-btn { height: 34px; padding: 0 14px; font-size: 12.5px; color: #e4e4e7; background: #27272a; border: 1px solid #303036; border-radius: 999px; cursor: pointer; }
/* 生成中只留一颗会动的按钮：取消退成一句安静的话，不再和参数胶囊抢位置。 */
.cm-btn-quiet { color: #9a9aa2; background: transparent; border-color: transparent; padding: 0 12px; }
.cm-btn-quiet:hover:not(:disabled) { color: #e4e4e7; background: rgb(255 255 255 / 6%); border-color: transparent; }
/* 静止时先把「取消」那一格占住（同字号同内边距，只是不画出来）：取消出现与消失都不改右边这组的宽度，
   左边胶囊不会在按下「生成」的瞬间重排一次——同一排忽长忽短正是错位的起点。 */
.cm-cancel-slot { display: inline-flex; align-items: center; visibility: hidden; user-select: none; }
  .cm-btn:hover:not(:disabled) { border-color: #4b4b52; }
  .cm-btn:disabled { opacity: .5; cursor: default; }
  .cm-btn-accent { background: #f24e4e; border-color: transparent; color: #141416; font-weight: 600; }

  /*
    主按钮：图库各处的主操作都是这颗品牌红，这里跟它对齐（同一套红、同一套圆角节奏）。
    生成要等十几秒到几十秒，所以按下去之后必须有东西在动：一道扫光 + 一颗转动的点，
    让人知道请求活着，而不是界面卡住了。转圈的是按钮里的小圆点，不是整颗按钮。
  */
  .cm-go { position: relative; overflow: hidden; display: inline-flex; align-items: center; justify-content: center; gap: 9px; height: 36px; min-width: 112px; padding: 0 18px; font-size: 13px; font-weight: 600; color: #fff; background: linear-gradient(135deg, #ff6a4d, #f24e4e 46%, #d63b57); border: 0; border-radius: 999px; box-shadow: 0 6px 18px rgba(242, 78, 78, .26), inset 0 1px 0 rgba(255, 255, 255, .18); cursor: pointer; transition: transform 140ms ease, box-shadow 140ms ease, filter 140ms ease; }
  .cm-go:hover:not(:disabled) { filter: brightness(1.07); transform: translateY(-1px); box-shadow: 0 10px 26px rgba(242, 78, 78, .34), inset 0 1px 0 rgba(255, 255, 255, .22); }
  .cm-go:active:not(:disabled) { transform: translateY(0); filter: brightness(.97); }
  .cm-go:disabled { color: #6f6f78; background: #2a2a2e; box-shadow: none; cursor: default; transform: none; filter: none; }
  /* 生成中不能塌成一颗死灰的禁用键：还是同一颗 CTA，只是压暗 + 扫光 + 转圈，
     一眼看得懂「它在干活」，而不是「这个按钮坏了/不能点」。 */
  .cm-go.is-busy { color: #fff; cursor: progress; background: linear-gradient(135deg, #b3563f, #a03b3b 46%, #8b2f40); box-shadow: 0 4px 14px rgba(242, 78, 78, .16), inset 0 1px 0 rgba(255, 255, 255, .12); filter: none; transform: none; }
  .cm-go-text { position: relative; white-space: nowrap; }
  .cm-go-shine { position: absolute; inset: 0; transform: translateX(-105%); background: linear-gradient(100deg, transparent 22%, rgba(255, 255, 255, .34) 50%, transparent 78%); pointer-events: none; }
  .cm-go.is-busy .cm-go-shine { animation: cm-sweep 1.45s linear infinite; }
  .cm-go-dot { position: relative; flex: none; width: 13px; height: 13px; border-radius: 50%; background: radial-gradient(circle at 34% 32%, #fff, rgba(255, 255, 255, .35)); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .4); }
    /* 静止时那颗白点只会把「生成」两个字顶偏（真机上就是苏醒指出的不对称）——圆点只在生成中转圈。 */
  .cm-go:not(.is-busy) { gap: 0; }
  .cm-go:not(.is-busy) .cm-go-dot { display: none; }
  .cm-go.is-busy .cm-go-dot { background: transparent; box-shadow: none; border: 2px solid rgba(255, 255, 255, .42); border-top-color: #fff; animation: cm-spin .68s linear infinite; }
  @keyframes cm-sweep { to { transform: translateX(105%); } }
  @keyframes cm-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .cm-go.is-busy .cm-go-shine, .cm-go.is-busy .cm-go-dot { animation: none; }
    .cm-go { transition: none; }
  }
  .cm-error { margin: 0; font-size: 12px; color: #f28b82; }
  .cm-status { margin: 0; font-size: 12px; color: #9ad1a4; }
/* 状态与报错单独占操作行下面一行：生成前后那颗按钮一动不动。 */
.cm-foot-note { margin: 8px 0 0; }
  .cm-results { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .cm-results-label { font-size: 11.5px; color: #71717a; }
  .cm-chip { width: 60px; height: 60px; }

  @media (max-width: 900px) {
    .cm-body { grid-template-columns: 1fr; }
    .cm-hero { max-height: 40vh; }
    .cm-pop { width: min(328px, 78vw); }
    .cm-pop-wf { width: min(268px, 78vw); }
  }

  /* ── @ 引用素材菜单：抄图库那套胶囊菜单的版式，只是贴在光标下面。 */
  .cm-prompt-wrap { position: relative; }
  .cm-mention {
    position: absolute; z-index: 6; width: 236px; max-height: 214px; overflow: auto;
    display: flex; flex-direction: column; gap: 2px; padding: 8px;
    border: 1px solid rgb(255 255 255 / 10%); border-radius: 14px; background: #1c1c20;
    box-shadow: 0 18px 46px rgba(0, 0, 0, 0.55);
  }
  .cm-mention-title { margin: 2px 6px 6px; font-size: 11.5px; color: #7f7f87; }
  .cm-mention-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; font-size: 12.5px; color: #d4d4d8; text-align: left; background: transparent; border: 0; border-radius: 9px; cursor: pointer; }
  .cm-mention-item:hover, .cm-mention-item.is-on { background: rgb(255 255 255 / 8%); color: #fafafa; }
  .cm-mention-icon { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; overflow: hidden; border-radius: 7px; color: #a1a1aa; background: rgb(255 255 255 / 6%); }
  .cm-mention-thumb { width: 100%; height: 100%; object-fit: cover; background: #0c0c0e; }
  .cm-mention-label { flex: none; font-weight: 600; color: #ececee; }
  .cm-mention-add .cm-mention-icon { color: #f8a29a; background: rgb(242 78 78 / 12%); }
  .cm-mention-file { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: #71717a; }
  .cm-mention-add .cm-mention-label { font-weight: 500; color: #f8a29a; }
</style>
