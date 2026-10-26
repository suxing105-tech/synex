<script lang="ts">
  /**
   * 新建文本 / 另存副本：目录 + 文件名 + 格式。
   *
   * 「新建文本」在网格工具栏，「另存副本」在阅读层，两处共用这一份表单；
   * 组件只管收集输入，写盘由调用方做（要顺带刷新网格 / 打开阅读层，各自主张）。
   */
  import { modalFocus } from "../lib/modal-focus";
  import { selectTextPaths } from "../lib/tauri";

  interface Props {
    open: boolean;
    title?: string;
    defaultName?: string;
    defaultFormat?: string;
    defaultDirectory?: string;
    error?: string;
    busy?: boolean;
    onSubmit: (value: { directory: string; name: string; format: string }) => void | Promise<void>;
    onClose: () => void;
  }
  let {
    open,
    title = "新建文本",
    defaultName = "未命名.md",
    defaultFormat = "md",
    defaultDirectory = "",
    error = "",
    busy = false,
    onSubmit,
    onClose,
  }: Props = $props();

  // 初值走下面的 open 同步，别在这里捕获 prop：那样改名后再打开还是第一次的值。
  let name = $state("");
  let format = $state("md");
  let directory = $state("");
  let pickError = $state("");

  $effect(() => {
    if (!open) return;
    name = defaultName;
    format = defaultFormat;
    directory = defaultDirectory;
    pickError = "";
  });

  async function browse() {
    pickError = "";
    try {
      const picked = (await selectTextPaths(true))[0];
      if (picked) directory = picked;
    } catch (e) {
      pickError = e instanceof Error ? e.message : String(e);
    }
  }

  function submit() {
    if (!name.trim()) { pickError = "文件名不能为空"; return; }
    void onSubmit({ directory: directory.trim(), name: name.trim(), format });
  }
</script>

{#if open}
  <div class="text-modal-backdrop" role="presentation">
    <div class="text-modal" role="dialog" aria-modal="true" aria-label={title} tabindex="-1" use:modalFocus>
      <header><h2>{title}</h2><button onclick={onClose}>×</button></header>
      <p>新文件写在你选定的本地目录里，之后每次编辑都直接保存回原文件。</p>
      <label>
        保存目录
        <div class="row">
          <input aria-label="保存目录" placeholder="例如 C:\Users\suxing\Documents\笔记" bind:value={directory}/>
          <button type="button" onclick={() => void browse()}>浏览…</button>
        </div>
      </label>
      <label>
        文件名
        <input aria-label="文件名" bind:value={name} onkeydown={(e) => { if (e.key === "Enter") submit(); }}/>
      </label>
      <label>
        格式
        <select aria-label="文本格式" bind:value={format}>
          <option value="md">Markdown（.md）</option>
          <option value="txt">纯文本（.txt）</option>
          <option value="srt">字幕（.srt）</option>
          <option value="vtt">字幕（.vtt）</option>
        </select>
      </label>
      {#if pickError || error}<p class="error" role="alert">{pickError || error}</p>{/if}
      <div class="modal-actions">
        <button onclick={onClose}>取消</button>
        <button class="primary" disabled={busy || !name.trim()} onclick={submit}>{title === "另存副本" ? "创建副本" : "创建并编辑"}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .text-modal-backdrop { position: fixed; inset: var(--desktop-titlebar-height, 0px) 0 0; background: #0009; z-index: 90; display: flex; align-items: center; justify-content: center; padding: 25px; color: #dddce4; }
  .text-modal { width: 540px; max-width: 96vw; max-height: 90vh; overflow: auto; border: 1px solid #44404a; border-radius: 12px; background: #18181b; padding: 22px; box-shadow: 0 22px 90px #0008; font-size: 13px; }
  .text-modal header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
  .text-modal h2 { font-size: 18px; font-weight: 600; }
  .text-modal p { line-height: 1.8; margin: 12px 0; }
  .text-modal label { display: flex; flex-direction: column; gap: 7px; margin: 14px 0; font-size: 12px; }
  .text-modal .row { display: flex; gap: 8px; }
  .text-modal input, .text-modal select { background: #27272a; color: inherit; border: 1px solid #383941; border-radius: 6px; padding: 7px 9px; font-size: 13px; min-width: 0; flex: 1; }
  .text-modal button { cursor: pointer; border: 1px solid #49424c; border-radius: 6px; padding: 6px 12px; font-size: 12px; background: transparent; color: inherit; white-space: nowrap; }
  .text-modal button:hover:not(:disabled) { background: #323237; color: #fff; }
  .text-modal button:disabled { opacity: .45; cursor: default; }
  .text-modal .error { color: #f0a8a8; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 15px; }
  .primary { background: #a86775; color: white; border-color: transparent; }
</style>