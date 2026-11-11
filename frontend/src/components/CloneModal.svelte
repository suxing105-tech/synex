<script lang="ts">
  /**
   * 再次创作弹窗：左边这张图，右边「工作流 + 参考位 + 提示词 + 比例/分辨率 + 生成」。
   *
   * 三条约束都是从用户角度定的：
   * 1. 提示词默认带这张图自己的（ComfyUI 写回的 → 反推的 → 空）；工作流内置那条只给按钮，
   *    因为换完参考图之后原文十有八九对不上画面。
   * 2. 参考位数量由工作流决定（LoadImage 节点数），默认全部填被点的这张图：最常见的用法
   *    就是「拿这张图再抽一张」，一次点击就能出图。
   * 3. 弹窗里不放「在 ComfyUI 中打开」：这是后台出图的入口，调试去设置页看模板 JSON。
   */
  import { get } from "svelte/store";
  import { tick, untrack } from "svelte";
  import { comfyuiApi, imagesApi } from "../lib/api";
  import { backendUrl } from "../lib/backend-url";
  import { basenameOnly } from "../lib/media-format";
  import { comfyuiStatus, stopAudio } from "../lib/stores";
  import { pushToast } from "../lib/toast";
  import { modalFocus } from "../lib/modal-focus";
  import { subscribeFileDrop } from "../lib/native-drop";
  import Icon from "./Icon.svelte";
  import MediaPickerModal from "./MediaPickerModal.svelte";
  import CloneCanvas from "./CloneCanvas.svelte";
  import type { CanvasEscape } from "../lib/clone-canvas";
  import {
    applyCloneProgress, buildGenerateRequest, cloneApi, cloneError, cloneJob, cloneStatusLabel,
    allowsTextMode, controlSlots, controlSummary, defaultControlValues, defaultReferences, latestReversePrompt,
    promptGroupValues, modeFromRefCount, modeLabel, numberPresets, numberUnit,
    primaryPromptGroup, promptGroupHint, promptPlaceholder, promptSlots, promptSourceLabel, secondaryPromptGroups,
    ratioShape, referenceCells, referenceIssues, resolvePromptSource, shouldOfferWorkflowPrompt, slotKey, visibleRefCells, voiceAvatar, voiceSample, nativeLanguageOverride,
    firstFreeRefKey, mergedRefCells, openRefKinds, REF_DISPLAY_ORDER,
    CLONE_SETTINGS_TAB, cloneOpen, cloneBatches, clearCloneBatches, armCloneBatchAspect, cloneOutputsOf,
    cloudApi, coinsLabel, isCloudTemplate, mentionsTags, supportsRefFamily,
    type CloudStatus,
    applyMention, caretCoordinates, mentionAddLabel, mentionChunks, mentionInsertText, mentionItems as buildMentionItems, mentionToken,
    audioModeLabel, audioModeTemplates, familyCells, isAudioTemplate, isVideoTemplate, promptGroupPlaceholder,
    workflowMenuRows, workflowDisplayName, cloudMenuGroups, AUDIO_MODE_GROUP_LABEL,
    CREATION_KIND_ORDER, CREATION_KIND_WORDS, rowsForKind, rowForKindSwitch, tallyByKind,
    referenceCounter, referenceFamilies, referenceNoun,
    REF_KIND_COUNTERS, REF_KIND_NAMES, templateDisplayName, templateMediaKind,
    WF_KIND_WORDS, WF_OUTPUT_WORDS,
    type CloneOutput, type CloneSlot, type MediaKind, type MentionItem, type MentionToken, type PromptGroup, type RefCell, type RefKind,
    type CloneJob, type CloneSources, type CloneTemplate,
  } from "../lib/clone";
  import type { ImageSummary, ImportResponse, MediaFeedItem } from "../lib/types";

  interface Props {
    open: boolean;
    /** 被点的那张图；关掉弹窗时父组件会置空，所以允许 null */
    image: MediaFeedItem | null;
    onClose: () => void;
    /** 打开设置页某个分区（没有工作流时要去导入） */
    onOpenSettings?: (tab: string) => void;
    /** 点本次产出的缩略图 → 跳到图库里那一份（图片进对比、视频进播放器，由父组件分派） */
    onOpenImage?: (id: number, kind?: string) => void;
    /**
     * 画布原型（浏览器加 ?cm_canvas=1，只在 DEV 生效）：跑完之后上半区那一格换成
     * 一个可缩放的画布，整批铺开、多轮累积。撤掉这个开关就是现在这一格一张张翻的形态，
     * 两条分支并存着比原地替换好——实拍对比过再决定要不要转正。
     */
    canvasPrototype?: boolean;
  }
  let { open, image, onClose, onOpenSettings, onOpenImage, canvasPrototype = false }: Props = $props();

  let templates = $state<CloneTemplate[]>([]);
  let templatesLoaded = $state(false);
  let templateId = $state<number | null>(null);
  const template = $derived(templates.find((t) => t.id === templateId) ?? null);

  let prompt = $state("");
  let promptOrigin = $state("");
  let promptLoading = $state(false);
  /**
   * 提示词的三个来源分开放，最后由 syncPrompt 定序：文件自带的 → 反推的 → 当初记下的。
   * 读文件那条和读来源那条是两个请求，谁先回来都行；但迟到那份绝不许盖掉用户已经敲进去的字。
   */
  let filePrompt = "";
  let reversePrompt = "";
  let promptTouched = false;
  let refs = $state<Record<string, ImageSummary | null>>({});
  /**
   * 这张图当初喂的参考图。再次创作生成过的才有；读回来之后参考位照它重摆。
   * 用两张参考做出来的画面，点开再次创作就该看到那两张，而不是让人重新选一遍。
   */
  let sources = $state<CloneSources | null>(null);
  let controls = $state<Record<string, string | number>>({});
  /**
   * 主框之外那几个附框填了什么（键 =「节点.输入」）。
   * 音色克隆那类节点要两段文字：要说的话进主框，参考音频里的原话进附框。合成一框就等于
   * 用户改台词的同时把原话冲掉，克隆出来的音色立刻不像——所以各填各的，各交各的。
   */
  let extraPrompts = $state<Record<string, string>>({});
  let pickerSlot = $state<string | null>(null);
  let error = $state("");
  let submitting = $state(false);
  let jobId = $state("");
  let probing = $state(false);
  let popOpen = $state(false);
  let wfOpen = $state(false);

  /* 悬停/键盘聚焦某一张参考就放大那一张（图二那个 composer 的交互）：格子里只有 84px，
     一眼认不出是哪份素材。坐标现场量、用 fixed 摆——弹窗自己会滚，挂成绝对定位会被裁掉。
     尺寸按这份素材自己的比例算：格子是被裁成方的，放大还按方的摆，就成了「一条黑边裱一张小图」。
     比例直接从格子里那张已经解码完的 <img> 拿，不用再等一次加载；拿不到（音频、图没解码）退回竖版。
     优先朝上开（composer 在这一屏下半部），上面放不下才朝下。 */
  const ZOOM_MAX_W = 224;
  const ZOOM_MAX_H = 268;
  const ZOOM_MIN_H = 96;
  let refZoom = $state<{ src: string; label: string; file: string; style: string } | null>(null);
  function refZoomFor(
    el: HTMLElement,
    picked: { filename: string; thumbnail_url?: string | null; original_url?: string | null } | null | undefined,
    label: string,
  ) {
    if (!picked) { refZoom = null; return; }
    const img = el.querySelector("img");
    const ar = img && img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 0.75;
    let w = ZOOM_MAX_W;
    let h = w / ar;
    if (h > ZOOM_MAX_H) { h = ZOOM_MAX_H; w = h * ar; }
    if (h < ZOOM_MIN_H) { h = ZOOM_MIN_H; w = Math.min(ZOOM_MAX_W, h * ar); }
    const r = el.getBoundingClientRect();
    const left = Math.max(12, Math.min(r.left, innerWidth - w - 12));
    const roomAbove = r.top - 20;
    const above = roomAbove >= h || roomAbove >= innerHeight - r.bottom - 20;
    refZoom = {
      src: backendUrl(picked.thumbnail_url || picked.original_url || ""),
      label,
      file: picked.filename,
      style: `width:${w.toFixed(1)}px; height:${h.toFixed(1)}px; left:${left.toFixed(1)}px; `
        + (above ? `bottom:${(innerHeight - r.top + 10).toFixed(1)}px;` : `top:${(r.bottom + 10).toFixed(1)}px;`),
    };
  }
  /** 弹层顶部那一排的两个屏：本机的配方在「本地工作流」，云端的收费模型在「云端API服务」。 */
  let wfTab = $state<"local" | "cloud">("local");
  /**
   * 音色试听：正在放的那一个选项值，"" = 没在放。
   *
   * 走组件里自己那条隐藏 <audio>，不走全局 AudioEngine：那条只认后端给的 play_url，
   * 而样本是随安装包走的静态文件；更要紧的是它一响就把图库卡片的状态抢过去，
   * 试听个音色不该让右侧的音频卡片跟着变「正在播放」。
   * 两条 <audio> 用 bind:this 拿到（和 AudioEngine 一个口径）。它们只许在事件回调和
   * untrack 里读写：试听开关一读它们就进依赖表，下面那条 effect 会在「刚点起播放」
   * 那一次重跑里自己把声音停掉。
   */
  let hearingVoice = $state("");
  let sampleEl = $state<HTMLAudioElement | null>(null);
  /** 左边那张音频卡自带的播放器：同一时刻只准有一个声音在响。 */
  let heroEl = $state<HTMLAudioElement | null>(null);
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
  /** 云端跑挂了但产物还取得回来：给一颗明确的出口，而不是留一句死错误。 */
  const refetchable = $derived(Boolean(
    job && job.recoverable && job.task_row_id
    && (job.state === "error" || job.state === "cancelled"),
  ));
  const workflowPrompt = $derived(template?.default_prompt ?? "");
  const cells = $derived(referenceCells(template));

  /** 点开这张卡的是哪一族：图片 / 视频 / 音频。决定素材默认落哪一格与产出怎么称呼。 */
  const cardKind = $derived<RefKind>(
    image?.kind === "video" ? "video" : image?.kind === "audio" ? "audio" : "image",
  );
  /** 叙述这一份素材的量词 + 名词：「这张视频」「这段音频」别统称成图。 */
  const cardLabel = $derived(
    cardKind === "video" ? "这条视频" : cardKind === "audio" ? "这段音频" : "这张图",
  );
  const isVideoWf = $derived(isVideoTemplate(template));
  // 弹窗的行为跟工作流走，不跟卡片走：在图片卡上换成音频工作流，
  // @ 引用也不该突然开始插 H3 的尖括号标签。
  const mediaKind = $derived<MediaKind>(templateMediaKind(template));
  /* ── 云端那三条 API ─────────────────────────────────────────────────
     可用性只在开弹窗与打开工作流菜单时读一次：它管的是「这一行现在点不动，差点什么」，
     不是要盯着的进度。读不到就当不知道（不置灰、不报原因）——提交那一关后端会拦，
     误灰一条其实能用的 API 比放行更糟。 */
  let cloudStatus = $state<CloudStatus | null>(null);
  let refetching = $state(false);
  const isCloud = $derived(isCloudTemplate(template));
  const cloudReason = $derived(
    cloudStatus && !cloudStatus.availability?.available
      ? cloudStatus.availability?.reason || "云端现在还不能用"
      : "",
  );
  /** 被点那一族这条 API 根本不吃：说清没放进去，这句挂在卡的悬停提示里。 */
  const cardFamilyNote = $derived(
    isCloud && cells.length > 0 && !supportsRefFamily(template, cardKind)
      ? `这条云端 API 不吃${REF_KIND_NAMES[cardKind]}参考，${cardLabel}没放进去。要喂素材就点下面的参考位。`
      : "",
  );
  /** 一族一行。只有图片一族时，参考区与图片再次创作的版面一字不差。 */
  const imageCells = $derived(familyCells(cells, "image"));
  const audioCells = $derived(familyCells(cells, "audio"));
  const videoCells = $derived(familyCells(cells, "video"));
  const families = $derived(referenceFamilies(template));
  /** 「参考图 / 参考素材」与「张 / 份」：三族混在一起时别再一口一个「这张图」。 */
  const refNoun = $derived(referenceNoun(template));
  const refCounter = $derived(referenceCounter(template));
  /**
   * 音频弹窗顶上那排模式按钮：出声音的工作流有几条就有几种出声方式（参考音色 /
   * 音色描述 / 指定音色）。它们各是不同模型的另一份工作流，所以点按钮走的是换模板
   * 那条现成的路——参考位、参数、附框全按新那条重摆，台词留着不冲。
   * 只有一条时不摆：一颗按钮的开关不是模式选择，是噪音。
   */
  const audioModes = $derived(isAudioTemplate(template) ? audioModeTemplates(templates) : []);
  /**
   * 「切换工作流」那一列：图片、视频各列各的，音频那几条收成一条「闪寻音频」。
   * 三种出声方式已经有弹窗顶上那排按钮了，清单里再列三条就是让人在两个地方选同一件事。
   */
  const wfRows = $derived(workflowMenuRows(templates, templateId));
  /**
   * 这一屏在产出哪一族——**跟着挂上的那份工作流走，不另开一个状态**：底部那颗写着「图片」、
   * 实际却挂着出声音的配方，是最难查的一种不一致（弹窗的行为本来就跟工作流走，不跟卡片走）。
   * 一条都没挂上时按被点的那张卡说，至少那颗 pill 不会空着。
   */
  const pickedKind = $derived<MediaKind>(template ? templateMediaKind(template) : cardKind);
  /** 三族各铺了几条路（本机几份 / 云端几条）。行末那串小字 2026-11-10 撤了，这数只在悬停提示里说。 */
  const kindTally = $derived(tallyByKind(wfRows, templates));
  /** 「创作类型」那层弹层。与工作流、参数那两层互斥——同一次屏幕上只可能有一层。 */
  let kindPop = $state(false);
  /** 三族的图标。音频用波形：这三条是 TTS 说话，不是做音乐。 */
  const KIND_ICONS: Record<MediaKind, string> = { image: "image", video: "video", audio: "wave" };
  /** 折叠那行悬浮说清它管的是哪三种方式——清单里看不到名字，总得在这儿报到。 */
  const wfGroupTitle = $derived(
    `三种出声方式在弹窗顶上切换：${audioModeTemplates(templates).map((item) => audioModeLabel(item.name)).join(" / ")}`,
  );
  /** 普通一行：名字之外报出片还是出图、几个节点几个参数，跟折叠那行同一套口径。 */
  function wfRowTitle(row: (typeof wfRows)[number]): string {
    const item = templates.find((t) => t.id === row.targetId);
    if (!item) return row.label;
    if (isCloudTemplate(item)) {
      // 云端没有「节点」这件事，报节点数是把本机的口径硬套过去。
      const bits = [row.label, WF_OUTPUT_WORDS[row.kind], "云端收费模型 · 出一次扣 RH币"];
      if (item.cloud?.verified === false) bits.push("端点还没实测过，第一次先拿最便宜的试");
      if (cloudReason) bits.push(`现在点不动：${cloudReason}`);
      bits.push("行末的 X 只是把它从清单里去掉，设置 → 模型API配置里能恢复回来");
      return bits.join(" · ");
    }
    return `${row.label} · ${WF_OUTPUT_WORDS[row.kind]} · ${item.node_count} 个节点 · ${item.control_count} 个参数`;
  }
  /** 菜单这一行对应库里哪一条（折叠那行只可能是本机那三条音频）。 */
  function rowTemplate(row: (typeof wfRows)[number]): CloneTemplate | null {
    return templates.find((item) => item.id === row.targetId) ?? null;
  }
  function rowIsCloud(row: (typeof wfRows)[number]): boolean {
    return isCloudTemplate(rowTemplate(row));
  }
  /** 账号没配 / Key 没填 / 总开关关着：这一行现在点下去只会拿到一句错误，所以先灰掉。 */
  function rowBlocked(row: (typeof wfRows)[number]): boolean {
    return rowIsCloud(row) && Boolean(cloudReason);
  }
  /** 「待实测」：端点或字段还没在真账号上跑通过，画面上就得说实话。 */
  function rowUnverified(row: (typeof wfRows)[number]): boolean {
    return isCloudTemplate(rowTemplate(row)) && rowTemplate(row)?.cloud?.verified === false;
  }
  /**
   * 这一屏摆哪几行：本机的配方与云端的 API 分两屏，不再混在一份清单里。
   * 混着摆的时候六行里其实只有两条路，眼睛得先替人做一遍分类。
   */
  const popRows = $derived(
    rowsForKind(wfRows, pickedKind).filter((row) => rowIsCloud(row) === (wfTab === "cloud")),
  );
  /** 「API」那颗后面的条数：不用点进去也知道这条路铺了几条 API。 */
  const cloudRowCount = $derived(rowsForKind(wfRows, pickedKind).filter((row) => rowIsCloud(row)).length);
  /**
   * API 那一屏的左列：一家服务商一行，右列摆它报的那些模型（2026-11-04 苏醒给的图二版式）。
   * 只有后端标了 is_cloud 的条目会进来，所以这一屏不可能摆出一家点不动的假服务商。
   */
  const apiGroups = $derived(
    cloudMenuGroups(rowsForKind(wfRows, pickedKind).filter((row) => rowIsCloud(row)), templates),
  );
  /** 指针停在哪家：悬停或点左列换它。没停过时回落到第一家；一家都没装时整块不画，走下面那句空态。 */
  let apiVendor = $state("");
  const apiActive = $derived(apiGroups.find((group) => group.key === apiVendor) ?? apiGroups[0] ?? null);
  /** 「已实测」只说后端明说 verified=true 的那几条；没说过的一句都不讲。 */
  function rowVerified(row: (typeof wfRows)[number]): boolean {
    return isCloudTemplate(rowTemplate(row)) && rowTemplate(row)?.cloud?.verified === true;
  }
  /**
   * 打开弹层：当前挂的是云端就开在「云端API服务」屏，是本机的就开在「本地工作流」屏。
   * 每次打开重读一次云端状态（Key 可能刚在设置里填过），读失败不置灰——
   * 读不到不等于云端坏了，真点下去再报错。
   */
  function toggleWorkflowPop() {
    wfOpen = !wfOpen;
    if (!wfOpen) return;
    popOpen = false;
    kindPop = false;
    wfTab = isCloud ? "cloud" : "local";
    void loadCloudStatus();
  }
  /** 这条工作流一个参考位都不吃时该说一句什么：不摆进版面，挂到卡的悬停提示上。 */
  const noRefNote = $derived(
    mediaKind === "audio"
      ? "这一种不用参考音频：想要什么样的声音写在下面的文字格与参数里。"
      : "这份工作流不需要参考素材，写好提示词就能出。",
  );
  /** 主框下面还要多摆几个框（参考音频的原话那种）。没有就一个都不摆。 */
  const secondaryGroups = $derived(secondaryPromptGroups(template));
  /**
   * 提示词框下面不再摆那行灰字（2026-11-04 苏醒：「这种小字提示也删掉」）。提示词来源挂到框的
   * title 上：鼠标悬停才说，版面不占。没有来源可说时不给 title，让框自己的 placeholder
   * （@ 可以引用哪份素材）照常显示。
   */
  const promptFoot = $derived(promptLoading ? "正在读这张图的提示词…" : promptOrigin);
  /** 没有来源记录时，被点的这张卡该站的那一格：图片卡＝图片1，视频卡＝视频1。 */
  const homeKey = $derived((familyCells(cells, cardKind)[0] ?? cells[0])?.key ?? "");

  /**
   * 参考位上那是成图自己、不是当初的参考图——只在「这张确实是 AI 出的图、参考图却没认出来、
   * 而它该站的那一格还没被用户动过」时说一次。用户一换素材这句就该消失，否则就成了瞎报。
   */
  const lostItsReferences = $derived(
    !!sources && !sources.references.length && sources.origin === "unrecorded"
    && Boolean(homeKey) && refs[homeKey]?.id === image?.id,
  );
  /**
   * 卡底那几行灰字合并成的一句提示，挂在 composer 卡的 title 上（2026-11-04 苏醒：「这种小字提示
   * 也删掉」）。丢了几份、被点这一族没被吃进去、这条工作流本来不吃参考——命中哪个说哪个；
   * 版面不占，悬停才看得到。
   */
  const composerNote = $derived(
    cells.length === 0
      ? noRefNote
      : sources && sources.dropped > 0
        ? `${cardLabel}当初还用了 ${sources.dropped} ${refCounter}${refNoun}，已经不在图库里了，重新生成前补上。`
        : lostItsReferences
          ? `没找到${cardLabel}当初用的${refNoun}，先放了它自己当参考。要原来那几份，点参考位换一下。`
          : cardFamilyNote,
  );
  const refCount = $derived(cells.filter((cell) => refs[cell.key]).length);
  // 生成方式是参考素材数量的函数，不是一个开关：0 份文生 / 1 份单参考 / 2 份以上多参考。
  const mode = $derived(modeFromRefCount(refCount));
  const canText = $derived(allowsTextMode(template));
  const issues = $derived(referenceIssues(template, refs, canText));
  /**
   * 参考区是一行，不是一族一行：三族各排一行时，用户看到的是三块互不相干的东西，
   * 加一份素材得先判断「这算哪一块」；合成一行之后它就是一个参考列表，末尾一颗「+ 参考」。
   * 排布按 REF_DISPLAY_ORDER（图片 → 视频 → 音频），跟 H3 把参考摆进上下文的顺序一个说法。
   *
   * 只有一族（图片再次创作）时仍走原来的 visibleRefCells：已填的 + 一颗「+ 参考」，
   * 版面、可访问名、悬浮说明与图片再次创作一字不差。
   */
  const singleFamily = $derived(families.length <= 1);
  const onlyFamily = $derived<RefKind>(families[0] ?? "image");
  const rowCells = $derived.by<{ kind: RefKind; cell: RefCell }[]>(() =>
    singleFamily
      ? visibleRefCells(familyCells(cells, onlyFamily), refs).map((cell) => ({ kind: onlyFamily, cell }))
      : mergedRefCells(cells, refs).map((cell) => ({ kind: (cell.kind ?? "image") as RefKind, cell })),
  );
  /** 还有空位的族：那颗「+ 参考」点不点得动、素材选择器给哪几个族 tab，全看它。 */
  const openKinds = $derived(openRefKinds(cells, refs));
  /**
   * 左边那一摞实际摆几块：格子（已填的 + 单族时那颗空格子）+ 那颗不绑族的「+ 参考」。
   *
   * 叠放的错位量、悬停时摊开多少，CSS 自己数不到 DOM，全从这一个数算出来。
   */
  const stackCount = $derived(rowCells.length + (!singleFamily && openKinds.length ? 1 : 0));
  /* 每张照片露多少、悬停再多露一点那两个数撤了（2026-11-10 参考改回横排）：横排不叠，用不着算露多少。 */
  /** 这一族最多吃几份：悬浮说明按族报上限，各族不互相借量词。 */
  function familyTotal(kind: RefKind): number {
    return kind === "audio" ? audioCells.length : kind === "video" ? videoCells.length : imageCells.length;
  }
  // 视频工作流插的是 H3 原生标签（<Picture 1>），图片工作流仍插 @图片1，一条老规矩都没动。
  const mentionOptions = $derived(mentionOpen ? buildMentionItems(cells, refs, mentionQuery, mediaKind, isCloud) : []);
  /**
   * 素材选择器：绑到某一格（替换、@ 菜单、图片再次创作那颗「+」）时只列那一族，标题写死那一族；
   * 点合并行里那颗不绑族的「+ 参考」时几族一起列，标题跟着当前挑的族走。
   */
  const ADD_ANY = "*";
  const pickerCell = $derived(cells.find((cell) => cell.key === pickerSlot) ?? null);
  const pickerKind = $derived<RefKind>(pickerCell?.kind ?? openKinds[0] ?? "image");
  const pickerKinds = $derived<RefKind[]>(pickerCell ? [pickerCell.kind ?? "image"] : openKinds);
  const PICKER_TITLES: Record<RefKind, string> = {
    image: "选一张参考图", audio: "选一段参考音频", video: "选一条参考视频",
  };
  /** 绑格子才有固定称呼；不绑族时留空，让选择器按当前挑的族自己拼标题。 */
  const pickerTitle = $derived(pickerCell ? PICKER_TITLES[pickerCell.kind ?? "image"] : "");

  /**
   * 整块参考区的可访问名。合并成一行之后它管的是这一整块，不再一族一个分组：
   * 「（单图编辑）」这半句仍挂在这儿——生成方式不是开关，是参考素材数量的函数。
   */
  const rowAria = $derived(`${refNoun}（${modeLabel(mode, mediaKind)}）`);

  /** 「添加图片1参考图」保持图片再次创作的原话；音频/视频不硬套「参考图」这三个字。 */
  function addLabel(kind: RefKind, label: string): string {
    return kind === "image" ? `添加${label}参考图` : `添加${label}`;
  }
  /** 单族那一格的悬浮说明：说清这一族最多吃几份。 */
  function addTitle(kind: RefKind): string {
    const total = familyTotal(kind);
    if (kind === "image") return `再加一张参考图（这份工作流最多吃 ${total} 张）`;
    return `再加一份参考${REF_KIND_NAMES[kind]}（这份工作流最多吃 ${total} ${REF_KIND_COUNTERS[kind]}）`;
  }
  /** 那颗不绑族的「+ 参考」要一次说清各族上限，否则用户以为只能往里加图片。 */
  const addAnyTitle = $derived(
    `再加一份参考素材（这份工作流最多吃 ${REF_DISPLAY_ORDER
      .filter((kind) => familyTotal(kind) > 0)
      .map((kind) => `${familyTotal(kind)} ${REF_KIND_COUNTERS[kind]}${REF_KIND_NAMES[kind]}`)
      .join(" / ")}）`,
  );
  // 参数面板：combo 走带方框的比例网格，数值走档位 + 自定义输入。
  const selectSlots = $derived(controlSlots(template).filter((slot) => slot.kind === "select"));
  const numberSlots = $derived(controlSlots(template).filter((slot) => slot.kind !== "select"));
  const hasParams = $derived(selectSlots.length + numberSlots.length > 0);
  /**
   * 底部胶囊上那颗小脸：当前参数里第一个「认得出是谁」的音色。语种、比例那类选项
   * voiceAvatar 直接返回 null，不会被误配；换成模型自带的其它音色时这颗自然消失。
   */
  const pickedFace = $derived(selectSlots.map((slot) => voiceAvatar(String(controls[slotKey(slot)] ?? ""))).find(Boolean) ?? "");
  /**
   * 时长走滑块，不走档位按钮：「几秒」是连续量，点 5/8/10/12/15 像在猜，
   * 拖到几秒就是几秒。区间 3–15 秒（苏醒点名），同时不越过工作流自己给的上下限。
   */
  const DURATION_MIN = 3;
  const DURATION_MAX = 15;
  function isDurationSlot(slot: CloneSlot): boolean {
    return /时长|duration/i.test(slot.label) || numberUnit(slot) === "秒";
  }
  function durationRange(slot: CloneSlot): [number, number] {
    const lo = Math.max(DURATION_MIN, Math.ceil(slot.min ?? DURATION_MIN));
    const hi = Math.min(DURATION_MAX, Math.floor(slot.max ?? DURATION_MAX));
    return hi > lo ? [lo, hi] : [DURATION_MIN, DURATION_MAX];
  }
  /** 滑块只画落在区间里的值：数字框里刚敲了个 90，滑块就该顶到最右而不是消失。 */
  function slideValue(value: string | number | undefined, range: [number, number]): number {
    return Math.min(range[1], Math.max(range[0], Number(value) || range[0]));
  }
  const summary = $derived(controlSummary(template, controls));
  /**
   * 产出清单：后端给了 outputs 就照它画（视频的海报帧地址不是 /api/images/{id}/file，
   * 前端硬拼必然拼错）；老后端只回 image_ids 时退回原来的拼法，图片和以前一样。
   */
  const outputChips = $derived.by<CloneOutput[]>(() => (done ? cloneOutputsOf(job) : []));

  /**
   * 顶部这一格是一条「舞台」，三种状态轮流占（2026-11-04 苏醒照图：「在生成中的状态，做一个
   * 交互动画，生成后，这里展示新生成的内容」）。以前生成中它仍摆着那张静止的旧图，唯一的动静
   * 是底栏那颗按钮在转——等十分钟的人盯着一张不会变的图，只会以为卡死了。
   */
  /** 本机与云端发的是同一组状态，各有一句 message（clone_jobs 与 cloud/engine 同一口径）。 */
  const STAGES = [
    { state: "uploading", word: "上传素材", percent: 14 },
    { state: "queued", word: "提交配方", percent: 34 },
    { state: "running", word: "正在生成", percent: 76 },
    { state: "downloading", word: "收进图库", percent: 92 },
  ];
  const stageIndex = $derived(STAGES.findIndex((s) => s.state === job?.state));
  /**
   * 那条只承诺「走到哪一档」，不承诺百分比：ComfyUI 不给整条工作流的剩余时间，
   * 编一条会自己往前爬的假百分比比诚实的台阶更坏。跑完补满 100。
   */
  const stagePercent = $derived(done ? 100 : stageIndex >= 0 ? STAGES[stageIndex].percent : busy ? 6 : 0);
  /** 舞台上一句话照后端那句 message：本机与云端说的不是一回事，这里不自己拼。 */
  const stageLine = $derived(job?.message || (busy ? "正在准备…" : ""));
  /**
   * 已经等了多久：后端的 elapsed 只在状态切换那一刻推一次，中间不推，照它显示就是数字不动——
   * 那正是「以为卡死了」的成因。所以本地起一条秒表，起点用后端给的 elapsed 校准。
   */
  let waited = $state(0);
  $effect(() => {
    if (!busy) { waited = 0; return; }
    const anchorAt = Date.now() - untrack(() => Math.max(0, job?.elapsed ?? 0)) * 1000;
    const stepWait = () => { waited = Math.max(0, Math.floor((Date.now() - anchorAt) / 1000)); };
    stepWait();
    const timer = window.setInterval(stepWait, 1000);
    return () => window.clearInterval(timer);
  });
  function waitedLabel(sec: number): string {
    const m = Math.floor(sec / 60);
    return m ? `${m} 分 ${sec % 60} 秒` : `${sec} 秒`;
  }
  /** 舞台底图还是被点的这份素材（虚化着）：等待也看得见在等的是谁。音频没有可虚化的画面，宁可空着。 */
  const stageGhost = $derived(
    image && image.kind !== "audio" ? backendUrl(image.original_url || image.thumbnail_url || "") : "",
  );

  /**
   * 跑完这一格让给刚出来的那一份：多份产出时 heroOut 记着人在看第几份，
   * 提交下一批时清空——旧那批已经不是「刚生成的」了。
   */
  let heroOut = $state<number | null>(null);
  /**
   * 画布上的批次：跑完一批封存一条，最新那条排最前面，旧的变淡。
   * 封存点不在这里，在 lib/clone.ts 的 applyCloneProgress——WS 推进度、重开弹窗接手、
   * 云端「取回来」补的那批全走那一个函数，挂在这里就得三条链路各写一遍。
   */
  const canvasBatches = $derived($cloneBatches);
  /** 画布放大态下 Esc 先退回全览。相机归画布管，这里只拿一个「还在放大吗 / 退回」。 */
  let canvasEscape = $state<CanvasEscape | null>(null);
  const heroOutput = $derived.by<CloneOutput | null>(() => {
    if (!done || !outputChips.length) return null;
    return outputChips.find((o) => o.id === heroOut) ?? outputChips[0];
  });
  const heroOutIndex = $derived(heroOutput ? outputChips.findIndex((o) => o.id === heroOutput.id) : -1);
  /* 展示图下面那行名字跟着这一格真正摆的东西走：跑完报刚出来的那份，还没跑报手上这份。生成中不报——
     那一格是等待台，报文件名等于骗人说图已经出来了。 */
  const heroCaption = $derived(heroOutput ? heroOutput.filename : busy ? "" : image?.filename ?? "");
  /* 提示词那一格的小标题用工作流给的槽位名（台词 / 正向提示词…），没名字才退回「完整提示词」。 */
  const promptBlockTitle = $derived(primaryPromptGroup(template)?.label ?? "");
  /** 图片取 1024 那张预览（后端缩好并落盘缓存）；视频与音频只认后端给的地址，前端硬拼必错。 */
  function heroOutSrc(out: CloneOutput): string {
    return out.kind === "image" ? `/api/images/${out.id}/file?max=1024` : out.thumbnail_url;
  }
  function stepHeroOut(delta: number) {
    const n = outputChips.length;
    const next = outputChips[(heroOutIndex + delta + n) % n];
    if (next) heroOut = next.id;
  }

  /* 这一层现在被中间那一列的宽度框住，最宽那颗弹层（云端两栏 452px）不能再用 100vw 封顶——
     量错了对象：列一窄它就从面板右边顶出去，把整块面板顶出横向滚动条。真实上限要实测：
     云端那一屏贴「工作流」那颗胶囊往左长，所以量的是「那一格的右沿 − 面板左内沿」，写进
     --cm-pop-wf-left；用户折展侧栏与详情栏会改变这一列的宽度，ResizeObserver 让它跟着走。
     别改成 container query：container-type 会给 .cm-panel 加 contain:layout，
     面板里那两条 position:fixed（参考图悬停放大预览、弹层那张整屏兜底遮罩）会跟着错位。 */
  // 中间那一列窄到放不下两栏时收回上下结构（CSS 见 .cm-body.is-stacked）。
  let stacked = $state(false);
  $effect(() => {
    if (!open) return;
    const host = panelEl;
    if (!host) return;
    const writePopMax = () => {
      const box = host.getBoundingClientRect();
      const wfPill = host.querySelector<HTMLElement>('[aria-label="工作流"]');
      // 云端那一屏那一层贴这颗胶囊的右边缘往左长（见 .cm-pop-wf.is-api）：余量在左边，量的是
      // 「那一格的右沿 − 面板左内沿（22 内边距 + 1 描边）」，和下面那颗「画面参数」同一把尺。
      // 外裹那一格就是胶囊自己的盒子，量同一只盒子；量不到（单测不排版）从 240 起。
      const wfBox = wfPill?.closest<HTMLElement>(".cm-pop-wrap") ?? wfPill;
      host.style.setProperty(
        "--cm-pop-wf-left",
        `${Math.max(240, Math.round((wfBox ? wfBox.getBoundingClientRect().right : box.right) - box.left - 23))}px`,
      );
      // 同一把尺再量一份「往左长还剩多少」：画面参数那层贴胶囊右边缘往左长（见 .cm-pop-params），
      // 余量在左边——那颗右边缘到面板左内沿（22 内边距 + 1 描边）。窗口一窄胶囊被压扁，这一档
      // 跟着缩，不至于从左边被面板切第二次。弹层的外裹那一格就是胶囊自己的盒子，量同一只盒子。
      const paramsPill = host.querySelector<HTMLElement>('.cm-pill[aria-label="画面参数"]');
      const paramsBox = paramsPill?.closest<HTMLElement>(".cm-pop-wrap") ?? paramsPill;
      host.style.setProperty(
        "--cm-pop-left",
        `${Math.max(240, Math.round((paramsBox ? paramsBox.getBoundingClientRect().right : box.right) - box.left - 23))}px`,
      );
      // 同一把尺顺手量「这一列放不放得下两栏」。980 是量出来的下限，不是凑的整数：
      // 底部那一排要单行放得下：实测右列 524（净宽 498）时三颗胶囊 109+109+108 + 两颗间距 20 = 346，
      // 右边那颗 99 + 间隙 8 → 494 ≤ 498，三颗名字都不截。右列 524 + 缝 22 + 展示图那列至少 390 → 面板 980。
      // 1440x900 实测过踩这以下的样子：面板 792、输入卡 399，那颗「闪寻图片」被压成「闪…」。
      // happy-dom 里 rect 全是 0：量不到就别写，没有布局可判，写一次就把整份单测摁成竖列。
      if (box.width) stacked = box.width < 980;
    };
    writePopMax();
    if (typeof ResizeObserver !== "function") return; // 单测环境（happy-dom）没有 RO：写一次就够
    const ro = new ResizeObserver(writePopMax);
    ro.observe(host);
    return () => ro.disconnect();
  });

  /** 弹窗自己会滚：跑完时人若滚在下面，把这一格滚回视野，否则「直接展示」等于没展示。 */
  let panelEl = $state<HTMLElement | null>(null);
  let revealedId = 0;
  $effect(() => {
    const firstId = done ? outputChips[0]?.id ?? 0 : 0;
    if (!firstId || firstId === revealedId) return;
    revealedId = firstId;
    // 画布分支自己会回到全览（见 CloneCanvas 里那条 batches.length 的 effect），
    // 再去滚面板就是多此一举：画布不靠竖向滚动看东西。
    if (canvasPrototype) return;
    const el = panelEl;
    if (!el || el.scrollTop < 40) return;
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || typeof el.scrollTo !== "function") el.scrollTop = 0;
    else el.scrollTo({ top: 0, behavior: "smooth" });
  });
  /**
   * 弹窗标题与底部那颗胶囊上的名字：跟「切换工作流」清单里那一行同一个叫法。
   * 三条音频工作流在清单里折成一条「闪寻音频」，这两处也跟着叫「闪寻音频」——一个弹窗里两种叫法，
   * 用户会以为清单那一行和底下这颗管的是两件事（2026-10-30 苏醒点名：三种模式底下都要同步显示）。
   * 具体是哪一种出声方式由顶上那排按钮的高亮说，全名在下面这两处的悬浮提示与设置页里都还在。
   */
  const wfName = $derived(workflowDisplayName(templates, template));
  /** 当前真正在用的那一份的全名：音频族三种模式各自是一条工作流，胶囊上收着，悬浮提示里报到。 */
  const wfDetail = $derived(templateDisplayName(template?.name));
  /** 折叠叫法与实际名字一致时不多余一个字（图片、视频工作流照旧只报自己的名字）。 */
  const wfFullTitle = $derived(
    wfDetail && wfDetail !== wfName ? wfName + `（当前：${wfDetail}）` : wfName,
  );

  const canGenerate = $derived(Boolean(template) && prompt.trim().length > 0 && issues.length === 0 && !busy && !submitting);

  /**
   * 移除一份就把同族后面的往前挪：编号就是接线顺序，中间不能留洞。
   * 只在本族内挪——删掉「音频1」把「图片2」顶上去，画面上就成了张冠李戴。
   */
  function removeRef(key: string) {
    const kind = cells.find((cell) => cell.key === key)?.kind ?? "image";
    const family = cells.filter((cell) => (cell.kind ?? "image") === kind);
    const kept = family
      .filter((cell) => cell.key !== key && refs[cell.key])
      .map((cell) => refs[cell.key]);
    const next: Record<string, ImageSummary | null> = { ...refs };
    family.forEach((cell, index) => { next[cell.key] = kept[index] ?? null; });
    refs = next;
  }

  /** 按扩展名认族。入库回来的文件名可能因为重名被改过，扩展名一定还在。 */
  function kindFromName(name: string): RefKind | "" {
    const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
    if (["mp3", "wav", "flac", "ogg", "m4a", "aac"].includes(ext)) return "audio";
    if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "video";
    if (["png", "jpg", "jpeg", "webp", "bmp"].includes(ext)) return "image";
    return "";
  }

  /** 拖进来 / 粘进来的这份是哪一族：先看 MIME，浏览器没给就退回扩展名。 */
  function fileKindOf(file: File): RefKind | "" {
    if (file.type.startsWith("image/")) return "image";
    if (file.type.startsWith("audio/")) return "audio";
    if (file.type.startsWith("video/")) return "video";
    return kindFromName(file.name);
  }

  /** 打 @ 就弹菜单。读 DOM 里的实时值：bind:value 比 input 慢一拍，读 prompt 会漏掉刚敲的那个字符。 */
  function onPromptInput(e: Event) {
    promptTouched = true;
    const el = e.currentTarget as HTMLTextAreaElement;
    const token = mentionToken(el.value, el.selectionStart ?? el.value.length);
    // 云端也有不认 @ 标签的：MiniMax 配音把提示词整段念出来，插 <Audio 1> 就成了台词。
    if (!token || !cells.length || !mentionsTags(template)) { mentionOpen = false; return; }
    const items = buildMentionItems(cells, refs, token.query, mediaKind, isCloudTemplate(template));
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

  /** 已经挂上的素材直接插标签；还没有合适的，就先走一遍图库选择器再插。 */
  async function chooseMention(item: MentionItem) {
    if (item.add) {
      mentionPickKey = item.key;
      pickerSlot = item.key;
      return;
    }
    promptTouched = true;
    // insert 才是最终写进正文的那串：图片工作流给 @图片1，H3 给 <Picture 1>。菜单上始终显示中文编号。
    await commitMention(item.insert || item.label);
  }

  /** 高亮层是 textarea 背后的镜像，滚动位置必须跟着走，否则一滚就错位。 */
  function syncPromptBg() {
    if (promptBg && promptEl) promptBg.scrollTop = promptEl.scrollTop;
  }

  /**
   * 输入区按内容长高：空着只有两行，写长了才往下撑，撑到上限再自己滚。
   * 写死 224px 的框在只写一句话时是一大片空黑——那张卡就不像「一次表达」了（2026-11-04 截图）。
   * 先量一次 auto：所以 textarea 的 rows 必须是 1，否则 auto 量到的是 rows 撑出来的高度，永远缩不回去。
   * 高亮层是 inset:0 的镜像，改完高度要再对一次滚动位置。
   * 一旦拖过（promptUserH 有值）就不再看内容：那一档就是那一档，打字、粘贴都不许改它。
   */
  const PROMPT_MIN_H = 46;
  /** 自动长高的天花板：这一段只该占屏幕三分之一上下，超了就自己滚（见 autosizePrompt）。 */
  function promptMaxH() {
    return Math.max(120, Math.min(Math.round(innerHeight * 0.34), 280));
  }
  /** 手动拉高的天花板：比自动那档宽裕得多（要的就是「一次看全一整段」），但仍按视口收，
   *  窗口一矮就跟着降——不然「取消」「生成」会被顶出弹窗。 */
  function promptHardMaxH() {
    return Math.max(140, Math.min(Math.round(innerHeight * 0.62), 900));
  }
  /**
   * 用户自己拖出来的那一档高度（px）：拖到哪就是哪，上下都跟手，打字也不改它。
   * 为什么要单独记一档——高度归 autosizePrompt 管，直接改 textarea 自己的 height（原生 resize: vertical
   * 就是干这个的）一打字就被下一次重算冲回去，看着像框在跟人抢方向盘。
   * null = 从没拖过：那时才跟着内容长，空着两行、写长了才撑，撑到自动上限再自己滚。
   * 存 localStorage：弹窗每开一次都是新实例，不记住就得每轮重拖一遍。
   */
  const PROMPT_H_KEY = "suxing.clonePromptH";
  let promptUserH = $state<number | null>(readPromptUserH());
  /** 上一次算出来的实际框高：拖动的起点、aria 报的数都用它，不去问 layout（无头环境量不到）。 */
  let promptShownH = $state(PROMPT_MIN_H);
  /** 正在拖：手柄亮一档，整块面板换成拉高光标并锁掉选字。 */
  let promptGripping = $state(false);
  let gripPointer = -1, gripStartY = 0, gripStartH = 0, gripWasAuto = false;

  function readPromptUserH(): number | null {
    try {
      const raw = Number(localStorage.getItem(PROMPT_H_KEY));
      return Number.isFinite(raw) && raw >= PROMPT_MIN_H ? Math.round(raw) : null;
    } catch {
      return null; /* 无痕模式禁了存储：这次照样能拖，只是记不住 */
    }
  }

  function savePromptUserH(h: number | null) {
    try {
      if (h === null) localStorage.removeItem(PROMPT_H_KEY);
      else localStorage.setItem(PROMPT_H_KEY, String(h));
    } catch {
      /* 同上 */
    }
  }

  /** 拖出来那档每次用之前先按当前窗口钳一遍：窗口变矮，不许还顶着一个够不着的高度。 */
  function promptUserClamp(): number {
    return Math.max(PROMPT_MIN_H, Math.min(promptUserH ?? PROMPT_MIN_H, promptHardMaxH()));
  }

  /**
   * 还剩多少给这一档：弹窗可视高，减去「除了打字框以外的全部内容」。
   * 让位顺序是写死的：上面那格（展示图/等待台）先让，让到它的地板 120（见 .cm-body.is-stacked
   * 那条），还装不下才轮到打字框让，两者都到底才让弹窗自己滚。为什么要有这第二层——
   * 2026-11-11 实测 1440x900 竖排 + 竖构图 + 一千字提示词：图已经压到 120，整弹窗还是 809 > 可视 732，
   * 钉在卡底那条 sticky 仍然压着打字框 65px，静止时看不见光标落点。
   * 只在「没拖过」这条路上起作用：人自己拖出来的那一档不许被这里的量反推掉（promptUserClamp 管它）。
   * 量不到就原样交回：无头环境里 rect 与 scrollHeight 全是 0，动一下就把整份单测摁塌。
   */
  function promptFitH(el: HTMLTextAreaElement, h: number): number {
    const panel = panelEl;
    if (!panel) return h;
    const taH = Math.round(el.getBoundingClientRect().height);
    const rest = panel.scrollHeight - taH;
    if (taH <= 0 || rest <= 0) return h;
    const left = panel.clientHeight - rest;
    if (left >= h) return h;
    return Math.max(PROMPT_MIN_H, left);
  }

  function autosizePrompt() {
    const el = promptEl;
    if (!el) return;
    el.style.height = "auto";
    const full = el.scrollHeight;
    // 拖过就照那一档；没拖过才跟着内容长（撑到自动上限，再长就自己滚）
    let h = promptUserH === null
      ? Math.max(PROMPT_MIN_H, Math.min(full, promptMaxH()))
      : promptUserClamp();
    const userSet = promptUserH !== null;
    el.style.height = `${h}px`;
    // 先落一次高度再量：promptFitH 要问的是「这样排下去弹窗总共多高」，高度没落上去量不准
    if (h < full) el.style.overflowY = "auto";
    if (!userSet) {
      const allow = promptFitH(el, h);
      if (allow < h) h = allow;
    }
    el.style.height = `${h}px`;
    el.style.overflowY = full > h ? "auto" : "hidden";
    if (promptShownH !== h) promptShownH = h;
    syncPromptBg();
  }

  /* ── 提示词框右下角那颗拉高手柄：监听怎么挂，照文本列表那根分隔线（TextListSplitter）的规矩来 ──
     pointermove/up 挂 svelte:window：指针一路跑出手柄、跑到弹窗外也跟得住，
     而且弹窗一卸载这些监听器自己就没了，不留悬空回调。 */

  /** 一次拖动的起点：已经拖过就从那一档接着走，没拖过就从现在的实测高度走，不会跳一格。 */
  function promptGripBase(): number {
    return promptUserH ?? promptShownH;
  }

  function clampPromptH(n: number): number {
    return Math.round(Math.max(PROMPT_MIN_H, Math.min(promptHardMaxH(), n)));
  }

  function onPromptGripDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    gripPointer = e.pointerId;
    gripStartY = e.clientY;
    gripStartH = promptGripBase();
    gripWasAuto = promptUserH === null;
    promptGripping = true;
    (e.currentTarget as HTMLElement).focus();
  }

  function onPromptGripMove(e: PointerEvent) {
    if (!promptGripping || e.pointerId !== gripPointer) return;
    e.preventDefault();
    promptUserH = clampPromptH(gripStartH + (e.clientY - gripStartY));
    // 高度还是交给 autosizePrompt 落盘：绕过它直接写 style，下一行字就把拖出来的高度冲掉
    autosizePrompt();
  }

  function onPromptGripFinish() {
    if (!promptGripping) return;
    promptGripping = false;
    savePromptUserH(promptUserH);
  }

  /** 拖到一半松手不算数（pointercancel）：回到起手那一档，别留个半途的高度。 */
  function onPromptGripCancel() {
    if (!promptGripping) return;
    promptUserH = gripWasAuto ? null : gripStartH;
    promptGripping = false;
    autosizePrompt();
  }

  /** 回到「跟着内容长」：双击手柄走这里，键盘按 Home 也走这里。 */
  function resetPromptHeight() {
    promptUserH = null;
    savePromptUserH(null);
    autosizePrompt();
  }

  /** 键盘那条路：上下 ±24 调，Home 复位。用不了鼠标的人不该只有「用不了」这一个选项。 */
  function onPromptGripKey(e: KeyboardEvent) {
    if (e.key === "Home") {
      e.preventDefault();
      resetPromptHeight();
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    promptUserH = clampPromptH(promptGripBase() + (e.key === "ArrowDown" ? 24 : -24));
    autosizePrompt();
    savePromptUserH(promptUserH);
  }

  $effect(() => {
    // 内容变了浏览器可能自己挪 textarea 的 scrollTop（插入标签、自动滚到光标），跟着补一次
    void prompt;
    autosizePrompt();
  });

  $effect(() => {
    // 上限跟窗口高度走，窗口一矮就得重算（否则长提示词会把卡片顶出弹窗）
    const onResize = () => autosizePrompt();
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  });

  /** 换掉 caret 前那段 @xxx，换成引用文本（@图片N 或 <Picture N>），再把焦点和光标放回原处。 */
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

  /**
   * 默认用哪份工作流按卡片那一族挑：视频卡默认吃出片的那条，图片卡默认吃出图的那条。
   * 这一族一条都没有（库里只导过图片工作流）就退回库里现有的「当前」，至少弹窗不是空的——
   * 空的会让人以为功能坏了，而挂上图片工作流至少还能看见槽位、自己换。
   */
  function pickDefaultTemplate(items: CloneTemplate[]): number | null {
    // 按卡片那一族选当前工作流：音频卡默认吃出声音的那条，不是「非视频就算图片」。
    const want: MediaKind = image?.kind === "video" ? "video" : image?.kind === "audio" ? "audio" : "image";
    const mine = items.filter((item) => templateMediaKind(item) === want);
    // 「当前」是用户在设置页点过的那一条，本机云端都照它开：那是他自己选的，
    // 不算我们替他花钱。种云端模板时后端不会把 is_active 标上去，所以刚装好不会走到这。
    const active = mine.find((item) => item.is_active);
    if (active) return active.id;
    // 没有明确「当前」才自己挑：一族里只要有本机的就先本机——云端那条是要扣 RH币的，
    // 不做没人认领的默认。
    const local = mine.filter((item) => !isCloudTemplate(item));
    const pool = local.length ? local : mine;
    return (pool[0] ?? items.find((item) => item.is_active) ?? items[0])?.id ?? null;
  }

  async function loadTemplates() {
    try {
      const res = await cloneApi.templates();
      const items = Array.isArray(res?.items) ? res.items : [];
      templates = items;
      const keep = templateId !== null && items.some((t) => t.id === templateId);
      if (!keep) templateId = pickDefaultTemplate(items);
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
      filePrompt = detail?.positive_prompt ?? "";
      reversePrompt = latestReversePrompt(history.items);
    } finally {
      promptLoading = false;
    }
    syncPrompt();
  }

  /**
   * 提示词该摆哪句：这张产出自带的 → 反推出来的 → 当初生成时记下的。
   * 音频为什么需要第三条：flac 带不走提示词（PNG 有 tEXt、片子有元数据），
   * 不记下来的话点「再次创作」就是一句空白的台词。
   * 用户已经在框里动过手，就一句都不再自动填。
   */
  function syncPrompt() {
    if (promptTouched) return;
    const resolved = resolvePromptSource({
      imagePrompt: filePrompt,
      reversePrompt,
      recordedPrompt: sources?.prompt,
    });
    prompt = resolved.text;
    promptOrigin = resolved.origin === "none" ? "" : promptSourceLabel(resolved.origin);
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
    if (!open || image?.id !== id) return;
    sources = next;
    syncPrompt();
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
    // 从视频卡点开的，这张视频默认站在「视频1」；从图片卡点开的仍是「图片1」。
    // 这一族这条 API 根本不吃时别硬塞：把音频塞进「图1」只会换来一句
    // 「先转成 PNG 或 JPG」，那是最没用的报错。不放，并把它写在参考区下面。
    const supported = !isCloudTemplate(next) || supportsRefFamily(next, cardKind);
    refs = defaultReferences(next, supported ? image : null, sources?.references ?? [], { kind: cardKind });
    // 母语对齐只读这份局部值：bindTemplate 是被 $effect 调的，在这里读一次 controls
    // 再写回去，effect 就会自己追自己——Svelte 5 这个坑本轮踩过一次，别再踩第二遍。
    const values = defaultControlValues(next);
    // 工作流默认就写着官方九人之一时，语种先挪到他的母语：打开「指定音色」不该先挂
    // 「自动」让他猜一遍，也不该等用户去点一下人才换。格子里没这个语种就原样不动。
    const native = nativeLanguageOverride(
      controlSlots(next).filter((slot) => slot.kind === "select"),
      values,
    );
    controls = Object.keys(native).length > 0 ? { ...values, ...native } : values;
    // 附框预填工作流里此刻写着的那段话：空着就等于把原话交给后端回落成台词，
    // 用户什么也没动，音色却变了。
    extraPrompts = promptGroupValues(next, sources && sources.template_id === next?.id ? sources.slot_prompts : null);
    popOpen = false;
  }

  function pickTemplate(id: number) {
    templateId = id;
    closeWorkflowPop();
  }

  /**
   * 清单里点一行。折叠那行（闪寻音频）已经在用的话就只是把弹层收起来——
   * 三种出声方式靠顶上那排按钮换，点族名不该把用户从「音色描述」踢回默认那条。
   */
  function pickMenuRow(row: (typeof wfRows)[number]) {
    if (rowBlocked(row)) {
      error = cloudReason;
      closeWorkflowPop();
      return;
    }
    if (row.collapsed && row.memberIds.includes(templateId ?? -1)) {
      closeWorkflowPop();
      return;
    }
    pickTemplate(row.targetId);
  }

  function closeWorkflowPop() {
    wfOpen = false;
  }

  /** 开类型弹层。顺手把另外两层收掉——三层同时开着，谁盖谁都说不清。 */
  function toggleKindPop() {
    kindPop = !kindPop;
    if (!kindPop) return;
    wfOpen = false;
    popOpen = false;
    void loadCloudStatus();
  }

  /**
   * 这一族有几个能挑的。本机与云端分开报：云端那是要扣 RH币的另一类东西。
   * 只出现在悬停提示里（菜单行末那串灰字 2026-11-10 照图撤了），所以这函数不能删。
   */
  function kindCountWords(kind: MediaKind): string {
    const tally = kindTally[kind];
    const bits: string[] = [];
    if (tally.local) bits.push(`本机 ${tally.local} 份`);
    if (tally.cloud) bits.push(`云端 ${tally.cloud} 条`);
    return bits.length ? bits.join(" / ") : "还没铺路";
  }

  /** 悬浮那一整句：这族出什么、有几份配方、挑不了的话为什么。 */
  function kindRowTitle(kind: MediaKind): string {
    const tally = kindTally[kind];
    const bits = [CREATION_KIND_WORDS[kind], WF_OUTPUT_WORDS[kind], kindCountWords(kind)];
    if (kind === pickedKind) bits.push("现在就是这一族");
    else if (!tally.local && !tally.cloud) bits.push("先加载一份这一族的工作流 JSON，或在设置里配好服务商");
    else bits.push("换过去会连参考位与参数一起换");
    return bits.join(" · ");
  }

  /**
   * 换创作类型 = 换这一族的那份工作流，走清单里点一行那条现成的路：参考位、参数、附框
   * 全按新的那份重摆，不留半套旧状态。这一族一条都没铺就不切——切进一份空清单
   * 只让人以为功能坏了，所以在这儿把话说完。
   */
  function pickCreationKind(kind: MediaKind) {
    kindPop = false;
    if (kind === pickedKind) return;
    const row = rowForKindSwitch(wfRows, kind, templates, templateId);
    if (!row) {
      error = `${CREATION_KIND_WORDS[kind]}这一族还没铺路：先加载一份这一族的工作流 JSON，或在设置 → 模型API配置里配好服务商。`;
      return;
    }
    pickMenuRow(row);
    error = "";
  }

  /** 这一族本机没配方时那句空态。仍然留着下面那颗「加载本地工作流 JSON」，指路得给出路。 */
  const localEmptyNote = $derived(
    kindTally[pickedKind].cloud
      ? `这一族还没有本机工作流。云端那条在「云端API服务」那一屏，或者直接加载一份 JSON。`
      : `这一族还没有工作流。加载一份这一族的 API 格式 JSON：设置 → ${CLONE_SETTINGS_TAB}。`,
  );

  /**
   * 是不是真的让播放器在放东西。普通 let，不进界面也不进依赖表：
   * 它只是 stopVoiceSample 的闸门——没在放就别去按暂停（effect 一挂载就会调 stop）。
   */
  let sampling = false;
  /** 正在听的那一格属于哪个槽位。同样只是普通值：换语种不该把音色试听掐掉。 */
  let hearingKey = "";

  /** 停下试听。只写状态、只碰 DOM，不读任何响应式值——上面那条 effect 靠这一点才安全。 */
  function stopVoiceSample() {
    hearingVoice = "";
    hearingKey = "";
    if (!sampling) return;
    sampling = false;
    sampleEl?.pause();
  }

  /**
   * 选了人就把语种那一格挪到他的母语：Ryan 开口是英文、Sohee 是韩文，还挂着「自动」
   * 等于让他先猜一遍。只挑工作流自己给的那些选项值——语种那一格里没有「英文」就不动，
   * 填一个它不认的值等于把参数丢回给后端猜。
   */
  function followNativeLanguage(voiceKeyArg: string, option: string) {
    // 把刚点的这位当成这格的值交给同一个函数：载入与点人要是分成两套算法，
    // 迟早会出现「打开是自动、点一下才换英文」这种说不上来的差别。
    const patch = nativeLanguageOverride(selectSlots, { ...controls, [voiceKeyArg]: option }, voiceKeyArg);
    for (const [key, value] of Object.entries(patch)) controls[key] = value;
  }

  /**
   * 点一个人：先按原来的规矩选中他，再就地放他那一段。
   * 同一个人再点一下就是停止；换人换源；图库那张卡正在放的声音先让路。
   * 改别的槽位（语种、比例）不许掐掉这段——听的是人，不是语种。
   */
  function pickVoiceValue(key: string, option: string) {
    // 换人才跟着换语种：同一个人再点一下是停/放试听，别把用户手动挑的语种又刷回去
    const changed = controls[key] !== option;
    controls[key] = option;
    if (changed) followNativeLanguage(key, option);
    const el = sampleEl;
    const url = voiceSample(option);
    // 没有样本（用户自己练的音色）或播放器还没挂上：只选中，不出声。
    // 但换的要是正在听的那一格，就得停下——听着 A 的话却选上了 B 比安静更糟。
    if (!url || !el) {
      if (hearingKey === key) stopVoiceSample();
      return;
    }
    if (hearingVoice === option) return stopVoiceSample();
    heroEl?.pause();
    stopAudio();
    hearingVoice = option;
    hearingKey = key;
    sampling = true;
    el.src = url;
    // 宿主放不出来（WebView 缺解码、文件没打进包）就退回静默：小条跟着停，别留着骗人
    void el.play().catch(() => {
      if (hearingVoice === option) stopVoiceSample();
    });
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
    const wanted = templateDisplayName(base) || "未命名工作流";
    const names = new Set(templates.map((item) => templateDisplayName(item.name)));
    if (!names.has(wanted)) return wanted;
    let n = 2;
    while (names.has(`${wanted} (${n})`)) n += 1;
    return `${wanted} (${n})`;
  }

  /**
   * 导入完成的播报。三族参考位各报各的格数：只说「12 个参考位」的话，
   * 用户不知道那里面是 9 张图 + 3 段音频，还是 9 张图而已。图片工作流保持原来那句。
   */
  function importedMessage(tpl: CloneTemplate): string {
    const list = referenceCells(tpl);
    const fams = referenceFamilies(tpl);
    const refs = fams.length === 1 && fams[0] === "image" && !isVideoTemplate(tpl) && !isAudioTemplate(tpl)
      ? `${list.length} 个参考位`
      : fams.map((kind) => `${REF_KIND_NAMES[kind]} ${familyCells(list, kind).length} 格`).join(" / ") || "没认出参考位";
    return `已载入「${templateDisplayName(tpl.name)}」：${promptSlots(tpl).length} 个提示词位 / ${refs}`;
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
        // 出片还是出图由工作流的产出节点判定，别让视频工作流当成图片模板用在图片卡上
        media_kind: inspect.media_kind,
      });
      await loadTemplates();
      templateId = saved.id;
      error = "";
      pushToast(importedMessage(saved));
      // 检测阶段的警告（例如「这份工作流没接音频加载器」）必须跟着报出来：
      // 不报就是让用户带着一个残缺的工作流点生成，等半小时才知道少了什么。
      for (const warning of inspect.warnings ?? []) pushToast(warning);
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
  /**
   * 上一次开弹窗时那张卡是哪一族。弹窗常驻在 Feed 里（关掉它不销毁组件），templateId 会一路带下去：
   * 音频卡用完再点图片卡，图片卡就挂着出声音的那条工作流——参考区、参数、产物全错一族，
   * 点下去跑了十几秒才知道不对。跨族必须重挑；同族之间照旧带着用户挑的那条
   * （连着几张卡共用一份配方才是「再次创作」的用法，不能每次开弹窗都跳回库里标的那条）。
   */
  let openedCardKind: RefKind | null = null;

  $effect(() => {
    if (!open || !image) {
      probedThisOpen = false;
      // 这一轮迭代结束了：换了一张卡或者收了弹窗，画布上那几批不该跟着过去。
      clearCloneBatches();
      canvasEscape = null;
      return;
    }
    const id = image.id;
    // 跨族换卡（音频卡 → 图片卡）时丢掉上一族挑的工作流，同族换卡不动它。
    if (openedCardKind !== null && openedCardKind !== cardKind) templateId = null;
    openedCardKind = cardKind;
    error = "";
    jobId = "";
    sources = null;
    // 换了一张卡就得忘掉上一张的提示词状态，包括「用户动过框」这件事
    prompt = "";
    promptOrigin = "";
    filePrompt = "";
    reversePrompt = "";
    promptTouched = false;
    void loadTemplates();
    void loadCloudStatus();
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

  /*
   * 试听只在这层弹层开着时有意义：收弹层、关弹窗、组件被换掉，声音都得跟着停——
   * 关掉的菜单里有人在说话是 bug，不是彩蛋。untrack 是必须的：stopVoiceSample 要写
   * hearingVoice，让它进依赖表的话，effect 会在刚点起播放那次重跑里把声音停掉。
   */
  $effect(() => {
    const live = open && popOpen;
    untrack(() => {
      if (!live) stopVoiceSample();
    });
    return () => untrack(stopVoiceSample);
  });

  /* 这一层开着时键盘归它。它只盖中间那一列、网格没被 inert，不报一声的话
     在弹窗里按 Delete 会把背后选中的那张删掉（Feed 认 cloneOpen 让位）。 */
  $effect(() => {
    cloneOpen.set(open);
    // 卸载时也清干净：还开着就被整棵树换掉，不能把「让位」留在背景上。
    return () => cloneOpen.set(false);
  });

  /** 弹窗重开时接手正在跑的任务：状态在后端内存里，关弹窗不会让它停下。 */
  async function adoptRunningJob() {
    try {
      // seal:false —— 接手只接状态，不接画布。那条 job 若是上一轮跑完的，界面本来就不显示它
      // （下面那句只认 running），让它悄悄进画布等于把清掉的历史又放回来。
      const current = applyCloneProgress(await cloneApi.currentJob(), { seal: false });
      if (current.running) jobId = current.job_id;
    } catch {
      /* 后端没答话就算了，弹窗照样能填 */
    }
  }

  /**
   * 读一次云端可用性。失败就留 null：宁可不置灰，也不要把一条其实能用的 API 灰掉——
   * 真不能用时后端在提交那一关会给出同一句原因。
   */
  async function loadCloudStatus() {
    try {
      cloudStatus = await cloudApi.status();
    } catch {
      cloudStatus = null;
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

  /** 附框改一次要落到这一组的所有文字位上：一组就是一个框，不是一个输入键。 */
  function setPromptGroup(group: PromptGroup, value: string) {
    for (const key of group.keys) extraPrompts[key] = value;
  }

  /* ── 云端这一条预计花多少：只报官方「价格预估」端点给的数 ─────────────
     绝不自己拿单价乘：价目表会漂，漂了就是骗人。拿不到（没账号、端点没实测、
     服务商没回话）就只说没取到，连「大约」都不写。
     提示词也进指纹：配音按字数计价，只按参数问出来的是个假价。 */
  let cloudCost = $state<number | null | undefined>(undefined);
  let cloudCostTimer: number | undefined;

  $effect(() => {
    window.clearTimeout(cloudCostTimer);
    if (!open || !isCloud || !template || cloudReason) {
      cloudCost = undefined;
      return;
    }
    // 重问期间先把上一个价撤掉：改完画质还挂着旧价，比不显示更容易让人照着花钱
    cloudCost = undefined;
    const body = { template_id: template.id, prompt, controls };
    cloudCostTimer = window.setTimeout(() => {
      void cloudApi.estimate(body)
        .then((res) => { cloudCost = typeof res?.coins === "number" ? res.coins : null; })
        .catch(() => { cloudCost = null; });
    }, 450);
    return () => window.clearTimeout(cloudCostTimer);
  });

  const cloudCostLine = $derived.by(() => {
    if (!isCloud || busy || cloudCost === undefined) return "";
    return cloudCost === null
      ? "这条云端 API 的价格没取到 · 跑完按余额差值记账"
      : `云端出一次预计 ${coinsLabel(cloudCost)}`;
  });

  /**
   * 云端「取回结果」：钱已经花了，产物还挂在会过期的链接上。
   * 只重新查一次云端任务，绝不重新提交——重新提交就是二次扣费。
   */
  async function refetchResults() {
    const row = job?.task_row_id;
    if (!row) return;
    refetching = true;
    try {
      const back = await cloudApi.refetch(row);
      // 取回来的东西要马上出现在「本次产出」里：走一遍现成的 applyCloneProgress，
      // 不另开一条状态通路（两条链路两个形状的老毛病，这个项目栽过一次）。
      applyCloneProgress({
        active: true,
        job_id: job?.job_id ?? "",
        state: "done",
        message: `取回来了 · 已收进图库 ${back.count} 份`,
        image_ids: back.image_ids,
        outputs: back.outputs,
        media_kind: job?.media_kind ?? "",
        template_id: job?.template_id ?? null,
        source_image_id: job?.source_image_id ?? null,
        engine: "cloud",
        cost_coins: back.cost_coins,
        task_id: job?.task_id ?? "",
        task_row_id: back.task_id,
        recoverable: false,
      });
      error = "";
    } catch (e) {
      error = cloneError(e);
    } finally {
      refetching = false;
    }
  }

  /** 这一批要出的画面比例：从画面参数里挑那颗认得出宽高的；认不出就按方的排。 */
  function batchAspectOption(): string | null {
    for (const slot of controlSlots(template)) {
      const value = controls[slotKey(slot)];
      if (typeof value === "string" && ratioShape(value).ratio) return value;
    }
    return null;
  }

  async function generate() {
    if (!template) return;
    if (issues.length) {
      error = `${refNoun}还没放好：${issues.join("、")}`;
      return;
    }
    submitting = true;
    error = "";
    // 上一批产出马上要让位：先收掉，这一格才能干净地回到「正在生成」那一态
    heroOut = null;
    // 画布排卡要用比例，而产出清单里不带它——只能在提交这一刻把当前挑的那颗交出去
    armCloneBatchAspect(batchAspectOption());
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
        slotPrompts: extraPrompts,
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
   * 本地文件 / 剪贴板素材：走现成导入接口先落收件箱再当参考位，语义和拖进图库一致。
   * 一次拖进来几份就依次占满后面的参考位——一份一份拖太慢了。
   *
 * 三族各归各位：拖进「音频2」的那一份只可能填进音频位；没指定格子（拖到那颗「+ 参考」上、
 * 或直接粘在参考区）时按文件自己的族分派，而且只认还有空位的族。往音频位塞图片、
 * 或往已经放满的一族里塞东西，都要当场说清是哪一族不让进，不能默默吞掉。
 */
  async function importFiles(files: File[], slot?: string | null) {
    const target = slot ? cells.find((cell) => cell.key === slot) ?? null : null;
    // 老图片工作流的格子不带 kind，一律按图片算：拖进「图片1」的那一份只可能是图片
    const wantKind: RefKind | null = target ? target.kind ?? "image" : null;
    const open = new Set(openRefKinds(cells, refs));
    const usable = files.filter((file) => {
      const kind = fileKindOf(file);
      if (!kind) return wantKind === null;
      return wantKind ? kind === wantKind : open.has(kind);
    });
    if (!usable.length) {
      if (wantKind && files.length) error = `${target?.label ?? "这一格"}要的是${REF_KIND_NAMES[wantKind]}，你给的这份不是，换一份。`;
      else if (files.length) {
        const first = fileKindOf(files[0]);
        error = first
          ? `这份工作流的${REF_KIND_NAMES[first]}参考位已经放满了。要换就点格子上的替换，或先移掉一份。`
          : "认不出这些素材是哪一族，先确认文件格式。";
      }
      return;
    }
    error = "";
    try {
      adoptRefs(await imagesApi.import(usable, null), wantKind, target);
    } catch (e) {
      pushToast(cloneError(e));
    }
  }

  /**
   * 从资源管理器拖进来的那一份：真机给的是磁盘路径，不是 File（见 subscribeFileDrop）。
   * 语义和拖进图库一致——先复制进收件箱（原文件保留），再自动占参考位。
   */
  async function importPaths(paths: string[], slot?: string | null) {
    const target = slot ? cells.find((cell) => cell.key === slot) ?? null : null;
    const wantKind: RefKind | null = target ? target.kind ?? "image" : null;
    const open = new Set(openRefKinds(cells, refs));
    const usable = paths.filter((path) => {
      const kind = kindFromName(path);
      if (!kind) return wantKind === null;
      return wantKind ? kind === wantKind : open.has(kind);
    });
    if (!usable.length) {
      if (wantKind && paths.length) error = `${target?.label ?? "这一格"}要的是${REF_KIND_NAMES[wantKind]}，你给的这份不是，换一份。`;
      else if (paths.length) {
        const first = kindFromName(paths[0]);
        error = first
          ? `这份工作流的${REF_KIND_NAMES[first]}参考位已经放满了。要换就点格子上的替换，或先移掉一份。`
          : "认不出这些素材是哪一族，先确认文件格式。";
      }
      return;
    }
    error = "";
    try {
      adoptRefs(await imagesApi.copyFiles(usable, null), wantKind, target);
    } catch (e) {
      pushToast(cloneError(e));
    }
  }

  /**
   * 入库回来的那几份按族占位。两条入库路（浏览器的 File、真机的磁盘路径）都汇到这里，
   * 「占哪一格」和那两句提示因此只有一份口径。
   */
  function adoptRefs(res: ImportResponse, wantKind: RefKind | null, target: RefCell | null) {
    if (!res.saved.length) {
      pushToast(res.skipped?.[0] ? `这些素材没能入库（${res.skipped[0].reason}）` : "这些素材没能入库");
      return;
    }
    // 空位按族分桶：一次拖进来一张图加一段音频时各找各的格子，不互相顶位。
    const free: Record<RefKind, string[]> = { image: [], audio: [], video: [] };
    for (const cell of cells) {
      if (!refs[cell.key]) free[(cell.kind ?? "image") as RefKind].push(cell.key);
    }
    // 指定了格子就先占它——那一格已经放了素材也照样占：把素材拖到一张参考缩略图上就是「换掉它」
    //（2026-11-11 苏醒：「当本地图片拖动到参考缩略图时，自动加载参考」）。
    // 同族剩下的顺本族的空位往后排。
    const queue: string[] = [];
    if (target && wantKind) {
      queue.push(target.key);
      free[wantKind] = free[wantKind].filter((key) => key !== target.key);
    }
    const next = { ...refs };
    let used = 0;
    for (const item of res.saved) {
      // 入库接口不回 kind（它只回 id / filename / path），认族只能看扩展名
      const kind: RefKind = kindFromName(item.filename) || wantKind || "image";
      const key = kind === wantKind && queue.length ? queue.shift() : free[kind].shift();
      if (!key) continue;
      next[key] = { ...item, kind } as ImageSummary;
      used += 1;
    }
    refs = next;
    pushToast(used > 1
      ? `已把 ${used} ${refCounter}素材收进图库并选为${refNoun}`
      : `已把「${res.saved[0].filename}」收进图库并选为${refNoun}`);
    if (res.saved.length > used) pushToast(`${refNoun}位满了，多出的 ${res.saved.length - used} ${refCounter}只收进了图库`);
  }

  /** 整排参考区那一个盒子：原生拖放订阅它，落点按格子逐个点出来。 */
  let refStackEl = $state<HTMLElement | null>(null);
  /** 指针现在停在哪个格子上。null = 没指着具体格子，落位交给「按族分派」。 */
  let refDropSlot = $state<string | null>(null);

  /** 坐标落在哪一格：量不到（还没排版、单测）就不认格子。 */
  function refSlotAt(x: number, y: number): string | null {
    const stack = refStackEl;
    if (!stack) return null;
    for (const el of Array.from(stack.querySelectorAll<HTMLElement>("[data-ref-slot]"))) {
      const box = el.getBoundingClientRect();
      if (!box.width && !box.height) continue;
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return el.dataset.refSlot || null;
    }
    return null;
  }

  /**
   * 真机（Tauri）里从资源管理器拖文件进来，页面收不到 drop，路径只在 tauri://drag-drop 的
   * payload 里——Feed、侧栏、设置页那几处早就接了这条，参考格只挂了 DOM 的 ondrop，所以
   * 「把本地图片拖到参考缩略图上」在真机上毫无反应（2026-11-11 苏醒点名要这条）。
   * 整排只订阅一次：H3 那种十几个格子的配方不该为每次 drag-over 跑十几遍 rect。
   */
  $effect(() => {
    if (!open) return;
    return subscribeFileDrop(
      () => refStackEl,
      () => {},
      (paths, point) => importPaths(paths, point ? refSlotAt(point.x, point.y) : refDropSlot),
      (point) => { refDropSlot = point ? refSlotAt(point.x, point.y) : null; },
    );
  });

  function onKey(e: KeyboardEvent) {
    if (!open || pickerSlot !== null) return;
    if (e.key === "Escape") {
      // 弹出的菜单开着时 Esc 先收菜单，别一下把整个弹窗关掉。
      if (mentionOpen || popOpen || wfOpen || kindPop) {
        e.preventDefault();
        mentionOpen = false;
        popOpen = false;
        kindPop = false;
        closeWorkflowPop();
        return;
      }
      // 画布放大着的时候第一下 Esc 先退回全览：一按就把整个弹窗关掉，
      // 等于把人刚放大那一份一起收走了（和图库里那层预览同一个口径）。
      if (canvasEscape?.isZoomed()) {
        e.preventDefault();
        canvasEscape.zoomOut();
        return;
      }
      e.preventDefault();
      onClose();
    }
  }
</script>

  <svelte:window onkeydown={onKey}
    onpointermove={onPromptGripMove} onpointerup={onPromptGripFinish}
    onpointercancel={onPromptGripCancel} onblur={onPromptGripFinish} />

{#if open}
  <!-- 这一层不再糊掉整个窗口（2026-11-04 苏醒：「和放大功能一样，收进缩略图区域，不要模糊背景了，
       和放大一样的纯色背景」）：absolute 落在 <main> 那一列上，底色抄 Lightbox 的 bg-bg。
       侧栏和右侧详情栏因此还在外面——aria-modal 那句假话撤了，role=dialog 留着
       （App / 搜索框 / 侧栏那几处全局快捷键判重认的就是它）。 -->
  <div class="cm-backdrop" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="cm-panel" class:is-grabbing={promptGripping} class:is-stacked={stacked} bind:this={panelEl} role="dialog" aria-label="再次创作" use:modalFocus onscroll={() => (refZoom = null)}>
      <!-- 顶栏只留大字那一行（2026-11-11 苏醒：「再次创作四字删除，标题合理上移」）：那四个字在这层的
           可访问名、关闭那颗和入口菜单上都还在，顶栏这一行只回答「我正在用哪一条」。
           底部那颗胶囊管「点进去换一条」，与它不重复。role=dialog 的 aria-label 照留。 -->
      <header class="cm-top">
        <div class="cm-heading">
          <p class="cm-title">{wfDetail || "未选工作流"}</p>
        </div>
        <button class="cm-close" aria-label="关闭再次创作" onclick={onClose}><Icon name="x" size={16} /></button>
      </header>

      {#if !$comfyuiStatus.enabled || !$comfyuiStatus.running}
        <div class="cm-banner" role="status">
          <span>{$comfyuiStatus.enabled ? ($comfyuiStatus.reason ? `连不上 ComfyUI：${$comfyuiStatus.reason}` : `连不上 ComfyUI（${$comfyuiStatus.url}），先把它启动起来才能出图。`) : "ComfyUI 集成没打开，去设置 → ComfyUI 里启用。"}</span>
          <button class="cm-btn" disabled={probing} onclick={() => void refreshComfyui()}>{probing ? "探测中…" : "重新探测"}</button>
        </div>
      {/if}

      <div class="cm-body" class:is-stacked={stacked}>
        <div class="cm-left">
          {#if busy && job}
            <!-- 生成中：这一格不再摆一张静止的旧图。底图慢慢呼吸、一条光带慢慢扫过去，中间那张卡说清三件
                 事——在等哪一份、走到第几步、已经等了多久。条子按状态台阶往前走：后端不给整条工作流的剩余
                 时间，就不编一条会自己爬的假百分比。动效只说「它还活着」，不催人。 -->
            <div class="cm-stage" data-stage={job.state}>
              {#if stageGhost}
                <img class="cm-stage-ghost" src={stageGhost} alt="" aria-hidden="true" draggable="false" />
              {/if}
              <span class="cm-stage-veil" aria-hidden="true"></span>
              <span class="cm-stage-beam" aria-hidden="true"></span>
              <div class="cm-stage-card">
                <span class="cm-stage-orb" aria-hidden="true"><i></i><i></i><i></i></span>
                <p class="cm-stage-line" role="status">{stageLine}</p>
                <p class="cm-stage-clock" aria-hidden="true">已等 {waitedLabel(waited)}</p>
                <div class="cm-stage-bar" aria-hidden="true"><span style="width: {stagePercent}%"></span></div>
                <p class="cm-stage-steps" aria-hidden="true">
                  {#each STAGES as st, si (st.state)}
                    <span class="cm-stage-step" class:is-now={si === stageIndex} class:is-past={stageIndex > si}>{st.word}</span>
                  {/each}
                </p>
              </div>
            </div>
          {:else if canvasPrototype && done && canvasBatches.length}
            <!-- 画布分支（?cm_canvas=1）：整批铺开、点哪张看哪张、旧批变淡。
                 下面那条原样留着——两条分支并存，实拍对比过再决定撤哪条。 -->
            <CloneCanvas batches={canvasBatches} {onOpenImage} onCamera={(api) => (canvasEscape = api)} />
          {:else if heroOutput}
            {@const out = heroOutput}
            <!-- 生成完直接在这格看新东西（2026-11-04 苏醒：「生成后，这里展示新生成的内容」）。
                 整块点下去 = 到图库里看那一份（图片进对比、视频进播放器，由父组件分派）；一次出几份时
                 中间那两颗箭头换着看，卡底那排小缩略图仍旧负责跳到图库。 -->
            <button class="cm-hero-out" aria-label={`在图库中打开刚生成的第 ${out.id} ${out.kind === "image" ? "张" : "条"}`}
              onclick={() => onOpenImage?.(out.id, out.kind)}>
              <img class="cm-hero cm-hero-new" src={backendUrl(heroOutSrc(out))}
                alt={out.kind === "image" ? "刚生成的画面" : ""} draggable="false" />
              {#if out.kind !== "image"}
                <span class="cm-hero-out-play" aria-hidden="true"><Icon name="play" size={20} /></span>
              {/if}
              <span class="cm-hero-out-hint" aria-hidden="true"><Icon name="external-link" size={12} />在图库中打开</span>
            </button>
            {#if outputChips.length > 1}
              <div class="cm-hero-pager">
                <button class="cm-hero-nav" aria-label="看上一份产出" onclick={() => stepHeroOut(-1)}><Icon name="chevron-left" size={14} /></button>
                <span class="cm-hero-count">{heroOutIndex + 1} / {outputChips.length}</span>
                <button class="cm-hero-nav" aria-label="看下一份产出" onclick={() => stepHeroOut(1)}><Icon name="chevron-right" size={14} /></button>
              </div>
            {/if}
          {:else}
            {#if image?.kind === "video" && image.playable !== false && image.play_url}
                <!-- 视频卡的左边直接能播：再次创作要抄的常常是片子里的节奏、运镜和转场，
                     只给一张首帧等于让人凭记忆写提示词。放不出来的容器（playable=false）退回海报帧。 -->
                <!-- svelte-ignore a11y_media_has_caption -->
                <video
                  class="cm-hero"
                  src={backendUrl(image.play_url)}
                  poster={image.thumbnail_url ? backendUrl(image.thumbnail_url) : undefined}
                  controls
                  playsinline
                  preload="metadata"
                  aria-label={`预览${image.filename}`}
                >
                  <span>这个容器放不出来，去图库里用外部播放器看。</span>
                </video>
              {:else if image?.kind === "audio"}
                <!-- 音频卡的左边：波形 + 一条原生播放器。写提示词时能就地听这段参考音色，
                     不用回图库放一遍再回来；波形是后端画好的那张（thumbnail_url）。 -->
                {#if image.thumbnail_url}
                  <img class="cm-hero cm-hero-wave" src={backendUrl(image.thumbnail_url)} alt={image.filename} />
                {/if}
                {#if image.playable !== false && (image.play_url || image.original_url)}
                  <!-- svelte-ignore a11y_media_has_caption -->
                  <audio
                    bind:this={heroEl}
                    class="cm-hero-audio"
                    src={backendUrl(image.play_url || image.original_url!)}
                    controls
                    preload="metadata"
                    aria-label={`预览${image.filename}`}
                    onplay={stopVoiceSample}
                  ></audio>
                {/if}
              {:else if image?.original_url || image?.thumbnail_url}
                <img class="cm-hero" src={backendUrl(image.original_url || image.thumbnail_url!)} alt={image.filename} />
              {:else}
                <div class="cm-hero cm-hero-empty">没有预览</div>
              {/if}
          {/if}
          {#if heroCaption}
            <!-- 文件名回到展示图下面（旧图那一版有）：一次出几份、或者从这一格跳回图库时，认的就是它。 -->
            <p class="cm-hero-name" title={heroCaption}>{heroCaption}</p>
          {/if}
        </div>

        <div class="cm-right">
          {#if !templatesLoaded}
            <p class="cm-note">正在读取工作流…</p>
          {:else if !template}
            <div class="cm-empty">
              <p>还没有工作流。导出一份 ComfyUI 的 API 格式工作流 JSON，{cardKind === "video" ? "之后每条片子点一下就能再出一条。" : cardKind === "audio" ? "之后每段配音点一下就能换词重配。" : "之后每张图点一下就能再出一张。"}</p>
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
            {#if audioModes.length > 1}
              <!-- 出声方式放最上面：它决定下面到底要不要参考音频，摆在参考区下面就得先往下找一趟。 -->
              <section class="cm-block">
                <p class="cm-block-title">音频模式</p>
                <div class="cm-seg" role="radiogroup" aria-label="音频模式">
                  {#each audioModes as item (item.id)}
                    <button class="cm-seg-item cm-seg-mode" role="radio" aria-checked={item.id === templateId}
                      class:is-on={item.id === templateId} disabled={busy}
                      title={busy ? `生成中不能换出声方式：${templateDisplayName(item.name)}` : `换成「${templateDisplayName(item.name)}」`}
                      onclick={() => pickTemplate(item.id)}>{audioModeLabel(item.name)}</button>
                  {/each}
                </div>
              </section>
            {/if}


            <section class="cm-block">
              <!-- composer 那张卡：素材、话、按钮是同一次表达，共用一张卡、一份内边距（2026-11-04 苏醒：像图二
                 那个 composer）。卡里那两行小标题 11-04 撤过一轮，2026-11-10 照旧图放回来——
                 上下排之后每块上面没名字就不成组了；「完整提示词」用的是工作流给的槽位名。 -->
              <div class="cm-composer" title={composerNote}>
              {#if shouldOfferWorkflowPrompt(prompt, workflowPrompt)}
                <!-- 工作流自带提示词、这一格还空着才有这颗（2026-11-04 苏醒照图圈）：半透明挂在
                     圆角框右上角，鼠标滑过才亮起来，点一下把内置那句填进提示词框。
                     z-index 压过左边那一摞参考（格子给到 1..n）；mention 弹层在卡内更靠后，仍盖得住它。 -->
                <button
                  class="cm-wand"
                  type="button"
                  aria-label="载入工作流内置提示词"
                  title="载入工作流内置的提示词"
                  onclick={() => { promptTouched = true; prompt = workflowPrompt; }}
                ><Icon name="wand" size={16} /></button>
              {/if}
                <!-- 参考在上、话在下（2026-11-10 照旧图改回来）：两块各带一行小标题，上下排读着是一件事的
                 两步——先给素材，再写话。一条参考位都没有（纯文生图、只填音色描述）时上面那一排
                 整块不摆，话独占这张卡。 -->
                <div class="cm-input-row">
                  {#if cells.length}
                    <p class="cm-block-title">替换或上传参考</p>
                    <!-- 这一排是参考素材：几族混着放（图片 → 视频 → 音频），末尾一颗不绑族的「+ 参考」。
                         横排不叠（2026-11-10 照旧图改回来），每格 = 一张照片 + 下面那行编号，
                         「图片1／图片2」写在格子底下，一眼数得出这是几份不同的东西；
                         --z 仍旧顺着给（后挂的压在前面那张上头，鼠标抬起时不互相吃），末尾那颗
                         「+ 参考」在最上面——它是下一个要动的地方。可访问名管的是整块参考区，
                         「（单图编辑）」这半句挂在那儿，读屏和测试都还拿得到。
                         只有一族时格子来自 visibleRefCells（已填的 + 一颗空格子）。 -->
                    <div
                      class="cm-ref-stack"
                      bind:this={refStackEl}
                      role="group"
                      aria-label={rowAria}
                      onpaste={(e) => {
                        const files = Array.from(e.clipboardData?.files ?? []);
                        if (files.length) { e.preventDefault(); void importFiles(files, null); }
                      }}
                    >
                      {#each rowCells as item, i (item.cell.key)}
                        {@const picked = refs[item.cell.key]}
                        <div
                          class="cm-ref-cell"
                          class:is-drop-target={refDropSlot === item.cell.key}
                          data-ref-slot={item.cell.key}
                          style="--z: {i + 1}"
                          role="group"
                          aria-label={item.cell.label}
                          onmouseenter={(e) => refZoomFor(e.currentTarget as HTMLElement, picked, item.cell.label)}
                          onmouseleave={() => (refZoom = null)}
                          onfocusin={(e) => refZoomFor(e.currentTarget as HTMLElement, picked, item.cell.label)}
                          onfocusout={() => (refZoom = null)}
                          ondragover={(e) => e.preventDefault()}
                          ondrop={(e) => {
                            const files = Array.from(e.dataTransfer?.files ?? []);
                            if (files.length) { e.preventDefault(); void importFiles(files, item.cell.key); }
                          }}
                        >
                          {#if picked}
                            <div class="cm-tile media-chip" class:cm-tile-audio={item.kind === "audio"} title={`${item.cell.slotLabel}｜${picked.filename}`}>
                              <!-- 整块缩略图本身就是「换一份」：那颗小圆钮只有悬停才亮，点画面别处毫无反应，
                                   用户以为参考换不了（真机实测）。圆钮降级成提示，点哪儿都开选择器。 -->
                              <button class="cm-tile-pick" aria-label={`替换${item.cell.label}`} onclick={() => (pickerSlot = item.cell.key)}>
                                <img class="cm-tile-img" src={backendUrl(picked.thumbnail_url || picked.original_url!)} alt={picked.filename} />
                                <span class="cm-tile-swap" aria-hidden="true"><Icon name="swap" size={14} /></span>
                              </button>
                              <button class="cm-tile-x" aria-label={`移除${item.cell.label}`} onclick={() => removeRef(item.cell.key)}>
                                <Icon name="x" size={12} />
                              </button>
                            </div>
                          {:else}
                            <button class="cm-tile cm-tile-add" aria-label={addLabel(item.kind, item.cell.label)} title={addTitle(item.kind)} onclick={() => (pickerSlot = item.cell.key)}>
                              <Icon name="plus" size={20} />
                              <span>{item.kind === "image" ? "参考" : REF_KIND_NAMES[item.kind]}</span>
                            </button>
                          {/if}
                          <span class="cm-ref-caption">{item.cell.label}</span>
                        </div>
                      {/each}
                      {#if !singleFamily && openKinds.length}
                        <!-- 这一颗不绑族：点进去几族一起挑，选到哪一族就落那一族的第一个空位。 -->
                        <button
                          class="cm-tile cm-tile-add cm-ref-add"
                          style="--z: {stackCount + 1}"
                          aria-label="添加参考素材"
                          title={addAnyTitle}
                          ondragover={(e) => e.preventDefault()}
                          ondrop={(e) => {
                            const files = Array.from(e.dataTransfer?.files ?? []);
                            if (files.length) { e.preventDefault(); void importFiles(files, null); }
                          }}
                          onclick={() => (pickerSlot = ADD_ANY)}
                        >
                          <Icon name="plus" size={20} />
                          <span>参考</span>
                        </button>
                      {/if}
                    </div>
                  {/if}
                  <div class="cm-prompt-col">
                    <p class="cm-block-title">{promptBlockTitle || "完整提示词"}</p>
                    <div class="cm-prompt-wrap">
                      <div class="cm-prompt-bg" bind:this={promptBg} aria-hidden="true">
                        {#each mentionChunks(prompt) as chunk, i (i)}
                          <span class:cm-mention-hl={chunk.mention}>{chunk.text}</span>
                        {/each}
                      </div>
                      <textarea id="clone-prompt" class="cm-textarea cm-textarea-mirror" bind:this={promptEl} oninput={onPromptInput} onkeydown={onPromptKeydown} onscroll={syncPromptBg} rows="1" aria-label="提示词" placeholder={promptPlaceholder(mediaKind, refNoun, cells.length > 0)} title={promptFoot} bind:value={prompt}></textarea>
                      <!-- 右下角这颗拉高手柄（2026-11-10 苏醒：「提示词输入框右下角加一个拉高提示词的功能」）。
                           它改的是 promptUserH 那一档高度，所以拖完接着打字不会被打回原形；
                           双击（或聚焦后按 Home）退回「跟着内容长」。 -->
                      <!-- 它调的就是「提示词框多高」这一个数，所以按 slider 报给读屏：念得出「拉高提示词框 · 自动高度」，
                           上下键与拖动改的是同一个值。Svelte 的 a11y 表认 slider 是可交互角色，不必再挂 svelte-ignore。 -->
                      <div class="cm-prompt-grip" class:is-live={promptGripping} role="slider"
                        aria-label="拉高提示词框" aria-orientation="vertical" tabindex="0"
                        aria-valuemin={PROMPT_MIN_H} aria-valuemax={promptHardMaxH()}
                        aria-valuenow={promptShownH} aria-valuetext={promptUserH === null ? "自动高度" : `已固定 ${promptShownH}px`}
                        title={"按住上下拖动：调提示词框的高度\n双击：恢复跟着内容长高"}
                        onpointerdown={onPromptGripDown} onkeydown={onPromptGripKey}
                        ondblclick={resetPromptHeight}></div>
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
                                  <Icon name={item.add ? "plus" : "image"} size={14} />
                                {/if}
                              </span>
                              <span class="cm-mention-label">{item.add ? mentionAddLabel(item.kind) : item.label}</span>
                              <span class="cm-mention-file" title={item.filename}>{item.add ? "" : basenameOnly(item.filename)}</span>
                            </button>
                          {/each}
                        </div>
                      {/if}
                    </div>
                    <!-- 提示词框下面不再摆那行灰字，也不再摆那颗文字按钮（2026-11-04 苏醒：
                         「这种小字提示也删掉」＋「做成半透明图标，放在圆角框右上角」）。
                         槽位名与提示词来源挂到提示词框的 title 上，鼠标悬停才说，不占版面。 -->
                  </div>
                </div>

                <!-- 卡底那几行灰字全撤了（2026-11-04 苏醒：「这种小字提示也删掉」）。
                     还想知道「当初那几份参考没认出来」「被点这一族没被吃进去」「这条工作流不吃参考」，
                     鼠标悬停这张卡看提示：几种情况合成一句挂在卡的 title 上，不占版面。 -->

              <!-- 悬停/键盘聚焦某一张参考时放大那一张（图二那种「一眼看清是哪份素材」）。
                   fixed + 量出来的坐标：弹窗自己会滚，绝对定位的放大图会被裁掉。上面放不下就朝下开。 -->
              {#if refZoom}
                <div class="cm-ref-zoom" style={refZoom.style} aria-hidden="true">
                  <img class="cm-ref-zoom-img" src={refZoom.src} alt="" />
                  <p class="cm-ref-zoom-cap"><span>{refZoom.label}</span><span class="cm-ref-zoom-file">{basenameOnly(refZoom.file)}</span></p>
                </div>
              {/if}

              {#each secondaryGroups as group (group.label)}
                <p class="cm-block-title cm-sub-prompt-title">{group.label}</p>
                <textarea class="cm-textarea cm-textarea-sub" rows="3" aria-label={group.label} title={promptGroupHint(group.label)}
                  placeholder={promptGroupPlaceholder(group.label)} value={extraPrompts[group.keys[0]] ?? ""}
                  oninput={(e) => setPromptGroup(group, (e.target as HTMLTextAreaElement).value)}></textarea>
              {/each}
              <!-- 「本次产出」那一排缩略图撤了（2026-11-04 苏醒：删掉干扰，生成后直接展示新内容）。
                   它原本管的是「跑完一眼看到结果，不用先滚过一排钉着的按钮」——顶上那一格现在直接摆
                   刚出来的那一份，人滚在下面还会自己滚回视野里，同一件事不必在两处各摆一遍。 -->

              <!-- 这一排是这张卡的底（2026-11-04 苏醒照图一收进同一个框）：族、工作流、参数、生成跟参考和提示词
                   同属一次表达，框外再摆一条深色的坞就等于把一次输入拆成两件事。
                   仍然 sticky：卡比弹窗高时它钉在可视区下沿，「生成」和下面那几行状态不用滚动就点得到。 -->
            <div class="cm-dock">
            <div class="cm-foot">
              <div class="cm-foot-left">
                <div class="cm-pop-wrap">
                  <!-- 先定这一屏出什么（2026-11-04 苏醒要的）：族定了，下面的工作流清单与云端模型只摆这一族。
                       以前六行混在一屏，眼睛得先替人做一遍「哪条出图、哪条出片、哪条出声音」的分类。
                       它显示的是**挂上的那份工作流真正在产出的族**，不是一个会跑偏的独立开关。 -->
                  <button class="cm-pill cm-pill-kind" class:is-on={kindPop} aria-label="创作类型" aria-haspopup="menu"
                    aria-expanded={kindPop} disabled={busy}
                    title={busy ? `生成中不换创作类型，现在出${WF_OUTPUT_WORDS[pickedKind]}` : `现在出${WF_OUTPUT_WORDS[pickedKind]} · ${kindCountWords(pickedKind)}。换一族会连参考位与参数一起换。`}
                    onclick={toggleKindPop}>
                    <Icon name={KIND_ICONS[pickedKind]} size={14} />
                    <span class="cm-pill-text">{CREATION_KIND_WORDS[pickedKind]}</span>
                    <span class="cm-chevron" class:is-open={kindPop} aria-hidden="true"><Icon name="chevron-down" size={12} /></span>
                  </button>
                  {#if kindPop}
                    <div class="cm-pop-scrim" role="presentation" onclick={() => (kindPop = false)}></div>
                    <div class="cm-pop cm-pop-kind" role="menu" aria-label="创作类型">
                      {#each CREATION_KIND_ORDER as kind (kind)}
                        <!-- 还没铺路的那族照旧可点：点下去那句「这一族还没铺路，先加载 JSON」比一个
                             不给理由的 disabled 有用得多。 -->
                        <button class="cm-wf cm-kind-row" role="menuitemradio" aria-checked={kind === pickedKind}
                          title={kindRowTitle(kind)} onclick={() => pickCreationKind(kind)}>
                          <span class="cm-kind-icon" aria-hidden="true"><Icon name={KIND_ICONS[kind]} size={14} /></span>
                          <span class="cm-wf-name">{CREATION_KIND_WORDS[kind]}</span>
                          <!-- 行末那串「本机 N 份 / 云端 N 条」撤了（2026-11-10 苏醒照图圈掉）：三行灰字并排，
                               眼睛先读到的是数而不是「选哪一族」，菜单最该有的那件事被挤成了配角。
                               数没消失：悬停这一行照样报，名字下面不再有第二排字。 -->
                          {#if kind === pickedKind}<span class="cm-kind-check" aria-hidden="true"><Icon name="check" size={14} /></span>{/if}
                        </button>
                      {/each}
                    </div>
                  {/if}
                </div>
                <div class="cm-pop-wrap cm-fill">
                  <!-- 这一排的顺序：先挑用哪份工作流 / 哪个云端模型，再定它的具体参数（2026-11-04 苏醒）。
                  参数是这份工作流自己的参数，反过来摆会让人先设完参数再发现工作流换了、参数得重来。 -->
                  <!-- 生成中不藏这颗：一藏这一行就空出一块，还看不出正在用哪份工作流出图。
                       但生成期间不给换：中途换工作流会把参考位和参数冲成另一份的，
                       而正在跑的那张既看不见也撤不回。理由写在 title 里，别让人对着点不动的按钮猜。
                       名字长到挤不下时，让位的是这颗胶囊（名字截断 + 收箭头），不是右边的取消和生成。 -->
                  <button class="cm-pill" class:is-busy={busy} aria-label="工作流" aria-haspopup="menu" aria-expanded={wfOpen}
                    disabled={busy} title={busy ? `生成中，等这张图画完再换工作流：${wfFullTitle}` : wfFullTitle}
                    onclick={toggleWorkflowPop}>
                    <Icon name="layers" size={14} />
                    <span class="cm-pill-text">{wfName}</span>
                    <span class="cm-chevron" class:is-open={wfOpen} aria-hidden="true"><Icon name="chevron-down" size={12} /></span>
                  </button>
                  {#if wfOpen}
                    <div class="cm-pop-scrim" role="presentation" onclick={closeWorkflowPop}></div>
                    <div class="cm-pop cm-pop-wf" class:is-api={wfTab === "cloud" && Boolean(apiActive)} role="menu" aria-label="工作流">
                      <!-- 两屏各摆各的（苏醒要的）：本机的配方在「本地工作流」，云端的收费模型在「云端API服务」。
                           用 aria-pressed 的按钮而不是 tablist：这层容器是 role="menu"，塞 tablist 是错的 ARIA。 -->
                      <div class="cm-pop-tabs">
                        <button class="cm-pop-tab" aria-pressed={wfTab === "local"} onclick={() => wfTab = "local"}>本地工作流</button>
                        <button class="cm-pop-tab" aria-pressed={wfTab === "cloud"} onclick={() => wfTab = "cloud"}>
                          云端API服务
                          {#if cloudRowCount}<span class="cm-pop-tab-count">{cloudRowCount}</span>{/if}
                        </button>
                      </div>
                      {#if wfTab === "local"}
                        <div class="cm-pop-list">
                            {#each popRows as row (row.key)}
                            {@const isOn = row.memberIds.includes(templateId ?? -1)}
                            <div class="cm-wf-row">
                              <button class="cm-wf" role="menuitemradio" aria-checked={isOn} disabled={busy || rowBlocked(row)}
                                title={row.collapsed ? `${AUDIO_MODE_GROUP_LABEL} · ${wfGroupTitle}` : wfRowTitle(row)}
                                onclick={() => pickMenuRow(row)}>
                                <!-- 图片和视频的工作流同列一份清单（用户要的「不分家」），但出片还是出图必须一眼分得清，
                                     否则图片卡挂上一条 H3 视频工作流，等十分钟出一段片子才知道选错。
                                     徽标钉在名字前面：跟在名字后面时它会随名字长短左右漂移，两行对不齐。 -->
                                <span class="cm-wf-kind" class:cm-wf-kind-video={row.kind === "video"}
                                  class:cm-wf-kind-audio={row.kind === "audio"}>{WF_KIND_WORDS[row.kind]}</span>
                                <span class="cm-wf-name">{row.label}</span>
                                {#if isOn}<span class="cm-wf-tag">当前</span>{/if}
                              </button>
                              {#if !row.collapsed}
                                <!-- 折叠那行不给删：一条「闪寻音频」背后是三条工作流，删哪条不该由这颗 X 临场决定。 -->
                                <button class="cm-wf-del" aria-label={`删除工作流 ${row.label}`} title="删除这个工作流"
                                  disabled={busy || wfDeleting} onclick={() => void removeTemplate(row.targetId)}>
                                  <Icon name="x" size={14} />
                                </button>
                              {/if}
                            </div>
                            {/each}
                            {#if popRows.length === 0}
                              <p class="cm-pop-empty">{localEmptyNote}</p>
                            {/if}
                        </div>
                      {:else if apiActive}
                        <!-- API 这一屏两列摆：左列一家服务商一行（图标 + 名字），右列是这一家能点的模型。
                             名字下面那两行小字（能干什么 / 怎么扣费）撤了（2026-11-11 苏醒：「左边显示服务商
                             即可，小字删除」）——这一屏总共就一家服务商、几行模型，那两行是给左列添噪，
                             还把右列挤到模型名都截断。信息不丢：整句在那一行的悬浮提示里。
                             为什么不在这屏再按图片/视频/音频切一刀：这一屏本来就只有「花钱的模型」一类东西，
                             切完每列只剩一行，等于多点一次看同样的东西。
                             行名用的是模型名，口径在 clone.ts 的 menuRowLabel——与底部那颗胶囊、弹窗标题同一个来源。 -->
                        <div class="cm-api">
                          <div class="cm-api-side">
                            <p class="cm-api-cap">服务商</p>
                            {#each apiGroups as group (group.key)}
                              <button class="cm-api-vendor" role="menuitem" type="button"
                                aria-current={group.key === apiActive.key} title={`${group.label} · ${group.blurb}`}
                                onmouseenter={() => apiVendor = group.key} onclick={() => apiVendor = group.key}>
                                <span class="cm-api-vendor-mark" aria-hidden="true"><Icon name="cloud" size={14} /></span>
                                <span class="cm-wf-name cm-api-vendor-name">{group.label}</span>
                                <span class="cm-api-vendor-arrow" aria-hidden="true"><Icon name="chevron-right" size={12} /></span>
                              </button>
                            {/each}
                          </div>
                          <div class="cm-api-main">
                            {#each apiActive.rows as row (row.key)}
                              {@const isOn = row.memberIds.includes(templateId ?? -1)}
                              <div class="cm-wf-row cm-api-row">
                                <button class="cm-wf cm-api-model" role="menuitemradio" aria-checked={isOn}
                                  disabled={busy || rowBlocked(row)} title={wfRowTitle(row)}
                                  onclick={() => pickMenuRow(row)}>
                                  <span class="cm-wf-kind" class:cm-wf-kind-video={row.kind === "video"}
                                    class:cm-wf-kind-audio={row.kind === "audio"}>{WF_KIND_WORDS[row.kind]}</span>
                                  <span class="cm-wf-name">{row.label}</span>
                                  <!-- 状态钉在行末同一个位置。黄的是「整条云端路差一把 Key」——灰的是路，不是这一行坏了。 -->
                                  {#if rowBlocked(row)}<span class="cm-wf-tag cm-wf-tag-warn">需配置</span>{/if}
                                  {#if rowUnverified(row)}<span class="cm-wf-tag">待实测</span>{/if}
                                  {#if rowVerified(row)}<span class="cm-wf-tag cm-wf-tag-ok">已实测</span>{/if}
                                  {#if isOn}<span class="cm-wf-tag cm-wf-tag-cur">当前</span>{/if}
                                </button>
                                {#if !row.collapsed}
                                  <button class="cm-wf-del" aria-label={`删除工作流 ${row.label}`} title="删除这个工作流"
                                    disabled={busy || wfDeleting} onclick={() => void removeTemplate(row.targetId)}>
                                    <Icon name="x" size={14} />
                                  </button>
                                {/if}
                              </div>
                            {/each}
                          </div>
                        </div>
                      {:else}
                        <p class="cm-pop-empty">云端这一屏还空着：去设置 → 模型API配置填 RunningHub 的 API Key。</p>
                      {/if}
                      {#if wfTab === "local"}
                        <!-- 分隔线与底部这颗只属于本机这一屏：API 那屏到模型清单就结束（2026-11-04 苏醒圈掉了
                             「设置 RunningHub 的 API Key」那一行）。Key 在设置 -> 模型API配置里填——空态那句话、
                             灰行的悬浮提示和行末 X 的说明都指着那一页，不在这里再挂一颗按钮。 -->
                        <div class="cm-pop-sep"></div>
                        <button class="cm-wf cm-wf-add" role="menuitem" disabled={workflowLoading} onclick={() => wfInput?.click()}>
                          <!-- 占位与上面的族徽同宽，「加载本地工作流 JSON」才跟上面的名字左对齐 -->
                          <span class="cm-wf-lead" aria-hidden="true"><Icon name="plus" size={14} /></span>
                          <span class="cm-wf-name">{workflowLoading ? "正在读取…" : "加载本地工作流 JSON"}</span>
                        </button>
                      {/if}
                    </div>
                  {/if}
                </div>
                {#if hasParams}
                  <div class="cm-pop-wrap">
                    <button class="cm-pill" aria-label="画面参数" aria-haspopup="dialog" aria-expanded={popOpen} onclick={() => { closeWorkflowPop(); popOpen = !popOpen; }}>
                      {#if pickedFace}
                        <img class="cm-pill-face" src={pickedFace} alt="" draggable="false" />
                      {/if}
                      <span class="cm-pill-text">{summary || "设置画面参数"}</span>
                      <span class="cm-chevron" class:is-open={popOpen} aria-hidden="true"><Icon name="chevron-down" size={12} /></span>
                    </button>
                    {#if popOpen}
                      <div class="cm-pop-scrim" role="presentation" onclick={() => (popOpen = false)}></div>
                      <div class="cm-pop cm-pop-params" role="dialog" aria-label="画面参数">
                        {#each selectSlots as slot (slotKey(slot))}
                          {@const key = slotKey(slot)}
                          <p class="cm-pop-title">{slot.label}</p>
                          <div class="cm-ratio-grid" role="group" aria-label={`${slot.label}选项`}>
                            {#each slot.options ?? [] as option (option)}
                              {@const shape = ratioShape(option)}
                              {@const face = voiceAvatar(option)}
                              {@const hearing = hearingVoice === option && voiceSample(option) !== null}
                              <button
                                class="cm-ratio"
                                class:is-voice={face !== null}
                                class:is-on={controls[key] === option}
                                class:is-hearing={hearing}
                                title={face ? `试听并选用：${option}` : option}
                                aria-label={option}
                                aria-pressed={controls[key] === option}
                                onclick={() => pickVoiceValue(key, option)}
                              >
                                {#if face}
                                  <!-- 内置音色：认得出是谁就摆那张脸。名字仍在下面，不看图也不影响读；
                                       圆形遮罩由 CSS 负责，图自己按「脸居中、头顶留白」出。
                                       正在放的那位右上角挂三条跳动的窄条——扫一眼就知道在听谁。 -->
                                  <span class="cm-ratio-face-wrap">
                                    <img class="cm-ratio-face" src={face} alt="" draggable="false" />
                                    {#if hearing}
                                      <span class="cm-voice-eq" aria-hidden="true"><i></i><i></i><i></i></span>
                                    {/if}
                                  </span>
                                {:else if shape.ratio}
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
                          {@const range = durationRange(slot)}
                          <p class="cm-pop-title">{slot.label}</p>
                          {#if isDurationSlot(slot)}
                            <!-- 时长是连续量：档位按钮点起来像在猜，拖滑块到几秒就是几秒（3–15 秒，
                                 也不越过工作流自己给的上下限）。右边留个数字框，要几秒直接敲。 -->
                            <div class="cm-slide">
                              <input
                                type="range"
                                class="cm-slider"
                                min={range[0]}
                                max={range[1]}
                                step="1"
                                value={slideValue(controls[key], range)}
                                style="--min: {range[0]}; --span: {range[1] - range[0]}; --value: {slideValue(controls[key], range)}"
                                aria-label={`${slot.label}滑块`}
                                oninput={(e) => (controls[key] = Number((e.target as HTMLInputElement).value))}
                              />
                              <input
                                type="number"
                                class="cm-slide-num"
                                aria-label={slot.label}
                                min={range[0]}
                                max={range[1]}
                                step="1"
                                bind:value={controls[key]}
                              />
                              <span class="cm-slide-unit">{numberUnit(slot) || "秒"}</span>
                            </div>
                          {:else}
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
                          {/if}
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>
              <div class="cm-actions">
                {#if busy}
                  <button class="cm-btn cm-btn-quiet" onclick={() => void cancel()}>取消</button>
                {:else}
                  <!-- 同宽的隐形占位，不是第二颗按钮：aria-hidden，也点不到 -->
                  <span class="cm-btn cm-btn-quiet cm-cancel-slot" aria-hidden="true">取消</span>
                {/if}
                <!-- 圆形品牌钮（2026-11-04 苏醒：「这个按钮做成圆形，用品牌图标」）：圆里放不下
                     「生成」两个字，文字撤了就要把名字从别处补回来——aria-label 与悬浮提示都跟着状态走，
                     读屏和鼠标用户拿到的信息一个字不少。后端的逐句进度仍然不进这颗（名字只有两态，
                     宽度才不会一边跑一边抖）。 -->
                <button class="cm-go" class:is-busy={busy} disabled={!canGenerate}
                  aria-label={busy ? "生成中…" : "生成"} title={busy ? "生成中…" : "生成"}
                  onclick={() => void generate()}>
                  <span class="cm-go-shine" aria-hidden="true"></span>
                  <span class="cm-go-mark" aria-hidden="true"></span>
                  <span class="cm-go-dot" aria-hidden="true"></span>
                </button>
              </div>
            </div>
                <!-- 状态这几行跟着底部这条一起钉着：生成中的进度、云端那句「价格没取到」和报错
                     必须一直看得见，不能藏到要往下滚才出现的地方。 -->
                {#if error}
                  <p class="cm-foot-note cm-error" role="status">{error}</p>
                {:else if job && job.state === "error"}
                  <p class="cm-foot-note cm-error" role="status">{job.error || job.message}</p>
                {:else if job && (done || job.state === "cancelled")}
                  <!-- 生成中不再单独显示这一行：那颗按钮本身就是进度（转圈 + 扫光 + 「生成中…」），下面再说一遍是噪声。
                       跑完之后才需要的信息（已取消 / 已生成 N 张）照旧留着。 -->
                  <p class="cm-foot-note cm-status" role="status">{cloneStatusLabel(job)}</p>
                {/if}

                {#if cloudCostLine}
                  <!-- 只报官方预估端点给的数；拿不到就说没取到，绝不显示自己乘出来的价 -->
                  <p class="cm-foot-note cm-status" role="status">{cloudCostLine}</p>
                {/if}
                {#if refetchable}
                  <p class="cm-foot-note">
                    <button class="cm-btn" disabled={refetching} onclick={() => void refetchResults()}>
                      {refetching ? "正在取回…" : "取回结果"}
                    </button>
                  </p>
                {/if}
            </div>
              </div>

            </section>

            </div>
          {/if}
        </div>
        <!-- 常驻的隐藏文件框：底部那颗「工作流」按钮和空态共用它，所以不能只在菜单开着的时候存在。
             位置别挪到组件模板最外层：实测挪出去之后元素还在 DOM 里，但 change 事件不再进 handler。 -->
        <!-- 音色试听用的播放器：整个弹窗共用一条，换人只换 src。放在弹层外面，
             收弹层时元素不会被销毁（销毁才是最容易漏掉的一条停音路径）。 -->
        <!-- svelte-ignore a11y_media_has_caption -->
        <audio
          bind:this={sampleEl}
          class="cm-voice-sample"
          preload="none"
          onended={stopVoiceSample}
          onerror={stopVoiceSample}
        ></audio>
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
  kind={pickerKind}
  kinds={pickerKinds}
  title={pickerTitle}
  onPick={(picked, chosenKind) => {
    const kind = chosenKind ?? pickerKind;
    // 不绑族那颗「+ 参考」：挑到哪一族就落这一族的第一个空位，从第 1 格连着填，跳不了格。
    const key = pickerSlot === ADD_ANY ? firstFreeRefKey(cells, refs, kind) : pickerSlot;
    if (!key) return;
    refs = { ...refs, [key]: { ...picked, kind } };
    const cell = cells.find((item) => item.key === key);
    // 从 @ 菜单里点「再挂一份」进来的：素材挂上了，顺手把引用标签插回提示词。
    // 插的是 insert 文本而不是中文编号——H3 只认 <Picture 1>，@图片1 对它是一行普通字。
    if (cell && mentionPickKey === key) {
      void commitMention(mentionInsertText(cell, mediaKind, isCloudTemplate(template)));
    }
    mentionPickKey = null;
  }}
  onClose={() => (pickerSlot = null)}
/>

<style>
  /* 与「放大」同一层、同一块底色（2026-11-04 苏醒：「再次创作和放大功能一样，收进缩略图区域，
     不要模糊背景了，和放大一样的纯色背景」）。absolute 的 containing block 为什么是 <main>：
     Feed 的根是 display:contents（不生成盒子），外面那层 wrapper 没有 position，
     往上最近的就是 main.relative——所以这一层刚好铺满中间那一列，侧栏与详情栏留在外面。
     #0e0e10 就是 tailwind 的 bg-bg，Lightbox 那块用的同一支色；z-30 在 main 的 isolate 里，
     比 Lightbox 的 z-20 高一档，顺序是定的（两者不同屏，但别靠 DOM 顺序赌）。 */
  .cm-backdrop {
    position: absolute; inset: 0; z-index: 30; padding: 20px;
    display: flex; align-items: center; justify-content: center;
    background: #0e0e10;
  }
  /* 这一层自己就是那块模块底（2026-11-10 第三轮苏醒：「我想让这个左右结构放在一个模块背景上。
     不要看起来像 2 截」）：图在左、控件在右，两块坐在同一张底上才读成一个东西。
     2026-11-04 那次撤外框当时是对的——只剩输入区一张卡 + 一张裸图，画一圈边等于凭空多贴一张卡片；
     现在两栏共用这张底，卡里那层画撤了（见 .cm-composer），这一层就是唯一那层面。
     纯色 #131316（App 那套卡色）不带虚化：底下是整列 #0e0e10 纯色，糊它等于什么也没糊。
     几何一个字不动：max-height 量的还是这一列去掉 backdrop 那 20px 之后的净高，
     下内边距那 20px 是钉住的坞 bottom:-20px 的测量基准——改它就露一条缝（538x682 踩过）。
     2026-11-10 苏醒「改回左右结构」：宽度上限 820 → 1040，第二轮照旧图放到旧版（53325f0）那个 1080。820 是竖排那一版的行宽需求，两栏要同时
     装下展示图与输入卡就不够了。100% 仍是硬顶——这一层被中间那一列框着：1731x1443（可视 1709x1345，
     侧栏 260 与详情栏 326 都开着）实测那一列 1123、面板吃满 1080；1440x900（可视 1418x802）
     那一列只有 832、面板 792，装不下两栏，跟着 is-stacked 收回上下结构（见 .cm-body）。 */
  .cm-panel {
    position: relative; width: min(1080px, 100%); max-height: 100%; overflow: auto; padding: 20px 22px;
    border: 1px solid rgb(255 255 255 / 8%); border-radius: 20px; background: #131316; color: #e4e4e7;
    transition: border-color 160ms ease, box-shadow 160ms ease;
  }

  /* 顶栏只剩大字那一行（2026-11-10 照旧图放回来时是两行，2026-11-11 苏醒「再次创作四字删除，
     标题合理上移」把上面那行小字撤了）：当前挂的工作流 / 模型自己就是顶栏。标题吃左、关闭那颗吃右，
     名字长了截断，全名在悬停提示里。整行上下居中——大字与右边那颗 30px 的关闭键同一条中线。 */
  .cm-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: -2px -4px 6px; }
  .cm-heading { min-width: 0; }
  .cm-title { margin: 0; font-size: 17px; line-height: 22px; font-weight: 650; color: #fafafa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cm-close { flex: none; display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 9px; color: #8a8a8e; background: transparent; }
  .cm-close:hover { color: #fafafa; background: rgb(255 255 255 / 10%); }

  .cm-banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; padding: 9px 12px; font-size: 12.5px; color: #f7d9a8; background: #2a2318; border: 1px solid #4a3c22; border-radius: 10px; }

  /* 左右两栏（2026-11-10 苏醒照旧图：「改回类似之前的这种版式」）：展示图在左、输入卡在右，
     两栏都从顶上开始（align-items: start）。旧图的读法是左图顶到弹窗上沿一路长到底、右列从上往下排；
     先前一版把两栏垂直居中，两格都在中间飘着、上下各空一大片，看着像弹窗没装满。
     切法照旧版（53325f0）：左列 1fr 吃剩余、右列定宽，22px 缝。旧图那张展示图之所以大，就是因为右列
     本来就定宽、剩余全归图；先前 5:7 对半摊把图压到只剩窗口高的 54%。
     右列上限从旧版 470 抬到 524：底部那一排现在是三颗胶囊 + 圆形生成那颗，470 会把参数胶囊截断。
     1080 那档实测 左 490 / 右 524 → 竖构图展示图 852 高（窗口高的 63%，旧图那版 72%，同量级）。
     轨道最小值一律 minmax(0, …)：写成 minmax(240px, …) 列一窄就不收缩，顶出来的是面板横向滚动条。 */
  .cm-body { --cm-hero-h: min(46vh, 480px); display: grid; grid-template-columns: minmax(0, 1fr) minmax(340px, 524px); gap: 22px; align-items: start; min-width: 0; }
  /* 中间那一列窄到放不下两栏时收回上下结构。判宽的是面板自己，不是窗口——侧栏折展、详情栏开关改的
     都是这一列的宽度；门槛与推导见脚本里 stacked 那条注释。 */
  .cm-body.is-stacked { grid-template-columns: minmax(0, 1fr); }
  /* 竖排那一档把整列锁在面板可视区里，剩余高度归上面那格，输入卡始终完整可见（2026-11-11 实测）。
     先说为什么要让面板自己变 flex 列：.cm-body 得拿到「可视区还剩多少」这个确定高度，1fr 才有得算。
     不锁高度时它的高等于内容高——1440x900（可视 1418x802）实测面板可视 732、内容 1104，
     只能滚；而卡底那条是 sticky，静止（scrollTop=0）时提示词框整格在可视区以下：框 758..1031，
     可视下沿 754，一条都不露，要往下滚 372 才够得着打字的地方。这不是「图太大」一个数的事：
     图按 46vh 换成 32vh 只省 112，同一档还差 260——除不干净，所以不再靠挑一个 vh。
     现在换成让高：第一行吃剩余、地板 120（图再怎么让也不缩没），
     那一行的 minmax 全文件只许出现一次，漂出第二个数两处就会各让各的（有测试钉住），
     第二行 auto 是「先给够输入卡」——卡里最矮也得能打字，所以让高的是图那一格。
     两栏那一档不受这条影响（判据都挂在 .is-stacked 上），面板不换 display、轨道不重写。
     真让不动了（人自己把提示词框拉到很高、窗口矮到 120+卡都装不下）照旧溢出、照旧滚动，
     sticky 那条仍然兜得住——那是人自己选的，不是布局替他决定的。 */
  .cm-panel.is-stacked { display: flex; flex-direction: column; }
  .cm-body.is-stacked { flex: 1 1 auto; min-height: 0; grid-template-rows: minmax(120px, 1fr) auto; align-items: stretch; }
  /* 住进 1fr 那一行就得允许被压：flex 子项的自动最小尺寸是内容尺寸，图又是替换元素，
     不写 min-height:0 它顶着 intrinsic 高度不让缩，压不动就变成溢出，等于这条白写。 */
  .cm-body.is-stacked .cm-left { min-height: 0; }
  .cm-body.is-stacked .cm-hero, .cm-body.is-stacked .cm-stage { min-height: 0; }
  .cm-body.is-stacked .cm-hero-name { flex: none; }
  /* 这一格的高度只有 --cm-hero-h 一个来源（展示图、等待台、画布都只读它：同一格轮流占，各自写一个数
     就会在换状态时把输入卡顶一下、坠一下，1478x562 踩过）。
     两栏那一档整列高度归它，取旧版那条 74vh：图是等比的，真正的上限其实是左列宽度（上一条定），74vh 只在
     横构图和超高屏上兜底；1080 封顶（再高就整屏只剩图，字对比难受）。
     竖排那一档这条只是天花板，不是占位：竖排时上面那一格吃的是「可视区剩下的」，见下面 .cm-body.is-stacked。
     所以这里的数往下调并不会让弹窗不滚（1440x900 实测 46vh→32vh 只省 112，同一档还差 260），
     它只决定高屏上让完之后还剩多少给图。 */
  .cm-body:not(.is-stacked) { --cm-hero-h: min(74vh, 1080px); }
  .cm-left { display: flex; flex-direction: column; align-items: center; gap: 8px; min-width: 0; }
  /* 竖排之后展示图由高度定大小（横排时是栏宽撑着的）：限高、等比、居中。
     2026-11-04 苏醒：「适当放大展示图」。26vh/300px 是这张还跟右侧并排时定的数；改成上下结构之后
     顶上这一格独占整宽，先在真浏览器里量了四档（1440x900 可视高 802，展示图是竖构图时）：
       38vh → 图 305 高，弹窗 575 高，离 90vh 上限还差 18vh
       46vh → 图 369 高，弹窗 639 高，差 10vh            ← 取这档
       54vh → 图 433 高，弹窗 703 高，只剩 2vh，弹窗自己开始滚
     所以定 46vh/480px：比原来的 26vh 高一截，又不至于把弹窗顶到要滚动才看得见生成那颗。
     480px 那条封顶是给高屏的：屏越高不等于图可以无限大，图一大字小的对比会更难受。
     2026-11-10 改回左右结构：这一格不再独占整宽，独占的是整列高度，两栏那一档按视口高算（见 .cm-body）。
     数不写在这条上：这里只读 --cm-hero-h，值在 .cm-body 那两条里，见上面那段。 */
  .cm-hero { width: auto; max-width: 100%; max-height: var(--cm-hero-h); object-fit: contain; border-radius: 16px; background: #0c0c0e; }
  /* 展示图下面那行文件名（旧图有这一行，2026-11-10 放回来）：从这一格跳回图库、或一次出几份时，
     认的就是它。长名字截断，完整名字在 title 里。 */
  .cm-hero-name { margin: 2px 0 0; max-width: 100%; font-size: 12px; line-height: 16px; color: #8a8a8e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* 波形是一张扁的后端 PNG：照搬 cm-hero 的 contain 会把它拉成一大块模糊，这里锁住高度。 */
  .cm-hero-wave { width: min(100%, 560px); height: clamp(88px, 18vh, 148px); object-fit: cover; }
  .cm-hero-audio { width: min(100%, 560px); margin-top: 10px; height: 36px; }
  .cm-hero-empty { display: flex; align-items: center; justify-content: center; min-height: 140px; font-size: 12.5px; color: #71717a; }

  /* ── 生成中这一格：等待台。三层叠——底图慢慢呼吸、一条光带斜着扫过去、中间那张卡报状态。
     2026-11-04 苏醒：「做一个友好的交互动效，减少用户的等待焦虑」。两条规矩：
     ① 尺寸写死，不跟素材宽高比跳，换阶段也不重排——来回拉扯本身就是在制造焦虑；
     ② 节奏一律放慢（呼吸 7.5s、扫光 3.4s），动的是「它还活着」，不是催人。 */
  .cm-stage {
    position: relative; width: min(100%, 620px); height: var(--cm-hero-h); overflow: hidden;
    display: flex; align-items: center; justify-content: center; border-radius: 16px; background: #0c0c0e;
    border: 1px solid rgb(255 255 255 / 6%);
  }
  .cm-stage-ghost { position: absolute; inset: -6%; width: 112%; height: 112%; object-fit: cover; opacity: .32; filter: blur(14px) saturate(105%); animation: cm-breathe 7.5s ease-in-out infinite; }
  .cm-stage-veil { position: absolute; inset: 0; background: radial-gradient(120% 90% at 50% 40%, rgb(242 78 78 / 10%), transparent 62%), linear-gradient(180deg, rgb(9 9 11 / 24%), rgb(9 9 11 / 74%)); }
  .cm-stage-beam { position: absolute; top: -40%; left: -20%; width: 38%; height: 180%; transform: rotate(14deg) translateX(-200%); background: linear-gradient(90deg, transparent, rgb(255 255 255 / 11%) 48%, transparent); animation: cm-scan 3.4s ease-in-out infinite; }
  /* 手放上去画面要答一声：底图再抬一点、光带快一点——这是「交互」该有的样子，不是多加一颗按钮。 */
  .cm-stage:hover .cm-stage-ghost { opacity: .44; }
  .cm-stage:hover .cm-stage-beam { animation-duration: 2.1s; }
  .cm-stage-card {
    position: relative; z-index: 2; display: flex; flex-direction: column; align-items: center; gap: 9px;
    padding: 18px 24px; border-radius: 15px; text-align: center;
    background: rgb(12 12 14 / 62%); border: 1px solid rgb(255 255 255 / 8%);
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  }
  .cm-stage-orb { display: inline-flex; align-items: flex-end; gap: 4px; height: 22px; }
  .cm-stage-orb i { width: 4px; height: 8px; border-radius: 3px; background: linear-gradient(180deg, #ff8a70, #f24e4e); animation: cm-pulse 1.15s ease-in-out infinite; }
  .cm-stage-orb i:nth-child(2) { animation-delay: .16s; }
  .cm-stage-orb i:nth-child(3) { animation-delay: .32s; }
  .cm-stage-line { margin: 0; font-size: 13.5px; font-weight: 600; color: #f4f4f5; }
  .cm-stage-clock { margin: 0; font-size: 11.5px; color: #9d9da4; font-variant-numeric: tabular-nums; }
  /* 台阶条：只在换档时走一段（900ms 缓动），中间不许自己爬——后端不给整条工作流的剩余时间，
     编一条会自己往前蹭的假百分比比诚实的台阶更坏。两条缝钉在 34% 与 76%：跑最久那一段一眼认得出。 */
  .cm-stage-bar { position: relative; width: 212px; height: 3px; border-radius: 999px; overflow: hidden; background: rgb(255 255 255 / 10%); }
  .cm-stage-bar > span { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #ff8a70, #f24e4e); transition: width 900ms cubic-bezier(.22, .61, .36, 1); }
  .cm-stage-bar::after { content: ""; position: absolute; inset: 0; pointer-events: none;
    background-image: linear-gradient(90deg, transparent calc(34% - 1px), #0c0c0e calc(34% - 1px), #0c0c0e calc(34% + 1px), transparent calc(34% + 1px)),
      linear-gradient(90deg, transparent calc(76% - 1px), #0c0c0e calc(76% - 1px), #0c0c0e calc(76% + 1px), transparent calc(76% + 1px)); }
  .cm-stage-steps { display: flex; gap: 9px; margin: 0; padding: 0; font-size: 11px; color: #6f6f78; }
  .cm-stage-step { transition: color 220ms ease; }
  .cm-stage-step.is-past { color: #8f8f97; }
  .cm-stage-step.is-now { color: #f8a29a; }
  @keyframes cm-breathe { 0%, 100% { transform: scale(1); opacity: .30; } 50% { transform: scale(1.045); opacity: .40; } }
  @keyframes cm-scan { 0% { transform: rotate(14deg) translateX(-220%); } 62%, 100% { transform: rotate(14deg) translateX(400%); } }
  @keyframes cm-pulse { 0%, 100% { height: 7px; opacity: .5; } 50% { height: 19px; opacity: 1; } }

  /* 刚跑完：这一格直接换成新出来的那一份。淡入加一点点抬起，「出来了」不用读字也知道。
     整块可点 = 到图库里看那一份；悬停或键盘聚焦才浮出右下角那颗提示，静止时画面上一条多余的字都没有。 */
  .cm-hero-out { position: relative; display: block; padding: 0; border: 0; background: transparent; cursor: pointer; }
  .cm-hero-new { animation: cm-hero-in 320ms cubic-bezier(.22, .61, .36, 1); }
  .cm-hero-out:hover .cm-hero-new, .cm-hero-out:focus-visible .cm-hero-new { outline: 1px solid rgb(255 255 255 / 24%); outline-offset: 3px; }
  .cm-hero-out-play { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: flex; align-items: center; justify-content: center; width: 52px; height: 52px; border-radius: 50%; color: #fafafa; background: rgb(12 12 14 / 62%); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
  .cm-hero-out-hint { position: absolute; right: 12px; bottom: 12px; display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; font-size: 11.5px; color: #f4f4f5; border-radius: 999px; background: rgb(12 12 14 / 74%); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); opacity: 0; transition: opacity 140ms ease; }
  .cm-hero-out:hover .cm-hero-out-hint, .cm-hero-out:focus-visible .cm-hero-out-hint { opacity: 1; }
  .cm-hero-pager { display: flex; align-items: center; gap: 6px; }
  .cm-hero-nav { display: flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 50%; color: #c9c9cf; background: rgb(255 255 255 / 7%); border: 1px solid rgb(255 255 255 / 8%); cursor: pointer; transition: background-color 140ms ease, color 140ms ease; }
  .cm-hero-nav:hover { color: #fafafa; background: rgb(255 255 255 / 14%); }
  .cm-hero-count { font-size: 11.5px; color: #8a8a8e; font-variant-numeric: tabular-nums; }
  @keyframes cm-hero-in { from { opacity: 0; transform: scale(.985) translateY(6px); } to { opacity: 1; transform: none; } }
  /* 不想看动效的人：等待台照样报状态、照样换档，只是不呼吸不扫光不跳——信息一条不少。 */
  @media (prefers-reduced-motion: reduce) {
    .cm-stage-ghost, .cm-stage-beam, .cm-stage-orb i, .cm-hero-new { animation: none; }
    .cm-stage-ghost { opacity: .34; }
    .cm-stage-beam { display: none; }
    .cm-stage-bar > span, .cm-stage-step, .cm-hero-out-hint { transition: none; }
  }

  .cm-right { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .cm-block { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .cm-block-title { margin: 0; font-size: 14px; font-weight: 600; color: #ececef; }

  /* 一次输入从上往下排（2026-11-10 苏醒照旧图：「改回类似之前的这种版式」）：参考在上、话在下、
     操作钉在卡底，两块各带一行小标题。11-04 那一版是「素材在左、话在右」，代价是参考那一摞只有
     84px 宽、编号只能压在照片上，几份参考叠在一起读不出「这是几张不同的东西」。
     参考多到一行装不下（十六格那种配方）时整排换行——以前靠竖摞长高，现在靠 wrap 长。 */
  .cm-input-row { display: flex; flex-direction: column; align-items: stretch; gap: 12px; min-width: 0; }
  .cm-prompt-col { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  /* 参考是一排缩略图（2026-11-10 改回横排）：每格 = 一张照片 + 摆在格子下面的编号，装不下整排换行。
     --z 由行内顺着给（后挂的压在前面那张上头），整排关在 z-index:0 这一层：格子悬停抬起时也会互相压，
     但再也出不去这层；卡底那条与它上面的弹层是 3 层，永远盖得住这一排。 */
  .cm-ref-stack {
    position: relative; z-index: 0; flex: none; display: flex; flex-wrap: wrap; align-items: flex-start; gap: 10px 12px; min-width: 0;
  }
  /* 一格 = 一张照片 + 下面那行编号，格子自己就是定位基准。叠放用的那几条负 margin 撤了（横排不叠）。 */
  .cm-ref-cell { position: relative; min-width: 0; flex: none; z-index: var(--z, 1);
    transition: transform 200ms cubic-bezier(0.22, 0.61, 0.36, 1); }
  /* 每格歪一点点那两条撤了：那是「手摆上去的一摞」的做法。横排之后编号要落在格子下面，
     格子一歪字就跟着歪，一排编号读不齐。悬停抬起仍然留着，见下面那条。 */
  /* 指到哪格，哪格抬起来摆正、其余压暗：眼睛只跟着手走。z-index 提到 60 才不被后面那格盖回去。 */
  .cm-ref-stack .cm-ref-cell:hover, .cm-ref-stack .cm-ref-cell:focus-within {
    z-index: 60; transform: translate(6px, -3px) rotate(0deg) scale(1.06);
  }
  /* 压暗只压照片：空格子本来就淡，再压一遍等于没了；压在角上那颗「+」压暗之后，
     白圆钮在深色卡上糊成一块脏灰（1440 实拍）——它是「还能再加一份」，不该跟着退场。 */
  .cm-ref-stack:hover .cm-ref-cell:not(:hover) .cm-tile.media-chip,
  .cm-ref-stack:focus-within .cm-ref-cell:not(:focus-within) .cm-tile.media-chip { opacity: 0.58; }
  /* 不想要动效的人不该被这一排晃：编号、点得动，一样都不少，只是不飞。 */
  @media (prefers-reduced-motion: reduce) {
    .cm-ref-cell { transition: none; }
    .cm-ref-stack .cm-ref-cell:hover, .cm-ref-stack .cm-ref-cell:focus-within { transform: none; }
  }
  .cm-tile { position: relative; width: 84px; height: 84px; overflow: hidden; border-radius: 14px; background: #141417; border: 1px solid rgb(255 255 255 / 7%); }
  .cm-tile-img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; object-fit: cover; }
  .cm-tile-add { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 0; font-size: 12.5px; color: #d4d4d8; background: #1a1a1e; cursor: pointer; transition: background-color 140ms ease, border-color 140ms ease; }
  /* 音频格子里那是波形图（840×360 的透明 PNG）：cover 会把波形切成一条中线，contain 才看得出起伏。
     背景压深一档，透明的波形才不会和卡片糊成一片。 */
  .cm-tile-audio { background: #101013; }
  .cm-tile-audio .cm-tile-img { object-fit: contain; padding: 12px 8px; }
  .cm-tile-add:hover { background: #232327; border-color: rgb(255 255 255 / 14%); }
  /* 整块缩略图都是替换的热区：这一层铺满格子，只管接点击，画面还是底下那张图。 */
  .cm-tile-pick { position: absolute; inset: 0; display: block; padding: 0; border: 0; background: transparent; cursor: pointer; }
  .cm-tile-swap,
  .cm-tile-x { position: absolute; display: flex; align-items: center; justify-content: center; color: #fafafa; background: rgba(18, 18, 20, 0.78); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); opacity: 0; transition: opacity 140ms ease, background-color 140ms ease; cursor: pointer; }
  .cm-tile-swap { left: 50%; top: 50%; width: 30px; height: 30px; border-radius: 50%; transform: translate(-50%, -50%); pointer-events: none; }
  .cm-tile-x { top: 5px; right: 5px; width: 20px; height: 20px; border-radius: 50%; }
  .cm-tile:hover .cm-tile-swap,
  .cm-tile:hover .cm-tile-x,
  .cm-tile:focus-within .cm-tile-swap,
  .cm-tile:focus-within .cm-tile-x { opacity: 1; }
  .cm-tile-pick:hover .cm-tile-swap,
  .cm-tile-x:hover { background: rgba(38, 38, 42, 0.95); }
  .cm-tile-x:hover { color: #f87171; }
  /* 编号摆在格子下面（横排之后照片不再互相压着，下沿是空的，读得清了）。提示词里写的是 @图片1，
     编号必须一眼对得上是谁，所以这一行不省。 */
  .cm-ref-caption {
    display: block; margin-top: 6px; max-width: 100%;
    font-size: 11px; line-height: 15px; color: var(--text-3); text-align: center;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none;
  }
  /* 绑到位的空格子：小牌上已经写着「图片2」，中间那行「参考」是重复的——只留加号。
     行末那颗不绑族的「+ 参考」不在 .cm-ref-cell 里，它的字照留（那颗没有编号可写）。
     按钮的可访问名来自 aria-label，藏掉这行字不影响读屏。 */
  .cm-ref-cell .cm-tile-add span { display: none; }
  /* 末尾那颗「+ 参考」自己占一格：它没有编号可写，所以「参考」那两个字留在自己身上。
     z-index 必须自己吃 --z：不写的话它是 z-index:auto，正 z 的格子全压在它上头。 */
  .cm-tile.cm-ref-add { width: 84px; height: 84px; min-height: 84px; z-index: var(--z, 1); }
  /* 「只有一份参考时把「+ 参考」缩成压在照片角上的小圆钮」那几条撤了（2026-11-10 改回横排）：
     那是竖摞没地方摆第二格时的省法。横排之后第二格就是它自己的位置，编号也写在它下面。 */

  /* 输入区这层不再自己带面（2026-11-10 第三轮）：模块底已经挂在外层 .cm-panel 上了，这一层再画
     一圈就是卡中卡，左右照样读成两截。这里只剩布局：一份内边距 + 上下两块的间距，几何照旧不动。
     底色走上浅下深的一层薄光 + 内上沿一道高光，卡片才不像在面板上又贴了一块黑纸。 */
  .cm-composer {
    position: relative; display: flex; flex-direction: column; gap: 10px;
    /* 下内边距 0：这条最后那根卡底条自己带 12px 下内边距，它的下边界就是这条的内边界。留 9px 的话，钉住时那 9px 会留在条下面，滚上去的字从缝里露出来。 */
    padding: 12px 12px 0;
  }
  /* 整块模块响应聚焦（原先挂在 composer 那圈画上，那层撤了就搬到这里）：人在下面打字，左边那张图
     与上面那几格也还在说「这些就是要用的参考」。描边提亮 + 一层很淡的品牌色外圈，不加底色。 */
  /* 正在拉提示词框：指针跑到哪一格都还是拉高光标，顺手锁掉选字——不锁的话拖一趟回来
     正文被划蓝一片。挂在面板上而不是 body 上，弹窗一卸载这些样式跟着就没了。 */
  .cm-panel.is-grabbing { cursor: nwse-resize; user-select: none; }
  .cm-panel:focus-within {
    border-color: rgb(255 255 255 / 20%);
    box-shadow: 0 0 0 3px rgb(242 78 78 / 7%);
  }
  /* 打字框自己的边回到基类那档；底色仍留透明——字是高亮层那层显示的，框一填死就把高亮糊掉了。 */
  /* .cm-prompt-bg 那层的底色也回到基类那档（rgba(0,0,0,.35) + 12 圆角）：那是输入区的口，不是第二张卡。 */
  /* 原生拉伸手柄仍然关着：它改的是 textarea 自己的 height，一打字就被 autosizePrompt 当场冲回去，
     看着像框在跟人抢方向盘。要拉高走右下角那颗手柄——它改的是 promptUserH 那一档高度，打字冲不掉。 */
  .cm-composer .cm-textarea { resize: none; }
  /* 附框（参考音频的原话那种）搬进卡里之后，上面那条「卡里的框一律透明」会连它一起吃掉——
     台词和原话糊成同一片，人就分不清哪一格念什么。给它把底和边要回来（同权重，靠顺序赢）。 */
  .cm-composer .cm-textarea-sub,
  .cm-composer .cm-textarea-sub:focus { background: rgba(0, 0, 0, 0.35); border-color: rgb(255 255 255 / 8%); }
  /* 素材与话之间不画分隔线：两块上面各有各的小标题，标题就是分组，再画一条线反而把参考框成
     「另一块区域」。 */
  /* 卡底那几行灰字撤了（2026-11-04 苏醒：「这种小字提示也删掉」）：说明不再另起一段摆进版面，
     「丢了几份参考」「这一族没被吃进去」「这条工作流不吃参考」合成一句挂到卡的悬停提示上。 */

  /* 格子里按「一张照片」处理：一点投影 + 描边提亮；末端那颗还没填的走虚线口。
     抬起、摆正整块挂在 .cm-ref-cell 上（上面那一摞那一段）——编号小牌是照片的兄弟，
     只提照片会把小牌丢在原地，所以这里不再自己写 transform。 */
  .cm-tile { box-shadow: 0 6px 16px rgba(0, 0, 0, 0.34); transition: transform 140ms ease, box-shadow 160ms ease, border-color 160ms ease, opacity 160ms ease; }
  .cm-ref-cell:hover .cm-tile,
  .cm-ref-cell:focus-within .cm-tile { border-color: rgb(255 255 255 / 26%); box-shadow: 0 16px 34px rgba(0, 0, 0, 0.52); }
  /* 从资源管理器拖素材进来时，指针底下那一格描一圈品牌红：真机的原生拖放不会给页面任何落点提示，
     画面不响应就等于让人盲投——人只会以为「拖不进来」（2026-11-11）。 */
  .cm-ref-cell.is-drop-target .cm-tile { border-color: transparent; box-shadow: 0 0 0 2px var(--accent), 0 16px 34px rgba(0, 0, 0, 0.52); }
  /* 空格子的底走不透明的 #1a1a1e（和上面那条 .cm-tile-add 同一个色），不再用 4% 白半透：
     叠放反过来之后，末尾那一格是压在最上面的，半透的话会把下面那张照片透上来——
     一个空位看着像已经放了东西。（贴在深色卡上时两种底差不到 1 个 RGB，看不出区别。） */
  .cm-tile-add { border-style: dashed; border-color: rgb(255 255 255 / 12%); }
  .cm-tile-add:hover { border-color: rgb(255 255 255 / 26%); }

  /* 悬停放大的那一张：只负责让人看清是哪份素材。不接点击（pointer-events:none，
     否则鼠标一移过去就把格子的离开事件吃掉、放大图赖着不走），也不进可访问树——
     格子的 title 早把「槽位｜文件名」念过一遍了。 */
  .cm-ref-zoom {
    position: fixed; z-index: 9; overflow: hidden; border-radius: 14px;
    border: 1px solid rgb(255 255 255 / 12%); background: #0c0c0e;
    box-shadow: 0 22px 54px rgba(0, 0, 0, 0.6); pointer-events: none;
  }
  /* 宽高由 refZoomFor 按这份素材的真实比例写在行内，所以 cover 不会裁——比例本来就是它算出来的。 */
  .cm-ref-zoom-img { width: 100%; height: 100%; display: block; object-fit: cover; }
  .cm-ref-zoom-cap {
    position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: baseline;
    justify-content: space-between; gap: 8px; margin: 0; padding: 20px 10px 8px;
    font-size: 11.5px; color: #e8e8ec; background: linear-gradient(180deg, transparent, rgba(8, 8, 10, 0.88));
  }
  .cm-ref-zoom-file { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #9a9aa2; }

  /* 标题右边那个只读标签：告诉他现在是哪种生成方式，但它不是按钮。 */
  .cm-form { display: contents; }

  /* 高亮遮罩和 textarea 是叠在一起的两层字，盒模型 / 字体 / 折行规则必须一字不差，
     所以两边写进同一条规则：谁要改排版就一起改，拆开改第一次滚动就会看见高亮在飘。 */
  .cm-prompt-bg, .cm-textarea { display: block; box-sizing: border-box; width: 100%; padding: 11px 12px; border: 1px solid transparent; font-family: inherit; font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; }
  .cm-prompt-bg { position: absolute; inset: 0; z-index: 0; overflow: hidden; pointer-events: none; border-radius: 12px; color: #e4e4e7; background: rgba(0, 0, 0, 0.35); }
  .cm-textarea { position: relative; z-index: 1; background: transparent; border-color: rgb(255 255 255 / 8%); border-radius: 12px; resize: vertical; }
  /* 提示词框跟着窗口高矮走：窗口矮的时候先让提示词框让出高度，而不是把下面那排按钮挤出弹窗 ——
     「生成中」和「取消」看不见、要滚动才点得到的弹窗，不算能用。 */
  /* 高度不写死了：空着两行、写长了才撑（见 autosizePrompt）。这里只兜住下限，JS 没跑也不至于塌成一条。 */
  .cm-textarea { min-height: 46px; height: auto; }
  /* 透明字只属于「背后有镜像高亮层」的主框：文字由 .cm-prompt-bg 那层显示。
     这条要是挂回 .cm-textarea，任何复用该类的框都会变成看不见字的盲打框。 */
  .cm-textarea-mirror { color: transparent; caret-color: #f24e4e; }
  .cm-textarea:focus { border-color: rgb(255 255 255 / 22%); outline: none; }
  .cm-textarea::placeholder { color: var(--text-3); opacity: 1; }
  /* 附框（参考音频的原话那种）比主框矮：它是「别乱动」的东西，占了大半个弹窗反而没人看台词 */
  .cm-textarea-sub { height: auto; min-height: 60px; color: #e4e4e7; background: rgba(0, 0, 0, 0.35); }
  .cm-sub-prompt-title { margin-top: 12px; }
  /* 高亮只许动颜色和背景：padding / border / font-weight 都会推字节，一改高亮就和光标错位。 */
  .cm-mention-hl { color: #ff6a4d; }
  /* 载入模板那颗：半透明挂在圆角框右上角，滑过才亮（2026-11-04 苏醒：「做成半透明图标，鼠标滑过
     展示，功能变成加载提示词模板，放在矩形圆框右上角」）。它是卡里唯一的悬浮件，z-index 必须高过
     左边那一摞参考（格子里给到 1..n）——上一轮菜单就是被这一摞糊掉的，别再犯。
     键盘走 :focus-visible 也亮起来，读屏拿 aria-label，不靠文字。 */
  .cm-wand {
    position: absolute; top: 10px; right: 10px; z-index: 6;
    display: inline-flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; padding: 0; border-radius: 50%;
    border: 1px solid rgb(255 255 255 / 12%); background: rgb(20 20 24 / 55%);
    color: rgb(255 255 255 / 62%); cursor: pointer;
    opacity: .55; backdrop-filter: blur(6px);
    transition: opacity 140ms ease, color 140ms ease, border-color 140ms ease, background 140ms ease;
  }
  .cm-wand:hover, .cm-wand:focus-visible { opacity: 1; color: #ff6a4d; border-color: rgb(255 106 77 / 45%); background: rgb(24 24 28 / 82%); }
  /* 提示词框右下角那颗拉高手柄（2026-11-10 苏醒：「提示词输入框右下角加一个拉高提示词的功能」）。
     静止时压暗、滑过/拖动/键盘聚焦才亮。斜纹画在伪元素上并裁成三角形：看着只是口内角的一小片纹路，
     命中区仍是整颗方块——好点中，也不会挡住正文文字。整颗往里让 4px：框的口角是 12px 圆角，
     贴着角画会被那道圆弧切掉一截，看着像缺了个口。 */
  .cm-prompt-grip {
    position: absolute; right: 4px; bottom: 4px; z-index: 3;
    width: 14px; height: 14px; outline: none;
    cursor: nwse-resize; touch-action: none;
    opacity: .55; transition: opacity 140ms ease;
  }
  .cm-prompt-grip::before {
    content: ""; position: absolute; inset: 0;
    clip-path: polygon(100% 0, 100% 100%, 0 100%);
    background: repeating-linear-gradient(135deg, transparent 0 3px, #9a9aa2 3px 4.5px);
  }
  .cm-prompt-grip:hover, .cm-prompt-grip.is-live, .cm-prompt-grip:focus-visible { opacity: 1; }
  /* 关掉动效的人不该看不见它：这一档不压暗，只是不再有那 140ms 的过渡 */
  @media (prefers-reduced-motion: reduce) {
    .cm-prompt-grip { opacity: .85; transition: none; }
  }
  .cm-note { margin: 0; font-size: 11.5px; color: #71717a; }
  .cm-empty { display: flex; flex-direction: column; gap: 10px; padding: 16px; font-size: 12.5px; color: #a1a1aa; background: #1b1b1f; border: 1px dashed #33333a; border-radius: 12px; }

  /* 让位顺序写死在这一行：右边按钮组不参与压缩（「取消」那一格连静止时都提前占好，按下生成的一瞬间
     右边宽度不变），左边每一格 min-width:0 可以被压缩；容器真装不下就整排换行，让位的永远是左边
     那排胶囊，不是右边的「取消」和「生成」（苏醒 Round 15 截图）。 */
  /* 底部这条「坞」钉在弹窗下沿（图二那条 composer bar 就是这么放的）：竖排之后内容比弹窗高，
     不钉住的话「生成」在初始状态下根本看不见——没钉之前实测 1478×902 那一排在 919..955，弹窗下沿只有 857。
     负 margin 是给弹窗内边距让路的（左右 22、下 20），让这条横到弹窗整宽；压一层不透明底，
     滚动时提示词从它底下过去不会糊成一团。状态与价格那几行说明也在坞里：生成中的进度、
     云端「价格没取到」那句必须一直看得见，不能藏在要往下滚才出现的地方。 */
  .cm-dock {
    /* bottom 是 -20px，不是 0：Chrome 量 sticky 偏移用的是滚动容器的 **content box**，
       而弹窗那 20px 下内边距属于可视区（滚动内容会画到里面）。写 0 的话这条的下边界停在
       content 下沿，底下露出 20px，滚上去的提示词从这条下面露出来（538x682 实测截图）。
       抬到 -20px 之后这条的下边界正好压在可视区下沿上。 */
    position: sticky; bottom: -20px; z-index: 3;
    /* 左右负 margin 只吃**卡片**的内边距（12px）：这一排住在卡里，左右跟卡内边对齐，
       看起来是框的一部分而不是一块外挂的板。下边不需要负——卡的下内边距已经是 0。 */
    margin: 2px -12px 0; padding: 10px 12px 12px;
    /* 卡不能 overflow:hidden（工作流弹层要往卡外冒），所以这条带自己的下圆角：模块圆角 20px 减 1px 边框。 */
    border-radius: 0 0 19px 19px;
    /* 一点都不许透：0.98/0.9 那一版在 538x682 打长提示词时，「完整提示词 · …」那行从坞底下
       过去，字整个透出来压在按钮上。
       底色跟模块底同一支 #131316（2026-11-10 第三轮：模块底搬到 .cm-panel 上了）：这条住在模块里，
       比模块亮一档或暗一档都会读成外挂的一块板；同色就等于看不见这块板，只在滚动时把从它底下
       过去的字压住。旧值 #0b0b0c 是当年 composer 那张卡下沿的合成色，那张卡的面已经撤了。 */
    background: #131316;
  }
  /* 上面那 14px 是一条渐隐，不是分隔线：钉住时滚上来的字在这里淡掉，比被这条的上沿切一刀干净。
     不占布局、不接点击（pointer-events:none），弹层与按钮都不受影响。 */
  .cm-dock::before {
    content: ""; position: absolute; left: 0; right: 0; top: -14px; height: 14px;
    background: linear-gradient(180deg, rgb(19 19 22 / 0) 0%, #131316 100%);
    pointer-events: none;
  }
  .cm-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px 12px; flex-wrap: wrap; }
  /* flex-basis 仍旧定死 240px：这一排要不要换行只跟容器宽度有关，跟工作流名字长短无关
     （名字一长就把「生成」顶到第二行，是苏醒 Round 15 截图里那个毛病）。
     但多出来的宽度不再摊给胶囊——胶囊只包到名字那么宽（苏醒 Round 26：
     「工作流按钮右边空太多」——七个字的胶囊拉到三百像素宽，右边一大片空白）。 */
  /* 2026-10-30 用户点名：左边先跟正文那一列对齐——整排靠右时参数胶囊前面空出一截，读着像漏了一块。
     省下的宽度落在胶囊组与「生成」之间，那是这一行本来就该有的呼吸位；右边按钮组仍不参与压缩。 */
  .cm-foot-left { display: flex; align-items: center; justify-content: flex-start; gap: 10px; min-width: 0; flex: 1 1 240px; }
  /* min-width:0：flex 子项默认 min-width:auto，长名字会把这一格顶穿，压到右边的按钮上 */
  .cm-pop-wrap { position: relative; min-width: 0; }
  /* 工作流那一格跟着名字收缩；装不下时还是它先让（可压缩 + min-width:0，名字在胶囊里截断），
     全名在弹窗顶部标题和悬浮提示里都还在。弹层钉的是胶囊右边缘，右边缘没动，位置也就没动。 */
  .cm-foot-left > .cm-fill { flex: 0 1 auto; }
  .cm-fill .cm-pill { width: auto; max-width: 100%; }
  .cm-pill:disabled { opacity: .62; cursor: default; }
  /* 那圈圆角矩形撤了（2026-11-04 苏醒照图：「这几个按钮的圆角矩形框也不要。简洁大气」）：
     图标 + 名字 + 下拉箭头已经把「这是一颗能点的当前值」说完了，外面再套一圈框是重复表达。
     静止态完全透明，只在悬浮和展开时给一层极淡的底当反馈——radius 留着，那是反馈的形状不是框。
     左右内边距从 13 收到 10：没有框之后，间隔由 padding + gap 给，读起来还是三件事。 */
  .cm-pill { position: relative; z-index: 5; flex: 0 1 auto; min-width: 0; display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 10px; font-size: 12.5px; color: #d4d4d8; background: transparent; border: 0; border-radius: 999px; cursor: pointer; transition: background 140ms ease, color 140ms ease; }
  .cm-pill:hover:not(:disabled) { color: #fafafa; background: rgb(255 255 255 / 7%); }
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
  /* 「画面参数」这一层反过来贴胶囊右边缘往左长（2026-11-10 苏醒照图：「这个弹出菜单会被吃掉一些看不见」）。
     根因是这一排换了位置：两栏那一档它是最右边那颗，弹层却还照竖排时代贴左往右长。1731x1443 实测
     弹层 1065..1393，而面板内容右沿 1339 —— 右边 54px 被 .cm-panel 的 overflow 整条切掉（比例第 4 列、
     分辨率最后一档、自定义那个输入框正好在被切的那截里），顺带顶出 32px 横向滚动条。
     贴右长就回到右栏之内：那颗的右边缘本来就在栏内，328 < 右栏净宽 498。
     写两条类名是为了压过窄窗口那条 .cm-pop { width: min(328px, 78vw) }：锚点换了，封顶得跟着换来源。 */
  .cm-pop.cm-pop-params { left: auto; right: 0; width: min(328px, var(--cm-pop-left, 328px)); }
  .cm-pop-title { margin: 2px 0 0; font-size: 12.5px; color: #a1a1aa; }
  /* 弹层锚点跟着胶囊在这一排里的位置走。竖排之后这颗恒在底部那一排的最左边（先挑来源、再定参数），
     所以一律贴它左边缘往右长——贴右长会顶穿面板左边界。横排时代它贴着右栏的右边缘，才有 right:0 那条。
     1478×902 实测：本机屏 352..620、API 屏 352..804，面板内容框 351..1127；820/560 宽同样在框里。 */
  .cm-pop-wf { left: 0; right: auto; width: 268px; gap: 3px; }
  /* 「创作类型」那一层只有三行，收窄；行距与清单同一套，别做出第二种菜单。 */
  /* 宽度按内容收（2026-11-10 照图：行末那串数撤了以后 268 的右半页全是空的）。这层只有一族一名，
  max-content 就是「图标 + 四个字 + 勾」那么宽；留 152 的地板防止哪天名字更短时空成一格。 */
  .cm-pop-kind { left: 0; right: auto; width: max-content; min-width: 152px; max-width: 78vw; gap: 3px; padding: 8px; }
  .cm-kind-row { padding: 9px 10px; border-radius: 10px; }
  .cm-kind-icon { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 18px; color: #a1a1aa; }
  .cm-kind-check { flex: none; display: inline-flex; color: #e4e4e7; }
  /* 三颗里它最窄，也最不能截断——截成「图片生…」没人认得那是干什么的。让位的是工作流那颗的名字。 */
  .cm-pill-kind { flex: none; }
  /* 展开态：名字提亮 + 一层淡底。不再描边——静止态没有边，展开时凭空长出一圈边就是闪烁。 */
  .cm-pill-kind.is-on { color: #fff; background: rgb(255 255 255 / 9%); }
  /* API 那一屏要装两列（左列服务商 + 右列模型清单），宽度只在这一屏放开。
     别写 100%：这块弹层的包含块是那颗胶囊外面那一格（position:relative），100% = 胶囊那么宽。
     锚点从「贴左往右长」翻成「贴右往左长」（2026-11-11 苏醒照图：右边那列的模型名被截成
     「即梦 Seedr…」）：这颗胶囊在底部那一排的中间，贴左往右长只剩 389px 可用（1881px 宽的
     实拍量出来的），两列谁都吃不饱；往左长量到的是「胶囊那一格右沿 − 面板左内沿」，
     452px 这个设计宽度才真放得下。与「画面参数」那一层同一个法子，封顶只认实测值。 */
  .cm-pop-wf.is-api { left: auto; right: 0; width: min(452px, var(--cm-pop-wf-left, 452px)); max-height: min(58vh, 430px); }
  /* 本机那一屏那一列行。包一层是为了让 else 挂在外层 if 上（见模板那三条注释），所以行距自己守。 */
  .cm-pop-list { display: flex; flex-direction: column; gap: 3px; }
  /* 左列 140：装「图标 + 服务商名 + 箭头」够了（名字过长自己截断，全名在悬浮提示里）。
     原来是 172，多出来的宽度全给了右边那列的模型名（2026-11-11 苏醒：右边显示具体模型名称即可）。 */
  .cm-api { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 10px; min-height: 0; }
  .cm-api-side { display: flex; flex-direction: column; gap: 3px; min-width: 0; padding-right: 10px; border-right: 1px solid rgb(255 255 255 / 8%); }
  .cm-api-cap { margin: 2px 0 0; padding: 0 6px; font-size: 10.5px; color: #7f7f87; }
  /* 服务商那一行：图标方块 + 名字 + 右箭头（小字两行 2026-11-11 撤，见模板那条注释）。
     选中态走 aria-current，不走 aria-pressed——全局 .fill-interactions 会把 pressed 的按钮整颗刷成品牌红底黑字（0.2.34 那轮在设置页栽过一次）。 */
  .cm-api-vendor { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; text-align: left; color: #d4d4d8; background: transparent; border-radius: 10px; cursor: pointer; }
  .cm-api-vendor:hover, .cm-api-vendor[aria-current="true"] { color: #fafafa; background: rgb(255 255 255 / 7%); }
  .cm-api-vendor-mark { flex: none; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; color: #93c5fd; background: rgb(59 130 246 / 14%); }
  .cm-api-vendor-name { flex: 1; min-width: 0; font-size: 12.5px; }
  .cm-api-vendor-arrow { flex: none; display: inline-flex; color: #7f7f87; }
  /* 左下角那一格：族徽 + 当前那条的名字 + 挂在哪一家。顶边一条线把它和上面的清单分开。 */
  .cm-api-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; overflow: auto; }
  /* 模型名允许折两行：这一屏要的就是「用的哪个模型」，截成「即梦 Seedream v…」等于白改。
     两行是上限——再长就是后端那条 label 该收一收了，全名一直在悬浮提示里。 */
  .cm-api-model { align-items: flex-start; padding-top: 7px; padding-bottom: 7px; }
  .cm-api-model .cm-wf-kind { margin-top: 1px; }
  .cm-api-model .cm-wf-name { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; white-space: normal; overflow: hidden; line-height: 1.3; }
  .cm-api-model .cm-wf-tag { margin-top: 1px; }
  /* 行末三态：中性说的是「当前」，黄的是差一步配置，红的才是「没验过」。
     别把三态刷成同一个红——那等于把「还没验」和「还没配」说成一件事。 */
  .cm-wf-tag-warn { color: #fbbf24; background: rgb(245 158 11 / 16%); }
  .cm-wf-tag-ok { color: #4ade80; background: rgb(34 197 94 / 16%); }
  .cm-wf-tag-cur { color: #e4e4e7; background: rgb(255 255 255 / 12%); }
  /* 弹层顶部那两屏：像同一颗胶囊里的两段，选中那段提亮，不额外占一行标题 */
  .cm-pop-tabs { display: flex; gap: 4px; padding: 2px; margin-bottom: 2px; background: rgb(255 255 255 / 4%); border-radius: 10px; }
  .cm-pop-tab {
    flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
    padding: 5px 0; font-size: 12px; color: #a1a1aa; background: transparent; border-radius: 8px;
    transition: background-color 120ms ease, color 120ms ease;
  }
  .cm-pop-tab[aria-pressed="true"] { color: #fafafa; background: rgb(255 255 255 / 9%); }
  .cm-pop-tab-count { font-size: 10.5px; color: #f87171; background: rgb(242 78 78 / 16%); border-radius: 999px; padding: 0 6px; }
  .cm-pop-empty { margin: 2px 0; padding: 0 4px; font-size: 11.5px; color: #a1a1aa; }
  .cm-pop-sep { height: 1px; margin: 5px 0; background: rgb(255 255 255 / 8%); }
  .cm-wf { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; font-size: 12.5px; color: #d4d4d8; text-align: left; background: transparent; border-radius: 10px; cursor: pointer; }
  .cm-wf:hover:not(:disabled) { background: rgb(255 255 255 / 7%); color: #fafafa; }
  .cm-wf:disabled { opacity: .5; cursor: default; }
  .cm-wf-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cm-wf-tag { flex: none; padding: 1px 7px; font-size: 10.5px; color: #f87171; background: rgb(242 78 78 / 16%); border-radius: 999px; }
  /* 图片和视频的工作流排在同一份清单里，出片还是出图得一眼分得开（颜色之外还有字，不靠颜色独担信息）。 */
  /* 族徽定宽并钉在名字前面：宽度一致 + 位置固定，两行工作流的名称才在同一条竖线上。 */
  .cm-wf-kind { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 34px; padding: 1px 0; font-size: 10.5px; color: #93c5fd; background: rgb(59 130 246 / 14%); border-radius: 999px; }
  .cm-wf-lead { flex: none; display: flex; align-items: center; justify-content: center; width: 34px; }
  .cm-wf-kind-video { color: #fbbf24; background: rgb(245 158 11 / 16%); }
  .cm-wf-kind-audio { color: #c4b5fd; background: rgb(139 92 246 / 16%); }
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
  /* 内置音色那一格：40px 圆脸。选中时用品牌色描一圈，和顶上音频模式那三颗同一个色，
     不新造一套选中语言；未选中只留一层极淡的内描边，免得黑底头像看起来像没图。 */
  .cm-ratio-face { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: #2a2a2e; box-shadow: inset 0 0 0 1px rgb(255 255 255 / 12%); }
  .cm-ratio.is-on .cm-ratio-face { box-shadow: inset 0 0 0 2px rgb(242 78 78 / 85%), 0 0 0 1px rgb(0 0 0 / 45%); }
  /*
   * 音色那一格不拿底色当指示：用户是挨个点九个脸听音色的，每点一下换一块灰底，
   * 整块菜单像被刷花，也看不出到底在放谁。改成——选中 = 名字变品牌红 + 头像描一圈品牌色；
   * 正在试听 = 名字品牌红 + 头像右上角那三条窄条在跳。语种那一格照旧用灰底，
   * 那是一排字，没有脸可以描边。
   */
  .cm-ratio.is-voice,
  .cm-ratio.is-voice:hover,
  .cm-ratio.is-voice.is-on { background: transparent; }
  .cm-ratio.is-voice.is-on .cm-ratio-label,
  .cm-ratio.is-hearing .cm-ratio-label { color: #f24e4e; }
  .cm-ratio-face-wrap { position: relative; width: 40px; height: 40px; }
  .cm-voice-sample { display: none; }
  /* 右上角那三条：不要圆圈底，就是三根裸着的品牌红窄条压在头像右上角（用户给的那张图）。
     静置时从左到右 6/10/14px 一阶梯，跑起来各自绕底边缩放，错开相位就是波形。
     压到浅色头像上靠一层很淡的投影撑住，深底上看不出来。 */
  .cm-voice-eq { position: absolute; top: -1px; right: -5px; display: flex; align-items: flex-end; gap: 2px; height: 14px; filter: drop-shadow(0 1px 1.5px rgb(0 0 0 / 45%)); }
  .cm-voice-eq i { width: 3px; border-radius: 999px; background: #f24e4e; transform-origin: bottom center; animation: cm-voice-eq 900ms ease-in-out infinite; }
  .cm-voice-eq i:nth-child(1) { height: 6px; animation-delay: -300ms; }
  .cm-voice-eq i:nth-child(2) { height: 10px; animation-delay: -150ms; }
  .cm-voice-eq i:nth-child(3) { height: 14px; }
  @keyframes cm-voice-eq {
    0%, 100% { transform: scaleY(0.42); }
    50% { transform: scaleY(1); }
  }
  /* 关了动效的人听到的还是同一段声音，只是那三条不跳，停在 6/10/14 那一阶梯上。 */
  @media (prefers-reduced-motion: reduce) {
    .cm-voice-eq i { animation: none; }
  }

  .cm-pill-face { flex: none; width: 20px; height: 20px; border-radius: 50%; object-fit: cover; background: #2a2a2e; box-shadow: inset 0 0 0 1px rgb(255 255 255 / 14%); }
  .cm-seg { display: flex; flex-wrap: wrap; gap: 6px; }
  .cm-seg-item { min-width: 46px; height: 30px; padding: 0 10px; font-size: 12.5px; color: #b8b8bf; background: rgb(255 255 255 / 5%); border-radius: 8px; cursor: pointer; }
  .cm-seg-item:hover { background: rgb(255 255 255 / 9%); }
  .cm-seg-item.is-on { background: rgb(255 255 255 / 15%); color: #fafafa; font-weight: 600; }
  /* 音频模式那一排：三颗字都短，只加粗读不出选中。品牌色描一圈 + 压深底，与生成按钮同一套色。 */
  .cm-seg-mode.is-on { background: rgb(242 78 78 / 22%); color: #fff; box-shadow: inset 0 0 0 1px rgb(242 78 78 / 75%); }
  .cm-seg-mode.is-on:hover:not(:disabled) { background: rgb(242 78 78 / 30%); }
  .cm-seg-item:disabled { opacity: .55; cursor: default; }
  .cm-seg-item:hover:disabled { background: rgb(255 255 255 / 5%); }
  .cm-seg-item.is-on:hover:disabled { background: rgb(255 255 255 / 15%); }
  .cm-custom { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 11.5px; color: #7c7c84; }
  .cm-custom input { width: 92px; height: 28px; padding: 0 8px; font-size: 12.5px; color: #e4e4e7; background: rgba(0, 0, 0, 0.4); border: 1px solid rgb(255 255 255 / 9%); border-radius: 8px; }
  /* 时长滑块：细轨 + 圆 thumb + 已填段，跟图库工具栏那条列数滑块一个手感。 */
  .cm-slide { display: flex; align-items: center; gap: 10px; }
  .cm-slider { -webkit-appearance: none; appearance: none; flex: 1; min-width: 0; height: 4px; border-radius: 2px; outline: none; cursor: pointer;
    background: linear-gradient(to right,
      rgb(242 78 78) 0%, rgb(242 78 78) calc((var(--value) - var(--min)) * 100% / var(--span)),
      rgb(64 64 70) calc((var(--value) - var(--min)) * 100% / var(--span)), rgb(64 64 70) 100%); }
  .cm-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 15px; height: 15px; border-radius: 50%; background: #f4f4f5; border: 2px solid rgb(24 24 27); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(242, 78, 78, 0.45); cursor: grab; }
  .cm-slider:active::-webkit-slider-thumb { cursor: grabbing; }
  .cm-slider::-moz-range-thumb { width: 15px; height: 15px; border-radius: 50%; background: #f4f4f5; border: 2px solid rgb(24 24 27); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(242, 78, 78, 0.45); cursor: grab; }
  .cm-slider::-moz-range-track { height: 4px; border-radius: 2px; background: rgb(64 64 70); }
  .cm-slider:focus-visible::-webkit-slider-thumb { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.55), 0 0 0 4px rgba(242, 78, 78, 0.35); }
  .cm-slide-num { flex: none; width: 62px; height: 28px; padding: 0 8px; font-size: 12.5px; color: #e4e4e7; background: rgba(0, 0, 0, 0.4); border: 1px solid rgb(255 255 255 / 9%); border-radius: 8px; }
  .cm-slide-unit { flex: none; font-size: 12px; color: #8a8a8e; }

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
    主按钮收成一颗圆形，中间是品牌字标（2026-11-04 苏醒照图：「这个按钮做成圆形，用品牌图标」）。
    字标不另画一份矢量：走 /logo.png 的透明通道当 mask，和启动页、标题栏同一份资产，
    颜色由这颗按钮自己给（currentColor），换配色不用动图。
    文字撤了，可访问名与悬浮提示必须补上（见模板那颗的 aria-label / title）。
    生成要等十几秒到几十秒，按下去之后必须有东西在动：扫光继续扫，字标换成转圈。
  */
  .cm-go { position: relative; overflow: hidden; display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; padding: 0; color: #fff; background: linear-gradient(135deg, #ff6a4d, #f24e4e 46%, #d63b57); border: 0; border-radius: 50%; box-shadow: 0 6px 18px rgba(242, 78, 78, .26), inset 0 1px 0 rgba(255, 255, 255, .18); cursor: pointer; transition: transform 140ms ease, box-shadow 140ms ease, filter 140ms ease; }
  .cm-go:hover:not(:disabled) { filter: brightness(1.07); transform: translateY(-1px); box-shadow: 0 10px 26px rgba(242, 78, 78, .34), inset 0 1px 0 rgba(255, 255, 255, .22); }
  .cm-go:active:not(:disabled) { transform: translateY(0); filter: brightness(.97); }
  .cm-go:disabled { color: #6f6f78; background: #2a2a2e; box-shadow: none; cursor: default; transform: none; filter: none; }
  /* 生成中不能塌成一颗死灰的禁用键：还是同一颗 CTA，只是压暗 + 扫光 + 转圈，
     一眼看得懂「它在干活」，而不是「这个按钮坏了/不能点」。 */
  .cm-go.is-busy { color: #fff; cursor: progress; background: linear-gradient(135deg, #b3563f, #a03b3b 46%, #8b2f40); box-shadow: 0 4px 14px rgba(242, 78, 78, .16), inset 0 1px 0 rgba(255, 255, 255, .12); filter: none; transform: none; }
  /* 品牌字标：mask 只借 /logo.png 的透明通道，颜色是这颗按钮的字色。
     /logo.png 在 public/ 里（vite 不改绝对路径），SplashOverlay 的 mask 用的是同一支。 */
  .cm-go-mark { position: relative; flex: none; width: 21px; height: 21px; background: currentColor; -webkit-mask: url(/logo.png) center / contain no-repeat; mask: url(/logo.png) center / contain no-repeat; }
  .cm-go:disabled .cm-go-mark { color: #57575f; }
  .cm-go-shine { position: absolute; inset: 0; transform: translateX(-105%); background: linear-gradient(100deg, transparent 22%, rgba(255, 255, 255, .34) 50%, transparent 78%); pointer-events: none; }
  .cm-go.is-busy .cm-go-shine { animation: cm-sweep 1.45s linear infinite; }
  /* 转圈那一条：圆里同一时刻只许有一个东西，所以生成中把字标藏掉、这一颗绝对居中。
     display:none 那条被测试钉着（真机上它把居中的字标顶偏过），别改写法。 */
  .cm-go-dot { position: absolute; left: 50%; top: 50%; flex: none; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; background: radial-gradient(circle at 34% 32%, #fff, rgba(255, 255, 255, .35)); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .4); }
  .cm-go:not(.is-busy) .cm-go-dot { display: none; }
  .cm-go.is-busy .cm-go-mark { visibility: hidden; }
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
  /* 卡底那排「本次产出」缩略图连同这几条样式一起撤了：刚出来的那一份现在直接摆在顶上那一格，
     视频与音频的角标跟着搬过去（.cm-hero-out-play）。 */

  @media (max-width: 900px) {
    /* 只换竖排那一档：两栏那条 .cm-body:not(.is-stacked) 特异性高一级，本来就不受这条影响。
     窄窗口也走不到两栏——面板最多 vw-84，够不着 980 那道门槛，走的就是这一档。 */
  .cm-body { --cm-hero-h: min(34vh, 360px); }
    .cm-stage { width: min(100%, 480px); }
    .cm-pop { width: min(328px, 78vw); }
    .cm-pop-wf { width: min(268px, 78vw); }
  .cm-pop-kind { width: max-content; }
    /* 窄窗口这一屏不放两列。这一档的面板内容宽只有 vw-84，而弹层现在贴着胶囊左边缘往右长，
       452px 撑出去就是顶穿右边界（538px 实测过）。所以窄窗口沿用量过的 268px 那一档，
       两列改成上下叠：服务商在上、模型清单在下，一样能挑，只是不再左右两栏。 */
    /* 窄窗口这一档锚点退回贴左：竖排之后这颗在底部那一排的最左边，往左长会顶穿面板左边界。 */
    .cm-pop-wf.is-api { left: 0; right: auto; width: min(268px, 78vw); }
    .cm-api { grid-template-columns: minmax(0, 1fr); gap: 6px; }
    .cm-api-side { padding-right: 0; padding-bottom: 5px; border-right: 0; border-bottom: 1px solid rgb(255 255 255 / 8%); }
  }

  /* 窗口一矮（笔记本、半屏）就给预览图砍一档：素材在 composer 里还有小图可认，顶部那张大图只是参照。
     不砍的话 1478x562 实测整弹窗 573 > 可视 504，钉住的坞直接压在输入区上面，得往下滚才看得见光标。
     放在 max-width 那条之后：又矮又窄时按矮处理。 */
  @media (max-height: 720px) {
    /* 同上：只换竖排那一档。154px 是等待台中间那张卡量出来的最低可用高度。
     两栏那一档不受这条影响：它的值自己带 240px 的地板。 */
  .cm-body { --cm-hero-h: max(154px, 19vh); }
    .cm-stage-card { gap: 7px; padding: 14px 18px; }
    .cm-stage-bar { width: 168px; }
    .cm-hero-wave { height: clamp(64px, 12vh, 96px); }
    .cm-hero-empty { min-height: 96px; }
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
