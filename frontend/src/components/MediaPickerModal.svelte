<script lang="ts">
  /**
   * 从图库里挑一份素材（一键同款的参考位替换用）。
   *
   * 默认只列图片：图片一键同款的参考位最终要喂给 ComfyUI 的 LoadImage，别的族在那儿没有意义。
   * 视频工作流有三族参考位，调用方传 kind="audio" / "video"，这里就换成列音频 / 列视频，
   * 免得用户在一片画面里翻那几条 mp3。
   * 卡片复用 app.css 的 .media-card 规范；画面框按每份素材自己的宽高比排，
   * 配合 .media-card-img 的 object-fit，保证不按扁、不拉伸（固定 4:3 会把竖图挤变形）。
   */
  import { get } from "svelte/store";
  import { audioApi, imagesApi } from "../lib/api";
  import { backendUrl } from "../lib/backend-url";
  import { hoverPlay } from "../lib/hover-play";
  import { playAudio, playingAudio, stopAudio } from "../lib/stores";
  import { pushToast } from "../lib/toast";
  import { basenameOnly, splitIntoColumns, thumbnailAspectRatio, thumbnailHeightToWidthRatio, thumbnailObjectFit } from "../lib/media-format";
  import { cloneError, REF_DISPLAY_ORDER, REF_KIND_COUNTERS, REF_KIND_NAMES, type RefKind } from "../lib/clone";
  import type { ImageSummary, MediaFeedItem } from "../lib/types";

  interface Props {
    open: boolean;
    /** 弹窗标题。不传就按当前那一族自己拼一句（选一张 / 选一段 / 选一条）。 */
    title?: string;
    /** 初始族，也是唯一族：图片一键同款只给 image，版面上就跟以前一模一样。 */
    kind?: RefKind;
    /**
     * 能挑哪几族。参考区合成一行之后，那颗「+ 参考」不绑族，调用方把还有空位的族一起给进来，
     * 顶部出图片/视频/音频 tab；点某一格的「替换」时只给那一族，tab 不出现、标题也不动。
     */
    kinds?: RefKind[];
    /** 第二个参数是挑中那一族：调用方靠它决定落进哪一族的第一个空位。 */
    onPick: (image: ImageSummary, kind: RefKind) => void;
    onClose: () => void;
  }
  let { open, title = "", kind = "image", kinds = [], onPick, onClose }: Props = $props();

  /** 能挑的族：没给 kinds 就只用 kind。顺序跟参考区那一行同一个口径（REF_DISPLAY_ORDER）。 */
  const allowed = $derived(REF_DISPLAY_ORDER.filter((one) => (kinds.length ? kinds : [kind]).includes(one)));
  /** 用户点的 tab；没点过就跟着调用方给的族走——换目标格时那个 prop 会变。 */
  let tab = $state<RefKind | null>(null);
  // 不在可选族里的 tab 一律不算数：工作流从三族换成只有一族时，上次点到的 tab 还留在状态里，
  // 让它继续决定列表就会出现「标题写着选一张图、里面全是 flac」。
  const activeKind = $derived(tab !== null && allowed.includes(tab) ? tab : kind);
  // 称呼与量词都取自 clone 里那份共用的表：参考区那一行与这里的说法必须一字不差
  const noun = $derived(REF_KIND_NAMES[activeKind]);
  const counter = $derived(REF_KIND_COUNTERS[activeKind]);
  const heading = $derived(title || `从图库选一${counter}${noun}`);

  const PAGE = 60;
  let query = $state("");
  let items = $state<ImageSummary[]>([]);
  let total = $state(0);
  let loaded = $state(0);
  let loading = $state(false);
  let error = $state("");
  /** 鼠标滑过哪一张：只有这一张挂进 <video>，一屏同时解码一条视频就够 GPU 受了。 */
  let hoveredId = $state<number | null>(null);
  /** 在这个弹窗里点开的试听是哪条：只有它是我们自己起的，关弹窗时才轮到我们停它。 */
  let previewAudioId: number | null = null;

  /**
   * 音频卡上的试听角标：点一下试听、再点停，跟图库里音频卡一个行为。
   * 解不了的容器不假装能播，交给系统播放器（与 Feed 的 toggleAudio 同一口径）。
   */
  async function toggleAudio(it: ImageSummary) {
    if (get(playingAudio)?.id === it.id) {
      stopAudio();
      if (previewAudioId === it.id) previewAudioId = null;
      return;
    }
    if (it.playable === false) {
      try {
        await audioApi.open(it.id);
        pushToast("这个容器无法内嵌播放，已用系统播放器打开");
      } catch (e) {
        error = cloneError(e);
      }
      return;
    }
    previewAudioId = it.id;
    playAudio({ ...it, item_type: "media" } as MediaFeedItem);
  }

  /** 关掉选择器就把这里的试听停掉：不能让人带着一段不知道哪儿在响的音频回到图库。 */
  function stopPreviewAudio() {
    if (previewAudioId !== null && get(playingAudio)?.id === previewAudioId) stopAudio();
    previewAudioId = null;
  }

  /**
   * 手动分列而不是 CSS grid：grid 的行高由这一行最高的卡决定，等比例缩略图竖横混排时
   * 同行那张矮卡下面会空出一大块。按「当前最矮的一列」投放之后，每列自己往下堆，没有行。
   */
  let viewportWidth = $state(1200);
  /** 列数：0＝跟着弹窗宽度走；用户拖过滑块就以他给的为准——窄列一屏看更多张，这不该由 app 替他定。 */
  let manualCols = $state(0);
  const columnCount = $derived(manualCols || (viewportWidth < 900 ? 3 : 4));
  const columns = $derived(
    splitIntoColumns(items, columnCount, (item) =>
      thumbnailHeightToWidthRatio(item.filename, item.kind, item.width, item.height),
    ),
  );

  async function load(append = false) {
    loading = true;
    error = "";
    try {
      const offset = append ? loaded : 0;
      const res = await imagesApi.list({ kind: activeKind, q: query.trim() || undefined, limit: PAGE, offset });
      items = append ? [...items, ...res.items] : res.items;
      total = res.total;
      loaded = offset + res.items.length;
    } catch (e) {
      error = cloneError(e);
    } finally {
      loading = false;
    }
  }

  /**
   * 每次打开都回到调用方指定的那一族。组件关闭后不销毁，tab 是组件内状态，
   * 所以在视频工作流里挑过音频/视频之后，切回图片工作流再开选择器会停在那一族。
   * 声明在「读列表」那条 effect 之前，免得先按上一族白读一次。
   */
  $effect(() => {
    const target = kind;
    const list = allowed;
    if (!open) {
      tab = null;
      return;
    }
    tab = list.includes(target) ? null : (list[0] ?? null);
  });

  $effect(() => {
    if (!open) return;
    // 换一族＝换一批素材：换目标格（prop kind 变）或在顶部 tab 之间切换，列表都得跟着重读。
    void activeKind;
    query = "";
    hoveredId = null;
    stopPreviewAudio();
    void load();
  });

  // 关弹窗（选完、Esc、点外面）：把这里起的试听收掉。试听是临时的，选完不该还在响。
  $effect(() => {
    if (open) return;
    stopPreviewAudio();
  });

  function onKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKey} bind:innerWidth={viewportWidth} />

