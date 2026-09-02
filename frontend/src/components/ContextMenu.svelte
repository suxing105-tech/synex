<script lang="ts">
  // 通用弹出菜单：被父组件控制 open + x + y，传 items 后点击外部或 Esc 自动关闭。

  export type ContextMenuItem =
    | { kind?: "item"; label: string; danger?: boolean; onClick: () => void | Promise<void>; disabled?: boolean }
    | { kind: "sep" };

  interface Props {
    open: boolean;
    x: number;
    y: number;
    items: ContextMenuItem[];
  }
  let { open = $bindable(), x, y, items }: Props = $props();

  let menuEl: HTMLDivElement | null = $state(null);

  // 防止菜单超出视口右下边界
  let adjustedX = $derived.by(() => {
    if (!open || !menuEl) return x;
    const w = menuEl.offsetWidth;
    return Math.min(x, window.innerWidth - w - 4);
  });
  let adjustedY = $derived.by(() => {
    if (!open || !menuEl) return y;
    const h = menuEl.offsetHeight;
    return Math.min(y, window.innerHeight - h - 4);
  });

  function close() {
    open = false;
  }

  async function pick(it: ContextMenuItem) {
    if (it.kind === "sep") return;
    if (it.disabled) return;
    close();
    await it.onClick();
  }

  function handleWindowClick(e: MouseEvent) {
    if (!open) return;
    if (menuEl && menuEl.contains(e.target as Node)) return;
    close();
  }

  function handleWindowContext(e: MouseEvent) {
    // 让父级决定；这里只关闭自己
    if (!open) return;
    if (menuEl && menuEl.contains(e.target as Node)) return;
    // 父级已经处理新菜单的显示，这里不需要做
  }

  function handleKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleKey} />

{#if open}
  <div
    bind:this={menuEl}
    class="context-menu fixed z-[100] min-w-[160px] rounded-md border border-border bg-surface shadow-2xl py-1 text-[12.5px]"
    style="left: {adjustedX}px; top: {adjustedY}px;"
    role="menu"
  >
    {#each items as it, i (i)}
      {#if it.kind === "sep"}
        <div class="my-1 border-t border-border"></div>
      {:else}
        <button
          type="button"
          class="ctx-item w-full text-left px-3 py-1.5 hover:bg-surface-2 disabled:opacity-50 disabled:cursor-not-allowed"
          class:!text-danger={it.danger}
          disabled={it.disabled}
          onclick={() => pick(it)}
          role="menuitem"
        >
          {it.label}
        </button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .context-menu {
    font-family: var(--font-ui, inherit);
  }
  .ctx-item {
    cursor: pointer;
    color: #e4e4e7;
  }
</style>
