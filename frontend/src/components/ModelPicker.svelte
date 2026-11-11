<script lang="ts">
  /**
   * 反推面板用的模型下拉：左列挑服务商，右列挑它报回来的模型。
   *
   * 为什么不再是「一条配置＝一个模型」那种平铺下拉：Key 与模型分家之后，配置只保证
   * 「这一家能连上」，用哪个模型是发请求那一刻的选择。两列摆在一起，一眼就能看出
   * 「哪家还没配 Key」「这家有哪些模型」，不用在两个页面之间来回跳。
   *
   * 清单是服务商自己报的，随时可能拉不到，所以右列底下永远留一条直接输入模型 ID 的路。
   */
  import { reverseApi, errorMessage, modelConfigs, rememberConfigModel } from "../lib/reverse-prompts";
import Icon from "./Icon.svelte";
  import type { ProviderModel } from "../lib/reverse-prompts";

  type List = { items: ProviderModel[]; reason: string; error: string; loading: boolean };

  let {
    value = null,
    model = "",
    label = "反推模型",
    disabled = false,
    onpick = () => {},
  }: {
    value?: number | null;
    model?: string;
    label?: string;
    disabled?: boolean;
    onpick?: (configId: number, model: string) => void;
  } = $props();

  let open = $state(false);
  let preview = $state<number | null>(null);   // 左列当前停在哪一家
  let lists: Record<number, List> = $state({});
  let manual = $state("");
  let busy = $state(false);
  let writeError = $state("");
  let root = $state<HTMLDivElement | null>(null);
  let trigger = $state<HTMLButtonElement | null>(null);
  let pos = $state({ left: 8, top: 8, width: 320, up: false });

  const configs = $derived($modelConfigs);
  const chosen = $derived(configs.find(item => item.id === value) ?? null);
  const previewConfig = $derived(configs.find(item => item.id === preview) ?? null);
  const previewList = $derived(preview !== null ? lists[preview] : undefined);
  /** 挑好了只显模型名（跟参考里那个下拉一样）；没挑就报「哪家 + 还差一步」。 */
  const text = $derived(model || (chosen ? chosen.name + " · 挑一个模型" : "选择模型"));
  const title = $derived(chosen ? (model ? chosen.name + " · " + model : chosen.name) : "先挑服务商，再挑模型");
  const popStyle = $derived("left:" + pos.left + "px; top:" + pos.top + "px; width:" + pos.width + "px;"
    + (pos.up ? " transform: translateY(-100%);" : ""));

  const avatar = (name: string) => (name.trim().slice(0, 2) || "?").toUpperCase();

  function place() {
    const rect = trigger?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(rect.width, 320);
    const room = window.innerHeight - rect.bottom - 14;
    const up = room < 280 && rect.top > 296;   // 底下放不下就往上翻，别让用户滚着找
    pos = {
      left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8)),
      top: up ? rect.top - 6 : rect.bottom + 6,
      width,
      up,
    };
  }

  async function load(id: number) {
    if (lists[id]) return;
    lists = { ...lists, [id]: { items: [], reason: "", error: "", loading: true } };
    try {
      const out = await reverseApi.configModels(id);
      lists = { ...lists, [id]: { items: out.models, reason: out.reason ?? "", error: "", loading: false } };
    } catch (e) {
      lists = { ...lists, [id]: { items: [], reason: "", error: errorMessage(e), loading: false } };
    }
  }

  async function enter(id: number | null) {
    preview = id;
    manual = "";
    if (id !== null) await load(id);
  }

  async function toggle() {
    if (open) { open = false; return; }
    writeError = "";
    open = true;
    const first = value ?? configs.find(item => item.has_api_key)?.id ?? configs[0]?.id ?? null;
    await enter(first);
    place();
  }

  /** 选中即落库：这一家当前用哪个模型是全局的一件事，两个面板读同一份。 */
  async function pick(id: string) {
    const picked = id.trim();
    if (preview === null || !picked || busy) return;
    busy = true; writeError = "";
    try {
      await rememberConfigModel(preview, picked);
      onpick(preview, picked);
      open = false;
    } catch (e) {
      writeError = errorMessage(e);
    } finally {
      busy = false;
    }
  }

  function gotoSettings() {
    open = false;
    window.dispatchEvent(new CustomEvent("open-model-settings"));
  }

  // 弹出层是 fixed 定位（外面那层滚动容器会裁掉 absolute 的子元素），所以滚动/缩放时直接收起，
  // 不让它浮在错误的位置上。
  $effect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && root?.contains(target)) return;
      open = false;
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") open = false; };
    const onClose = () => { open = false; };
    window.addEventListener("click", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("click", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  });
</script>

