<script lang="ts">
  /**
   * 右侧栏「队列」那一页（方案 3 · 生产力工作台第三批，2026-11-11）。
   *
   * 按「现在要不要看着它 / 要不要动手 / 东西去哪了」回答三个问题：
   *   1. 现在这一条跑到哪一步——读全局 cloneJob（WS 的 clone_progress 与 jobs/current 都汇到它）；
   *   2. 有没有一条云端任务钱花了、产物还没回来——GET /api/clone/cloud/pending，只在这一页露着时取；
   *   3. 这一轮跑出来的批次去哪了——读 cloneHistory，点缩略图直接回图库看那一张。
   *
   * 三条都是一个真源读一遍：不自己数进度、不自己拼缩略图地址、不另开一条状态通路。
   *
   * 后端同一时刻只允许一条任务在跑（clone_jobs.CloneBusy 就是这条规矩），所以这一页没有「排队中」：
   * 画一条假的排队列表比不画更坏——用户会以为多提交几次会轮着跑，实际后一次直接被 409 拒掉。
   */
  import { backendUrl } from "../lib/backend-url";
  import { refreshFeed } from "../lib/stores";
  import { pushToast } from "../lib/toast";
  import { footerTimeLabel } from "../lib/media-format";
  import {
    applyCloneProgress,
    cloneApi,
    cloneHistory,
    cloneJob,
    cloneOutputsOf,
    cloneStatusLabel,
    cloudApi,
    coinsLabel,
    formatElapsed,
    stateLabel,
  } from "../lib/clone";
  import type { CloneOutput, CloudPendingTask } from "../lib/clone";
  import Icon from "./Icon.svelte";

  interface Props {
    /** 这一页露不露着。云端待取回那份只在露着的时候取，不打开就不发请求。 */
    active?: boolean;
  }
  let { active = true }: Props = $props();

  const job = $derived($cloneJob);
  const outputs = $derived(cloneOutputsOf(job));
  const engineLabel = $derived(job.engine === "cloud" ? "云端 · " + (job.provider || "API") : "本机 · ComfyUI");
  /**
   * 跑完的不再占上面那一格：同一件事在「本次运行」里已经有一条，两处都写会让人以为还有活没完。
   * 留在上面的只有需要动手的——跑挂了的那条，和云端那种「按了停止但钱已经付了、产物还能取回」。
   */
  const attention = $derived(
    job.active && !job.running && (job.state === "error" || (job.state === "cancelled" && job.recoverable)),
  );

  /** 四条阶段名，短到能在三百来像素宽的面板里排成一排；某一条在云端叫什么由 stateLabel 那行说。 */
  const STAGES = [
    { key: "uploading", label: "上传" },
    { key: "queued", label: "提交" },
    { key: "running", label: "生成" },
    { key: "downloading", label: "取回" },
  ];
  const stageAt = $derived(STAGES.findIndex((s) => s.key === job.state));

  let pending = $state<CloudPendingTask[]>([]);
  let refetching = $state<number | null>(null);

  const counterFor = (kind: string) => (kind === "video" || kind === "audio" ? "条" : "张");
  const thumbOf = (o: CloneOutput) => (o.thumbnail_url ? backendUrl(o.thumbnail_url) : "");
  const costOf = (coins: number | null) => (coins === null ? "" : " · 花 " + coinsLabel(coins));

  // 每次这一页被翻开取一次：effect 只读 active，切走再切回来正好一趟，不轮询。
  $effect(() => {
    if (!active) return;
    let alive = true;
    cloudApi
      .pending()
      .then((r) => {
        if (alive) pending = r.items ?? [];
      })
      .catch(() => {
        if (alive) pending = [];
      });
    return () => {
      alive = false;
    };
  });

  /** 停止等待：本机就是不再等了；云端那句由 cloneStatusLabel 说清楚——钱已经付了，产物还能取。 */
  async function cancel() {
    try {
      applyCloneProgress(await cloneApi.cancelJob());
    } catch (e) {
      pushToast("取消失败：" + ((e as Error).message || String(e)));
    }
  }

  /**
   * 云端「取回结果」：只重新查一次那条任务，绝不重新提交——重新提交就是二次扣费
   * （这条规矩在 CloneModal 的取回里已经立过，这里只补一句：取回来的东西得让图库重拉一次，
   * 不然新图已经落库了，中间那栏还空着，用户会以为白跑一趟）。
   */
  async function refetch(rowId: number) {
    refetching = rowId;
    try {
      const back = await cloudApi.refetch(rowId);
      pending = pending.filter((x) => x.id !== rowId);
      await refreshFeed({ keepScroll: true });
      pushToast("取回来了 · 已收进图库 " + back.count + " 份", { kind: "success" });
    } catch (e) {
      pushToast("取回失败：" + ((e as Error).message || String(e)), { kind: "error" });
    } finally {
      refetching = null;
    }
  }

  /** 点产出缩略图 = 回图库看那一张，手势与详情栏的缩略图一致。音频没有对应弹层，所以不给按钮。 */
  function openOutput(o: CloneOutput) {
    if (o.kind === "video") {
      window.dispatchEvent(new CustomEvent("open-video-player", { detail: { id: o.id } }));
      return;
    }
    window.dispatchEvent(new CustomEvent("open-lightbox", { detail: { id: o.id } }));
  }
