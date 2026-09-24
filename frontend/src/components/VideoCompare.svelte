<script lang="ts">
  import { backendUrl } from "../lib/backend-url";
  import type { ImageSummary } from "../lib/types";

  interface Props {
    videos: ImageSummary[];
  }
  let { videos }: Props = $props();

  const a = $derived(videos[0]);
  const b = $derived(videos[1]);

  // 视图模式：分割 / 并排
  let mode = $state<"split" | "side">("split");

  // 分割视图：分割线位置 + 同步播放
  let split = $state(50);
  let stage = $state<HTMLDivElement>();
  let root = $state<HTMLDivElement>();
  let pointer: number | null = null;
  let aEl = $state<HTMLVideoElement>();
  let bEl = $state<HTMLVideoElement>();
  let aSideEl = $state<HTMLVideoElement>();
  let bSideEl = $state<HTMLVideoElement>();
  let playing = $state(false);
  let currentTime = $state(0);
  let duration = $state(0);

  // 同步播放（右键菜单开关）：开启后 B 跟随 A 的播放/暂停/进度
  let synced = $state(true);
  let menu = $state<{ x: number; y: number } | null>(null);

  function update(e: PointerEvent) {
    const rect = stage!.getBoundingClientRect();
    if (rect.width) split = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
  }

  function clampTime(t: number): number {
    return Number.isFinite(t) && t > 0 ? t : 0;
  }

  // 以 A 为基准，把 B 的时间拉到 A，避免双视频漂移
  function onTimeA() {
    if (!aEl) return;
    if (synced && bEl && Math.abs(aEl.currentTime - bEl.currentTime) > 0.35) {
      bEl.currentTime = aEl.currentTime;
    }
    currentTime = aEl.currentTime;
    duration = clampTime(aEl.duration) || clampTime(bEl?.duration || 0);
  }

  function onPlayState() {
    playing = !!aEl && !aEl.paused;
    if (synced && bEl) {
      if (playing) bEl.play().catch(() => {});
      else bEl.pause();
    }
  }

  function togglePlay() {
    if (!aEl) return;
    if (aEl.paused) { void aEl.play(); if (synced && bEl) void bEl.play(); }
    else { aEl.pause(); if (synced && bEl) bEl.pause(); }
  }

  function onSeek(e: Event) {
    const t = Number((e.currentTarget as HTMLInputElement).value);
    currentTime = t;
    if (aEl) aEl.currentTime = t;
    if (synced && bEl) bEl.currentTime = t;
  }

  // 并排模式：A 控制 B（仅在同步开启时）
  function sideOnTime() {
    if (!synced || !aSideEl || !bSideEl) return;
    if (Math.abs(aSideEl.currentTime - bSideEl.currentTime) > 0.35) bSideEl.currentTime = aSideEl.currentTime;
  }
  function sideOnPlay() {
    if (!synced || !bSideEl || !aSideEl) return;
    if (!aSideEl.paused) bSideEl.play().catch(() => {});
  }
  function sideOnPause() {
    if (!synced || !bSideEl) return;
    bSideEl.pause();
  }
  function sideOnSeeked() {
    if (!synced || !bSideEl || !aSideEl) return;
    bSideEl.currentTime = aSideEl.currentTime;
  }

  // 右键菜单：同步播放开关
  function openMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const x = Math.max(4, Math.min(e.clientX - rect.left, rect.width - 150));
    const y = Math.max(4, Math.min(e.clientY - rect.top, rect.height - 46));
    menu = { x, y };
  }
  function closeMenu() {
    menu = null;
  }
  function toggleSync() {
    synced = !synced;
    menu = null;
    const A = mode === "split" ? aEl : aSideEl;
    const B = mode === "split" ? bEl : bSideEl;
    if (synced && A && B) {
      B.currentTime = A.currentTime;
      if (!A.paused) B.play().catch(() => {});
      else B.pause();
    }
  }

  function fmt(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    return `${m}:${(s % 60).toString().padStart(2, "0")}`;
  }
</script>

<svelte:window onclick={closeMenu} />

