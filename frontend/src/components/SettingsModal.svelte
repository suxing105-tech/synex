<script lang="ts">
  import { settingsApi, comfyuiApi } from "../lib/api";
  import { comfyuiStatus } from "../lib/stores";
  import type { ConfigOut } from "../lib/types";
  import ShortcutSettings from "./ShortcutSettings.svelte";
  import UpdatePanel from "./UpdatePanel.svelte";
  import ModelSettings from "./ModelSettings.svelte";
  import { pushToast } from "../lib/toast";
  import { onMount, tick, untrack } from "svelte";

  interface Props {
    open: boolean;
    tab?: string;
    onOpenOnboarding?: () => void;
  }
  let { open = $bindable(), tab = $bindable("通用"), onOpenOnboarding }: Props = $props();

  let cfg = $state<ConfigOut | null>(null);
  let saving = $state<boolean>(false);
  let newDir = $state<string>("");
  let configError = $state(false);
  let scroller = $state<HTMLDivElement | null>(null);
  const sections = [
    { id: "general", label: "通用" },
    { id: "shortcuts", label: "快捷键" },
    { id: "models", label: "模型与反推" },
    { id: "comfyui", label: "ComfyUI" },
    { id: "about", label: "关于与更新" },
  ];

  async function loadConfig() {
    configError = false;
    try { cfg = await settingsApi.get(); } catch { configError = true; }
  }

  function goToSection(label: string) {
    const id = sections.find(section => section.label === label)?.id ?? "general";
    const section = scroller?.querySelector<HTMLElement>(`#settings-${id}`);
    if (!scroller || !section) return;
    tab = label;
    scroller.scrollTo({ top: section.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 28, behavior: "instant" });
  }

  function syncSection() {
    if (!scroller) return;
    const top = scroller.getBoundingClientRect().top + 64;
    let current = sections[0].label;
    for (const section of sections) {
      const element = scroller.querySelector(`#settings-${section.id}`);
      if (element && element.getBoundingClientRect().top <= top) current = section.label;
    }
    if (scroller.scrollHeight > scroller.clientHeight && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) current = sections.at(-1)!.label;
    tab = current;
  }

  $effect(() => {
    if (open) {
      const initialTab = untrack(() => tab);
      void tick().then(() => { if (open) goToSection(initialTab); });
    }
  });

  onMount(async () => {
    await loadConfig();
  });

  $effect(() => {
    if (open && !cfg) {
      void loadConfig();
    }
  });

  let comfyuiUrlInput = $state<string>("http://127.0.0.1:8188");
  $effect(() => { if (open) void refreshComfyui(); });
  let comfyuiEnabledLocal = $state<boolean>(true);
  let probing = $state<boolean>(false);
  let comfyuiStatusLocal = $state<{ running: boolean; url: string } | null>(null);

  async function refreshComfyui() {
    probing = true;
    try {
      const s = await comfyuiApi.status();
      comfyuiStatusLocal = { running: s.running, url: s.url };
      comfyuiUrlInput = s.url;
      comfyuiEnabledLocal = s.enabled;
      comfyuiStatus.set(s);
    } catch (e) {
      comfyuiStatusLocal = { running: false, url: comfyuiUrlInput };
    } finally {
      probing = false;
    }
  }

  async function saveComfyui() {
    try {
      const s = await comfyuiApi.updateConfig({
        url: comfyuiUrlInput,
        enabled: comfyuiEnabledLocal,
      });
      comfyuiStatusLocal = { running: s.running, url: s.url };
      comfyuiStatus.set(s);
    } catch (e) {
      pushToast("ComfyUI 设置保存失败", { kind: "error" });
    }
  }

  async function save() {
    if (!cfg) return;
    saving = true;
    try {
      // 注意：feed 现在直接用原图 + ?max=1024 预览，thumb 系统不再需要 UI 配置；
      // 后端 thumb_size / thumb_quality 字段保留但只在 API 层面维护，不会再有 UI 入口。
      cfg = await settingsApi.update({
        watch_dirs: cfg.watch_dirs,
        live_enabled: cfg.live_enabled,
      });
      pushToast("通用设置已保存", { kind: "success" });
    } catch {
      pushToast("通用设置保存失败", { kind: "error" });
    } finally {
      saving = false;
    }
  }

  function addDir() {
    if (!cfg || !newDir.trim()) return;
    if (!cfg.watch_dirs.includes(newDir.trim())) {
      cfg = { ...cfg, watch_dirs: [...cfg.watch_dirs, newDir.trim()] };
    }
    newDir = "";
  }

  function removeDir(d: string) {
    if (!cfg) return;
    cfg = { ...cfg, watch_dirs: cfg.watch_dirs.filter((x) => x !== d) };
  }