</script>

<div class="queue space-y-3">
  {#if job.running}
    <section class="queue-card" aria-label="正在生成的任务">
      <div class="queue-head">
        <span class="queue-engine"><Icon name={job.engine === "cloud" ? "cloud" : "comfyui"} size={12} />{engineLabel}</span>
        <span class="queue-elapsed" title="从提交这一刻算起">{formatElapsed(job.elapsed)}</span>
      </div>
      <p class="queue-state">{stateLabel(job)}</p>
      <div class="queue-stages" role="list">
        {#each STAGES as stage, i}
          <span class="queue-stage" class:is-on={i === stageAt} class:is-done={stageAt > i} role="listitem">{stage.label}</span>
        {/each}
      </div>
      <div class="queue-bar" aria-hidden="true"><span class="queue-bar-run"></span></div>
      {#if job.message}<p class="queue-msg">{job.message}</p>{/if}
      {#if outputs.length}
        <div class="queue-outs">
          {#each outputs.slice(0, 8) as o}
            {#if thumbOf(o)}
              <img src={thumbOf(o)} alt={o.filename} loading="lazy" class="queue-out" />
            {:else}
              <span class="queue-out queue-out-empty"><Icon name="image" size={14} /></span>
            {/if}
          {/each}
        </div>
      {/if}
      <button type="button" class="queue-cancel" onclick={cancel}><Icon name="x" size={12} />停止等待</button>
    </section>
  {:else if attention}
    <section class="queue-card is-bad" aria-label="上一条需要你处理的生成">
      <p class="queue-state">{cloneStatusLabel(job) || "上一条生成没有跑完"}</p>
      {#if job.error}<p class="queue-msg">{job.error}</p>{/if}
      {#if job.recoverable && job.task_row_id}
        <button type="button" class="queue-btn" onclick={() => void refetch(job.task_row_id as number)}>
          <Icon name="download" size={12} />取回结果
        </button>
      {/if}
    </section>
  {/if}

  {#if pending.length}
    <!-- 钱已经花了、产物还挂在会过期的链接上：这个入口必须一直在，别等链接过期才发现没地方点 -->
    <section class="queue-block">
      <h4 class="queue-label">云端待取回</h4>
      {#each pending as task}
        <div class="queue-row">
          <div class="queue-row-main">
            <span class="queue-row-title">{task.state_label || task.state} · {task.model || task.capability}</span>
            <span class="queue-row-sub">{task.cost_coins === null ? "花费未实测" : "已花 " + coinsLabel(task.cost_coins)}</span>
          </div>
          <button type="button" class="queue-btn" disabled={refetching === task.id} onclick={() => void refetch(task.id)}>
            <Icon name="download" size={12} />{refetching === task.id ? "取回中…" : "取回结果"}
          </button>
        </div>
      {/each}
    </section>
  {/if}

  <section class="queue-block">
    <h4 class="queue-label">本次运行</h4>
    {#if $cloneHistory.length}
      {#each $cloneHistory as entry}
        <div class="queue-row">
          <div class="queue-thumbs">
            {#each entry.outputs.slice(0, 4) as o}
              {#if o.kind === "image" || o.kind === "video"}
                <button
                  type="button"
                  class="queue-out-btn"
                  title={o.filename || "看这一张"}
                  aria-label={"看 " + (o.filename || "这一张") + " 产出"}
                  onclick={() => openOutput(o)}
                >
                  {#if thumbOf(o)}
                    <img src={thumbOf(o)} alt="" loading="lazy" class="queue-out" />
                  {:else}
                    <Icon name={o.kind === "video" ? "video" : "image"} size={14} />
                  {/if}
                </button>
              {:else}
                <span class="queue-out-btn is-plain" title={o.filename || "音频产出"}><Icon name="music" size={14} /></span>
              {/if}
            {/each}
          </div>
          <div class="queue-row-main">
            <span class="queue-row-title">{entry.outputs.length} {counterFor(entry.mediaKind)} · {entry.engine === "cloud" ? "云端" : "本机"}</span>
            <span class="queue-row-sub">{footerTimeLabel(entry.at / 1000)}{costOf(entry.costCoins)}</span>
          </div>
        </div>
      {/each}
    {:else if !job.running && !attention && !pending.length}
      <div class="queue-empty">
        <Icon name="wand" size={20} />
        <p>这一轮还没跑过生成</p>
        <p class="queue-hint">在卡片右下角点「再次创作」跑一批，进度和跑完的批次都会留在这里。</p>
      </div>
    {/if}
  </section>
</div>

<style>
  .queue { padding: 0; }
  .queue-card {
    border: 1px solid var(--line);
    border-radius: var(--r-2);
    background: var(--ink-2);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .queue-card.is-bad {
    border-color: rgb(var(--danger-rgb) / 45%);
    background: rgb(var(--danger-rgb) / 8%);
  }
  .queue-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .queue-engine {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: var(--fs-2xs); color: var(--text-2);
    padding: 2px 6px; border-radius: var(--r-pill);
    background: var(--raise-1);
  }
  .queue-elapsed { font-size: var(--fs-2xs); color: var(--text-3); font-variant-numeric: tabular-nums; }
  .queue-state { font-size: var(--fs-sm); color: var(--text-1); }
  .queue-msg { font-size: var(--fs-xs); color: var(--text-2); line-height: 1.5; word-break: break-word; }
  .queue-stages { display: flex; gap: 4px; }
  .queue-stage {
    flex: 1; text-align: center; padding: 3px 0;
    font-size: var(--fs-2xs); border-radius: var(--r-1);
    background: var(--raise-1); color: var(--text-3);
  }
  .queue-stage.is-done { background: var(--raise-2); color: var(--text-2); }
  .queue-stage.is-on { background: var(--accent); color: var(--accent-ink); font-weight: 600; }
  /* 后端没有百分比（ComfyUI 那边拿不到稳定的进度号），所以这条是不定长的走带动条，
     不画假百分比：画成 40% 那种，跑十分钟不动就会以为卡死。 */
  .queue-bar { position: relative; height: 3px; border-radius: var(--r-pill); background: var(--raise-1); overflow: hidden; }
  .queue-bar-run {
    position: absolute; inset: 0 auto 0 0; width: 38%;
    border-radius: var(--r-pill); background: var(--accent);
    animation: queue-run 1.5s ease-in-out infinite;
  }
  @keyframes queue-run {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(262%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .queue-bar-run { animation: none; width: 100%; opacity: 0.6; }
  }
  .queue-outs, .queue-thumbs { display: flex; gap: 4px; flex-wrap: wrap; }
  .queue-out {
    width: 34px; height: 34px; object-fit: cover; display: block;
    border-radius: var(--r-1); background: var(--ink-0);
  }
  .queue-out-empty { display: flex; align-items: center; justify-content: center; color: var(--text-3); }
  .queue-out-btn {
    width: 34px; height: 34px; padding: 0; border: 0; border-radius: var(--r-1);
    background: var(--ink-0); color: var(--text-3); overflow: hidden; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  /* 详情栏的规矩：hover 只改底色，不加描边 */
  .queue-out-btn:hover { background: var(--ink-4); color: var(--text-1); }
  .queue-out-btn.is-plain { cursor: default; }
  .queue-out-btn.is-plain:hover { background: var(--ink-0); color: var(--text-3); }
  .queue-cancel, .queue-btn {
    align-self: flex-start;
    display: inline-flex; align-items: center; gap: 5px;
    height: var(--ctl-sm); padding: 0 9px;
    border: 1px solid var(--line); border-radius: var(--r-1);
    background: transparent; color: var(--text-2);
    font-size: var(--fs-xs); cursor: pointer;
  }
  .queue-cancel:hover, .queue-btn:hover { background: var(--ink-3); color: var(--text-1); }
  .queue-btn:disabled { opacity: 0.5; cursor: default; }
  .queue-block { display: flex; flex-direction: column; gap: 6px; }
  .queue-label { font-size: var(--fs-2xs); letter-spacing: 0.06em; color: var(--text-3); text-transform: uppercase; }
  .queue-row {
    display: flex; align-items: center; gap: 8px;
    padding: 6px; border: 1px solid var(--line-soft); border-radius: var(--r-2);
    background: var(--ink-2);
  }
  .queue-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .queue-row-title { font-size: var(--fs-xs); color: var(--text-1); }
  .queue-row-sub { font-size: var(--fs-2xs); color: var(--text-3); }
  .queue-empty {
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    padding: 18px 10px; text-align: center; color: var(--text-3);
    border: 1px dashed var(--line); border-radius: var(--r-2);
    font-size: var(--fs-xs);
  }
  .queue-hint { font-size: var(--fs-2xs); line-height: 1.6; color: var(--text-3); }
</style>