<div class="mp" bind:this={root}>
  <button bind:this={trigger} class="mp-trigger" type="button" {disabled} aria-label={label}
          aria-haspopup="dialog" aria-expanded={open} {title} onclick={() => void toggle()}>
    <span class="mp-text">{text}</span>
    <span class="mp-arrow"><Icon name="chevron-down" size={12} /></span>
  </button>
  {#if open}
    <div class="mp-pop" role="dialog" aria-label="选择服务商与模型" style={popStyle}>
      <div class="mp-cols">
        <div class="mp-providers" aria-label="服务商">
          {#each configs as item (item.id)}
            <button class="mp-provider" class:mp-on={item.id === preview} type="button"
                    aria-current={item.id === preview} onclick={() => void enter(item.id)}>
              <span class="mp-avatar" aria-hidden="true">{avatar(item.name)}</span>
              <span class="mp-pname">{item.name}</span>
              {#if !item.has_api_key}<span class="mp-tag mp-warn">需配置</span>{/if}
            </button>
          {/each}
          {#if !configs.length}<p class="mp-empty">还没有服务商，先去设置里配一把 Key。</p>{/if}
        </div>
        <div class="mp-models" aria-label="模型">
          {#if previewList?.loading}
            <p class="mp-empty">正在读这家的模型清单…</p>
          {:else if previewList?.error}
            <p class="mp-empty">{previewList.error}</p>
          {:else if previewList?.items.length}
            {#each previewList.items as item (item.id)}
              <button class="mp-model" class:mp-on={item.id === model && preview === value} type="button"
                      aria-current={item.id === model && preview === value} onclick={() => void pick(item.id)}>
                <span class="mp-mname">{item.label}</span>
                {#if item.recommended}<span class="mp-tag mp-rec">推荐</span>{/if}
              </button>
            {/each}
          {:else if previewList?.reason}
            <p class="mp-empty">{previewList.reason}</p>
          {:else if previewConfig}
            <p class="mp-empty">这家没报回模型清单，直接在下面输入模型 ID 也行。</p>
          {/if}
          {#if previewConfig}
            <div class="mp-manual">
              <input class="mp-input" aria-label="直接输入模型 ID" placeholder="或直接输入模型 ID" bind:value={manual}
                     onkeydown={(event) => { if (event.key === "Enter") void pick(manual); }} />
              <button class="mp-use" type="button" disabled={busy || !manual.trim()} onclick={() => void pick(manual)}>用</button>
            </div>
          {/if}
          {#if previewConfig && !previewConfig.has_api_key}
            <button class="mp-goto" type="button" onclick={gotoSettings}>这把 Key 还没配，去设置</button>
          {/if}
          {#if writeError}<p class="mp-error" role="alert">{writeError}</p>{/if}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .mp { position: relative; min-width: 0; flex: 1; }
  .mp-trigger {
    display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0;
    font-size: 11px; padding: 5px 8px; border: 1px solid #3f3f46; border-radius: 5px;
    background: #202024; color: inherit; text-align: left;
  }
  .mp-trigger:disabled { opacity: .5; cursor: default; }
  .mp-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mp-arrow { display: inline-flex; flex: none; }
  /* fixed + 由 JS 定坐标：外层面板是 overflow 滚动容器，absolute 的浮层会被裁掉半截。 */
  .mp-pop {
    position: fixed; z-index: 60; background: #18181b; border: 1px solid #3f3f46; border-radius: 8px;
    box-shadow: 0 12px 28px rgba(0, 0, 0, .55); overflow: hidden;
  }
  .mp-cols { display: flex; align-items: stretch; }
  .mp-providers { width: 124px; flex: none; max-height: 272px; overflow: auto; padding: 4px; border-right: 1px solid #27272a; }
  .mp-models { flex: 1; min-width: 0; max-height: 272px; overflow: auto; padding: 4px; }
  .mp-provider, .mp-model {
    display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
    font-size: 11px; padding: 5px 6px; border: 0; border-radius: 5px; background: transparent; color: #e4e4e7;
  }
  .mp-provider:hover, .mp-model:hover { background: #26262b; }
  .mp-on { background: #2f2f35; }
  .mp-avatar {
    width: 18px; height: 18px; flex: none; border-radius: 4px; background: #3f3f46;
    font-size: 9px; display: flex; align-items: center; justify-content: center; color: #a1a1aa;
  }
  .mp-pname, .mp-mname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mp-tag { flex: none; font-size: 9px; padding: 1px 4px; border-radius: 4px; background: #27272a; color: #a1a1aa; }
  .mp-rec { color: #4ade80; border: 1px solid #14532d; }
  .mp-warn { color: #fbbf24; border: 1px solid #78350f; }
  .mp-empty { font-size: 10px; line-height: 1.5; color: #a1a1aa; padding: 6px; margin: 0; }
  .mp-manual { display: flex; gap: 4px; padding: 4px; border-top: 1px solid #27272a; margin-top: 4px; }
  .mp-input {
    flex: 1; min-width: 0; font-size: 11px; padding: 4px 6px; color: #e4e4e7;
    background: #202024; border: 1px solid #3f3f46; border-radius: 5px;
  }
  .mp-use, .mp-goto { font-size: 11px; padding: 4px 8px; border: 1px solid #3f3f46; border-radius: 5px; background: #202024; color: #e4e4e7; }
  .mp-use:disabled { opacity: .5; cursor: default; }
  .mp-goto { display: block; width: calc(100% - 8px); margin: 4px; color: #fbbf24; }
  .mp-error { font-size: 10px; color: #f87171; padding: 4px 6px; margin: 0; }
</style>
