<script lang="ts">
  import { onDestroy } from "svelte";
  import { scanApi, settingsApi } from "../lib/api";
  import { isTauri, selectImportDirectory, getSidecarStatus } from "../lib/tauri";
  import { refreshFolders, refreshStats, refreshFeed, scanProgress } from "../lib/stores";

  interface Props { open: boolean; }
  let { open = $bindable() }: Props = $props();
  let path = $state("");
  let submitting = $state(false);
  let picking = $state(false);
  let checking = $state(false);
  let error = $state("");
  let message = $state("");
  let completed = $state(false);
  let session = 0;
  let poll: ReturnType<typeof setTimeout> | undefined;
  const desktop = isTauri();
  const busy = $derived(submitting || picking || checking || $scanProgress.running);

  function invalidate() { session++; clearTimeout(poll); }
  $effect(() => { if (!open) { invalidate(); picking = false; checking = false; } });
  onDestroy(invalidate);
  function errorText(e: unknown, fallback: string) {
    return typeof (e as any)?.detail === "string" ? (e as any).detail : fallback;
  }
  function changed() { error = ""; message = ""; completed = false; }

  async function chooseFolder() {
    if (busy) return;
    const active = session;
    picking = true;
    changed();
    try {
      let previous = "";
      try { previous = localStorage.getItem("suxing.lastImportDirectory") ?? ""; } catch { /* storage may be disabled */ }
      if (!previous) {
        try { previous = (await settingsApi.get()).watch_dirs.at(-1) ?? ""; } catch { /* 选择窗口不依赖后台 */ }
      }
      if (active !== session || !open) return;
      const selected = await selectImportDirectory(path, previous);
      if (active !== session || !open || selected === null) return;
      path = selected;
      checking = true;
      try {
        const valid = await scanApi.validateDirectory(selected);
        if (active === session && open) { path = valid.path; message = "文件夹已选择，点击开始导入。"; }
      } catch (e) {
        if (active === session && open) error = errorText(e, "无法验证目录，请确认图库后台正常运行后重试");
      }
    } catch (e) {
      console.error("folder selection failed", e);
      if (active === session && open) error = "无法打开文件夹选择窗口，请重试或手动输入路径";
    } finally {
      if (active === session) { picking = false; checking = false; }
    }
  }

  async function startImport() {
    if (!path.trim() || busy) return;
    const active = session;
    submitting = true;
    changed();
    message = "正在检查目录并准备导入…";
    try {
      const result = await scanApi.importDirectory(path.trim());
      if (active !== session || !open) return;
      path = result.path;
      try { localStorage.setItem("suxing.lastImportDirectory", path); } catch { /* optional preference */ }
      message = "扫描中…";
      const tick = async () => {
        if (active !== session || !open) return;
        try {
          const progress = await scanApi.progress();
          if (active !== session || !open) return;
          scanProgress.set(progress);
          if (progress.running) { poll = setTimeout(tick, 600); return; }
          completed = true;
          if (progress.error) { error = progress.error; message = "导入未全部完成，已收录的图片保留，可重试。"; }
          else message = progress.total === 0 ? "暂无可导入图片，目录已保存；开启 Live 监听后，新图片会自动收录。" : `导入完成，已收录 ${progress.indexed} 张图片。`;
          try { await Promise.all([refreshFolders(), refreshStats(), refreshFeed()]); }
          catch { error ||= "导入已结束，但图库刷新失败，请稍后重试"; }
          if (active === session && open) {
            submitting = false;
            if (!error) close();
          }
        } catch (e) {
          console.error("scan progress failed", e);
          if (active === session) { submitting = false; error = "暂时无法获取进度，后台可能仍在导入，请稍后重试"; message = ""; }
        }
      };
      await tick();
    } catch (e) {
      console.error("directory import failed", e);
      if (active === session) { error = errorText(e, "无法开始导入，请确认图库后台正常运行后重试"); message = ""; submitting = false; }
    }
  }

  async function chooseSample() {
    if (busy) return;
    const active = session;
    changed();
    checking = true;
    try {
      const status = await getSidecarStatus();
      if (active === session && open) path = status ? `${status.data_dir}/sample_images` : "./data/sample_images";
    } finally { if (active === session) checking = false; }
  }
  function close() { if (submitting) return; invalidate(); open = false; }
