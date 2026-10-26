<script lang="ts">
  /**
   * 关联本地文本 / 目录：先预览范围，确认后才入库。
   *
   * 入口有三个：文本网格工具栏、「拖到侧栏或网格」（`associateTextPaths` store）
   * 与阅读层的空态。入库成功后立刻在中间栏打开第一篇，不用回网格再找。
   */
  import { modalFocus } from "../lib/modal-focus";
  import { refreshFeed, refreshFolders, openTextReader, associateTextPaths } from "../lib/stores";
  import { textsApi } from "../lib/texts";
  import { selectTextPaths } from "../lib/tauri";
  import { textFeedItemOf } from "../lib/text-reading";
  import { pushToast } from "../lib/toast";

  interface Props {
    open: boolean;
    paths?: string[];
    onClose: () => void;
  }
  let { open, paths = [], onClose }: Props = $props();

  let input = $state("");
  let preview = $state<Awaited<ReturnType<typeof textsApi.preview>> | null>(null);
  let busy = $state(false);
  let error = $state("");

  const lines = $derived(input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));

  // 已经同步进输入框的那一批路径。必须按内容比对：只判 open 的话，
  // 输入框里打的字会触发这个 effect，然后被 paths 原样覆盖回去，等于没法手打路径。
  let synced = $state<string | null>(null);

  $effect(() => {
    if (!open) { synced = null; return; }
    const next = paths.join("\n");
    if (synced === next) return;
    synced = next;
    input = next;
    error = "";
    preview = null;
    if (next.trim()) void runPreview(next.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  });

  async function runPreview(targets: string[]) {
    busy = true; error = ""; preview = null;
    try { preview = await textsApi.preview(targets); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }

  async function browse() {
    try {
      const picked = await selectTextPaths(false);
      if (picked.length) input = [...lines, ...picked.filter((p) => !lines.includes(p))].join("\n");
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }

  async function confirm() {
    if (!lines.length) return;
    busy = true; error = "";
    try {
      const result = await textsApi.associate(lines);
      await Promise.all([refreshFolders(), refreshFeed({ keepScroll: true })]);
      associateTextPaths.set(null);
      if (result.errors.length) error = result.errors.map((x) => `${x.path}：${x.reason}`).join("\n");
      else { onClose(); pushToast(`已关联 ${result.saved.length} 篇文本`, { kind: "success" }); }
      const first = result.saved[0];
      if (first) openTextReader(textFeedItemOf(first), "");
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
</script>

{#if open}
  <div class="text-modal-backdrop" role="presentation">
    <div class="text-modal" role="dialog" aria-modal="true" aria-label="关联本地文本" tabindex="-1" use:modalFocus>
      <header><h2>关联本地文本</h2><button onclick={onClose}>×</button></header>
      <p>把已经在硬盘上的 TXT / Markdown / SRT / VTT 加进图库。可以一行一个文件，也可以直接写目录；编辑会保存到原文件，入库不会复制一份。</p>
      <textarea aria-label="关联路径" rows="4" placeholder="每行一个本地文件或目录的完整路径" bind:value={input} oninput={() => { preview = null; }}></textarea>
      <div class="row">
        <button type="button" onclick={() => void browse()}>浏览文件…</button>
        <button type="button" disabled={busy || !lines.length} onclick={() => void runPreview(lines)}>预览范围</button>
      </div>
      {#if preview}
        <div class="preview">
          <strong>将纳入 {preview.total} 个文本</strong>
          {#if preview.roots.length}<p>目录：{preview.roots.join("、")}</p>{/if}
          <p>{Object.entries(preview.formats).filter(([, n]) => n).map(([f, n]) => `${f.toUpperCase()} ${n}`).join(" · ") || "没有可识别的文本格式"}</p>
          {#each preview.errors as issue}<p class="error">{issue.path}：{issue.reason}</p>{/each}
        </div>
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <div class="modal-actions">
        <button onclick={onClose}>取消</button>
        <button class="primary" disabled={busy || !lines.length} onclick={() => void confirm()}>确认关联 · 编辑将保存到原文件</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .text-modal-backdrop { position: fixed; inset: var(--desktop-titlebar-height, 0px) 0 0; background: #0009; z-index: 90; display: flex; align-items: center; justify-content: center; padding: 25px; color: #dddce4; }
  .text-modal { width: 620px; max-width: 96vw; max-height: 90vh; overflow: auto; border: 1px solid #44404a; border-radius: 12px; background: #18181b; padding: 22px; box-shadow: 0 22px 90px #0008; font-size: 13px; }
  .text-modal header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
  .text-modal h2 { font-size: 18px; font-weight: 600; }
  .text-modal p { line-height: 1.8; margin: 10px 0; color: #b6b3bf; }
  .text-modal textarea { width: 100%; background: #27272a; color: inherit; border: 1px solid #383941; border-radius: 6px; padding: 9px; font-size: 13px; margin: 12px 0; }
  .text-modal button { cursor: pointer; border: 1px solid #49424c; border-radius: 6px; padding: 6px 12px; font-size: 12px; background: transparent; color: inherit; }
  .text-modal button:hover:not(:disabled) { background: #323237; color: #fff; }
  .text-modal button:disabled { opacity: .45; cursor: default; }
  .row { display: flex; gap: 8px; }
  .preview { margin: 14px 0; padding: 12px; border: 1px solid #2e2e33; border-radius: 8px; background: #ffffff04; font-size: 12px; }
  .error { color: #f0a8a8; white-space: pre-wrap; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 15px; }
  .primary { background: #a86775; color: white; border-color: transparent; }
</style>