<script lang="ts">
  /**
   * 参数卡片：按域分组展示 sampler / model / lora / size / other。
   *
   * 设计：
   * - 默认展开所有非 lora 组；lora 单独成组且优先展示（detail 主诉求）。
   * - 长值 ellipsis + tooltip；单击值复制。
   * - seed 单列高亮（等宽 + 复制按钮）。
   */
  import { copyText } from "../lib/ws";
  import Icon from "./Icon.svelte";
  import { groupParams, truncateValue, formatWeight, type ParamGroup } from "../lib/params";

  interface Props {
    /** detail.parameters */
    parameters: Record<string, unknown>;
    /** detail 顶层字段，用于补全并去重 */
    detail: {
      sampler?: string | null;
      steps?: number | null;
      cfg?: number | null;
      seed?: number | null;
      model?: string | null;
      width?: number | null;
      height?: number | null;
    };
    /** LoRA 列表（由父组件传入 prompt + parameters 抽取结果） */
    loras: Array<{ name: string; weight: number }>;
    onCopy?: (ok: boolean) => void;
  }

  let { parameters, detail, loras, onCopy }: Props = $props();

  const groups = $derived<ParamGroup[]>(buildGroups(parameters, detail, loras));

  async function copy(text: string) {
    if (!text) return;
    const ok = await copyText(text);
    onCopy?.(ok);
  }

  function buildGroups(
    parameters: Record<string, unknown>,
    detail: Props["detail"],
    loras: Props["loras"],
  ): ParamGroup[] {
    const base = groupParams(parameters, detail);
    if (loras.length === 0) return base;
    // 插入 LoRA 组到 sampler 之后
    const idx = base.findIndex((g) => g.id === "sampler");
    const loraGroup: ParamGroup = {
      id: "lora",
      label: "LoRA",
      entries: loras.map((l) => [l.name, formatWeight(l.weight)]),
    };
    const next = [...base];
    next.splice(idx + 1, 0, loraGroup);
    return next;
  }

</script>

<section class="params-card space-y-3">
  {#each groups as g (g.id)}
    <div class="border border-border rounded-md">
      <div class="px-2 py-1 text-[11px] uppercase text-muted tracking-wider bg-surface-2 border-b border-border rounded-t-md">
        {g.label}
      </div>
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 p-2 text-[12px]">
        {#each g.entries as [k, v]}
          {#if k === "seed"}
            <dt class="text-muted">seed</dt>
            <dd class="font-mono flex items-center gap-1">
              <span class="truncate">{v}</span>
              <button
                type="button"
                class="opacity-50 hover:opacity-100 hover:text-accent"
                title="复制 seed"
                aria-label="复制 seed"
                onclick={() => copy(v)}
              >
                <Icon name="copy" size={11} />
              </button>
            </dd>
          {:else}
            <dt class="text-muted">{k}</dt>
            <dd class="font-mono">
              <span title={v} class="break-all">{truncateValue(v, 32)}</span>
            </dd>
          {/if}
        {/each}
      </dl>
    </div>
  {/each}
  {#if groups.length === 0}
    <div class="text-[12px] text-muted italic">没有可识别的参数</div>
  {/if}
</section>
