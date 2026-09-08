<script lang="ts">
  /**
   * Prompt 卡片：正向 / 反向 prompt 通用容器。
   *
   * 设计：
   * - 标题区显示「正向 Prompt / 反向 Prompt」+ 字数 + 行数 + 复制按钮。
   * - 内容支持折叠（默认 max-h-32，展开 max-h-96）。
   * - 双击卡片 / 单击复制按钮 → 复制并通过 onCopy 回调通知外层 toast。
   */
  import { copyText } from "../lib/ws";
  import Icon from "./Icon.svelte";

  interface Props {
    title: string;
    text: string;
    /** 复制成功的提示文本（用于外层 toast）。 */
    copyLabel: string;
    /** 通知外层做 toast / 视觉反馈；true=成功，false=失败。 */
    onCopy?: (ok: boolean) => void;
    /** 初始是否展开（默认 false，长 prompt 默认折叠）。 */
    initiallyExpanded?: boolean;
  }

  let {
    title,
    text,
    copyLabel,
    onCopy,
    initiallyExpanded = false,
  }: Props = $props();

  let expanded = $state.raw(initiallyExpanded);

  const chars = $derived(text ? text.length : 0);
  const lines = $derived(text ? text.split(/\r?\n/).length : 0);

  async function copy() {
    if (!text) return;
    const ok = await copyText(text);
    onCopy?.(ok);
  }

  function toggle() {
    expanded = !expanded;
  }
</script>

<section class="prompt-card">
  <header class="flex items-center gap-2 text-[11px]">
    <button
      type="button"
      class="flex items-center gap-1 text-muted hover:text-zinc-200"
      onclick={toggle}
      aria-expanded={expanded}
    >
      <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
      <span class="tracking-wider uppercase">{title}</span>
    </button>
    <span class="text-muted">· {chars} 字 {lines} 行</span>
    <span class="ml-auto flex items-center gap-1">
      <button
        type="button"
        class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border hover:bg-surface-3 text-muted hover:text-zinc-200 disabled:opacity-40 disabled:hover:bg-transparent"
        onclick={copy}
        disabled={!text}
        title="复制"
        aria-label={`复制 ${title}`}
      >
        <Icon name="copy" size={11} />
        <span>复制</span>
      </button>
    </span>
  </header>
  {#if expanded}
    <div
      class="prompt-box bg-surface-2 border border-border rounded-md p-2 mt-1.5 max-h-96 overflow-y-auto"
      ondblclick={copy}
      onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copy(); } }}
      role="button"
      tabindex="0"
      title="双击或回车复制"
    >
      {text || "（空）"}
    </div>
  {:else}
    <button
      type="button"
      class="prompt-box bg-surface-2 border border-border rounded-md p-2 mt-1.5 max-h-16 overflow-hidden text-left w-full text-muted hover:text-zinc-200"
      onclick={toggle}
      title="点击展开"
    >
      {text || "（空）"}
    </button>
  {/if}
</section>

