<script lang="ts">
  /**
   * 「所有素材」的类型过滤：**单选**。
   *
   * 导航（切口径）已经交给侧栏，这里只在混排流里挑一类来看；默认「全部」。
   * 所以它只在 scope === 'all' 时出现，切到单一类型就不渲染 —— 同屏两套类型控件
   * 只会让人搞不清哪个说了算。再点已选中的那一类不取消：空过滤没有意义。
   */
  import Icon from "./Icon.svelte";
  import { feedCounts, kindFilter, scope, selectKind } from "../lib/stores";
  import type { ItemKind } from "../lib/types";

  type Choice = ItemKind | "all";
  const chips: { kind: Choice; label: string; icon: string }[] = [
    { kind: "all", label: "全部", icon: "home" },
    { kind: "image", label: "图片", icon: "image" },
    { kind: "video", label: "视频", icon: "video" },
    { kind: "audio", label: "音频", icon: "music" },
    { kind: "text", label: "文本", icon: "text" },
  ];

  function onCount(kind: Choice): number {
    const counts = $feedCounts;
    if (kind === "all") return counts.image + counts.video + counts.audio + counts.text;
    return counts[kind];
  }

  function titleFor(kind: Choice, label: string): string {
    return kind === "all" ? "显示全部类型" : `只看${label}`;
  }
</script>

{#if $scope === "all"}
  <nav class="type-chips" aria-label="素材类型过滤">
    {#each chips as chip (chip.kind)}
      {@const on = $kindFilter === chip.kind}
      <button
        class="chip"
        class:on={on}
        type="button"
        aria-pressed={on}
        title={titleFor(chip.kind, chip.label)}
        onclick={() => selectKind(chip.kind)}
      >
        <Icon name={chip.icon} size={12} />
        <span class="label">{chip.label}</span>
        <span class="n">{onCount(chip.kind).toLocaleString("en-US")}</span>
      </button>
    {/each}
  </nav>
{/if}

<style>
  /* 分段控件（方案 3 · 2026-11-06）：五颗原来是散着的小胶囊，读起来像五个
     各自独立的按钮，看不出「这是同一组里选一个」。收进一条轨道之后，
     单选语义写在形状上，不用靠颜色去猜。
     选中仍然是品牌红的一层薄底 + 一圈同色细描边，跟侧栏当前项同一套语言。
     flex-wrap 必须留着：窄屏时 chips 自己换行，而不是撑破工具栏被详情面板裁掉。 */
  .type-chips {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 2px;
    min-width: 0;
    padding: 2px;
    border: 1px solid var(--line);
    border-radius: var(--r-1);
    background: var(--ink-2);
  }
  .chip {
    display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px;
    border: 0; border-radius: 4px; background: transparent; color: var(--text-2);
    font-size: var(--fs-2xs); cursor: pointer; white-space: nowrap;
    transition: background-color 120ms ease, color 120ms ease, box-shadow 120ms ease;
  }
  .chip:hover, .chip:focus-visible { background: var(--raise-2); color: var(--text-1); }
  .chip.on {
    background: rgb(var(--accent-rgb) / 14%);
    color: var(--text-1);
    box-shadow: inset 0 0 0 1px rgb(var(--accent-rgb) / 38%);
  }
  .chip .n { font-variant-numeric: tabular-nums; opacity: .7; }
  .chip.on .n { opacity: 1; }
  @media (prefers-reduced-motion: reduce) {
    .chip { transition: none; }
  }
</style>
