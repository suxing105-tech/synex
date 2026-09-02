<script lang="ts">
  import { settingsApi, thumbnailsApi } from "../lib/api";
  import type { ConfigOut } from "../lib/types";
  import { onMount } from "svelte";

  interface Props {
    open: boolean;
  }
  let { open = $bindable() }: Props = $props();

  let cfg = $state<ConfigOut | null>(null);
  let saving = $state<boolean>(false);
  let newDir = $state<string>("");

  // 缩略图重建状态
  let rebuilding = $state<boolean>(false);
  let rebuildMsg = $state<string>("");
  let lastSavedThumbSize = $state<number | null>(null);

  // 提示：「缩略图尺寸」最小有效值 = 缩放滑块上限（让任何滑块位置都不糊）
  const ZOOM_MAX = 480;

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

  async function rebuildAllThumbs() {
    if (!cfg || rebuilding) return;
    rebuilding = true;
    rebuildMsg = "";
    try {
      const sizeBefore = cfg.thumb_size;
      lastSavedThumbSize = sizeBefore;
      const r = await thumbnailsApi.rebuild({ size: cfg.thumb_size, quality: cfg.thumb_quality });
      rebuildMsg = r.ok
        ? `后台重建已启动，size=${r.size ?? cfg.thumb_size}。稍候 F5 刷新即可看到清晰版。`
        : "启动失败，请看后端日志";
    } catch (e) {
      rebuildMsg = "失败：" + (e instanceof Error ? e.message : String(e));
    } finally {
      rebuilding = false;
    }
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
        <div class="text-[11px] text-muted pl-[5.75rem]">
          推荐 ≥ {`${ZOOM_MAX}`}（缩放滑块上限），否则滑到最大时浏览器会拉伸缩略图变糊。
        </div>
        <div class="flex items-center gap-3">
          <label class="text-[12px] text-muted w-20">质量</label>
          <input type="number" min="50" max="100" bind:value={cfg.thumb_quality} class="w-24 bg-bg border border-border rounded px-2 py-1 text-[12px] outline-none focus:border-accent" />
        </div>
        <div class="flex items-center gap-3 pt-1">
          <button
            class="text-[12px] px-3 py-1 rounded border border-border hover:border-accent disabled:opacity-50"
            disabled={rebuilding}
            onclick={rebuildAllThumbs}
          >
            {rebuilding ? "重建中…" : "🔄 一键重建所有缩略图"}
          </button>
          <span class="text-[11px] text-muted">后台跑，不阻塞你浏览；完事刷新即可。</span>
        </div>
        {#if rebuildMsg}
          <div class="text-[11.5px] text-success pl-1">{rebuildMsg}</div>
        {/if}
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
