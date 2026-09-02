<script lang="ts">
  import { query } from "../lib/stores";
  import { settingsApi } from "../lib/api";
  import { onMount } from "svelte";
  import type { ConfigOut } from "../lib/types";

  interface Props {
    onOpenSettings: () => void;
    onOpenOnboarding: () => void;
  }
  let { onOpenSettings, onOpenOnboarding }: Props = $props();

  let searchInput = $state<HTMLInputElement | null>(null);
  let cfg = $state<ConfigOut | null>(null);

  onMount(async () => {
    try {
      cfg = await settingsApi.get();
    } catch (e) {
      console.error(e);
    }
  });
</script>

<header class="bg-surface border-b border-border px-5 h-[52px] flex items-center gap-4 z-10">
  <div class="flex items-center gap-2 font-semibold text-sm">
    <img
      src="/logo.png"
      alt="苏醒图库"
      class="w-[28px] h-[28px] rounded-[7px] object-cover"
    />
    <span>苏醒图库</span>
  </div>
  <div class="flex-1 max-w-[380px] relative">
    <span class="absolute left-3 top-1/2 -translate-y-1/2 text-[12px] opacity-55">🔍</span>
    <input
      bind:this={searchInput}
      type="text"
      placeholder="搜索 prompt、文件名、标签…"
      autocomplete="off"
      class="w-full bg-bg border border-border text-zinc-200 py-[7px] pl-[34px] pr-[10px] rounded-[7px] text-[13px] outline-none focus:border-accent"
      value={$query}
      oninput={(e) => query.set((e.target as HTMLInputElement).value)}
    />
  </div>
  <div class="flex items-center gap-[10px] ml-auto">
    <span class="text-xs text-muted" title="ComfyUI 输出目录">
      {cfg?.watch_dirs?.[0] ? "监听：" + cfg.watch_dirs[0] : "未配置监听目录"}
    </span>
    <button class="bg-surface-2 border border-border text-zinc-200 w-8 h-8 rounded-[7px] hover:border-accent" onclick={onOpenSettings} title="设置">⚙</button>
    <button class="bg-surface-2 border border-border text-zinc-200 w-8 h-8 rounded-[7px] hover:border-accent" onclick={onOpenOnboarding} title="导入目录">＋</button>
  </div>
</header>