<div class="video-compare" bind:this={root} oncontextmenu={openMenu}>
  {#if mode === "split"}
    <div class="compare-stage" bind:this={stage}>
      <video
        bind:this={bEl}
        src={backendUrl(b.play_url!)}
        autoplay
        playsinline
        muted
        class="base-video"
        ontimeupdate={onTimeA}
      ></video>
      <div class="compare-overlay" style:clip-path={`inset(0 0 0 ${split}%)`}>
        <video
          bind:this={aEl}
          src={backendUrl(a.play_url!)}
          autoplay
          playsinline
          class="base-video"
          ontimeupdate={onTimeA}
          onplay={onPlayState}
          onpause={onPlayState}
        ></video>
      </div>
      <span class="label left">A · {a.filename}</span>
      <span class="label right">B · {b.filename}</span>
      <div class="divider" style:left={`${split}%`}><span>‹ ›</span></div>
      <input
        class="compare-control"
        type="range"
        min="0"
        max="100"
        step="0.1"
        bind:value={split}
        aria-label="视频对比分割线"
        onpointerdown={(e) => { pointer = e.pointerId; e.currentTarget.setPointerCapture?.(e.pointerId); update(e); e.preventDefault(); }}
        onpointermove={(e) => { if (pointer === e.pointerId) update(e); }}
        onpointerup={(e) => { if (pointer === e.pointerId) { pointer = null; e.currentTarget.releasePointerCapture?.(e.pointerId); } }}
        onpointercancel={() => { pointer = null; }}
      />
      <div class="compare-bar">
        <button type="button" class="bar-btn" onclick={togglePlay} aria-label={playing ? "暂停" : "播放"}>
          {playing ? "⏸" : "▶"}
        </button>
        <input type="range" class="seek" min="0" max={duration || 0} step="0.1" value={currentTime} oninput={onSeek} aria-label="进度" />
        <span class="time">{fmt(currentTime)} / {fmt(duration)}</span>
        <span class="sync-badge" class:off={!synced}>{synced ? "同步播放" : "已取消同步"}</span>
      </div>
    </div>
  {:else}
    <div class="side-stage">
      <div class="side-panel">
        <video
          bind:this={aSideEl}
          src={backendUrl(a.play_url!)}
          controls
          autoplay
          playsinline
          class="side-video"
          ontimeupdate={sideOnTime}
          onplay={sideOnPlay}
          onpause={sideOnPause}
          onseeked={sideOnSeeked}
        ></video>
        <div class="side-label">A · {a.filename}</div>
      </div>
      <div class="side-panel">
        <video bind:this={bSideEl} src={backendUrl(b.play_url!)} controls autoplay playsinline class="side-video"></video>
        <div class="side-label">B · {b.filename}</div>
      </div>
    </div>
  {/if}

  <div class="mode-switch">
    <button type="button" class="switch-btn" aria-pressed={mode === "split"} onclick={() => { mode = "split"; }}>分割视图</button>
    <button type="button" class="switch-btn" aria-pressed={mode === "side"} onclick={() => { mode = "side"; }}>并排对比</button>
    <span class="hint">右键画面可切换同步播放</span>
  </div>

  {#if menu}
    <div class="ctx-menu" style:left={`${menu.x}px`} style:top={`${menu.y}px`} role="menu" onclick={(e) => e.stopPropagation()}>
      <button type="button" role="menuitem" class="ctx-item" onclick={toggleSync}>
        {synced ? "取消同步" : "同步播放"}
      </button>
    </div>
  {/if}
</div>

<style>
  .video-compare { position: relative; width: 100%; height: 100%; display: flex; flex-direction: column; gap: 8px; }
  .compare-stage { position: relative; flex: 1; min-height: 0; overflow: hidden; background: #000; border-radius: 8px; }
  .base-video { width: 100%; height: 100%; object-fit: contain; display: block; }
  .compare-overlay { position: absolute; inset: 0; background: #000; }
  .label { position: absolute; top: 10px; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 4px 8px; border-radius: 6px; background: #0009; color: #eee; font-size: 11px; z-index: 3; }
  .left { left: 10px; } .right { right: 10px; }
  .divider { position: absolute; top: 0; bottom: 0; width: 1px; background: #ffffffb0; pointer-events: none; z-index: 4; }
  .divider span { position: absolute; top: 50%; transform: translate(-50%, -50%); border-radius: 20px; padding: 6px; white-space: nowrap; background: #222c; border: 1px solid #aaa; color: white; }
  .compare-control { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: ew-resize; touch-action: none; z-index: 5; }
  .compare-bar { display: flex; align-items: center; gap: 10px; padding: 0 12px; }
  .bar-btn { width: 34px; height: 34px; border-radius: 50%; background: #fff2; color: #fff; display: flex; align-items: center; justify-content: center; }
  .bar-btn:hover { background: #fff4; }
  .seek { flex: 1; accent-color: #f24e4e; }
  .time { color: #ccc; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sync-badge { font-size: 11px; color: #9fe0a0; background: #2e7d3226; border: 1px solid #2e7d3255; border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
  .sync-badge.off { color: #bbb; background: #ffffff14; border-color: #ffffff22; }
  .side-stage { flex: 1; min-height: 0; display: flex; gap: 12px; }
  .side-panel { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .side-video { width: 100%; flex: 1; min-height: 0; object-fit: contain; background: #000; border-radius: 8px; }
  .side-label { color: #ccc; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
  .mode-switch { display: flex; justify-content: center; align-items: center; gap: 8px; flex-shrink: 0; }
  .switch-btn { padding: 5px 12px; border-radius: 6px; font-size: 12px; background: #fff1; color: #ddd; }
  .switch-btn[aria-pressed="true"] { background: #f24e4e; color: #fff; }
  .hint { font-size: 11px; color: #888; margin-left: 6px; }
  .ctx-menu { position: absolute; z-index: 20; min-width: 128px; padding: 4px; background: #26262a; border: 1px solid #3a3a40; border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); }
  .ctx-item { display: block; width: 100%; text-align: left; padding: 7px 10px; border-radius: 6px; font-size: 13px; color: #eee; background: transparent; }
  .ctx-item:hover { background: #f24e4e; color: #fff; }
</style>
