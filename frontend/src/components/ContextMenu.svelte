<script lang="ts">
  import { tick } from 'svelte';
  export type ContextMenuItem =
    | { kind?: "item"; label: string; danger?: boolean; onClick?: () => void | Promise<void>; disabled?: boolean; children?: ContextMenuItem[] }
    | { kind: "sep" };
  let { open = $bindable(), x, y, items }: { open: boolean; x: number; y: number; items: ContextMenuItem[] } = $props();
  let host: HTMLDivElement = $state()!;
  let branches = $state<{ items: ContextMenuItem[]; x: number; y: number; label: string }[]>([]);
  let panels = $derived([{ items, x, y }, ...branches]);
  $effect(() => { open; x; y; items; branches = []; });
  function close() { open = false; branches = []; }
  function place(node: HTMLElement, position: { x: number; y: number }) {
    function adjust(p: { x: number; y: number }) {
      const rect = node.getBoundingClientRect();
      node.style.left = `${Math.max(4, Math.min(p.x, window.innerWidth - rect.width - 4))}px`;
      node.style.top = `${Math.max(4, Math.min(p.y, window.innerHeight - rect.height - 4))}px`;
    }
    adjust(position);
    return { update: adjust };
  }
  function expand(it: ContextMenuItem, level: number, button: HTMLElement) {
    branches = branches.slice(0, level);
    if (it.kind === 'sep' || it.disabled || !it.children?.length) return;
    const rect = button.getBoundingClientRect();
    branches = [...branches, { label: it.label, items: it.children, x: rect.right + 1 + 184 > window.innerWidth ? rect.left - 185 : rect.right + 1, y: rect.top - 4 }];
  }
  async function pick(it: ContextMenuItem, level: number, button: HTMLElement) {
    if (it.kind === 'sep' || it.disabled) return;
    if (!it.onClick) { expand(it, level, button); return; }
    close();
    await it.onClick();
  }
  async function key(e: KeyboardEvent, it: ContextMenuItem, level: number) {
    const button = e.currentTarget as HTMLElement;
    if (e.key === 'ArrowRight' && it.kind !== 'sep' && it.children?.length) {
      e.preventDefault(); expand(it, level, button); await tick();
      host.querySelectorAll<HTMLElement>('[role="menu"]')[level + 1]?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    } else if (e.key === 'ArrowLeft' && level > 0) {
      e.preventDefault(); branches = branches.slice(0, level - 1);
      host.querySelectorAll<HTMLElement>('[role="menu"]')[level - 1]?.querySelector<HTMLElement>('[aria-expanded="true"]')?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const buttons = [...button.parentElement!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      buttons[(buttons.indexOf(button as HTMLButtonElement) + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    }
  }
</script>
<svelte:window onclick={(e) => { if (open && !host?.contains(e.target as Node)) close(); }} onkeydown={(e) => { if (open && e.key === 'Escape') { e.preventDefault(); close(); } }} onresize={close} />
{#if open}
  <div bind:this={host}>
    {#each panels as panel, level (level)}
      <div class="context-menu" role="menu" use:place={{ x: panel.x, y: panel.y }}>
        {#each panel.items as it, i (i)}
          {#if it.kind === 'sep'}<div class="separator" role="separator"></div>
          {:else}
            <button class="ctx-item" class:danger={it.danger} disabled={it.disabled} role="menuitem" title={it.label}
              aria-haspopup={it.children?.length ? 'menu' : undefined}
              aria-expanded={it.children?.length ? branches[level]?.label === it.label : undefined}
              onpointerenter={(e) => expand(it, level, e.currentTarget)}
              onkeydown={(e) => key(e, it, level)}
              onclick={(e) => pick(it, level, e.currentTarget)}>
              <span>{it.label}</span>{#if it.children?.length}<span aria-hidden="true">›</span>{/if}
            </button>
          {/if}
        {/each}
      </div>
    {/each}
  </div>
{/if}
<style>
  .context-menu { position: fixed; z-index: 100; width: 184px; max-width: calc(100vw - 8px); max-height: calc(100vh - 8px); overflow-y: auto; padding: 4px; border: 1px solid #3b3b40; border-radius: 7px; background: #222225; box-shadow: 0 8px 28px #0007; font: 12.5px var(--font-ui, sans-serif); }
  .ctx-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 7px 9px; text-align: left; color: #e4e4e7; border: 0; border-radius: 4px; background: transparent; cursor: pointer; }
  .ctx-item span:first-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .ctx-item:hover, .ctx-item:focus-visible, .ctx-item[aria-expanded="true"] { background: #38383d; outline: none; }
  .ctx-item:disabled { opacity: .45; cursor: default; }
  .danger { color: #f07178; } .separator { border-top: 1px solid #3b3b40; margin: 4px 2px; }
</style>