{#if open}
  <div class="mp-backdrop" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="mp-panel" role="dialog" aria-modal="true" aria-label={heading}>
      <div class="mp-head">
        <h3>{heading}</h3>
        {#if allowed.length > 1}
          <!-- 参考区合成一行之后，加素材只有一颗「+ 参考」：先在这儿挑族，选到哪族落哪族。 -->
          <div class="mp-tabs" role="group" aria-label="素材类型">
            {#each allowed as tabKind (tabKind)}
              <button class="mp-tab" aria-pressed={tabKind === activeKind} onclick={() => (tab = tabKind)}>
                {REF_KIND_NAMES[tabKind]}
              </button>
            {/each}
          </div>
        {/if}
        <input
          type="search"
          class="mp-search"
          aria-label="搜索图库素材"
          placeholder="搜索图库素材"
          bind:value={query}
          onkeydown={(e) => { if (e.key === "Enter") void load(); }}
        />
        <button class="mp-btn" onclick={() => void load()}>搜索</button>
        <label class="mp-cols" title="缩略图排几列">
          <span>列数</span>
          <input
            type="range"
            class="mp-slider"
            min="2"
            max="8"
            step="1"
            value={columnCount}
            style="--value: {columnCount}"
            oninput={(e) => (manualCols = Number((e.target as HTMLInputElement).value))}
            aria-label="列数"
          />
          <span class="mp-cols-num">{columnCount}</span>
        </label>
      </div>
      {#if error}<p class="mp-note" role="status">{error}</p>{/if}
      {#if !loading && items.length === 0}
        <p class="mp-note" role="status">没有可选的{noun}。先把{noun}拖进图库，或直接把{noun}拖到这个弹窗里。</p>
      {/if}
      <div class="media-pick-grid mp-grid">
        {#each columns as column, index (index)}
          <div class="mp-col">
            {#each column as picked (picked.id)}
              <button
                class="media-card mp-card"
                title={picked.filename}
                aria-label={picked.filename}
                onmouseenter={() => (hoveredId = picked.id)}
                onmouseleave={() => { if (hoveredId === picked.id) hoveredId = null; }}
                onclick={() => { onPick(picked, activeKind); onClose(); }}
              >
                <span class="media-card-media" style="aspect-ratio: {thumbnailAspectRatio(picked.filename, picked.kind, picked.width, picked.height)};">
                  {#if picked.thumbnail_url || picked.original_url}
                    <img class="media-card-img" class:object-cover={thumbnailObjectFit(picked.filename) === "cover"} class:object-contain={thumbnailObjectFit(picked.filename) === "contain"} src={backendUrl(picked.thumbnail_url || picked.original_url!)} alt="" loading="lazy" decoding="async" onload={(e) => e.currentTarget.classList.add("is-loaded")} />
                  {/if}
                  {#if picked.kind === "video" && picked.playable && hoveredId === picked.id}
                    <!-- 滑过就自己动起来：不用点进播放器才知道这条视频是什么画面（与图库卡片同一套）。 -->
                    <video
                      class="media-card-video"
                      src={picked.play_url ? backendUrl(picked.play_url) : undefined}
                      muted
                      loop
                      autoplay
                      playsinline
                      tabindex="-1"
                      aria-hidden="true"
                      use:hoverPlay
                    ></video>
                  {/if}
                </span>
                <span class="media-card-footer media-card-footer--1l" class:mp-footer-audio={picked.kind === "audio"}>
                  <span class="media-card-name">{basenameOnly(picked.filename)}</span>
                  {#if picked.kind === "audio"}
                    <!-- 试听角标不能抢卡片点击：点它是试听，点别处才是选它。
                         它跟文件名同一行、同一条中线——钉在画面框下沿时会压在波形上，
                         看起来像浮错了地方，和右边的文字各站一头。 -->
                    <span
                      role="button"
                      tabindex="-1"
                      class="mp-audio-btn"
                      title={$playingAudio?.id === picked.id ? "暂停音频" : "播放音频"}
                      aria-label={($playingAudio?.id === picked.id ? "暂停 " : "播放 ") + picked.filename}
                      onclick={(e) => { e.stopPropagation(); e.preventDefault(); void toggleAudio(picked); }}
                      onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); void toggleAudio(picked); } }}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true" class="mp-audio-icon">
                        <circle cx="12" cy="12" r="9.2" fill="rgba(0,0,0,0.34)" stroke="#fff" stroke-width="1.25" />
                        {#if $playingAudio?.id === picked.id}
                          <path d="M9.9 8.4v7.2M14.1 8.4v7.2" stroke="#fff" stroke-width="2" stroke-linecap="round" />
                        {:else}
                          <path d="M9.7 7.9 16.4 12 9.7 16.1 Z" fill="#fff" stroke="#fff" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round" />
                        {/if}
                      </svg>
                    </span>
                  {/if}
                </span>
              </button>
            {/each}
          </div>
        {/each}
      </div>
      {#if loaded < total}
        <button class="mp-btn mp-more" disabled={loading} onclick={() => void load(true)}>
          {loading ? "加载中…" : `加载更多（还有 ${total - loaded} ${counter}）`}
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .mp-backdrop { position: fixed; inset: 0; z-index: 70; background: rgba(0, 0, 0, 0.5); -webkit-backdrop-filter: blur(20px) saturate(110%); backdrop-filter: blur(20px) saturate(110%); display: flex; align-items: center; justify-content: center; padding: 16px; }
  .mp-panel { width: min(1040px, 100%); max-height: 84vh; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 18px; border: 1px solid rgb(255 255 255 / 8%); border-radius: 16px; background: rgba(20 20 23 / 88%); -webkit-backdrop-filter: blur(34px); backdrop-filter: blur(34px); box-shadow: 0 30px 90px rgba(0, 0, 0, 0.6); color: #e4e4e7; }
  /* 标题 + 三族 tab + 搜索 + 列数滑块挤在一行：窄窗口里宁可整块换行，也别把「图片」掰成竖排两个字。 */
  .mp-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .mp-head h3 { margin: 0; font-size: 15px; font-weight: 600; }
  /* 族 tab 只在能挑几族时出现：图片一键同款仍是原来那颗干净的标题行。 */
  .mp-tabs { display: flex; align-items: center; gap: 2px; padding: 2px; border: 1px solid #26262b; border-radius: 10px; background: #101013; }
  .mp-tab { flex: none; white-space: nowrap; height: 26px; padding: 0 10px; font-size: 12.5px; color: #a1a1aa; background: transparent; border-radius: 8px; cursor: pointer; transition: background-color 140ms ease, color 140ms ease; }
  .mp-tab:hover { color: #e4e4e7; }
  .mp-tab[aria-pressed="true"] { color: #fafafa; background: #303036; }
  .mp-search { flex: 1; min-width: 0; height: 32px; padding: 0 10px; font-size: 13px; color: #e4e4e7; background: #101013; border: 1px solid #2b2b30; border-radius: 8px; }
  /* 列数滑块：照抄图库工具栏那条（细轨 + 圆 thumb + 已填段），两处手势一个手感。 */
  .mp-cols { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: #8a8a8e; white-space: nowrap; }
  .mp-cols-num { min-width: 12px; text-align: right; color: #d4d4d8; font-variant-numeric: tabular-nums; }
  .mp-slider { -webkit-appearance: none; appearance: none; width: 72px; height: 4px; border-radius: 2px; outline: none; cursor: pointer;
    background: linear-gradient(to right,
      rgb(242 78 78) 0%, rgb(242 78 78) calc((var(--value) - 2) * 100% / 6),
      rgb(50 50 55) calc((var(--value) - 2) * 100% / 6), rgb(50 50 55) 100%); }
  .mp-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 14px; height: 14px; border-radius: 50%; background: rgb(242 78 78); border: 2px solid rgb(24 24 27); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(242, 78, 78, 0.4); cursor: grab; }
  .mp-slider::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: rgb(242 78 78); border: 2px solid rgb(24 24 27); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(242, 78, 78, 0.4); cursor: grab; }
  .mp-slider::-moz-range-track { height: 4px; border-radius: 2px; background: rgb(50 50 55); }
  .mp-search:focus { border-color: #3f3f46; outline: none; }
  /* 音频卡的页脚排成一行：文件名占满余下宽度（该省略号还是省略号），角标钉在最右，
     两者共用这条 26px 行的中线。全局 .media-card-footer 是 column，这里换成 row。 */
  .mp-footer-audio { flex-direction: row; align-items: center; gap: 6px; }
  .mp-footer-audio .media-card-name { flex: 1 1 auto; }
  /* 角标不再 absolute：它现在就是这一行的第二个成员，跟着文字垂直居中，不再浮在波形上。 */
  .mp-audio-btn { flex: none; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .mp-audio-icon { width: 100%; height: 100%; opacity: 0.92; transition: transform 140ms ease, opacity 140ms ease; }
  .mp-audio-btn:hover .mp-audio-icon, .mp-audio-btn:focus-visible .mp-audio-icon { opacity: 1; transform: scale(1.06); }
  .mp-btn { height: 32px; padding: 0 12px; font-size: 12.5px; color: #e4e4e7; background: #27272a; border: 1px solid #303036; border-radius: 8px; cursor: pointer; }
  .mp-btn:hover:not(:disabled) { border-color: #4b4b52; }
  .mp-btn:disabled { opacity: .55; cursor: default; }
  .mp-more { align-self: center; }
  .mp-note { margin: 0; font-size: 12.5px; color: #8a8a8e; }
  /* 分列容器：覆盖全局 .media-pick-grid 的 grid，列内自己往下堆。
     align-items 必须是 flex-start：stretch 会把每一列硬拉到容器高度，列里的卡片
     作为 flex item 就被压扁（overflow:hidden 顺手把文件名那一条也裁没了）。 */
  .mp-grid { display: flex; align-items: flex-start; gap: 12px; margin: 0;
    /* 全局 .media-pick-grid 的 max-height:480px 是给小弹窗用的：在这个弹窗里它把缩略图
       压成一条 480px 的窄带，一屏只看得见四张，等于逼用户滚。这里按弹窗自己的高度撑开。 */
    max-height: calc(84vh - 168px); overflow: auto; }
  .mp-col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
  .mp-col > .mp-card { flex: none; }
  .mp-card { border: 0; padding: 0; margin: 0; color: inherit; background: var(--thumb-bg); }
  /* 选择器里不做悬停放大：图已经是不裁切的等比例框，再放大就变成裁切，看着像变形。 */
  .mp-card:hover .media-card-img { transform: none; }
</style>