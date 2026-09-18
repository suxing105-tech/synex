<script lang="ts">
  import { backendUrl } from '../lib/backend-url';
  import type { ImageSummary } from '../lib/types';
  let { images }: { images: ImageSummary[] } = $props();
  let split = $state(50);
  let stage: HTMLDivElement;
  let pointer: number | null = null;
  function update(e: PointerEvent) {
    const rect = stage.getBoundingClientRect();
    if (rect.width) split = Math.max(0, Math.min(100, (e.clientX - rect.left) / rect.width * 100));
  }
</script>

<div class="compare-stage" bind:this={stage}>
  <img src={backendUrl(`/api/images/${images[1].id}/file`)} alt={`B：${images[1].filename}`} draggable="false" />
  <div class="compare-overlay" style:clip-path={`inset(0 ${100 - split}% 0 0)`}>
    <img src={backendUrl(`/api/images/${images[0].id}/file`)} alt={`A：${images[0].filename}`} draggable="false" />
  </div>
  <span class="label left">A · {images[0].filename}</span>
  <span class="label right">B · {images[1].filename}</span>
  <div class="divider" style:left={`${split}%`}><span>‹ ›</span></div>
  <input class="compare-control" type="range" min="0" max="100" step="0.1" bind:value={split} aria-label="图片对比分割线"
    onpointerdown={(e) => { pointer = e.pointerId; e.currentTarget.setPointerCapture?.(e.pointerId); update(e); e.preventDefault(); }}
    onpointermove={(e) => { if (pointer === e.pointerId) update(e); }}
    onpointerup={(e) => { if (pointer === e.pointerId) { pointer = null; e.currentTarget.releasePointerCapture?.(e.pointerId); } }}
    onpointercancel={() => pointer = null} />
</div>

<style>
  .compare-stage { position: absolute; inset: 16px; overflow: hidden; background: #101010; }
  img { width: 100%; height: 100%; object-fit: contain; user-select: none; pointer-events: none; }
  .compare-overlay { position: absolute; inset: 0; background: #101010; }
  .label { position: absolute; top: 12px; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 5px 9px; border-radius: 6px; background: #0009; color: #eee; font-size: 11px; }
  .left { left: 12px; } .right { right: 12px; }
  .divider { position: absolute; top: 0; bottom: 0; width: 1px; background: #ffffffb0; pointer-events: none; }
  .divider span { position: absolute; top: 50%; transform: translate(-50%, -50%); border-radius: 20px; padding: 6px; white-space: nowrap; background: #222c; border: 1px solid #aaa; color: white; }
  .compare-control { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: ew-resize; touch-action: none; }
  .compare-stage:focus-within .divider { background: white; width: 2px; }
</style>
