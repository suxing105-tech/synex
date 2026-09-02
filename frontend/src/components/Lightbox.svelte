<script lang="ts">
  import { feedItems } from "../lib/stores";
  import { formatDate, formatSize } from "../lib/ws";

  interface Props {
    open: boolean;
    index: number;
    selectedId: number | null;
  }
  let { open = $bindable(), index = $bindable(), selectedId = $bindable() }: Props = $props();

  let originalUrl = $state<string | null>(null);

  function close() {
    open = false;
    originalUrl = null;
  }

  function prev() {
    if ($feedItems.length === 0) return;
    index = (index - 1 + $feedItems.length) % $feedItems.length;
  }
  function next() {
    if ($feedItems.length === 0) return;
    index = (index + 1) % $feedItems.length;
  }

  function handleKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      prev();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      next();
    } else if (e.key === ' ') {
      e.preventDefault();
      next();
    }
  }

  $effect(() => {
    if (open) {
      const it = $feedItems[index];
      if (it) {
        // 直接读 path 文件（要后端暴露 /files/...？这里用 file 协议借助 fetch 不行）
        // 简化：用 thumb 的大图不够清晰。我们可以加一个 /original 接口，但本期简化：用缩略图。
        // 也支持直接通过 path 的 file URL（浏览器可能拒绝 file://）。
        // 取折中：用 /api/images/{id}/file 后端读取并返回 FileResponse
        originalUrl = `/api/images/${it.id}/file`;
        selectedId = it.id;
      }
    }
  });
</script>

<svelte:window onkeydown={handleKey} />

{#if open && $feedItems.length > 0 && $feedItems[index]}
  {@const it = $feedItems[index]}
  <div class="fixed inset-0 z-[80] bg-black/94 flex items-center justify-center backdrop-blur-md" role="dialog" ondblclick={close}>
    <button class="absolute top-5 right-5 w-[42px] h-[42px] rounded-full bg-white/10 border border-white/20 text-white text-[22px] hover:bg-white/22" onclick={close} title="关闭">×</button>
    <button class="absolute left-5 top-1/2 -translate-y-1/2 w-[54px] h-[86px] rounded-[10px] bg-white/8 border border-white/15 text-white text-[34px] hover:bg-white/20 flex items-center justify-center" onclick={prev} title="上一张">‹</button>
    <button class="absolute right-5 top-1/2 -translate-y-1/2 w-[54px] h-[86px] rounded-[10px] bg-white/8 border border-white/15 text-white text-[34px] hover:bg-white/20 flex items-center justify-center" onclick={next} title="下一张">›</button>

    <img
      src={originalUrl ?? ''}
      alt={it.filename}
      class="max-w-[92vw] max-h-[84vh] object-contain rounded-md shadow-2xl"
      draggable="false"
    />

    <div class="absolute bottom-5 left-1/2 -translate-x-1/2 bg-black/65 border border-white/12 text-white px-[18px] py-[9px] rounded-[10px] text-[12.5px] text-center backdrop-blur-md min-w-[240px]">
      <div class="font-mono font-semibold mb-[3px] truncate">{it.filename}</div>
      <div class="text-[11.5px] text-white/70">
        {#if it.width && it.height}{it.width}×{it.height} · {/if}
        {#if it.model}{it.model} · {/if}
        {#if it.seed !== null}seed {it.seed} · {/if}
        {formatSize(it.size_bytes)} · {formatDate(it.mtime)}
      </div>
      <div class="text-[11px] text-white/55 mt-1">{index + 1} / {$feedItems.length} · 双击图片外关闭</div>
    </div>
  </div>
{/if}
