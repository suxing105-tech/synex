<script lang="ts">
  /**
   * 从图库里挑一张图（一键同款的参考位替换用）。
   *
   * 只列图片：参考位最终要喂给 ComfyUI 的 LoadImage，视频/音频在那儿没有意义。
   * 卡片复用 app.css 的 .media-card 规范；画面框按每张图片自己的宽高比排，
   * 配合 .media-card-img 的 object-fit，保证不按扁、不拉伸（固定 4:3 会把竖图挤变形）。
   */
  import { imagesApi } from "../lib/api";
  import { backendUrl } from "../lib/backend-url";
  import { basenameOnly, splitIntoColumns, thumbnailAspectRatio, thumbnailHeightToWidthRatio, thumbnailObjectFit } from "../lib/media-format";
  import { cloneError } from "../lib/clone";
  import type { ImageSummary } from "../lib/types";

  interface Props {
    open: boolean;
    title?: string;
    onPick: (image: ImageSummary) => void;
    onClose: () => void;
  }
  let { open, title = "从图库选一张", onPick, onClose }: Props = $props();

  const PAGE = 60;
  let query = $state("");
  let items = $state<ImageSummary[]>([]);
  let total = $state(0);
  let loaded = $state(0);
  let loading = $state(false);
  let error = $state("");

  /**
   * 手动分列而不是 CSS grid：grid 的行高由这一行最高的卡决定，等比例缩略图竖横混排时
   * 同行那张矮卡下面会空出一大块。按「当前最矮的一列」投放之后，每列自己往下堆，没有行。
   */
  let viewportWidth = $state(1200);
  const columnCount = $derived(viewportWidth < 900 ? 3 : 4);
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
      const res = await imagesApi.list({ kind: "image", q: query.trim() || undefined, limit: PAGE, offset });
      items = append ? [...items, ...res.items] : res.items;
      total = res.total;
      loaded = offset + res.items.length;
    } catch (e) {
      error = cloneError(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (!open) return;
    query = "";
    void load();
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
    <div class="mp-panel" role="dialog" aria-modal="true" aria-label={title}>
      <div class="mp-head">
        <h3>{title}</h3>
        <input
          type="search"
          class="mp-search"
          aria-label="搜索图库素材"
          placeholder="搜索图库素材"
          bind:value={query}
          onkeydown={(e) => { if (e.key === "Enter") void load(); }}
        />
        <button class="mp-btn" onclick={() => void load()}>搜索</button>
      </div>
      {#if error}<p class="mp-note" role="status">{error}</p>{/if}
      {#if !loading && items.length === 0}
        <p class="mp-note" role="status">没有可选的图片。先把素材拖进图库，或直接把图片拖到这个弹窗里。</p>
      {/if}
      <div class="media-pick-grid mp-grid">
        {#each columns as column, index (index)}
          <div class="mp-col">
            {#each column as picked (picked.id)}
              <button class="media-card mp-card" title={picked.filename} aria-label={picked.filename} onclick={() => { onPick(picked); onClose(); }}>
                <span class="media-card-media" style="aspect-ratio: {thumbnailAspectRatio(picked.filename, picked.kind, picked.width, picked.height)};">
                  {#if picked.thumbnail_url || picked.original_url}
                    <img class="media-card-img" class:object-cover={thumbnailObjectFit(picked.filename) === "cover"} class:object-contain={thumbnailObjectFit(picked.filename) === "contain"} src={backendUrl(picked.thumbnail_url || picked.original_url!)} alt="" loading="lazy" decoding="async" onload={(e) => e.currentTarget.classList.add("is-loaded")} />
                  {/if}
                </span>
                <span class="media-card-footer media-card-footer--1l"><span class="media-card-name">{basenameOnly(picked.filename)}</span></span>
              </button>
            {/each}
          </div>
        {/each}
      </div>
      {#if loaded < total}
        <button class="mp-btn mp-more" disabled={loading} onclick={() => void load(true)}>
          {loading ? "加载中…" : `加载更多（还有 ${total - loaded} 张）`}
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .mp-backdrop { position: fixed; inset: 0; z-index: 70; background: rgba(0, 0, 0, 0.5); -webkit-backdrop-filter: blur(20px) saturate(110%); backdrop-filter: blur(20px) saturate(110%); display: flex; align-items: center; justify-content: center; padding: 16px; }
  .mp-panel { width: min(1040px, 100%); max-height: 84vh; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 18px; border: 1px solid rgb(255 255 255 / 8%); border-radius: 16px; background: rgba(20 20 23 / 88%); -webkit-backdrop-filter: blur(34px); backdrop-filter: blur(34px); box-shadow: 0 30px 90px rgba(0, 0, 0, 0.6); color: #e4e4e7; }
  .mp-head { display: flex; align-items: center; gap: 10px; }
  .mp-head h3 { margin: 0; font-size: 15px; font-weight: 600; }
  .mp-search { flex: 1; height: 32px; padding: 0 10px; font-size: 13px; color: #e4e4e7; background: #101013; border: 1px solid #2b2b30; border-radius: 8px; }
  .mp-search:focus { border-color: #3f3f46; outline: none; }
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