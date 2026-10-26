<script lang="ts">
  /**
   * 全应用唯一的音频播放实例。
   *
   * 界面上没有待机播放条 —— 控件在音频卡本身（点缩略图播放 / 再点暂停，卡片顶部画进度线），
   * 这里只留一个不显示的 <audio>：playingAudio 变就换源播放，置空就停，
   * 进度写回 audioProgress。切口径或卸载时一定停，免得声音跟着跑到别的页面去。
   */
  import { onDestroy } from "svelte";
  import { backendUrl } from "../lib/backend-url";
  import { pushToast } from "../lib/toast";
  import { audioProgress, playingAudio, scope, stopAudio } from "../lib/stores";

  let audioEl: HTMLAudioElement | undefined = $state();

  const src = $derived($playingAudio ? backendUrl($playingAudio.play_url || $playingAudio.original_url || "") : "");

  // 换口径时音频卡已经不在屏幕上了，留着声音就没有任何控件能停它
  $effect(() => {
    void $scope;
    stopAudio();
  });

  $effect(() => {
    const el = audioEl;
    const url = src;
    if (!el) return;
    if (!url) { el.pause(); return; }
    if (el.getAttribute("src") !== url) el.setAttribute("src", url);
    void el.play().catch(() => {
      pushToast("浏览器内核无法解码这个音频，请用系统播放器打开", { kind: "error" });
      stopAudio();
    });
  });

  onDestroy(() => audioEl?.pause());
</script>

<!-- svelte-ignore a11y_media_has_caption -->
<audio
  bind:this={audioEl}
  class="audio-engine"
  preload="none"
  ontimeupdate={(e) => audioProgress.set((e.currentTarget as HTMLAudioElement).currentTime)}
  onended={() => stopAudio()}
></audio>

<style>
  .audio-engine { display: none; }
</style>
