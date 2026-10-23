<script lang="ts">
  /**
   * ComfyUI 工作流 JSON 卡片（图片与视频共用）。
   *
   * 这段原来长在 DetailPanel 的图片分支里。ComfyUI 也会把整份画布写进它导出的
   * 视频容器（mp4 的 workflow tag，或 comment 里的 JSON），视频读得出来却没有出口，
   * 所以抽成组件两边复用。
   */
  import Icon from "./Icon.svelte";

  interface Props {
    workflow: string;
    /** 用来拼下载文件名（去扩展名后加 .workflow.json）。 */
    filename: string;
    copy: (text: string, label: string) => void;
    notify: (msg: string, kind?: "info" | "success" | "error") => void;
  }

  let { workflow, filename, copy, notify }: Props = $props();

  const bytes = $derived(workflow ? new Blob([workflow]).size : 0);
  const nodeCount = $derived.by(() => {
    try {
      const o = JSON.parse(workflow);
      if (o && typeof o === "object") {
        // ComfyUI workflow 用 "nodes" 数组；API 格式用对象键
        if (Array.isArray(o.nodes)) return o.nodes.length;
        return Object.keys(o).length;
      }
    } catch {
      /* 不是合法 JSON 就只显示字节数 */
    }
    return 0;
  });

  function copyFormatted() {
    try {
      const formatted = JSON.stringify(JSON.parse(workflow), null, 2);
      navigator.clipboard?.writeText(formatted).then(
        () => notify("已复制（格式化后）"),
        () => notify("复制失败"),
      );
    } catch {
      notify("JSON 解析失败");
    }
  }

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

<section>
  <h4 class="text-[11px] uppercase text-muted mb-1.5 tracking-wider">Workflow JSON</h4>
  <details class="bg-surface-2 border border-border rounded-md">
    <summary class="cursor-pointer text-[12px] text-muted hover:text-zinc-200 px-2 py-1.5 flex items-center gap-2 select-none">
      <Icon name="chevron-right" size={11} />
      <span class="flex-1">
        {nodeCount > 0 ? `${nodeCount} 节点` : "查看"}
        {#if bytes > 0}
          · {(bytes / 1024).toFixed(1)} KB
        {/if}
      </span>
    </summary>
    <div class="px-2 pb-2 flex items-center gap-1">
      <button
        type="button"
        class="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-surface-3 inline-flex items-center gap-1"
        onclick={() => copy(workflow, "Workflow JSON")}
      >
        <Icon name="copy" size={10} />复制
      </button>
      <button
        type="button"
        class="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-surface-3 inline-flex items-center gap-1"
        onclick={copyFormatted}
      >
        <Icon name="code" size={10} />格式化并复制
      </button>
      <button
        type="button"
        class="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-surface-3 inline-flex items-center gap-1"
        onclick={download}
      >
        <Icon name="download" size={10} />下载
      </button>
    </div>
    <pre class="prompt-box border-t border-border p-2 max-h-48 overflow-y-auto">{workflow}</pre>
  </details>
</section>