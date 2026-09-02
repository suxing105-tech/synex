<script lang="ts">
  import { settingsApi } from "../lib/api";
  import type { ConfigOut } from "../lib/types";
  import { onMount } from "svelte";

  interface Props {
    open: boolean;
  }
  let { open = $bindable() }: Props = $props();

  let cfg = $state<ConfigOut | null>(null);
  let saving = $state<boolean>(false);
  let newDir = $state<string>("");

  onMount(async () => {
    cfg = await settingsApi.get();
  });

  $effect(() => {
    if (open && !cfg) {
      settingsApi.get().then((c) => (cfg = c));
    }
  });

  async function save() {
    if (!cfg) return;
    saving = true;
    try {
      cfg = await settingsApi.update({
        watch_dirs: cfg.watch_dirs,
        thumb_size: cfg.thumb_size,
        thumb_quality: cfg.thumb_quality,
        live_enabled: cfg.live_enabled,
      });
    } finally {
      saving = false;
    }
  }

  function addDir() {
    if (!cfg || !newDir.trim()) return;
    if (!cfg.watch_dirs.includes(newDir.trim())) {
      cfg = { ...cfg, watch_dirs: [...cfg.watch_dirs, newDir.trim()] };
    }
    newDir = "";
  }

  function removeDir(d: string) {
    if (!cfg) return;
    cfg = { ...cfg, watch_dirs: cfg.watch_dirs.filter((x) => x !== d) };
  }
</script>

{#if open && cfg}
  <div class="fixed inset-0 z-[60] bg-black/75 flex items-center justify-center" role="dialog">
    <div class="bg-surface-2 border border-border rounded-[12px] p-7 w-[560px] max-w-[92vw] max-h-[80vh] overflow-y-auto">
      <div class="flex items-center justify-between mb-5">
        <h2 class="text-lg font-semibold">设置</h2>
        <button class="w-8 h-8 rounded bg-surface border border-border hover:border-accent" onclick={() => (open = false)}>×</button>
      </div>

      <section class="space-y-2 mb-5">
        <h3 class="text-[11px] uppercase text-muted tracking-wider">监听目录</h3>
        {#each cfg.watch_dirs as d}
          <div class="flex items-center gap-2 bg-surface border border-border rounded px-3 py-1.5">
            <span class="flex-1 font-mono text-[12px] truncate">{d}</span>
            <button class="text-muted hover:text-danger text-[12px]" onclick={() => removeDir(d)}>移除</button>
          </div>
        {/each}
        <div class="flex items-center gap-2">
          <input
            type="text"
            bind:value={newDir}
            placeholder="新增目录路径…"
            class="flex-1 bg-bg border border-border rounded px-2 py-1 text-[12px] outline-none focus:border-accent font-mono"
            onkeydown={(e) => { if (e.key === 'Enter') addDir(); }}
          />
          <button class="text-[12px] px-3 py-1 rounded border border-border hover:border-accent" onclick={addDir}>添加</button>
        </div>
      </section>

      <section class="space-y-2 mb-5">
        <h3 class="text-[11px] uppercase text-muted tracking-wider">缩略图</h3>
        <div class="flex items-center gap-3">
          <label class="text-[12px] text-muted w-20">尺寸</label>
          <input type="number" min="128" max="512" bind:value={cfg.thumb_size} class="w-24 bg-bg border border-border rounded px-2 py-1 text-[12px] outline-none focus:border-accent" />
          <span class="text-[11px] text-muted">px</span>
        </div>
        <div class="flex items-center gap-3">
          <label class="text-[12px] text-muted w-20">质量</label>
          <input type="number" min="50" max="100" bind:value={cfg.thumb_quality} class="w-24 bg-bg border border-border rounded px-2 py-1 text-[12px] outline-none focus:border-accent" />
        </div>
      </section>

      <section class="space-y-2 mb-5">
        <h3 class="text-[11px] uppercase text-muted tracking-wider">Live 监听</h3>
        <label class="flex items-center gap-2 text-[13px] cursor-pointer">
          <input type="checkbox" bind:checked={cfg.live_enabled} class="accent-accent" />
          <span>启用文件系统监听（新文件自动流入 feed）</span>
        </label>
      </section>

      <div class="flex justify-end gap-2 pt-3 border-t border-border">
        <button class="text-[12px] px-3 py-1.5 rounded border border-border hover:border-accent" onclick={() => (open = false)}>取消</button>
        <button class="text-[13px] px-4 py-1.5 rounded bg-accent text-bg font-medium disabled:opacity-50" disabled={saving} onclick={save}>保存</button>
      </div>
    </div>
  </div>
{/if}
