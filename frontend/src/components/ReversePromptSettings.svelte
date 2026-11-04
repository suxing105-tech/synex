<script lang="ts">
  import { onMount } from "svelte";
  import { modelConfigs, refreshReverseConfig, reverseApi, reverseSettings, errorMessage } from "../lib/reverse-prompts";
  import type { ReverseSettings } from "../lib/reverse-prompts";
  import { H3_MODES, SEEDANCE_MODES, MODE_LABELS, videoPromptApi, videoPromptSettings, refreshVideoPromptSettings } from "../lib/video-prompts";
  import type { VideoPromptSettings } from "../lib/video-prompts";

  /**
   * 「反推指令」这一页只管两件事：默认服务商 + 两套指令怎么说。
   * 选厂商、填 Key 都在隔壁「模型API配置」——那半动的是服务商与凭据，
   * 这半动的只是话怎么说。混在一页时每次改个指令都要先滚过一整屏厂商卡片。
   */
  let preferences = $state<ReverseSettings | null>(null);
  let videoPrefs = $state<VideoPromptSettings | null>(null);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  // 两份偏好在两张卡片里各自渲染，所以任一半读失败都单独标记，卡片给「重新加载」而不是卡在「正在读取…」。
  let loadFailed = $state(false);
  async function run(action: () => Promise<void>) {
    busy = true; error = ""; notice = "";
    try { await action(); } catch (e) { error = errorMessage(e); } finally { busy = false; }
  }
  async function loadImagePart() {
    await refreshReverseConfig();
    preferences = $reverseSettings ? { ...$reverseSettings } : null;
  }
  async function loadVideoPart() {
    try {
      await refreshVideoPromptSettings();
      videoPrefs = $videoPromptSettings ? { ...$videoPromptSettings } : null;
    } catch (e) { videoPrefs = null; throw e; }
  }
  function loadAll() {
    loadFailed = false;
    // 视频那半不等：它慢或挂了都不该让图片这半一直转圈、按钮一直禁用。
    void loadVideoPart().catch(() => { loadFailed = true; });
    return loadImagePart().catch(() => { loadFailed = true; });
  }
  const reloadSettings = () => run(loadAll);
  /**
   * 隔壁那页也有一颗「设为默认服务商」，它存完会把偏好换成新的。
   * 这里两个 select 绑的是本地副本，不接住这一次变化，人就会看见自己刚点的默认没生效。
   * 只认「store 自己变了」：人在这一页改了还没保存时，不许拿旧值把他的选择盖回去。
   */
  let lastDefault = $state<number | null | undefined>();
  $effect(() => {
    const id = $reverseSettings?.default_model_id ?? null;
    if (lastDefault === undefined) { lastDefault = id; return; }
    if (id === lastDefault) return;
    lastDefault = id;
    if (preferences) preferences.default_model_id = id;
  });
  onMount(() => { void run(loadAll); });
