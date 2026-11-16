<script lang="ts">
  /**
   * Prompt 卡片：正向 / 反向 prompt 通用容器。
   *
   * 设计：
   * - 标题区显示提示词名称与复制按钮。
   * - 内容支持折叠（默认 max-h-16，展开 max-h-96）。
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
  <header class="flex items-center gap-2 text-2xs">
    <button
      type="button"
      class="flex items-center gap-1 text-muted hover:text-zinc-200"
      onclick={toggle}
      aria-expanded={expanded}
      title={expanded ? "收起全文" : "展开全文"}
    >
      <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
      <span class="section-title is-card">{title}</span>
    </button>
    <span class="ml-auto flex items-center gap-1">
      <button
        type="button"
        class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-muted hover:bg-surface-3 hover:text-zinc-100 disabled:opacity-40 disabled:hover:bg-transparent"
        onclick={copy}
        disabled={!text}
        title="复制"
        aria-label={`复制 ${title}`}
      >
        <Icon name="copy" size={12} />
        <span>复制</span>
      </button>
    </span>
  </header>
  {#if expanded}
    <div
      class="prompt-box mt-2 rounded-md border border-border p-2 max-h-96 overflow-y-auto"
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
      class="prompt-box mt-2 rounded-md border border-border p-2 max-h-16 overflow-hidden text-left w-full text-muted hover:text-zinc-200"
      onclick={toggle}
      aria-expanded={expanded}
      title="展开全文"
    >
      {text || "（空）"}
    </button>
  {/if}
</section>