</script>

{#if open}
  <div class="fixed inset-0 z-[60] bg-surface-2" role="dialog" aria-modal="true" aria-label="设置" data-settings-dialog>
    <div class="settings-shell w-full h-full">
      <header class="settings-header fill-interactions">
        <div class="settings-heading">
          <button class="settings-return" aria-label="返回图库" title="返回图库" onclick={() => (open = false)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 5-7 7 7 7M3 12h18" /></svg>
          </button>
          <h2>设置</h2>
        </div>
        <span class="settings-header-note">管理你的工作空间</span>
      </header>
      <div class="settings-body">
        <div class="settings-content min-w-0 overflow-y-auto" bind:this={scroller} onscroll={syncSection}>
          <div class="settings-page fill-interactions">
            <section id="settings-general" class="settings-section" aria-labelledby="settings-general-title">
              <h3 id="settings-general-title">通用</h3>
              <p class="section-description">导入素材，管理监听目录与自动收录。</p>
              {#if onOpenOnboarding}
                <div class="setting-group">
                  <h4>导入目录</h4>
                  <p class="setting-description">选择本地文件夹，将图片和视频导入图库。</p>
                  <button class="setting-button" onclick={onOpenOnboarding}>导入目录</button>
                </div>
              {/if}
              {#if cfg}
                <div class="setting-group">
                  <h4>监听目录</h4>
                  <p class="setting-description">启用 Live 监听后，这些目录中的新文件会自动加入图库。</p>
                  <div class="directory-list">
                    {#each cfg.watch_dirs as d}
                      <div class="directory-row">
                        <span title={d}>{d}</span>
                        <button class="directory-remove" aria-label={`移除监听目录 ${d}`} onclick={() => removeDir(d)}>移除</button>
                      </div>
                    {/each}
                    {#if cfg.watch_dirs.length === 0}<p class="setting-description">尚未添加监听目录</p>{/if}
                  </div>
                  <div class="directory-add">
                    <input type="text" aria-label="新增监听目录" bind:value={newDir} placeholder="输入本地目录路径…" onkeydown={(e) => { if (e.key === 'Enter') addDir(); }} />
                    <button class="setting-button" disabled={!newDir.trim()} onclick={addDir}>添加目录</button>
                  </div>
                </div>
                <div class="setting-group">
                  <h4>Live 监听</h4>
                  <label class="setting-check"><input type="checkbox" bind:checked={cfg.live_enabled} /><span>自动收录监听目录中的新文件</span></label>
                </div>
                <div class="section-actions"><button class="setting-button bg-accent text-bg" disabled={saving} onclick={save}>{saving ? "保存中…" : "保存通用设置"}</button></div>
              {:else}
                <div class="settings-load-state" role="status">
                  <p>{configError ? "暂时无法读取监听设置，请确认图库后台已启动。" : "正在读取监听设置…"}</p>
                  {#if configError}<button class="setting-button" onclick={loadConfig}>重新加载</button>{/if}
                </div>
              {/if}
            </section>
            <section id="settings-shortcuts" class="settings-section" aria-labelledby="settings-shortcuts-title">
              <h3 id="settings-shortcuts-title">快捷键</h3>
              <p class="section-description">按你的使用习惯调整常用操作。</p>
              <ShortcutSettings />
            </section>
            <section id="settings-models" class="settings-section" aria-labelledby="settings-models-title">
              <h3 id="settings-models-title">模型与反推</h3>
              <p class="section-description">配置图片识别模型与反推指令。</p>
              <ModelSettings />
            </section>
            <section id="settings-comfyui" class="settings-section" aria-labelledby="settings-comfyui-title">
              <h3 id="settings-comfyui-title">ComfyUI</h3>
              <p class="section-description">连接本地 ComfyUI，从图库打开图片中的工作流。</p>
              <div class="setting-group">
                <h4>服务地址</h4>
                <div class="directory-add">
                  <input type="text" aria-label="ComfyUI 服务地址" bind:value={comfyuiUrlInput} placeholder="http://127.0.0.1:8188" />
                  <button class="setting-button" disabled={probing} onclick={refreshComfyui}>{probing ? "探测中…" : "重新探测"}</button>
                </div>
                <p class="connection-status" role="status"><span class="status-dot" class:bg-success={comfyuiStatusLocal?.running} class:bg-danger={comfyuiStatusLocal && !comfyuiStatusLocal.running} class:bg-muted={!comfyuiStatusLocal}></span>{comfyuiStatusLocal?.running ? "已连接 ComfyUI" : probing ? "正在探测服务…" : "未连接 ComfyUI"}</p>
              </div>
              <div class="setting-group">
                <h4>工作流集成</h4>
                <label class="setting-check"><input type="checkbox" bind:checked={comfyuiEnabledLocal} /><span>启用工作流一键打开</span></label>
                <p class="setting-description">ComfyUI 运行时，带有工作流的图片会显示打开按钮。</p>
              </div>
              <div class="section-actions"><button class="setting-button bg-accent text-bg" onclick={saveComfyui}>保存 ComfyUI 设置</button></div>
            </section>
            <section id="settings-about" class="settings-section" aria-labelledby="settings-about-title">
              <h3 id="settings-about-title">关于与更新</h3>
              <p class="section-description">闪寻空间 · Seek-X</p>
              <UpdatePanel />
            </section>
          </div>
        </div>
        <aside class="settings-index">
          <nav class="settings-nav" aria-label="设置分类">
            {#each sections as section}
              <button aria-current={tab === section.label ? 'location' : undefined} aria-controls={`settings-${section.id}`} onclick={() => goToSection(section.label)}>{section.label}</button>
            {/each}
          </nav>
          <div class="settings-index-footer">
            <span>修改后在各分组保存</span>
            <button class="settings-top" onclick={() => goToSection('通用')} aria-label="返回设置顶部"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 6-6 6 6" /></svg>回到顶部</button>
          </div>
        </aside>
      </div>
    </div>
  </div>
{/if}

<style>
  .settings-shell { display: flex; flex-direction: column; overflow: hidden; color: #e4e4e7; }
  .settings-header { display: flex; align-items: center; justify-content: space-between; min-height: 84px; padding: 0 48px; border-bottom: 1px solid #2e2e33; }
  .settings-heading { display: flex; align-items: center; gap: 18px; }
  .settings-heading h2 { font-size: 22px; font-weight: 600; letter-spacing: -.02em; }
  .settings-return { display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 8px; color: #a1a1aa; }
  .settings-header-note { font-size: 12px; color: #71717a; }
  .settings-body { display: grid; grid-template-columns: minmax(0, 1fr) 224px; flex: 1; min-height: 0; }
  .settings-content { overscroll-behavior: contain; scrollbar-gutter: stable; }
  .settings-page { max-width: 1080px; padding: 36px 56px 72px 64px; margin: 0 auto; }
  .settings-section { padding: 0 0 40px; margin-bottom: 36px; border-bottom: 1px solid #2e2e33; scroll-margin-top: 28px; }
  .settings-section:last-child { margin-bottom: 0; border-bottom: 0; padding-bottom: 0; min-height: 320px; }
  .settings-section h3 { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
  .section-description { font-size: 13px; line-height: 1.7; color: #85858f; margin-bottom: 28px; }
  .setting-group { margin-bottom: 28px; }
  .setting-group h4 { font-size: 14px; font-weight: 500; margin-bottom: 10px; }
  .setting-description { font-size: 13px; line-height: 1.7; color: #a1a1aa; margin-bottom: 12px; }
  .setting-button { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 7px 14px; border: 1px solid #3f3f46; border-radius: 7px; font-size: 13px; white-space: nowrap; }
  .setting-button:disabled { opacity: .45; }
  .directory-list { display: flex; flex-direction: column; gap: 8px; max-width: 640px; }
  .directory-row { display: flex; align-items: center; border: 1px solid #3f3f46; border-radius: 7px; min-height: 40px; margin-bottom: 4px; }
  .directory-row span { flex: 1; min-width: 0; padding: 8px 12px; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .directory-remove { align-self: stretch; padding: 8px 14px; font-size: 12px; color: #a1a1aa; border-radius: 0 6px 6px 0; }
  .directory-add { display: flex; gap: 10px; max-width: 640px; }
  .directory-add input { min-width: 0; flex: 1; min-height: 40px; padding: 8px 12px; font-size: 13px; background: #18181b; border: 1px solid #3f3f46; border-radius: 7px; }
  .setting-check { display: flex; align-items: center; gap: 10px; width: fit-content; font-size: 13px; }
  .setting-check input { width: 16px; height: 16px; }
  .section-actions { display: flex; align-items: center; gap: 10px; margin-top: 24px; }
  .connection-status { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #a1a1aa; margin-top: 12px; }
  .status-dot { width: 7px; height: 7px; border-radius: 50%; }
  .settings-load-state { display: flex; align-items: center; gap: 12px; font-size: 13px; color: #a1a1aa; flex-wrap: wrap; }
  .settings-index { display: flex; flex-direction: column; justify-content: space-between; padding: 36px 24px 28px 12px; min-height: 0; }
  .settings-nav { display: flex; flex-direction: column; gap: 4px; overflow-y: auto; }
  .settings-nav button { position: relative; flex-shrink: 0; text-align: left; padding: 12px 18px; border-radius: 6px; color: #93939e; font-size: 14px; line-height: 1.4; background: transparent; }
  .settings-nav button:hover { color: #e4e4e7; background: #27272a; }
  .settings-nav button[aria-current="location"] { color: #f24e4e; }
  .settings-nav button[aria-current="location"]::before { content: ""; position: absolute; left: 0; top: 50%; transform: translateY(-50%); width: 3px; height: 17px; border-radius: 2px; background: #f24e4e; }
  .settings-index-footer { display: flex; flex-direction: column; gap: 18px; align-items: flex-start; padding-left: 18px; margin-top: 32px; }
  .settings-index-footer span { font-size: 11px; color: #71717a; }
  .settings-top { display: flex; align-items: center; gap: 8px; color: #93939e; font-size: 12px; padding: 8px 0; }
  .settings-top:hover { color: #e4e4e7; }
  .settings-nav button:focus-visible, .settings-top:focus-visible { outline: none; background: #323237; text-decoration: underline; text-underline-offset: 4px; }
  @media (max-width: 1100px) {
    .settings-body { grid-template-columns: minmax(0, 1fr) 184px; }
    .settings-page { padding: 32px 32px 64px; }
    .settings-header { padding: 0 24px; }
    .settings-index { padding-right: 16px; }
  }
  @media (max-width: 700px) {
    .settings-body { display: flex; flex-direction: column-reverse; }
    .settings-index { padding: 8px 12px; flex-shrink: 0; }
    .settings-nav { flex-direction: row; overflow-x: auto; }
    .settings-nav button { font-size: 12px; padding: 10px 12px; }
    .settings-nav button[aria-current="location"]::before { top: auto; bottom: 0; left: 12px; transform: none; width: 16px; height: 2px; }
    .settings-index-footer, .settings-header-note { display: none; }
    .settings-header { min-height: 68px; padding: 0 16px; }
    .settings-content { flex: 1; }
    .settings-page { padding: 24px 20px 48px; }
    .directory-add { flex-wrap: wrap; }
    .directory-add input { flex-basis: 200px; }
  }
</style>
