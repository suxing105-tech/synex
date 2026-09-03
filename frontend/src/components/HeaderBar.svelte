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

  // ---------- 监听目录展示优化 ----------
  // 长路径不能直接渲染：会被搜索框 max-w-[380px] 切掉，反而难看。
  // 这里把目录提炼成"父目录 + 末级名"两段：
  //   - 父目录做 muted 缩略，hover 看完整路径；
  //   - 末级名做主色高亮；
  // 多个 watch_dir 时退化为 "N 个目录" + hover 看完整列表。

  // 把路径切成 [parentDir, basename]，跨 Win / POSIX / 反斜杠 / 正斜杠。
  function splitPath(p: string): { parent: string; base: string } {
    // 兼容 Windows 反斜杠与 POSIX 正斜杠
    const norm = p.replace(/\\/g, "/");
    const idx = norm.lastIndexOf("/");
    if (idx < 0) return { parent: "", base: norm };
    return { parent: norm.slice(0, idx), base: norm.slice(idx + 1) };
  }

  // 单目录展示派生：截断的父目录 + 末级名（高亮）。
  let singleDir = $derived.by(() => {
    const dir = cfg?.watch_dirs?.[0];
    if (!dir) return null;
    return splitPath(dir);
  });

  // 多目录展示派生：标题用 "N 个目录"，hover 看完整列表。
  let watchCount = $derived(cfg?.watch_dirs?.length ?? 0);

  // tooltip 文案
  let watchTitle = $derived.by(() => {
    const dirs = cfg?.watch_dirs ?? [];
    if (dirs.length === 0) return "未配置监听目录 — 点此打开设置";
    if (dirs.length === 1) return dirs[0];
    return `监听 ${dirs.length} 个目录：\n${dirs.join("\n")}`;
  });
</script>

<header class="bg-surface border-b border-border px-5 h-[52px] flex items-center gap-4 z-10">
  <div class="flex items-center gap-2 font-semibold text-sm shrink-0">
    <img
      src="/logo.png"
      alt="苏醒图库"
      class="w-[22px] h-[22px] rounded-[7px] object-cover"
    />
    <span>苏醒图库</span>
  </div>

  <!--
    搜索区：
    - 父容器 flex-1 占据 logo 与右侧控件之间的剩余空间；
    - justify-center 让 input 在这段剩余空间里水平居中；
    - min-w-0 让 input 能在窄屏被正确挤压（flex 默认 min-width: auto 会撑破外框）。
    input 本身：
    - 扁平：去 border、focus 无高亮（focus:ring-0 / outline-none）；
    - 背景轻微下沉 bg-bg，比 header 的 bg-surface 略深，看起来像"嵌入"的输入区。
    图标：换成 inline SVG 线条图标（Feather 风），比 emoji 立体图标更扁平。
  -->
  <div class="flex-1 flex justify-center min-w-0">
    <div class="relative w-full max-w-[480px]">
      <span
        class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
        aria-hidden="true"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      </span>
      <input
        bind:this={searchInput}
        type="text"
        placeholder="搜索 prompt、文件名、标签…"
        autocomplete="off"
        class="w-full bg-bg text-zinc-200 py-[7px] pl-[34px] pr-[10px] rounded-[7px] text-[13px] outline-none border-0 focus:ring-0 placeholder:text-muted"
        value={$query}
        oninput={(e) => query.set((e.target as HTMLInputElement).value)}
      />
    </div>
  </div>

  <div class="flex items-center gap-[10px] shrink-0">
    <!--
      监听目录指示器：
      - 一个 status dot（live 时绿带 pulse / 未 live 时灰），直观反映 live_enabled；
      - 单目录：显示末级名 + 弱化父目录，hover title 看完整路径；
      - 多目录：显示 "N 个目录"，hover title 看完整列表；
      - 0 目录：显示 "未配置"，hover 提示去设置；
      - 整个块可点击 → 打开 SettingsModal（等同于 ⚙ 按钮但更显眼）。
    -->
    {#if cfg}
      <button
        type="button"
        class="watch-pill group flex items-center gap-1.5 max-w-[260px] px-2 py-1 rounded-md hover:bg-surface-2 text-left"
        title={watchTitle}
        onclick={onOpenSettings}
      >
        <span
          class="live-dot shrink-0 {cfg.live_enabled ? 'on' : ''}"
          aria-label={cfg.live_enabled ? "Live 已开启" : "Live 已关闭"}
        ></span>
        {#if watchCount === 0}
          <span class="text-xs text-muted">未配置监听目录</span>
        {:else if watchCount === 1 && singleDir}
          <span class="text-xs text-zinc-200 font-medium truncate" title={cfg.watch_dirs[0]}>
            {singleDir.base || cfg.watch_dirs[0]}
          </span>
          {#if singleDir.parent}
            <span class="text-[11px] text-muted opacity-60 truncate hidden sm:inline" title={singleDir.parent}>
              · {singleDir.parent}
            </span>
          {/if}
        {:else}
          <span class="text-xs text-zinc-200 font-medium">
            监听 {watchCount} 个目录
          </span>
        {/if}
      </button>
    {/if}

    <button
      class="bg-surface-2 border border-border text-zinc-200 w-8 h-8 rounded-[7px] hover:border-accent"
      onclick={onOpenSettings}
      title="设置"
    >⚙</button>
    <button
      class="bg-surface-2 border border-border text-zinc-200 w-8 h-8 rounded-[7px] hover:border-accent"
      onclick={onOpenOnboarding}
      title="导入目录"
    >＋</button>
  </div>
</header>

<style>
  /* watch-pill 在 hover 时给整块一个浅色底，强调"这是个可点的状态" */
  .watch-pill:focus-visible {
    outline: 2px solid #f24e4e;
    outline-offset: 1px;
  }
</style>
