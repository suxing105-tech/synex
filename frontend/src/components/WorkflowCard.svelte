<script lang="ts">
  /**
   * ComfyUI 工作流 JSON 卡片（图片与视频共用）。
   *
   * 这段原来长在 DetailPanel 的图片分支里。ComfyUI 也会把整份画布写进它导出的
   * 视频容器（mp4 的 workflow tag，或 comment 里的 JSON），视频读得出来却没有出口，
   * 所以抽成组件两边复用。
   */
  interface Props {
    workflow: string;
    /** 用来拼下载文件名（去扩展名后加 .workflow.json）。 */
    filename: string;
  }

  let { workflow, filename }: Props = $props();

  function download() {
    const blob = new Blob([workflow], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename.replace(/\.[^.]+$/, "")}.workflow.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
</script>

<button type="button" class="workflow-download" onclick={download}>
  <span>下载工作流</span>
</button>

<style>
  .workflow-download { display:flex; align-items:center; justify-content:center; width:100%; padding:9px 10px; border:1px solid var(--accent); border-radius:6px; background:var(--accent); color:var(--accent-ink); font-size:12px; font-weight:600; text-align:center; cursor:pointer; }
  .workflow-download:hover { background:color-mix(in srgb, var(--accent) 86%, white); border-color:color-mix(in srgb, var(--accent) 86%, white); }
</style>
