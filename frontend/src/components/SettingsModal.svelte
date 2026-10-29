<script lang="ts">
  import { foldersApi, settingsApi, comfyuiApi, healthApi } from "../lib/api";
  import { describeMediaTools } from "../lib/media-tools";
  import { comfyuiStatus } from "../lib/stores";
  import { updateStatus } from "../lib/updates";
  import type { ArchivedFolder, ConfigOut } from "../lib/types";
  import { refreshFeed, refreshFolders, refreshStats } from "../lib/stores";
  import ShortcutSettings from "./ShortcutSettings.svelte";
  import ModelSettings from "./ModelSettings.svelte";
  import CloneTemplates from "./CloneTemplates.svelte";
  import UpdatePanel from "./UpdatePanel.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import wechatContact from "../assets/about/wechat-contact.png";
  import rewardQr from "../assets/about/reward-qr.png";
  import { pushToast } from "../lib/toast";
  import { onMount, tick, untrack } from "svelte";

  interface Props {
    open: boolean;
    tab?: string;
    onOpenOnboarding?: () => void;
  }
  let { open = $bindable(), tab = $bindable("通用"), onOpenOnboarding }: Props = $props();

  // 左目录的数据：分组 → 条目。id 对应正文里的 #settings-<id>，keywords 只服务目录里的搜索框。
  interface NavItem { id: string; label: string; keywords: string; }
  const navGroups: { label: string; items: NavItem[] }[] = [
    { label: "素材库", items: [
      { id: "general", label: "通用", keywords: "导入 目录 监听 watch live 自动 收录 文件夹 图片 视频 音频 文本" },
      { id: "archived", label: "已归档目录", keywords: "归档 恢复 收起 隐藏 来源目录 移除" },
    ] },
    { label: "操作", items: [
      { id: "shortcuts", label: "快捷键", keywords: "按键 键盘 组合键 沉浸 全屏 搜索 侧栏 灯箱 对比 所有素材" },
    ] },
    { label: "AI 与集成", items: [
      { id: "models", label: "模型与反推", keywords: "api key 服务商 视觉模型 反推 指令 seedance h3 视频提示词 超时 密钥 默认模型" },
      { id: "comfyui", label: "ComfyUI", keywords: "工作流 服务地址 端口 连接 探测 节点" },
      { id: "clone", label: "一键同款", keywords: "工作流 模板 提示词 参考图 生成 一键同款 同款 ComfyUI 出图" },
    ] },
    { label: "应用", items: [
      { id: "media", label: "媒体组件", keywords: "ffmpeg ffprobe 封面 波形 内置 检测 版本" },
      { id: "update", label: "软件更新", keywords: "版本 升级 检查 下载 安装 自动更新 便携 安装包" },
      { id: "about", label: "关于", keywords: "闪寻空间 seek-x 版本 引导 新手 反馈" },
    ] },
  ];
  const navItems: NavItem[] = navGroups.flatMap((group) => group.items);
  // 目录字形：只用 path 描述，省得为每个条目再引一套图标组件。
  const navIcons: Record<string, string[]> = {
    general: ["M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0", "M16 4v4M10 10v4M18 16v4"],
    archived: ["M3 7h18v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z", "M2 4h20v3H2Z", "M10 11h4"],
    shortcuts: ["M3 6h18v12H3z", "M7 10h.01M11 10h.01M15 10h.01M8 14h8"],
    models: ["M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7Z", "M18 15l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8Z"],
    comfyui: ["M9 2v6M15 2v6", "M6 8h12v3a6 6 0 0 1-12 0V8Z", "M12 17v5"],
    clone: ["M8 3h9a3 3 0 0 1 3 3v9", "M6 8h9a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3Z"],
    media: ["M3 5h18v14H3z", "M7 5v14M17 5v14M3 12h18"],
    update: ["M12 3v11", "m8 10 4 4 4-4", "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"],
    about: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 11v5M12 8h.01"],
  };

  // 后台答话之前正文用的是这个空壳：cfg 始终是个完整对象，开关才能直接 bind；
  // cfgReady 才表示「真的读回来了」，未就绪时监听那一栏显示读取状态。
  const emptyConfig: ConfigOut = { watch_dirs: [], theme: "dark", live_enabled: true, scan_workers: 4 };
  let cfg = $state<ConfigOut>(emptyConfig);
  let cfgReady = $state(false);
  let saving = $state<boolean>(false);
  let newDir = $state<string>("");
  let configError = $state(false);
  let scroller = $state<HTMLDivElement | null>(null);
  let filter = $state("");
  // 「关于」里的两张码：微信联系方式与赞赏收款码，点开看大图。
  let qr = $state<"wechat" | "reward" | null>(null);
  const qrImage = $derived(qr === "reward" ? rewardQr : wechatContact);
  const qrLabel = $derived(qr === "reward" ? "微信收款码" : "微信二维码");
  $effect(() => {
    if (!qr) return;
    // 捕获阶段先吃掉 Esc，否则关掉大图的同时把整个设置页也关了。
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      qr = null;
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const searchTokens = $derived(filter.trim().toLowerCase().split(/\s+/).filter(Boolean));
  function shown(id: string) {
    const item = navItems.find((entry) => entry.id === id);
    if (!item || searchTokens.length === 0) return true;
    const haystack = `${item.label} ${item.keywords}`.toLowerCase();
    return searchTokens.every((token) => haystack.includes(token));
  }
  const visibleGroups = $derived(
    navGroups
      .map((group) => ({ ...group, items: group.items.filter((item) => shown(item.id)) }))
      .filter((group) => group.items.length > 0),
  );
  const activeId = $derived(navItems.find((item) => item.label === tab)?.id ?? "general");

  async function loadConfig() {
    configError = false;
    try { cfg = await settingsApi.get(); cfgReady = true; } catch { configError = true; }
  }

  function goToSection(label: string) {
    const item = navItems.find((entry) => entry.label === label);
    const id = item?.id ?? "general";
    const section = scroller?.querySelector<HTMLElement>(`#settings-${id}`);
    if (!scroller || !section) return;
    tab = label;
    scroller.scrollTo({ top: section.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 28, behavior: "instant" });
  }

  function syncSection() {
    if (!scroller) return;
    const top = scroller.getBoundingClientRect().top + 64;
    let current = navItems[0].label;
    for (const section of navItems) {
      const element = scroller.querySelector(`#settings-${section.id}`);
      if (element && element.getBoundingClientRect().top <= top) current = section.label;
    }
    const lastVisible = navItems.filter((item) => shown(item.id)).at(-1);
    if (scroller.scrollHeight > scroller.clientHeight && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2 && lastVisible) current = lastVisible.label;
    tab = current;
  }

  $effect(() => {
    if (open) {
      const initialTab = untrack(() => tab);
      void tick().then(() => { if (open) goToSection(initialTab); });
    }
  });

  // 搜索时正文只剩命中的分组：回到顶部，选中项也跟着落到第一个命中，否则目录会「亮着一个看不见的页」。
  $effect(() => {
    if (!filter.trim()) return;
    const first = navItems.find((item) => shown(item.id));
    void tick().then(() => {
      scroller?.scrollTo({ top: 0, behavior: "instant" });
      if (first) tab = first.label;
    });
  });

  // 已归档目录：只在图库里收起来的目录，素材和标签都还在库里，随时可恢复。
  let archivedFolders = $state<ArchivedFolder[]>([]);
  let restoringId = $state<number | null>(null);

  async function loadArchived() {
    try { archivedFolders = await foldersApi.archived(); } catch { archivedFolders = []; }
  }

  async function restoreArchived(entry: ArchivedFolder) {
    restoringId = entry.id;
    try {
      await foldersApi.restore(entry.id);
      await Promise.all([loadArchived(), refreshFolders(), refreshFeed(), refreshStats()]);
      pushToast(`已恢复「${entry.name}」`);
    } catch (error) {
      pushToast(`恢复失败：${error instanceof Error ? error.message : error}`, { kind: "error" });
    } finally { restoringId = null; }
  }

  $effect(() => { if (open) void loadArchived(); });

  onMount(async () => {
    await loadConfig();
  });

  $effect(() => {
    if (open && !cfgReady) {
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

  // ffmpeg/ffprobe 缺失只会让封面、波形、视频提示词静默变空，用户完全看不出来，
  // 所以「媒体组件」常驻一条状态（后端 /api/health 顺带报来源和版本）。
  let mediaTools = $state(describeMediaTools(null));
  let mediaProbing = $state<boolean>(false);
  $effect(() => { if (open) void refreshMediaTools(); });

  async function refreshMediaTools() {
    mediaProbing = true;
    try {
      const health = await healthApi.get();
      mediaTools = describeMediaTools(health.media_tools ?? null);
    } catch {
      mediaTools = { ok: false, text: "图库后台未响应", hint: "重启闪寻空间后再重新检测。" };
    } finally {
      mediaProbing = false;
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
    if (!newDir.trim()) return;
    if (!cfg.watch_dirs.includes(newDir.trim())) {
      cfg = { ...cfg, watch_dirs: [...cfg.watch_dirs, newDir.trim()] };
    }
    newDir = "";
  }

  function removeDir(d: string) {
    cfg = { ...cfg, watch_dirs: cfg.watch_dirs.filter((x) => x !== d) };
  }
</script>

{#if open}
  <div class="fixed inset-0 z-[60] bg-bg" role="dialog" aria-modal="true" aria-label="设置" data-settings-dialog>
    <div class="settings-shell w-full h-full">
      <aside class="settings-rail">
        <div class="settings-rail-head">
          <button class="settings-return" aria-label="返回图库" title="返回图库" onclick={() => (open = false)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 5-7 7 7 7M3 12h18" /></svg>
          </button>
          <h2>设置</h2>
        </div>
        <div class="settings-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input type="search" aria-label="搜索设置" placeholder="搜索设置" autocomplete="off" bind:value={filter} />
          {#if filter}
            <button class="settings-search-clear" aria-label="清除搜索" onclick={() => (filter = "")}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          {/if}
        </div>
        <nav class="settings-nav fill-interactions" aria-label="设置分类">
          {#if visibleGroups.length === 0}
            <p class="settings-nav-empty">没有匹配的设置</p>
          {/if}
          {#each visibleGroups as group}
            <p class="settings-nav-group">{group.label}</p>
            {#each group.items as section}
              <button class="settings-nav-item" aria-current={activeId === section.id ? "location" : undefined} aria-controls={`settings-${section.id}`} onclick={() => goToSection(section.label)}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  {#each navIcons[section.id] ?? [] as d}<path {d} />{/each}
                </svg>
                <span>{section.label}</span>
              </button>
            {/each}
          {/each}
        </nav>
      </aside>
      <div class="settings-content min-w-0 overflow-y-auto" bind:this={scroller} onscroll={syncSection}>
        <div class="settings-page fill-interactions">
          {#if shown("general")}
            <section id="settings-general" class="settings-section" aria-labelledby="settings-general-title">
              <h3 id="settings-general-title">通用</h3>
              <p class="section-description">导入素材，管理监听目录与自动收录。</p>

              {#if onOpenOnboarding}
                <h4 class="settings-group-label">导入</h4>
                <div class="settings-card">
                  <SettingsRow title="从本地文件夹导入" description="选一个文件夹，把里面的图片和视频导入图库；文件留在原处，不搬动。">
                    {#snippet control()}
                      <button class="setting-button" onclick={onOpenOnboarding}>导入目录</button>
                    {/snippet}
                  </SettingsRow>
                </div>
              {/if}

              <h4 class="settings-group-label">监听</h4>
              <div class="settings-card">
                {#if cfgReady}
                  <div class="settings-card-body">
                    <SettingsRow title="自动收录新文件" description="开着时，监听目录里新出现的文件会自动进图库，不用手动导入。">
                      {#snippet control()}
                        <label class="settings-switch"><input type="checkbox" aria-label="自动收录监听目录中的新文件" bind:checked={cfg.live_enabled} /><span class="switch-track"></span></label>
                      {/snippet}
                    </SettingsRow>
                    <SettingsRow title="监听目录" description="图库只读这些目录，不移动、不改名；删掉一行只是不再监听，磁盘文件不动。" top>
                      {#snippet control()}
                        <span>{cfg.watch_dirs.length} 个目录</span>
                      {/snippet}
                      {#snippet children()}
                        <div>
                          {#each cfg.watch_dirs as d}
                            <div class="settings-subrow">
                              <span class="settings-subpath" title={d}>{d}</span>
                              <button class="setting-button setting-button-ghost" aria-label={`移除监听目录 ${d}`} onclick={() => removeDir(d)}>移除</button>
                            </div>
                          {/each}
                          {#if cfg.watch_dirs.length === 0}<p class="settings-subempty">尚未添加监听目录</p>{/if}
                        </div>
                        <div class="settings-addrow">
                          <input type="text" aria-label="新增监听目录" bind:value={newDir} placeholder="输入本地目录路径…" onkeydown={(e) => { if (e.key === 'Enter') addDir(); }} />
                          <button class="setting-button" disabled={!newDir.trim()} onclick={addDir}>添加目录</button>
                        </div>
                      {/snippet}
                    </SettingsRow>
                    <div class="settings-card-footer">
                      <span class="settings-hint">监听目录与自动收录一起保存</span>
                      <button class="setting-button bg-accent text-bg" disabled={saving} onclick={save}>{saving ? "保存中…" : "保存通用设置"}</button>
                    </div>
                  </div>
                {:else}
                  <div class="settings-load-state" role="status">
                    <p>{configError ? "暂时无法读取监听设置，请确认图库后台已启动。" : "正在读取监听设置…"}</p>
                    {#if configError}<button class="setting-button" onclick={loadConfig}>重新加载</button>{/if}
                  </div>
                {/if}
              </div>
            </section>
          {/if}

          {#if shown("archived")}
            <section id="settings-archived" class="settings-section" aria-labelledby="settings-archived-title">
              <h3 id="settings-archived-title">已归档目录</h3>
              <p class="section-description">在目录右键点「归档」的目录。图库不再显示它们，但磁盘上的文件夹与文件都没动，恢复后素材原样回来。</p>
              <div class="settings-card">
                {#each archivedFolders as entry (entry.id)}
                  <SettingsRow title={entry.name} description={`${entry.path || entry.name} · 藏起 ${entry.media + entry.texts} 项`}>
                    {#snippet control()}
                      <button class="setting-button" aria-label={`恢复目录 ${entry.name}`} disabled={restoringId === entry.id}
                        onclick={() => void restoreArchived(entry)}>{restoringId === entry.id ? "恢复中…" : "恢复"}</button>
                    {/snippet}
                  </SettingsRow>
                {/each}
                {#if archivedFolders.length === 0}
                  <SettingsRow title="没有已归档的目录" description="想收起某个目录：在左侧目录上点右键 → 归档。它只是不再出现在图库里，文件还在磁盘上。" />
                {/if}
              </div>
            </section>
          {/if}

          {#if shown("shortcuts")}
            <section id="settings-shortcuts" class="settings-section" aria-labelledby="settings-shortcuts-title">
              <h3 id="settings-shortcuts-title">快捷键</h3>
              <p class="section-description">按你的使用习惯调整常用操作。</p>
              <ShortcutSettings />
            </section>
          {/if}

          {#if shown("models")}
            <section id="settings-models" class="settings-section" aria-labelledby="settings-models-title">
              <h3 id="settings-models-title">模型与反推</h3>
              <p class="section-description">配置图片与视频反推用的模型、指令与偏好。</p>
              <ModelSettings />
            </section>
          {/if}

          {#if shown("comfyui")}
            <section id="settings-comfyui" class="settings-section" aria-labelledby="settings-comfyui-title">
              <h3 id="settings-comfyui-title">ComfyUI</h3>
              <p class="section-description">连接本地 ComfyUI，从图库打开图片或视频中的工作流。</p>
              <div class="settings-card">
                <SettingsRow title="服务地址" description="本地 ComfyUI 的访问地址，改动后要重新探测再保存。">
                  {#snippet control()}
                    <input type="text" aria-label="ComfyUI 服务地址" bind:value={comfyuiUrlInput} placeholder="http://127.0.0.1:8188" />
                    <button class="setting-button" disabled={probing} onclick={refreshComfyui}>{probing ? "探测中…" : "重新探测"}</button>
                  {/snippet}
                </SettingsRow>
                <SettingsRow title="连接状态" description="连不上也能看图，只是打不开工作流。">
                  {#snippet control()}
                    <span class="status-dot" class:bg-success={comfyuiStatusLocal?.running} class:bg-danger={comfyuiStatusLocal && !comfyuiStatusLocal.running} class:bg-muted={!comfyuiStatusLocal}></span>
                    <span role="status">{comfyuiStatusLocal?.running ? "已连接 ComfyUI" : probing ? "正在探测服务…" : "未连接 ComfyUI"}</span>
                  {/snippet}
                </SettingsRow>
                <SettingsRow title="工作流集成" description="ComfyUI 运行时，带有工作流的图片或视频会显示打开按钮。">
                  {#snippet control()}
                    <label class="settings-switch"><input type="checkbox" aria-label="启用工作流一键打开" bind:checked={comfyuiEnabledLocal} /><span class="switch-track"></span></label>
                  {/snippet}
                </SettingsRow>
                <div class="settings-card-footer">
                  <span class="settings-hint">地址与开关一起保存</span>
                  <button class="setting-button bg-accent text-bg" onclick={saveComfyui}>保存 ComfyUI 设置</button>
                </div>
              </div>
            </section>
          {/if}

          {#if shown("clone")}
            <section id="settings-clone" class="settings-section" aria-labelledby="settings-clone-title">
              <h3 id="settings-clone-title">一键同款</h3>
              <p class="section-description">换一份工作流，图片卡上的「一键同款」立刻跟着换；出图统一存进图库的「一键同款」文件夹。</p>
              <CloneTemplates />
            </section>
          {/if}

          {#if shown("media")}
            <section id="settings-media" class="settings-section" aria-labelledby="settings-media-title">
              <h3 id="settings-media-title">媒体组件</h3>
              <p class="section-description">视频封面、音频波形与视频提示词读取由内置的 ffmpeg / ffprobe 完成。</p>
              <div class="settings-card">
                <SettingsRow title="ffmpeg / ffprobe" description={`缺了它们不会报错，只会让封面、波形和视频提示词静默变空。当前：${mediaTools.text}`} top>
                  {#snippet control()}
                    <span class="status-dot" class:bg-success={mediaTools.ok} class:bg-danger={!mediaTools.ok}></span>
                    <span role="status">{mediaProbing ? "正在检测…" : mediaTools.ok ? "组件正常" : "组件缺失"}</span>
                    <button class="setting-button" disabled={mediaProbing} onclick={refreshMediaTools}>{mediaProbing ? "检测中…" : "重新检测"}</button>
                  {/snippet}
                  {#if mediaTools.hint}
                    {#snippet children()}
                      <p class="settings-hint">{mediaTools.hint}</p>
                    {/snippet}
                  {/if}
                </SettingsRow>
              </div>
            </section>
          {/if}

          {#if shown("update")}
            <section id="settings-update" class="settings-section" aria-labelledby="settings-update-title">
              <h3 id="settings-update-title">软件更新</h3>
              <p class="section-description">检查新版本由你决定何时下载与安装。</p>
              <UpdatePanel />
            </section>
          {/if}

          {#if shown("about")}
            <section id="settings-about" class="settings-section" aria-labelledby="settings-about-title">
              <h3 id="settings-about-title">关于</h3>
              <p class="section-description">闪寻空间 · Seek-X</p>
              <div class="settings-card">
                <SettingsRow title="闪寻空间" description="本地素材图库：图片、视频、音频、文本在同一套目录与标签里翻看、搜索、对比。">
                  {#snippet control()}
                    <span class="setting-row-mono">{$updateStatus ? `v${$updateStatus.current_version}` : "网页版"}</span>
                  {/snippet}
                </SettingsRow>
                <SettingsRow title="开发者" description="苏醒。有问题、想要新功能，或者只是想说一句好用，都可以直接找我。" top>
                  {#snippet children()}
                    <div class="about-contacts">
                      <button class="about-qr" onclick={() => (qr = "wechat")}>
                        <img src={wechatContact} alt="微信二维码：扫码添加开发者苏醒" width="408" height="408" />
                        <span>联系开发者</span>
                      </button>
                      <button class="about-qr" onclick={() => (qr = "reward")}>
                        <img src={rewardQr} alt="微信收款码：请开发者喝一杯" width="408" height="408" />
                        <span>赞赏支持</span>
                      </button>
                      <p class="settings-hint">左边加微信，右边请我喝杯咖啡。都是自愿，用着开心最重要。</p>
                    </div>
                  {/snippet}
                </SettingsRow>
                {#if onOpenOnboarding}
                  <SettingsRow title="新手引导" description="重新走一遍导入目录、监听与对比的用法。">
                    {#snippet control()}
                      <button class="setting-button" onclick={onOpenOnboarding}>打开引导</button>
                    {/snippet}
                  </SettingsRow>
                {/if}
              </div>
            </section>
          {/if}

          {#if visibleGroups.length === 0}
            <p class="settings-empty" role="status">没有匹配「{filter}」的设置，换个词试试。</p>
          {/if}
        </div>
      </div>
    </div>
    {#if qr}
      <div class="about-zoom" role="dialog" aria-modal="true" aria-label={qrLabel} tabindex="-1" onclick={() => (qr = null)}
        onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") qr = null; }}>
        <figure class="about-zoom-figure">
          <img src={qrImage} alt={qrLabel} />
          <figcaption>{qr === "reward" ? "赞赏支持：扫码请开发者喝一杯" : "联系方式：扫码添加苏醒的微信"}</figcaption>
        </figure>
        <button class="setting-button" onclick={() => (qr = null)}>关闭</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .settings-shell { display: grid; grid-template-columns: 264px minmax(0, 1fr); overflow: hidden; color: #e4e4e7; background: #0e0e10; }
  .settings-rail { display: flex; flex-direction: column; min-height: 0; padding: 18px 12px 16px; background: #16161a; border-right: 1px solid #232327; }
  .settings-rail-head { display: flex; align-items: center; gap: 10px; padding: 2px 4px 14px; }
  .settings-rail-head h2 { font-size: 17px; font-weight: 600; letter-spacing: -.01em; }
  .settings-return { display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; color: #a1a1aa; }
  .settings-search { position: relative; display: flex; align-items: center; margin: 0 4px 10px; }
  .settings-search > svg { position: absolute; left: 11px; color: #6d6d75; pointer-events: none; }
  .settings-search input { width: 100%; height: 34px; padding: 0 30px 0 32px; font-size: 13px; color: #e4e4e7; background: #101013; border: 1px solid #2b2b30; border-radius: 8px; }
  .settings-search input::placeholder { color: #6d6d75; }
  .settings-search input::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }
  .settings-search input:focus { border-color: #3f3f46; background: #191920; outline: none; }
  .settings-search-clear { position: absolute; right: 5px; display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 6px; color: #8a8a8e; }
  .settings-nav { display: flex; flex-direction: column; gap: 2px; min-height: 0; overflow-y: auto; }
  .settings-nav-group { margin: 14px 0 4px; padding: 0 10px; font-size: 11px; letter-spacing: .06em; color: #6d6d75; }
  .settings-nav-group:first-child { margin-top: 2px; }
  .settings-nav-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border-radius: 8px; text-align: left; font-size: 13px; line-height: 1.4; color: #a1a1aa; }
  .settings-nav-item svg { flex-shrink: 0; opacity: .7; }
  .settings-nav-item:hover { color: #e4e4e7; }
  .settings-nav-item[aria-current="location"] { color: #fafafa; background: #27272a; }
  .settings-nav-item[aria-current="location"] svg { color: #f24e4e; opacity: 1; }
  .settings-nav-empty { padding: 10px; font-size: 12.5px; color: #71717a; }
  .settings-nav-item:focus-visible { outline: none; background: #323237; text-decoration: underline; text-underline-offset: 4px; }
  .settings-content { min-height: 0; background: #0e0e10; overscroll-behavior: contain; scrollbar-gutter: stable; }
  /* 内容宽度跟着窗口长：窄时贴满，宽时最多加到 1440px 再居中留白，左右内边距按视口同步缩放。
     以前固定 820px，窗口最大化后两侧各空 700px 以上，看起来像页面坏了一半。 */
  .settings-page { width: min(100%, 1440px); padding: 40px clamp(22px, 4.4vw, 84px) 120px; margin: 0 auto; }
  .settings-section { padding-bottom: 34px; margin-bottom: 30px; border-bottom: 1px solid #232327; scroll-margin-top: 28px; }
  .settings-section:last-child { padding-bottom: 0; margin-bottom: 0; border-bottom: 0; }
  .settings-section h3 { margin-bottom: 6px; font-size: 21px; font-weight: 600; letter-spacing: -.02em; }
  .section-description { margin-bottom: 22px; max-width: 88ch; font-size: 13px; line-height: 1.7; color: #85858f; }
  .settings-load-state { display: flex; align-items: center; gap: 12px; padding: 18px 20px; font-size: 13px; color: #a1a1aa; flex-wrap: wrap; }
  .about-contacts { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 16px; }
  /* 缩略图也要能直接扫出来，所以给到 168px；点开还有大图。 */
  .about-qr { display: flex; flex-direction: column; align-items: center; gap: 8px; width: 190px; padding: 10px; border-radius: 10px; background: #101013; font-size: 12px; line-height: 1.5; color: #a1a1aa; }
  .about-qr img { width: 168px; height: auto; border-radius: 6px; background: #fafafa; }
  .about-contacts .settings-hint { flex: 1 1 220px; }
  .about-zoom { position: fixed; inset: 0; z-index: 5; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 32px; background: rgba(8, 8, 10, .88); }
  .about-zoom-figure { display: flex; flex-direction: column; align-items: center; gap: 14px; margin: 0; }
  .about-zoom img { max-width: min(90vw, 440px); max-height: 62%; border-radius: 10px; background: #fafafa; }
  .about-zoom figcaption { font-size: 13px; color: #a1a1aa; }
  @media (max-width: 1180px) {
    .settings-shell { grid-template-columns: 228px minmax(0, 1fr); }
  }
  @media (max-width: 860px) {
    .settings-shell { grid-template-columns: 196px minmax(0, 1fr); }
  }
  @media (max-width: 640px) {
    .settings-shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
    .settings-rail { padding: 12px 12px 8px; border-right: 0; border-bottom: 1px solid #232327; }
    .settings-nav { flex-direction: row; overflow-x: auto; }
    .settings-nav-item { flex-shrink: 0; }
    .settings-nav-group { display: none; }
  }
</style>
