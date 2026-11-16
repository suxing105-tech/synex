<script lang="ts">
  /**
   * 素材选择器左侧的文件夹分类。
   *
   * 为什么加它：素材一多，「选一张参考图」只能靠搜索框或者一页页翻；
   * 而图库里本来就已经按文件夹归好类了（来源目录 / 我的文件夹），
   * 这里把同一棵树搬到选择器左边，点哪一类就只看那一类。
   *
   * 计数口径与主侧栏一致：一行只显示当前这一族（图片/视频/音频）的数量，
   * 四类明细放到 hover 提示里 —— 一个数字只讲一件事，别让人猜它数的是什么。
   */
  import { folders, refreshFolders, stats } from "../lib/stores";
  import { countFor, formatCount } from "../lib/counts";
  import { REF_KIND_NAMES } from "../lib/clone";
  import Icon from "./Icon.svelte";
  import type { FolderNode } from "../lib/types";
  import type { RefKind } from "../lib/clone";

  interface Props {
    /** 当前这一族：决定每行右侧的数字数什么 */
    kind: RefKind;
    /** 选中的文件夹 id；null = 全部素材 */
    value: number | null;
    onSelect: (id: number | null) => void;
  }
  let { kind, value, onSelect }: Props = $props();

  let collapsed = $state<Set<number>>(new Set());

  /** 树按 is_system 拆两份：来源目录 / 我的文件夹（与主侧栏同一口径）。 */
  let systemFolders = $derived($folders.filter((f) => !!f.is_system));
  let userFolders = $derived($folders.filter((f) => !f.is_system));

  /** 顶部那一行：不按文件夹筛选。名字跟着当前族走 —— 它显示的是这一族的总数。 */
  let allLabel = $derived(`全部${REF_KIND_NAMES[kind]}`);
  let allCount = $derived(
    countFor(
      { image: $stats.total_images, video: $stats.total_videos, audio: $stats.total_audio },
      kind,
    ),
  );

  // 正常打开时 store 里已经有树了；真没有（冷启动直接跳进选择器）才补拉一次。
  // 拉失败就让它空着：侧栏空着只是少个分类，不该把整个选择器拖下水。
  $effect(() => {
    if ($folders.length === 0) void refreshFolders().catch(() => {});
  });

  function toggle(id: number) {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsed = next;
  }
</script>

<div class="pft">
  <div class="pft-row">
    <span class="pft-toggle-spacer"></span>
    <button
      class="pft-item"
      class:active={value === null}
      title="不按文件夹筛选"
      aria-label={allLabel}
      aria-current={value === null ? "true" : undefined}
      onclick={() => onSelect(null)}
    >
      <span class="pft-icon"><Icon name="layers" size={14} /></span>
      <span class="pft-label">{allLabel}</span>
      <span class="pft-count" class:zero={allCount === 0}>{formatCount(allCount)}</span>
    </button>
  </div>

  {#if systemFolders.length}
    <div class="pft-group">来源目录</div>
    {#each systemFolders as f (f.id)}
      {@render node(f, 0)}
    {/each}
  {/if}
  {#if userFolders.length}
    <div class="pft-group">我的文件夹</div>
    {#each userFolders as f (f.id)}
      {@render node(f, 0)}
    {/each}
  {/if}
</div>

{#snippet node(folder: FolderNode, depth: number)}
  <!-- 箭头与文件名是两个并列的按钮，不是一个套一个：嵌套按钮键盘上走不到，也不合法。 -->
  <div class="pft-row" style="padding-left: {depth * 12}px">
    {#if folder.children.length}
      <button
        class="pft-toggle"
        aria-label={collapsed.has(folder.id) ? `展开 ${folder.name}` : `收起 ${folder.name}`}
        aria-expanded={!collapsed.has(folder.id)}
        title={collapsed.has(folder.id) ? "展开子文件夹" : "收起子文件夹"}
        onclick={() => toggle(folder.id)}
      >
        <Icon name={collapsed.has(folder.id) ? "chevron-right" : "chevron-down"} size={12} />
      </button>
    {:else}
      <span class="pft-toggle-spacer"></span>
    {/if}
    <button
      class="pft-item"
      class:active={value === folder.id}
      title={folder.path ?? folder.name}
      aria-label={folder.name}
      aria-current={value === folder.id ? "true" : undefined}
      onclick={() => onSelect(folder.id)}
    >
      <span class="pft-icon"><Icon name="folder-solid" size={14} /></span>
      <span class="pft-label">{folder.name}</span>
      <span class="pft-count" class:zero={countFor(folder, kind) === 0}>{formatCount(countFor(folder, kind))}</span>
    </button>
  </div>
  {#if !collapsed.has(folder.id)}
    {#each folder.children as child (child.id)}
      {@render node(child, depth + 1)}
    {/each}
  {/if}
{/snippet}

<style>
  .pft { display: flex; flex-direction: column; gap: 1px; }
  .pft-row { display: flex; align-items: center; gap: 1px; }
  .pft-toggle { flex: none; width: 17px; height: 24px; display: flex; align-items: center; justify-content: center; border: 0; border-radius: var(--r-1); background: transparent; color: var(--text-3); cursor: pointer; }
  .pft-toggle:hover { background: var(--raise-2); color: var(--text-1); }
  .pft-toggle-spacer { flex: none; width: 17px; }
  .pft-item { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: var(--sp-2); height: 28px; padding: 0 var(--sp-2) 0 var(--sp-05); border: 0; border-radius: var(--r-1); background: transparent; color: var(--text-2); font-size: var(--fs-sm); font-family: inherit; text-align: left; cursor: pointer; transition: background-color 140ms ease, color 140ms ease; }
  .pft-item:hover { background: var(--raise-1); color: var(--text-1); }
  .pft-item.active { background: var(--ink-3); color: var(--text-1); }
  .pft-icon { flex: none; display: flex; color: var(--text-3); }
  .pft-item.active .pft-icon { color: var(--accent); }
  .pft-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pft-count { flex: none; font-size: var(--fs-2xs); color: var(--text-3); font-variant-numeric: tabular-nums; }
  .pft-count.zero { opacity: .4; }
  .pft-group { margin: var(--sp-3) 0 var(--sp-05); padding: 0 var(--sp-2); font-size: var(--fs-2xs); color: var(--text-3); letter-spacing: var(--track-label); }
</style>