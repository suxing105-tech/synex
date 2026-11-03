<script lang="ts">
  // 启动/载入期的缩略图骨架：长在 Feed 真正的网格容器里。
  //
  // 为什么不是遮罩层里另画一张：另画就得猜侧栏宽度、工具栏高度、列宽，收场那一刻
  // 一定对不上，而「交接」恰恰是用户盯得最紧的一帧。放在这里，列数和间距就是 Feed
  // 自己那一份（$targetColumns + THUMB_GAP），形状语言也共用 --thumb-* 变量。
  import { targetColumns } from "../lib/stores";
  import { THUMB_GAP } from "../lib/media-format";

  const ROWS = 5;
  // 确定性宽高比序列：同一屏每次抖出不同形状更像 bug，也不好用测试钉住。
  // 按列号错开，避免出现整齐的方格（真瀑布流不会那样）。
  const RATIOS = ["1 / 1", "4 / 5", "3 / 4", "1 / 1", "4 / 5", "16 / 9"];

  let columns = $derived(Math.max(1, $targetColumns));

  function ratiosFor(col: number): string[] {
    return Array.from({ length: ROWS }, (_, i) => RATIOS[(i + col * 2) % RATIOS.length]);
  }
</script>

<div
  class="feed-skeleton"
  role="status"
  aria-label="图库正在载入"
  style="grid-template-columns: repeat({columns}, minmax(0, 1fr)); gap: {THUMB_GAP}px;"
>
  {#each { length: columns } as _, col (col)}
    <div class="sk-col" style="gap: {THUMB_GAP}px;">
      {#each ratiosFor(col) as ratio, i (i)}
        <span class="sk-tile" style="aspect-ratio: {ratio}; --i: {i * 2 + col};"></span>
      {/each}
    </div>
  {/each}
  <span class="sk-shine" aria-hidden="true"></span>
</div>

<style>
  /* 与 Feed 的 .masonry-scroller / .masonry-grid 同 padding、同 gap、同圆角 */
  .feed-skeleton {
    position: relative;
    display: grid;
    align-items: start;
    padding: 2px;
    overflow: hidden;
  }
  .sk-col {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .sk-tile {
    display: block;
    width: 100%;
    border-radius: var(--thumb-radius, 10px);
    background: var(--thumb-media-bg, #1a1a1d);
    animation: sk-in 280ms cubic-bezier(.22, .61, .36, 1) both;
    /* 入场按格错开，20 格封顶：再多也只是让后面的格子白等 */
    animation-delay: calc(min(var(--i), 20) * 16ms);
  }
  /* 微光只有一条：整块网格一个动画层，不给每张卡各挂一个合成层 */
  .sk-shine {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 45%;
    pointer-events: none;
    background: linear-gradient(100deg, transparent, rgba(255, 255, 255, .055) 45%, transparent);
    animation: sk-shine 1500ms ease-in-out infinite;
  }
  @keyframes sk-in { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
  @keyframes sk-shine { from { transform: translateX(-120%); } to { transform: translateX(260%); } }
  @media (prefers-reduced-motion: reduce) {
    .sk-tile, .sk-shine { animation: none; }
    .sk-tile { opacity: 1; transform: none; }
    .sk-shine { display: none; }
  }
</style>