</script>

{#if open}
  <div class="fixed inset-0 z-[60] bg-black/75 flex items-center justify-center" role="dialog" aria-label="导入 ComfyUI 输出目录" aria-modal="true">
    <div class="bg-surface-2 border border-border rounded-[12px] p-7 w-[620px] max-w-[92vw] max-h-[90vh] overflow-y-auto">
      <h2 class="text-lg font-semibold mb-1">导入 ComfyUI 输出目录</h2>
      <p class="text-[12.5px] text-muted mb-4">选择或输入 ComfyUI 输出文件夹，导入其中的图片和生成信息，包含子文件夹。</p>
      <label for="import-directory" class="text-[11px] uppercase text-muted tracking-wider">目录路径</label>
      <div class="flex flex-wrap gap-2 mt-1">
        <input id="import-directory" type="text" bind:value={path} oninput={changed} title={path} disabled={busy}
          aria-describedby="directory-help directory-feedback" placeholder="例如：D:\ComfyUI\output"
          class="flex-1 min-w-[200px] bg-bg border border-border rounded px-3 py-2 text-[13px] outline-none focus:border-accent font-mono disabled:opacity-60" />
        {#if desktop}
          <button class="px-3 py-2 rounded border border-border text-[13px] enabled:hover:bg-white/10 enabled:focus-visible:bg-white/10 transition-colors disabled:opacity-50" disabled={busy} onclick={chooseFolder}>
            {picking ? "选择中…" : checking ? "检查中…" : "选择文件夹"}
          </button>
        {/if}
      </div>
      <p id="directory-help" class="text-xs text-muted mt-2">{desktop ? "建议选择 ComfyUI 的 output 文件夹，无需启动 ComfyUI。" : "请输入图库后台所在电脑上的文件夹路径。桌面版支持直接选择文件夹。"}</p>
      <div class="mt-3">
        <button class="text-[12px] text-accent hover:underline disabled:opacity-50" disabled={busy} onclick={chooseSample}>试用示例目录</button>
      </div>
      <div id="directory-feedback" class="mt-3 text-xs space-y-2">
        {#if error}<p class="text-danger" role="alert">{error}</p>{/if}
        {#if message}<p class="text-muted" role="status">{message}</p>{/if}
      </div>
      {#if submitting || $scanProgress.running}
        <div class="mt-4 bg-surface border border-border rounded p-3 text-[12px]">
          <div class="flex justify-between text-muted mb-1"><span>扫描进度</span><span>{$scanProgress.indexed} / {$scanProgress.total}</span></div>
          <progress class="w-full accent-accent" max="100" value={$scanProgress.total ? Math.min(100, $scanProgress.scanned / $scanProgress.total * 100) : undefined}></progress>
          <div class="text-[10.5px] text-muted mt-1 truncate" title={$scanProgress.current_path}>{$scanProgress.current_path}</div>
        </div>
      {/if}
      <div class="flex justify-between gap-2 mt-5">
        <button class="text-[12px] px-3 py-1.5 rounded border border-border enabled:hover:bg-white/10 enabled:focus-visible:bg-white/10 transition-colors disabled:opacity-50" disabled={submitting} onclick={close}>{completed ? "完成" : "暂不导入"}</button>
        <button class="text-[13px] px-4 py-1.5 rounded bg-accent text-bg font-medium disabled:opacity-50" disabled={busy || !path.trim()} onclick={startImport}>{submitting ? "导入中…" : "开始导入"}</button>
      </div>
    </div>
  </div>
{/if}
