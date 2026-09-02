<script lang="ts">
  import { scanApi, settingsApi } from "../lib/api";
  import { refreshFolders, refreshStats, refreshFeed, scanProgress } from "../lib/stores";

  interface Props {
    open: boolean;
  }
  let { open = $bindable() }: Props = $props();

  let path = $state<string>("");
  let submitting = $state<boolean>(false);

  async function startImport() {
    if (!path.trim()) return;
    submitting = true;

    // 1. PUT /api/settings
    try {
      await settingsApi.update({ watch_dirs: [path.trim()] });
    } catch (e) {
      console.error("[import] PUT /api/settings failed:", e);
      alert(`保存监听目录失败（${(e as Error).message}）\n请检查 uvicorn 是否在 8000 端口运行。`);
      submitting = false;
      return;
    }

    // 2. POST /api/scan
    try {
      await scanApi.start(path.trim());
    } catch (e) {
      console.error("[import] POST /api/scan failed:", e);
      alert(`触发扫描失败（${(e as Error).message}）\n路径：${path.trim()}`);
      submitting = false;
      return;
    }

    // 3. 轮询扫描进度
    const tick = setInterval(async () => {
      try {
        const p = await scanApi.progress();
        scanProgress.set(p);
        if (!p.running) {
          clearInterval(tick);
          await refreshFolders();
          await refreshStats();
          await refreshFeed();
          submitting = false;
          open = false;
        }
      } catch (e) {
        console.error("[import] progress poll failed:", e);
        clearInterval(tick);
        submitting = false;
      }
    }, 600);
  }

  function chooseSample() {
    path = "./data/sample_images";
  }

  function skip() {
    open = false;
  }
</script>

{#if open}
  <div class="fixed inset-0 z-[60] bg-black/75 flex items-center justify-center" role="dialog">
    <div class="bg-surface-2 border border-border rounded-[12px] p-7 w-[480px] max-w-[90vw]">
      <h2 class="text-lg font-semibold mb-1">导入 ComfyUI 输出目录</h2>
      <p class="text-[12.5px] text-muted mb-4">输入你的 ComfyUI 输出文件夹路径，应用会扫描所有 PNG / WebP，解析 prompt 元数据并建立可搜索的索引。</p>

      <label class="text-[11px] uppercase text-muted tracking-wider">目录路径</label>
      <input
        type="text"
        bind:value={path}
        placeholder="例如：C:\\ComfyUI\\output"
        class="w-full bg-bg border border-border rounded px-3 py-2 mt-1 text-[13px] outline-none focus:border-accent font-mono"
      />

      <div class="flex items-center gap-2 mt-3">
        <button class="text-[12px] text-accent hover:underline" onclick={chooseSample}>使用示例目录（./data/sample_images）</button>
      </div>

      {#if $scanProgress.running || submitting}
          <div class="mt-4 bg-surface border border-border rounded p-3 text-[12px]">
            <div class="flex justify-between text-muted mb-1">
              <span>扫描中…</span>
              <span>{$scanProgress.indexed} / {$scanProgress.total}</span>
            </div>
            <div class="h-1.5 bg-bg rounded overflow-hidden">
              <div class="h-full bg-accent transition-all" style="width: {$scanProgress.total ? ($scanProgress.indexed / $scanProgress.total) * 100 : 0}%"></div>
            </div>
            <div class="text-[10.5px] text-muted mt-1 truncate" title={$scanProgress.current_path}>{$scanProgress.current_path}</div>
          </div>
        {/if}

      <div class="flex justify-between gap-2 mt-5">
        <button class="text-[12px] px-3 py-1.5 rounded border border-border hover:border-accent" onclick={skip}>跳过</button>
        <button class="text-[13px] px-4 py-1.5 rounded bg-accent text-bg font-medium disabled:opacity-50" disabled={submitting || !path.trim()} onclick={startImport}>开始导入</button>
      </div>
    </div>
  </div>
{/if}
