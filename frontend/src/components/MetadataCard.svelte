<script lang="ts">
  /**
   * 元数据卡片：标签 chips + 所属文件夹路径面包屑 + 切换按钮。
   *
   * 设计：
   * - 标签：hover 显示 × 删除；点击触发 tag 搜索（通过 onTagClick）。
   * - 位置：显示文件当前所在的真实目录（由 path 推导，磁盘上移动完就跟着变），
   *   点击 = 在资源管理器里打开该目录并选中该文件；「切换」仍走 FolderPickerModal。
   *   只有拿不到文件路径时才退回显示库内文件夹名 chips。
   */
  import Icon from "./Icon.svelte";
  import type { FolderNode } from "../lib/types";
  import { displayPath, nativePath, parentDirectory } from "../lib/file-location";

  interface Props {
    tags: string[];
    folderIds: number[];
    folders: FolderNode[];
    /** 文件当前的绝对路径，用来显示「所在文件夹」 */
    path?: string;
    /** 点击标签触发搜索（全局跳到 ?tag=xxx） */
    onTagClick?: (tag: string) => void;
    /** 删除标签 */
    onRemoveTag?: (tag: string) => void;
    /** 打开 FolderPickerModal */
    onSwitchFolder?: () => void;
    /** 点击位置：打开所在文件夹（并选中该文件） */
    onRevealLocation?: () => void;
    /** 复制所在文件夹路径 */
    onCopyLocation?: () => void;
  }

  let {
    tags,
    folderIds,
    folders,
    path = "",
    onTagClick,
    onRemoveTag,
    onSwitchFolder,
    onRevealLocation,
    onCopyLocation,
  }: Props = $props();

  const folderNodes = $derived(
    folderIds
      .map((id) => folders.find((f) => f.id === id))
      .filter((n): n is FolderNode => Boolean(n)),
  );

  // 位置行由文件自身的 path 推导：移动后 detail 一重拉，这里就是新目录
  const locationDir = $derived(parentDirectory(path));
  const locationText = $derived(displayPath(locationDir));

  // 以下是兜底分支用的路径面包屑：当前文件夹名（system folder 显示路径）
  function breadcrumb(node: FolderNode): string {
    if (node.is_system && node.path) return node.path;
    return node.name;
  }
</script>

<section class="metadata-card space-y-3">
  <!-- 标签 -->
  <div>
    <div class="text-[11px] uppercase text-muted tracking-wider mb-1.5 flex items-center gap-1">
      <Icon name="tag" size={11} />
      <span>标签</span>
    </div>
    {#if tags.length === 0}
      <div class="text-[12px] text-muted italic">还没有标签</div>
    {:else}
      <div class="flex flex-wrap gap-1">
        {#each tags as t (t)}
          <span class="group inline-flex items-center gap-1 bg-surface-2 border border-border rounded-full pl-2.5 pr-1 py-0.5 text-[11px] hover:bg-surface-3">
            <button
              type="button"
              class="hover:text-accent"
              title={`搜索 #${t}`}
              onclick={() => onTagClick?.(t)}
            >
              #{t}
            </button>
            <button
              type="button"
              class="text-muted opacity-0 group-hover:opacity-100 hover:text-danger"
              title="删除标签"
              aria-label={`删除标签 ${t}`}
              onclick={() => onRemoveTag?.(t)}
            >
              <Icon name="x" size={10} />
            </button>
          </span>
        {/each}
      </div>
    {/if}
  </div>

  <!-- 文件夹 -->
  <div>
    <div class="text-[11px] uppercase text-muted tracking-wider mb-1.5 flex items-center gap-1">
      <Icon name="folder" size={11} />
      <span>所属文件夹</span>
      <button
        type="button"
        class="ml-auto normal-case text-[11px] text-muted hover:text-zinc-200"
        onclick={() => onSwitchFolder?.()}
      >
        切换
      </button>
    </div>
    {#if locationDir}
      <div class="group flex items-center gap-1">
        <button
          type="button"
          class="min-w-0 flex-1 inline-flex items-center gap-1 bg-surface-2 hover:bg-surface-3 border border-border rounded px-2 py-1 text-[11px] text-zinc-300 hover:text-zinc-100 transition-colors text-left"
          title={"打开所在文件夹：" + nativePath(locationDir)}
          aria-label="打开所在文件夹"
          onclick={() => onRevealLocation?.()}
        >
          <Icon name="folder" size={10} />
          <span class="truncate">{locationText}</span>
        </button>
        <button
          type="button"
          class="shrink-0 text-muted opacity-0 group-hover:opacity-100 hover:text-zinc-200 transition-opacity"
          title={"复制文件夹路径：" + nativePath(locationDir)}
          aria-label="复制文件夹路径"
          onclick={() => onCopyLocation?.()}
        >
          <Icon name="copy" size={10} />
        </button>
      </div>
    {:else if folderNodes.length === 0}
      <div class="text-[12px] text-muted italic">位置未知（文件可能已被移动或删除）</div>
    {:else}
      <div class="flex flex-wrap gap-1">
        {#each folderNodes as node (node.id)}
          <span
            class="inline-flex items-center gap-1 bg-surface-2 border border-border rounded px-2 py-0.5 text-[11px]"
            title={breadcrumb(node)}
          >
            <Icon name="folder" size={10} />
            <span class="truncate max-w-[200px]">{node.name}</span>
          </span>
        {/each}
      </div>
    {/if}
  </div>
</section>

