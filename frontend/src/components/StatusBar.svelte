<script lang="ts">
  /**
   * 底部状态栏（方案 3 · 生产力工作台第一批，2026-11-06）。
   *
   * 只放「环境层」的信息：ComfyUI 连没连上、ffmpeg 在不在、库在哪个目录、库里有多少条。
   * 刻意不放筛选和已选——那两样顶部工具条已经说了（Feed 的 toolbar-info），
   * 同一条信息在上下两处各写一遍，早晚有一处说不准。扫描进度同理，
   * ScanProgressBar 已经在顶部管着它，这里不重复占位。
   *
   * 这一行为什么值得占：ffmpeg 缺失时海报帧、波形、视频里的 ComfyUI 提示词全是空的，
   * 但视频照样能播（AGENTS.md §7.2），用户只会以为程序坏了。让它一直摆在明面上。
   */
  import { onMount } from "svelte";
  import { comfyuiEnabled, comfyuiStatus, stats } from "../lib/stores";
  import { healthApi } from "../lib/api";
  import { describeMediaTools } from "../lib/media-tools";
  import { isTauri, getSidecarStatus } from "../lib/tauri";
  import type { MediaToolsStatus } from "../lib/types";
  import Icon from "./Icon.svelte";

  let mediaTools = $state<MediaToolsStatus | null>(null);
  let dataDir = $state<string>("");

  const tools = $derived(describeMediaTools(mediaTools));
  const totalLib = $derived(
    $stats.total_images + $stats.total_videos + $stats.total_audio + $stats.total_texts,
  );

  const comfyText = $derived(
    !$comfyuiEnabled
      ? "ComfyUI 已停用"
      : $comfyuiStatus.running
        ? "ComfyUI 已连接"
        : "ComfyUI 未连接",
  );
  const comfyTone = $derived(
    !$comfyuiEnabled ? "off" : $comfyuiStatus.running ? "on" : "bad",
  );
  const comfyTitle = $derived(
    !$comfyuiEnabled
      ? "设置里关掉了 ComfyUI 集成，工作流与再次创作不可用"
      : $comfyuiStatus.running
        ? $comfyuiStatus.url
        : $comfyuiStatus.url + "｜" + ($comfyuiStatus.reason || "还没有探测记录"),
  );

  // 后端还没答话时给中性灰点，别先亮一个红灯吓人——那一瞬间什么都是「缺」的。
  const toolsTone = $derived(!mediaTools ? "" : tools.ok ? "on" : "bad");
  const toolsLabel = $derived(
    !mediaTools ? "正在检查 ffmpeg…" : tools.ok ? "ffmpeg 就绪" : tools.text,
  );
  const toolsHint = $derived(
    !mediaTools ? "后端还没回媒体组件的状态" : tools.ok ? tools.text : tools.hint,
  );

  // Windows 和 POSIX 两种分隔符都要认：数据目录在 exe 所在盘根时是反斜杠。
  const dirName = $derived(
    dataDir
      .split(/[\\/]/)
      .filter((seg) => seg.length > 0)
      .pop() ?? "",
  );

  onMount(() => {
    void (async () => {
      try {
        const h = await healthApi.get();
        mediaTools = h.media_tools ?? null;
      } catch {
        // 后端没答上来就停在「正在检查」，别亮一个假的绿灯
      }
    })();
    if (isTauri()) {
      void (async () => {
        try {
          const s = await getSidecarStatus();
          if (s?.data_dir) dataDir = s.data_dir;
        } catch {
          /* 读不到就不显示这一格 */
        }
      })();
    }
  });
</script>

<footer class="status-bar" aria-label="运行状态">
  <div class="group">
    <span class="dot {comfyTone}" aria-hidden="true"></span>
    <span class="label" title={comfyTitle}>{comfyText}</span>
  </div>

  <div class="group">
    <span class="dot {toolsTone}" aria-hidden="true"></span>
    <span class="label" title={tools.ok ? tools.text : toolsHint}>{toolsLabel}</span>
  </div>

  <span class="spacer"></span>

  {#if totalLib > 0}
    <div class="group" title="库内已索引条目合计">
      <Icon name="layers" size={11} />
      <span class="num">{totalLib.toLocaleString("en-US")}</span>
      <span class="unit">项</span>
    </div>
  {/if}

  {#if dirName}
    <div class="group" title={dataDir}>
      <Icon name="folder" size={11} />
      <span class="dir">{dirName}</span>
    </div>
  {/if}
</footer>

<style>
  /* 28px：比顶栏工具条明显矮一档，读起来是「收尾信息」而不是又一条工具条。 */
  .status-bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 14px;
    height: 28px;
    padding: 0 12px;
    border-top: 1px solid var(--line);
    background: var(--ink-1);
    color: var(--text-3);
    font-size: var(--fs-2xs);
    line-height: 1;
    user-select: none;
  }
  .group {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
  }
  .spacer { flex: 1 1 auto; }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: none;
    background: var(--ink-5);
  }
  .dot.on { background: var(--success); }
  .dot.bad { background: var(--danger); }
  .num {
    font-variant-numeric: tabular-nums;
    color: var(--text-2);
  }
  .dir {
    max-width: 16ch;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
</style>
