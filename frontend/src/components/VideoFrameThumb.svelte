<script lang="ts">
  // 提示词里 @图片 1 / <Picture 1> 指的那一张：从后端读缓存好的段首/末帧，就地复制与下载。
  import { onMount } from "svelte";
  import { errorMessage } from "../lib/reverse-prompts";
  import { copyDataUrlImage, dataUrlToBlob, downloadBlob } from "../lib/image-clipboard";
  import { videoPromptApi, wholeSecond } from "../lib/video-prompts";
  import type { FrameEdge } from "../lib/video-prompts";
  import { pushToast } from "../lib/toast";

  let { videoId, runId, index, edge, at, usage, fileBase }: {
    videoId: number; runId: number; index: number; edge: FrameEdge;
    at: number; usage: string; fileBase: string;
  } = $props();

  let frame = $state("");
  let phase = $state<"loading" | "ready" | "error">("loading");
  let error = $state("");
  let zoomed = $state(false);

  const tag = $derived(`P${String(index).padStart(2, "0")}`);
  const title = $derived(`${tag} ${edge === "first" ? "首帧" : "末帧"}`);
  const filename = $derived(`${fileBase}-${tag}-${edge}.jpg`);
  /** 秒数一律整数显示：取帧的实际时刻可能带毫秒，但界面上只写整秒。 */
  const atText = $derived(`@${wholeSecond(at)} 秒`);

  async function load() {
    phase = "loading"; error = "";
    try {
      frame = (await videoPromptApi.referenceFrame(videoId, runId, index, edge)).data_url;
      phase = "ready";
    } catch (e) { error = errorMessage(e); phase = "error"; }
  }
  onMount(() => { void load(); });

  async function copy() {
    try { await copyDataUrlImage(frame); pushToast(`${title}已复制`, { kind: "success" }); }
    catch (e) { pushToast(errorMessage(e), { kind: "error" }); }
  }
  function save() {
    try { downloadBlob(dataUrlToBlob(frame), filename); pushToast(`已存为 ${filename}`); }
    catch (e) { pushToast(errorMessage(e), { kind: "error" }); }
  }
</script>

<figure class="vt-frame" aria-label="{title} 参考帧">
  {#if phase === "ready"}
    <button class="vt-thumb" title="点击放大" aria-label="放大 {title}" onclick={() => zoomed = !zoomed}>
      <img src={frame} alt="{title} 参考帧" class:zoomed draggable="false" />
    </button>
    <figcaption class="vt-caption">
      <span class="vt-meta">{atText} · {usage}</span>
      <span class="vt-actions">
        <button class="vt-button" aria-label="复制{title}" onclick={copy}>复制图</button>
        <button class="vt-button" aria-label="下载{title}" onclick={save}>存为 jpg</button>
      </span>
    </figcaption>
  {:else if phase === "error"}
    <div class="vt-thumb vt-empty">取帧失败</div>
    <figcaption class="vt-caption">
      <span class="vt-meta vt-danger">{error}</span>
      <span class="vt-actions"><button class="vt-button" onclick={load}>重试取帧</button></span>
    </figcaption>
  {:else}
    <div class="vt-thumb vt-empty">取帧中…</div>
    <figcaption class="vt-caption"><span class="vt-meta">{atText} · {usage}</span></figcaption>
  {/if}
</figure>

<style>
  .vt-frame { margin: 0; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .vt-thumb {
    padding: 0; border: 1px solid #3f3f46; border-radius: 5px; overflow: hidden;
    background: #121215; width: 132px; height: 92px; cursor: zoom-in;
  }
  .vt-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .vt-thumb img.zoomed { object-fit: contain; background: #000; }
  .vt-empty {
    display: flex; align-items: center; justify-content: center;
    font-size: 10px; color: #71717a; cursor: default;
  }
  .vt-caption { display: flex; flex-direction: column; gap: 3px; }
  .vt-meta { font-size: 10px; color: #a1a1aa; }
  .vt-danger { color: #f87171; }
  .vt-actions { display: flex; gap: 4px; flex-wrap: wrap; }
  .vt-button {
    font-size: 10px; padding: 3px 6px; border: 1px solid #3f3f46; border-radius: 5px; background: #202024;
  }
</style>
