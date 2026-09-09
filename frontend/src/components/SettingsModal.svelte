<script lang="ts">
  import { settingsApi, comfyuiApi } from "../lib/api";
  import { comfyuiStatus } from "../lib/stores";
  import type { ConfigOut } from "../lib/types";
  import UpdatePanel from "./UpdatePanel.svelte";
  import { onMount } from "svelte";

  interface Props {
    open: boolean;
  }
  let { open = $bindable() }: Props = $props();

  let cfg = $state<ConfigOut | null>(null);
  let saving = $state<boolean>(false);
  let newDir = $state<string>("");

  onMount(async () => {
    try { cfg = await settingsApi.get(); } catch { /* 更新入口不依赖后台 */ }
  });

  $effect(() => {
    if (open && !cfg) {
      settingsApi.get().then((c) => (cfg = c)).catch(() => {});
    }
  });

  let comfyuiUrlInput = $state<string>("http://127.0.0.1:8188");
  let comfyuiEnabledLocal = $state<boolean>(true);
  let probing = $state<boolean>(false);
  let comfyuiStatusLocal = $state<{ running: boolean; url: string } | null>(null);

  async function refreshComfyui() {
    probing = true;
    try {
      const s = await comfyuiApi.status();
      comfyuiStatusLocal = { running: s.running, url: s.url };
      comfyuiUrlInput = s.url;
      comfyuiEnabledLocal = s.enabled;
      comfyuiStatus.set(s);
    } catch (e) {
      comfyuiStatusLocal = { running: false, url: comfyuiUrlInput };
    } finally {
      probing = false;
    }
  }

  async function saveComfyui() {
    try {
      const s = await comfyuiApi.updateConfig({
        url: comfyuiUrlInput,
        enabled: comfyuiEnabledLocal,
      });
      comfyuiStatusLocal = { running: s.running, url: s.url };
      comfyuiStatus.set(s);
    } catch (e) {
      console.error(e);
    }
  }

  async function save() {
    if (!cfg) return;
    saving = true;
    try {
      // 注意：feed 现在直接用原图 + ?max=1024 预览，thumb 系统不再需要 UI 配置；
      // 后端 thumb_size / thumb_quality 字段保留但只在 API 层面维护，不会再有 UI 入口。
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

{#if open}
  <div class="fixed inset-0 z-[60] bg-black/75 flex items-center justify-center" role="dialog">
    <div class="bg-surface-2 border border-border rounded-[12px] p-7 w-[560px] max-w-[92vw] max-h-[80vh] overflow-y-auto">
      <div class="flex items-center justify-between mb-5">
        <h2 class="text-lg font-semibold">设置</h2>
        <button class="w-8 h-8 rounded bg-surface border border-border hover:border-accent" onclick={() => (open = false)}>×</button>
      </div>

      <UpdatePanel />
      {#if cfg}
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
        <h3 class="text-[11px] uppercase text-muted tracking-wider">Live 监听</h3>
        <label class="flex items-center gap-2 text-[13px] cursor-pointer">
          <input type="checkbox" bind:checked={cfg.live_enabled} class="accent-accent" />
          <span>启用文件系统监听（新文件自动流入 feed）</span>
        </label>
      </section>

      
      <section class="space-y-2 mb-5">
        <h3 class="text-[11px] uppercase text-muted tracking-wider">ComfyUI 集成</h3>
        <div class="flex items-center gap-2">
          <input
            type="text"
            bind:value={comfyuiUrlInput}
            placeholder="http://127.0.0.1:8188"
            class="flex-1 bg-bg border border-border rounded px-2 py-1 text-[12px] outline-none focus:border-accent font-mono"
          />
          <button
            class="text-[12px] px-3 py-1 rounded border border-border hover:border-accent disabled:opacity-50"
            disabled={probing}
            onclick={refreshComfyui}
            title="重新探测本机 ComfyUI"
          >
            {probing ? "探测中…" : "重新探测"}
          </button>
          <span
            class="inline-block w-2.5 h-2.5 rounded-full"
            class:bg-success={comfyuiStatusLocal?.running}
            class:bg-danger={comfyuiStatusLocal && !comfyuiStatusLocal.running}
            class:bg-muted={!comfyuiStatusLocal}
            title={comfyuiStatusLocal?.running ? "ComfyUI 在跑" : "未探测到 ComfyUI"}
          ></span>
        </div>
        <label class="flex items-center gap-2 text-[13px] cursor-pointer">
          <input type="checkbox" bind:checked={comfyuiEnabledLocal} class="accent-accent" />
          <span>启用 ComfyUI 工作流一键打开（仅在 ComfyUI 运行时显示按钮）</span>
        </label>
        <div class="flex justify-end">
          <button
            class="text-[11px] px-2 py-1 rounded border border-border hover:border-accent"
            onclick={saveComfyui}
          >保存 ComfyUI 设置</button>
        </div>
      </section>

      {/if}
      <div class="flex justify-end gap-2 pt-3 border-t border-border">
        <button class="text-[12px] px-3 py-1.5 rounded border border-border hover:border-accent" onclick={() => (open = false)}>取消</button>
        <button class="text-[13px] px-4 py-1.5 rounded bg-accent text-bg font-medium disabled:opacity-50" disabled={saving || !cfg} onclick={save}>保存</button>
      </div>
    </div>
  </div>
{/if}
