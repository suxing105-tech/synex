<script lang="ts">
  import { backendUrl } from "../lib/backend-url";
  import { videosApi } from "../lib/api";
  import { pushToast } from "../lib/toast";
  import Icon from "./Icon.svelte";
  import type { ImageDetail } from "../lib/types";

  interface Props {
    open: boolean;
    video: ImageDetail | null;
    onCoverChange?: () => void;
  }
  let { open = $bindable(false), video = $bindable<ImageDetail | null>(null), onCoverChange = () => {} }: Props = $props();

  let videoEl = $state<HTMLVideoElement | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let saving = $state(false);

  function close(): void {
    open = false;
  }

  async function run(fn: () => Promise<unknown>, okMsg: string): Promise<void> {
    if (saving) return;
    saving = true;
    try {
      await fn();
      pushToast(okMsg, { kind: "success" });
      onCoverChange();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      pushToast(m.replace(/^.*→ \d+: /, ""), { kind: "error" });
    } finally {
      saving = false;
    }
  }

  async function setFrame(): Promise<void> {
    if (!video) return;
    const t = videoEl?.currentTime ?? 0;
    await run(() => videosApi.setCover(video.id, t), "已将当前帧设为封面");
  }

  async function reset(): Promise<void> {
    if (!video) return;
    await run(() => videosApi.resetCover(video.id), "已恢复默认封面");
  }

  function upload(): void {
    fileInput?.click();
  }

  async function onFile(e: Event): Promise<void> {
    if (!video) return;
    const target = e.currentTarget as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;
    await run(() => videosApi.uploadCover(video.id, file), "已上传自定义封面");
    target.value = "";
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }}
/>

{#if open && video}
  <div class="fixed inset-0 z-[110] bg-black/85 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="修改视频封面">
    <div class="w-full max-w-[640px] bg-surface-2 border border-border rounded-lg shadow-2xl overflow-hidden">
      <header class="flex items-center justify-between px-4 py-3 border-b border-border">
        <div class="flex items-center gap-2">
          <Icon name="video" size={16} />
          <span class="text-[13px] font-medium">修改视频封面</span>
        </div>
        <button
          type="button"
          class="p-1.5 rounded-md hover:bg-surface-3 focus:outline-none focus:border-accent transition-colors"
          title="关闭 (Esc)"
          aria-label="关闭"
          onclick={close}
        >
          <Icon name="x" size={16} />
        </button>
      </header>

      <div class="p-4 space-y-4">
        <div class="bg-black rounded-md overflow-hidden">
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            bind:this={videoEl}
            src={video.play_url ? backendUrl(video.play_url) : undefined}
            controls
            playsinline
            preload="metadata"
            class="w-full max-h-[52vh] bg-black"
          >
            <span>你的浏览器不支持播放视频。</span>
          </video>
        </div>

        <div class="text-[12px] text-muted">
          拖动进度到想要作为封面的画面，然后点击「设为封面」；也可以上传一张图片作为封面。
        </div>

        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="flex-1 min-w-[160px] px-3 py-2 rounded-md bg-accent text-bg text-[13px] font-medium hover:opacity-90 disabled:opacity-50"
            disabled={saving}
            onclick={setFrame}
          >
            设为封面（当前帧）
          </button>
          <button
            type="button"
            class="px-3 py-2 rounded-md border border-border hover:bg-surface-3 text-[13px] disabled:opacity-50"
            disabled={saving}
            onclick={upload}
          >
            上传图片
          </button>
          <button
            type="button"
            class="px-3 py-2 rounded-md border border-border hover:bg-surface-3 text-[13px] disabled:opacity-50"
            disabled={saving}
            onclick={reset}
          >
            恢复默认
          </button>
        </div>

        <input
          bind:this={fileInput}
          type="file"
          accept="image/*"
          class="hidden"
          onchange={onFile}
        />
      </div>
    </div>
  </div>
{/if}
