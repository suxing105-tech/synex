<script lang="ts">
  import { settingsApi, comfyuiApi } from "../lib/api";
  import { comfyuiStatus } from "../lib/stores";
  import type { ConfigOut } from "../lib/types";
  import ShortcutSettings from "./ShortcutSettings.svelte";
  import UpdatePanel from "./UpdatePanel.svelte";
  import ModelSettings from "./ModelSettings.svelte";
  import { pushToast } from "../lib/toast";
  import { onMount } from "svelte";

  interface Props {
    open: boolean;
    tab?: string;
  }
  let { open = $bindable(), tab = $bindable("通用") }: Props = $props();

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
  $effect(() => { if (open && tab === "ComfyUI") void refreshComfyui(); });
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
      pushToast("ComfyUI 设置保存失败", { kind: "error" });
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
        live_enabled: cfg.live_enabled,
      });
      pushToast("通用设置已保存", { kind: "success" });
    } catch {
      pushToast("通用设置保存失败", { kind: "error" });
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
  <div class="fixed inset-0 z-[60] bg-surface-2" role="dialog" aria-modal="true" aria-label="设置" data-settings-dialog>
    <div class="fill-interactions settings-shell w-full h-full overflow-hidden flex flex-col">
      <div class="flex items-stretch shrink-0 h-[88px]">
        <div class="settings-title w-[240px] shrink-0 bg-surface flex items-center px-8">
          <h2 class="text-2xl font-semibold tracking-tight">设置</h2>
        </div>
        <div class="flex flex-1 items-center justify-end px-8">
          <button class="settings-return flex items-center justify-center w-10 h-10 rounded-xl text-muted" aria-label="返回图库" title="返回图库" onclick={() => (open = false)}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 5-7 7 7 7M3 12h18" /></svg>
          </button>
        </div>
      </div>

      <div class="settings-body flex flex-1 min-h-0">
      <nav class="settings-nav flex flex-col gap-2 px-5 py-6 w-[240px] shrink-0 overflow-y-auto bg-surface" aria-label="设置分类">
        {#each ["通用", "模型与反推", "快捷键", "ComfyUI", "关于与更新"] as item}
          <button class="flex items-center gap-3 text-sm text-left px-4 py-3 rounded-xl" aria-pressed={tab === item} onclick={() => tab = item}>
            <svg class="shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              {#if item === "通用"}<path d="M4 7h8m4 0h4M4 17h3m4 0h9" /><circle cx="14" cy="7" r="2" /><circle cx="9" cy="17" r="2" />
              {:else if item === "模型与反推"}<rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 4-6 5 7" />
              {:else if item === "快捷键"}<rect x="2" y="5" width="20" height="14" rx="3" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15h10" />
              {:else if item === "ComfyUI"}<rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="15" y="15" width="6" height="6" rx="1.5" /><path d="M9 6h6a3 3 0 0 1 3 3v6M6 9v9h9" />
              {:else}<circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" />{/if}
            </svg>
            <span>{item}</span>
          </button>
        {/each}
      </nav>
      <div class="settings-content flex-1 min-w-0 overflow-y-auto">
      <div class="settings-page w-full max-w-[960px] mx-auto px-12 py-10">
      <h3 class="text-2xl font-semibold tracking-tight mb-8">{tab}</h3>
      {#if tab === "快捷键"}<ShortcutSettings />{/if}
      {#if tab === "关于与更新"}<UpdatePanel />{/if}
      {#if tab === "模型与反推"}<ModelSettings />{/if}
      {#if cfg && tab === "通用"}
      <section class="space-y-2 mb-5">
        <h3 class="text-[11px] uppercase text-muted tracking-wider">监听目录</h3>
        {#each cfg.watch_dirs as d}
          <div class="flex items-center gap-2 bg-surface border border-border rounded px-3 py-1.5">
            <span class="flex-1 font-mono text-[12px] truncate">{d}</span>
            <button class="text-muted rounded px-2 py-1 text-[12px]" onclick={() => removeDir(d)}>移除</button>
          </div>
        {/each}
        <div class="flex items-center gap-2">
          <input
            type="text"
            bind:value={newDir}
            placeholder="新增目录路径…"
            class="flex-1 bg-bg border border-border rounded px-2 py-1 text-[12px] font-mono"
            onkeydown={(e) => { if (e.key === 'Enter') addDir(); }}
          />
          <button class="text-[12px] px-3 py-1 rounded border border-border" onclick={addDir}>添加</button>
        </div>
      </section>

      <section class="space-y-2 mb-5">
        <h3 class="text-[11px] uppercase text-muted tracking-wider">Live 监听</h3>
        <label class="flex items-center gap-2 text-[13px] cursor-pointer">
          <input type="checkbox" bind:checked={cfg.live_enabled} class="accent-accent" />
          <span>启用文件系统监听（新文件自动流入 feed）</span>
        </label>
      </section>

      
      {/if}
      {#if tab === "ComfyUI"}
      <section class="space-y-2 mb-5">
        <h3 class="text-[11px] uppercase text-muted tracking-wider">ComfyUI 集成</h3>
        <div class="flex items-center gap-2">
          <input
            type="text"
            bind:value={comfyuiUrlInput}
            placeholder="http://127.0.0.1:8188"
            class="flex-1 bg-bg border border-border rounded px-2 py-1 text-[12px] font-mono"
          />
          <button
            class="text-[12px] px-3 py-1 rounded border border-border disabled:opacity-50"
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
            class="text-[11px] px-2 py-1 rounded border border-border"
            onclick={saveComfyui}
          >保存 ComfyUI 设置</button>
        </div>
      </section>

      {/if}
      <div class="flex justify-end gap-2 pt-8 mt-6 border-t border-border">
        <button class="text-[12px] px-3 py-1.5 rounded border border-border" onclick={() => (open = false)}>返回图库</button>
        {#if tab === "通用"}<button class="text-[13px] px-4 py-1.5 rounded bg-accent text-bg font-medium disabled:opacity-50" disabled={saving || !cfg} onclick={save}>保存</button>{/if}
      </div>
      </div>
      </div>
      </div>
    </div>
  </div>
{/if}

<style>
  @media (max-width: 600px) {
    .settings-nav { width: 144px; padding: 8px; }
    .settings-title { width: 144px; padding: 0 24px; }
    .settings-page { padding: 24px 16px; }
  }
</style>