</script>
<section class="fill-interactions model-settings" aria-label="反推偏好">
  <h4 class="settings-group-label">图片反推</h4>
  <div class="settings-card">
    <div class="settings-model-body">
      {#if preferences}
        <fieldset disabled={busy} class="space-y-3">
          <label>默认服务商<select aria-label="默认服务商" bind:value={preferences.default_model_id}>
            <option value={null}>请选择服务商</option>
            {#each $modelConfigs as model}<option value={model.id}>{model.model ? model.name + " · " + model.model : model.name}</option>{/each}
          </select></label>
          <label>反推指令<textarea aria-label="反推指令" rows="5" bind:value={preferences.instruction}></textarea></label>
          <p class="settings-hint">可修改内容和风格偏好，程序始终要求输出中文与英文两个版本。</p>
        </fieldset>
      {:else}
        <div class="settings-load-state" role="status"><p>{loadFailed ? "暂时读取不到图片反推设置，可以重试。" : "正在读取图片反推设置…"}</p>{#if loadFailed}<button class="setting-button" onclick={reloadSettings}>重新加载</button>{/if}</div>
      {/if}
    </div>
    {#if preferences}
      <div class="settings-card-footer">
        <span class="settings-hint">默认服务商与指令一起保存</span>
        <button class="setting-button" onclick={() => { if (preferences) preferences.instruction = preferences.default_instruction; }}>恢复默认（图片指令）</button>
        <button class="setting-button bg-accent text-bg" onclick={() => run(async () => { if (preferences) { preferences = await reverseApi.saveSettings(preferences); await refreshReverseConfig(); notice = "反推偏好已保存"; } })}>保存反推偏好</button>
      </div>
    {/if}
  </div>

  <h4 class="settings-group-label">视频反推（Seedance 2.0 / MiniMax H3）</h4>
  <div class="settings-card">
    <div class="settings-model-body">
      {#if videoPrefs}
        <fieldset disabled={busy} class="space-y-3">
          <label>默认服务商<select aria-label="视频反推默认服务商" bind:value={videoPrefs.default_model_id}>
            <option value={null}>跟随图片反推默认模型</option>
            {#each $modelConfigs as model}<option value={model.id}>{model.model ? model.name + " · " + model.model : model.name}</option>{/each}
          </select></label>
          <div class="grid grid-cols-2 gap-2">
            <label>默认 Seedance 模式<select aria-label="默认 Seedance 模式" bind:value={videoPrefs.default_mode_seedance}>
              {#each SEEDANCE_MODES as option}<option value={option}>{MODE_LABELS[option]}</option>{/each}
            </select></label>
            <label>默认 H3 模式<select aria-label="默认 H3 模式" bind:value={videoPrefs.default_mode_h3}>
              {#each H3_MODES as option}<option value={option}>{MODE_LABELS[option]}</option>{/each}
            </select></label>
          </div>
          <div class="grid grid-cols-3 gap-2">
            <label>帧数上限<input aria-label="视频帧数上限" type="number" min="4" max="16" bind:value={videoPrefs.frame_limit} /></label>
            <label>单元时长上限（秒）<input aria-label="单元时长上限" type="number" min="5" max="15" bind:value={videoPrefs.max_unit_seconds} /></label>
            <label>单元数上限<input aria-label="单元数上限" type="number" min="1" max="24" bind:value={videoPrefs.max_units} /></label>
          </div>
          <p class="settings-hint">每段按镜头切点装箱，不超单元时长上限；超过单元数上限会要求缩小区间或调大设置。帧数越多越贵。</p>
          <label>分镜方案指令
            <textarea aria-label="分镜方案指令" rows="4" bind:value={videoPrefs.instruction_plan}></textarea>
          </label>
          <button class="setting-button setting-button-ghost restore-plan" onclick={() => { if (videoPrefs) videoPrefs.instruction_plan = videoPrefs.defaults.instruction_plan; }}>恢复默认（分镜方案）</button>
          <label>Seedance 2.0 指令
            <textarea aria-label="Seedance 指令" rows="5" bind:value={videoPrefs.instruction_seedance}></textarea>
          </label>
          <button class="setting-button setting-button-ghost restore-seedance" onclick={() => { if (videoPrefs) videoPrefs.instruction_seedance = videoPrefs.defaults.instruction_seedance; }}>恢复默认（Seedance）</button>
          <label>MiniMax H3 指令
            <textarea aria-label="H3 指令" rows="5" bind:value={videoPrefs.instruction_h3}></textarea>
          </label>
          <button class="setting-button setting-button-ghost restore-h3" onclick={() => { if (videoPrefs) videoPrefs.instruction_h3 = videoPrefs.defaults.instruction_h3; }}>恢复默认（H3）</button>
        </fieldset>
      {:else}
        <div class="settings-load-state" role="status"><p>{loadFailed ? "暂时读取不到视频反推设置，可以重试。" : "正在读取视频反推设置…"}</p>{#if loadFailed}<button class="setting-button" onclick={reloadSettings}>重新加载</button>{/if}</div>
      {/if}
    </div>
    {#if videoPrefs}
      <div class="settings-card-footer">
        <span class="settings-hint">两种格式的正文各自独立保存，互不覆盖；正文语言由上面的指令决定</span>
        <button class="setting-button bg-accent text-bg" onclick={() => run(async () => {
          if (!videoPrefs) return;
          videoPrefs = await videoPromptApi.saveSettings(videoPrefs);
          await refreshVideoPromptSettings();
          notice = "视频反推偏好已保存";
        })}>保存视频反推偏好</button>
      </div>
    {/if}
  </div>

  {#if busy}<p class="settings-hint" role="status">处理中…</p>{/if}
  {#if error}<p class="model-error" role="alert">{error}</p>{/if}
  {#if notice}<p class="model-notice" role="status">{notice}</p>{/if}
</section>

<style>
  .model-settings { width: 100%; }
  /* 卡片内表单自己的内边距：保存条挂在卡片底部时要通到边，所以不能给整张卡片加 padding。 */
  .settings-model-body { padding: 20px; }
  /* 竖排表单铺满卡片：右边缘要和卡片、右下角保存条对齐（固定宽度会在右边留一条空白）。 */
  .model-settings fieldset { max-width: none; }
  /* 指令框里是长段文字：白字压黑底太刺眼，行距也偏挤，所以压灰一档、行距放到 1.9。 */
  .model-settings textarea { color: #c2c2ca; line-height: 1.9; letter-spacing: .01em; }
  fieldset { margin-top: 18px; }
  fieldset:first-child { margin-top: 0; }
  label { display: block; font-size: 13px; color: #b8b8c3; }
  input:not([type=checkbox]), textarea, select { display: block; width: 100%; margin-top: 6px; padding: 9px 12px; color: #e4e4e7; background: #18181b; border: 1px solid #3f3f46; border-radius: 6px; }
  button:disabled { opacity: .5; }
  .model-error { margin-top: 14px; font-size: 13px; color: #fb7185; }
  .model-notice { margin-top: 14px; font-size: 13px; color: #a1a1aa; }
  @media (max-width: 860px) { .settings-model-body { padding: 16px; } }
</style>
