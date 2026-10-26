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
    { kind: "all", label: "全部", icon: "layers" },
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
  /* 宽度不够时 chips 自己换行，而不是撑破工具栏被详情面板裁掉 */
  .type-chips { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
  .chip {
    display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px;
    border: 0; border-radius: 7px; background: #ffffff08; color: #9a9aa0;
    font-size: 11.5px; cursor: pointer; white-space: nowrap;
  }
  .chip:hover, .chip:focus-visible { background: #ffffff14; color: #e6e6ea; }
  .chip.on { background: #f24e4e1f; color: #f2a0a0; }
  .chip .n { font-variant-numeric: tabular-nums; opacity: .75; }
</style>
