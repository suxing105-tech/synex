<!--
  提示词优化技能的管理弹窗：左边挑一条，右边改它。

  为什么不做成设置页里的一个分组：入口挂在再次创作弹窗那颗优化按钮的右键菜单上，人是在
  「刚写完一句提示词、嫌它不顺眼」的那一刻想到要改技能的。让人绕回设置页再翻到这一组，
  大概率就没人改了。

  模型不在这里挑：它吃的是「反推提示词」那一份默认配置——同一个脑子干两件事，再存一份迟早对不上。
  这里只把当前是哪一家报出来，要换模型把人指回设置。
-->
<script lang="ts">
  import { modalFocus } from "../lib/modal-focus";
  import { subscribeFileDrop } from "../lib/native-drop";
  import { errorMessage, reverseApi } from "../lib/reverse-prompts";
  import { revealError, revealLocation } from "../lib/reveal";
  import { isTauri, selectSkillSourcePath } from "../lib/tauri";
  import { pushToast } from "../lib/toast";
  import Icon from "./Icon.svelte";
  import {
    describeImport,
    isSkillSourcePath,
    isTextFilePath,
    KIND_WORDS,
    LANGUAGE_WORDS,
    promptSkills,
    promptSkillsApi,
    promptSkillSettings,
    setDefaultSkill,
    type PromptSkill,
    type PromptSkillDraft,
    type PromptSkillKind,
    type PromptSkillLanguage,
    type SkillConflictMode,
    type SkillImportConflict,
    type SkillImportResult,
  } from "../lib/prompt-skills";

  interface Props {
    open: boolean;
    onClose: () => void;
  }
  let { open, onClose }: Props = $props();

  const skills = $derived($promptSkills);
  /** 新建那条的起手式：后端要求指令非空，给一句说清这里写什么，比留白强。 */
  const NEW_INSTRUCTION = "把这条技能的具体要求补在这里——它会被原样交给模型。";

  let selectedId = $state<number | null>(null);
  let busy = $state(false);
  let error = $state("");
  let confirmDelete = $state(false);
  /** 浏览器版那颗文件框：md 和 .zip 都从这儿进。桌面版走原生对话框。 */
  let sourceEl = $state<HTMLInputElement | null>(null);
  /** 浏览器版选技能包目录用的隐藏 input（webkitdirectory）。桌面版把文件夹直接拖进来。 */
  let dirEl = $state<HTMLInputElement | null>(null);
  /** 后端在问「替换还是另存」时挂着的那一次尝试，和它报回来的冲突。 */
  let pendingAttempt: ImportAttempt | null = $state(null);
  let conflicts = $state<SkillImportConflict[]>([]);
  /** 拖进来的东西像是技能才描红：亮一下再告诉人不收，比一直不亮更误导人。 */
  let dropping = $state(false);
  let modelNote = $state("");

  // 草稿按字段摊平：bind:value 直连，省掉每敲一个字就 spread 一整个对象。
  let name = $state("");
  let note = $state("");
  let useImage = $state(true);
  let useVideo = $state(true);
  let language = $state<PromptSkillLanguage>("auto");
  let withRefs = $state(true);
  let instruction = $state("");

  const selected = $derived(skills.find((item) => item.id === selectedId) ?? null);

  /** 包内文件的展示顺序：写法在前，参考资料按进资料块的次序，资源垫后。 */
  const packageFiles = $derived(
    selected?.package
      ? [...selected.package.files].sort((a, b) => {
          const rank = (file: typeof a) => (file.role === "写法" ? 0 : file.role === "参考" ? 1 : 2);
          return rank(a) - rank(b) || (a.order || 99) - (b.order || 99) || a.path.localeCompare(b.path);
        })
      : [],
  );

  function fill(skill: PromptSkill | null) {
    name = skill?.name ?? "";
    note = skill?.note ?? "";
    useImage = skill?.kinds.includes("image") ?? true;
    useVideo = skill?.kinds.includes("video") ?? true;
    language = skill?.language ?? "auto";
    withRefs = skill?.with_refs ?? true;
    instruction = skill?.instruction ?? "";
    error = "";
    confirmDelete = false;
  }

  /** 草稿当前对应哪一条。按 id 比对：不然刚敲进框里的字会被下一次 effect 原样冲回去。 */
  let syncedId = $state<number | null>(null);

  $effect(() => {
    if (!open) {
      syncedId = null;
      return;
    }
    if (!skills.length) return;
    if (selectedId === null || !skills.some((item) => item.id === selectedId)) selectedId = skills[0].id;
    if (syncedId === selectedId) return;
    syncedId = selectedId;
    fill(selected);
  });

  function kindsOf(): PromptSkillKind[] {
    const out: PromptSkillKind[] = [];
    if (useImage) out.push("image");
    if (useVideo) out.push("video");
    return out;
  }

  const draftOf = (): PromptSkillDraft => ({
    name: name.trim(),
    note: note.trim(),
    kinds: kindsOf(),
    instruction: instruction.trim(),
    language,
    with_refs: withRefs,
  });

  const dirty = $derived(
    !!selected &&
      (name !== selected.name ||
        note !== selected.note ||
        useImage !== selected.kinds.includes("image") ||
        useVideo !== selected.kinds.includes("video") ||
        language !== selected.language ||
        withRefs !== selected.with_refs ||
        instruction !== selected.instruction),
  );

  function putStore(skill: PromptSkill) {
    promptSkills.update((list) => list.map((item) => (item.id === skill.id ? skill : item)));
  }

  /** 所有写库动作走这一个口：错一律落回弹窗内联那行（后端 detail 本来就是能直接给人看的中文）。 */
  async function run(what: () => Promise<unknown>, done: string) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await what();
      pushToast(done, { kind: "success" });
    } catch (e) {
      error = errorMessage(e);
    } finally {
      busy = false;
    }
  }

  async function save() {
    const skill = selected;
    if (!skill) return;
    if (!kindsOf().length) {
      error = "至少勾一族：这条技能得说清它管图片、视频，还是两者都管。";
      return;
    }
    const label = name.trim();
    await run(async () => {
      putStore(await promptSkillsApi.update(skill.id, draftOf()));
    }, "已保存「" + label + "」");
  }

  async function create() {
    await run(async () => {
      const saved = await promptSkillsApi.create({ name: "新技能", instruction: NEW_INSTRUCTION });
      promptSkills.update((list) => [...list, saved]);
      selectedId = saved.id;
    }, "已新建一条技能，把写法补进去再保存");
  }

  async function restore() {
    const skill = selected;
    if (!skill) return;
    await run(async () => {
      const saved = await promptSkillsApi.restoreDefault(skill.id);
      putStore(saved);
      fill(saved);
    }, "已恢复默认写法");
  }

  /** 删是两步：第一下只把按钮变成「确认删除」，第二下才真删。自己建的技能删了就没了。 */
  async function remove() {
    const skill = selected;
    if (!skill) return;
    if (!confirmDelete) {
      confirmDelete = true;
      return;
    }
    const label = skill.name;
    await run(async () => {
      await promptSkillsApi.remove(skill.id);
      promptSkills.update((list) => list.filter((item) => item.id !== skill.id));
      selectedId = null;
    }, "已删除「" + label + "」");
  }

  async function markDefault(kind: PromptSkillKind) {
    const skill = selected;
    if (!skill) return;
    const label = skill.name;
    await run(() => setDefaultSkill(kind, skill.id), "「" + label + "」现在是" + KIND_WORDS[kind] + "提示词的默认技能");
  }

  /** 那一个入口收到的一次尝试长什么样。冲突时原样重发，只改「怎么办」那一参。 */
  type ImportAttempt =
    | { kind: "paths"; paths: string[] }
    | { kind: "markdown"; filename: string; content: string }
    | { kind: "archive"; filename: string; file: File }
    | { kind: "upload"; root: string; files: { path: string; content: string }[] };

  const clashLine = $derived(
    conflicts.length === 1
      ? "库里已经有一条「" + conflicts[0].existing_name + "」" +
        (conflicts[0].source_dir ? "就是这一份" : "同名") +
        "。要换掉它，还是另存一条新的？"
      : conflicts.length + " 条技能和已有的撞了名字。要全部换掉，还是另存新的？",
  );

  /** 四种来源打到四条路由上。撞了怎么办那一参每次都要跟着，别在别处再拼一遍。 */
  function sendAttempt(attempt: ImportAttempt, onConflict: SkillConflictMode) {
    if (attempt.kind === "paths") return promptSkillsApi.importPaths(attempt.paths, onConflict);
    if (attempt.kind === "markdown") {
      return promptSkillsApi.importMarkdown(attempt.filename, attempt.content, onConflict);
    }
    if (attempt.kind === "archive") {
      return promptSkillsApi.importArchive(attempt.file, attempt.filename, onConflict);
    }
    return promptSkillsApi.importPackageUpload(attempt.root, attempt.files, onConflict);
  }

  /** 回来的条目并进清单：替换的那条原地换掉，新的排到最后，选中最末一条。 */
  function applyImported(result: SkillImportResult) {
    if (!result.imported.length) return;
    promptSkills.update((list) => {
      const next = [...list];
      for (const item of result.imported) {
        const at = next.findIndex((row) => row.id === item.id);
        if (at >= 0) next[at] = item;
        else next.push(item);
      }
      return next;
    });
    selectedId = result.imported[result.imported.length - 1].id;
    // 替换是同一个 id 换了内容：草稿那格按 id 比对，不松一下 syncedId 就还挂着旧写法
    syncedId = null;
  }

  /**
   * 所有导入走这一个口。
   *
   * 后端默认「先问」：撞名那一次什么都不写，把冲突报回来，这里挂住原样那一次尝试，
   * 人点了「替换」或「另存」再原样重发。中途不许顺手挑一个默认值——
   * 一次拖二十个来源，猜错一次就是把用户改过的技能吃掉。
   */
  async function importWith(attempt: ImportAttempt, onConflict: SkillConflictMode) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      const result = await sendAttempt(attempt, onConflict);
      if (result.conflicts.length) {
        conflicts = result.conflicts;
        pendingAttempt = attempt;
        return;
      }
      conflicts = [];
      pendingAttempt = null;
      applyImported(result);
      pushToast(describeImport(result), {
        kind: result.imported.length && !result.skipped.length ? "success" : "error",
        ttl: result.skipped.length ? 6000 : 3000,
      });
    } catch (e) {
      error = failText(e);
      conflicts = [];
      pendingAttempt = null;
    } finally {
      busy = false;
    }
  }

  /** 「先不动」不发消息：撤掉那一条问句，库里一个字都没写过，没什么可回滚。 */
  function resolveConflict(choice: "replace" | "new" | "cancel") {
    const attempt = pendingAttempt;
    conflicts = [];
    pendingAttempt = null;
    if (choice === "cancel" || !attempt) return;
    void importWith(attempt, choice);
  }

  /** 桌面版那颗「导入技能」：原生文件框，md 和 .zip 一起摆出去。 */
  async function pickSkillSource() {
    if (busy) return;
    conflicts = [];
    pendingAttempt = null;
    if (!isTauri()) {
      void sourceEl?.click();
      return;
    }
    let path: string | null = null;
    try {
      path = await selectSkillSourcePath();
    } catch (e) {
      error = failText(e);
      return;
    }
    if (!path) return;
    await importWith({ kind: "paths", paths: [path] }, "ask");
  }

  /** 浏览器版那颗文件框：.zip 走 multipart，其余读成文字交原文。截断只在后端切一刀。 */
  async function onSourceFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || busy) return;
    if (file.name.toLowerCase().endsWith(".zip")) {
      await importWith({ kind: "archive", filename: file.name, file }, "ask");
      return;
    }
    await importWith({ kind: "markdown", filename: file.name, content: await file.text() }, "ask");
  }

  /**
   * 整个弹窗都是落点：一整个技能包目录、.zip、SKILL.md 都能拖进来。
   *
   * 路径一律原样交给后端判断，被拒的原因由它说（只有这里能区分「7z 要先解压」
   * 和「这不是个文件」）。描红只认像是技能的那批，拖一堆图片进来不点亮。
   */
  function dropSource(node: HTMLElement) {
    return {
      destroy: subscribeFileDrop(
        () => node,
        (count, paths) => {
          dropping = count > 0 && paths.some(isSkillSourcePath);
        },
        async (paths) => {
          dropping = false;
          await importWith({ kind: "paths", paths }, "ask");
        },
      ),
    };
  }

  /** 后端给的中文原因优先；本地抛的错就把 message 摆出来，别一律换成「请求失败」。 */
  function failText(e: unknown): string {
    const detail = (e as { detail?: string })?.detail;
    if (detail) return detail;
    if (e instanceof Error && e.message) return e.message;
    return errorMessage(e);
  }

  /**
   * 浏览器版「选文件夹」：只送能读成文字的文件，二进制读成文字就是乱码。
   *
   * 桌面版不走这条路——那边把文件夹拖进窗口就行，前端读一遍再传一遍是白搬一趟。
   */
  async function onPackageDir(event: Event) {
    const input = event.target as HTMLInputElement;
    const picked = Array.from(input.files ?? []);
    input.value = "";
    if (!picked.length || busy) return;
    const payload: { path: string; content: string }[] = [];
    for (const file of picked) {
      const rel = (file as any).webkitRelativePath || file.name;
      if (!isTextFilePath(rel)) continue;
      payload.push({ path: rel, content: await file.text() });
    }
    if (!payload.length) {
      error = "这个文件夹里没有能读成文字的文件，换一个技能包目录。";
      return;
    }
    await importWith({ kind: "upload", root: payload[0].path.split("/")[0] || "技能包", files: payload }, "ask");
  }

  /** 在系统文件管理器里打开技能包落盘的那份。 */
  async function revealPackage() {
    const dir = selected?.package_dir;
    if (!dir) return;
    try {
      await revealLocation(dir, false);
    } catch (e) {
      error = revealError(e).message;
    }
  }

  // 脚下一句「现在吃的是哪家哪个模型」。读失败就留空：它只是把人指回设置，不拦任何操作。
  $effect(() => {
    if (!open) {
      modelNote = "";
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const [row, configs] = await Promise.all([reverseApi.settings(), reverseApi.models()]);
        if (!alive) return;
        const hit = configs.find((item) => item.id === row.default_model_id);
        modelNote = !hit ? "" : hit.model ? hit.name + " · " + hit.model : hit.name + "（这家还没挑模型）";
      } catch {
        /* 留空 */
      }
    })();
    return () => {
      alive = false;
    };
  });
</script>

{#if open}
  <div class="psk-scrim" role="presentation" use:dropSource
    onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="psk" class:is-dropping={dropping} role="dialog" aria-modal="true"
      aria-label="提示词优化技能" tabindex="-1" use:modalFocus>
      <header class="psk-head">
        <h2>提示词优化技能</h2>
        <button class="psk-x" aria-label="关闭" onclick={onClose}><Icon name="x" size={16} /></button>
      </header>

      <div class="psk-body">
        <div class="psk-side">
          <div class="psk-side-actions">
            <button class="psk-btn is-lead" disabled={busy} onclick={() => void create()}><Icon name="plus" size={12} />新建技能</button>
            <button class="psk-btn is-lead" disabled={busy} onclick={() => void pickSkillSource()}><Icon name="folder" size={12} />导入技能</button>
            {#if !isTauri()}
              <button class="psk-btn is-lead" disabled={busy} onclick={() => dirEl?.click()}>选文件夹</button>
            {/if}
          </div>
          <div class="psk-list" role="listbox" aria-label="技能清单">
            {#each skills as skill (skill.id)}
              <button class="psk-item" class:is-on={skill.id === selectedId} role="option"
                aria-selected={skill.id === selectedId} onclick={() => (selectedId = skill.id)}>
                <span class="psk-item-name">{skill.name}</span>
                <span class="psk-tags">
                  {#each skill.kinds as kind (kind)}<i class="psk-tag">{KIND_WORDS[kind]}</i>{/each}
                  {#if $promptSkillSettings?.default_image_skill === skill.id}<i class="psk-tag is-default">图片默认</i>{/if}
                  {#if $promptSkillSettings?.default_video_skill === skill.id}<i class="psk-tag is-default">视频默认</i>{/if}
                  {#if skill.builtin_key}<i class="psk-tag">内置</i>{/if}
                </span>
              </button>
            {:else}
              <p class="psk-hint">还没有技能。新建一条，或者把 SKILL.md、.zip、一整个技能包文件夹拖到这个窗口里。</p>
            {/each}
          </div>
        </div>

        <div class="psk-edit">
          {#if selected}
            <label class="psk-field">
              <span class="psk-label">名字</span>
              <input class="psk-input" maxlength={60} bind:value={name} aria-label="技能名字" />
            </label>
            <label class="psk-field">
              <span class="psk-label">一句话说明</span>
              <input class="psk-input" maxlength={200} bind:value={note} aria-label="技能说明" placeholder="清单里悬停时看得见，比如「只补镜头与光影，不改主体」" />
            </label>

            <div class="psk-row">
              <span class="psk-label">管哪一族提示词</span>
              <label class="psk-check"><input type="checkbox" bind:checked={useImage} />图片</label>
              <label class="psk-check"><input type="checkbox" bind:checked={useVideo} />视频</label>
              <span class="psk-label psk-label-inline">输出</span>
              <select class="psk-input psk-select" value={language} aria-label="输出语言"
                onchange={(e) => (language = (e.target as HTMLSelectElement).value as PromptSkillLanguage)}>
                {#each Object.entries(LANGUAGE_WORDS) as [key, word] (key)}
                  <option value={key}>{word}</option>
                {/each}
              </select>
            </div>

            <label class="psk-check">
              <input type="checkbox" bind:checked={withRefs} />
              把已挂上的参考图一起发给模型
              <span class="psk-hint">认图的模型才吃得住，会慢一些；只改文字就关掉它</span>
            </label>

            <label class="psk-field psk-field-grow">
              <span class="psk-label">这条技能怎么写<span class="psk-count">{instruction.length} 字</span></span>
              <textarea class="psk-text" rows="10" bind:value={instruction} aria-label="技能写法"
                placeholder={"交给模型的指令，例如：\n· 保留原有主体与动作，补上景别、机位、镜头焦段\n· 材质与光影各写一句\n· 只输出提示词本身，不要解释"}></textarea>
            </label>

            {#if selected.source === "package" && selected.package}
              <div class="psk-pkg">
                <div class="psk-pkg-head">
                  <span class="psk-label">技能包</span>
                  <span class="psk-hint">
                    {selected.package.root} · {selected.package.files.length} 个文件 · 带进模型 {selected.package.refs_chars} 字
                  </span>
                </div>
                <ul class="psk-pkg-list">
                  {#each packageFiles as file (file.path)}
                    <li>
                      <span class="psk-pkg-path">{file.path}</span>
                      {#if file.role === "写法"}
                        <i class="psk-tag">写法</i>
                      {:else if file.role === "资源"}
                        <i class="psk-tag is-default">资源</i>
                      {:else if file.included && !file.truncated}
                        <i class="psk-tag">已带</i>
                      {:else if file.truncated}
                        <i class="psk-tag">截断</i>
                      {:else}
                        <i class="psk-tag is-default">没带上</i>
                      {/if}
                    </li>
                  {/each}
                </ul>
                <p class="psk-hint">
                  附属文件只作参考文本发给模型，里面的脚本不会执行。
                  {#if selected.package.license}授权：{selected.package.license}。{/if}
                </p>
                {#if isTauri() && selected.package_dir}
                  <button class="psk-btn" disabled={busy} onclick={() => void revealPackage()}>在文件夹中显示</button>
                {/if}
              </div>
            {/if}

            <div class="psk-edit-foot">
              <button class="psk-btn" disabled={busy || !useImage} onclick={() => void markDefault("image")}>设为图片默认</button>
              <button class="psk-btn" disabled={busy || !useVideo} onclick={() => void markDefault("video")}>设为视频默认</button>
              {#if selected.builtin_key}
                <button class="psk-btn" disabled={busy} onclick={() => void restore()}>恢复默认写法</button>
              {:else}
                <button class="psk-btn is-danger" class:is-armed={confirmDelete} disabled={busy} onclick={() => void remove()}>
                  {confirmDelete
                    ? selected.source === "package" ? "确认删除（连同包内文件）" : "确认删除"
                    : "删除这条技能"}
                </button>
              {/if}
              <button class="psk-btn is-primary" disabled={busy || !dirty} onclick={() => void save()}>保存</button>
            </div>
          {:else}
            <p class="psk-hint">左边挑一条，或者新建一条。</p>
          {/if}
        </div>
      </div>

      {#if conflicts.length}
        <div class="psk-clash" role="group" aria-label="已有同名技能">
          <span class="psk-clash-text">{clashLine}</span>
          <span class="psk-clash-btns">
            <button class="psk-btn" disabled={busy} onclick={() => resolveConflict("replace")}>替换原来的</button>
            <button class="psk-btn" disabled={busy} onclick={() => resolveConflict("new")}>另存为新的</button>
            <button class="psk-btn" disabled={busy} onclick={() => resolveConflict("cancel")}>先不动</button>
          </span>
        </div>
      {/if}
      {#if error}<p class="psk-error" role="alert">{error}</p>{/if}
      <p class="psk-foot">模型沿用「反推提示词」那一份默认配置{modelNote ? "：现在吃的是 " + modelNote : "，目前还没配好"}。要换模型去 设置 › 反推提示词。</p>
      <input bind:this={sourceEl} class="psk-file" type="file" accept=".md,.markdown,.txt,.zip"
        aria-label="选择技能文件" onchange={(e) => void onSourceFile(e)} />
      <input bind:this={dirEl} class="psk-file" type="file" webkitdirectory multiple aria-label="选择技能包文件夹"
        onchange={(e) => void onPackageDir(e)} />
    </div>
  </div>
{/if}

<style>
  .psk-scrim {
    position: fixed; inset: var(--desktop-titlebar-height, 0px) 0 0; z-index: 95;
    display: flex; align-items: center; justify-content: center; padding: var(--sp-6);
    background: var(--shade-2);
  }
  .psk {
    display: flex; flex-direction: column; gap: var(--sp-3); width: 880px; max-width: 96vw; max-height: 92vh;
    padding: var(--sp-4); border: 1px solid var(--line-strong); border-radius: var(--r-3);
    background: var(--ink-1); color: var(--text-1); box-shadow: 0 22px 90px var(--shade-2);
    font-size: var(--fs-sm);
  }
  .psk-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-3); }
  .psk-head h2 { margin: 0; font-size: var(--fs-md); font-weight: 600; }
  .psk-x {
    display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; flex: none;
    padding: 0; border: 1px solid var(--line); border-radius: var(--r-1); background: transparent;
    color: var(--text-2); cursor: pointer;
  }
  .psk-x:hover { background: var(--ink-4); color: var(--text-1); }

  .psk-body { display: flex; gap: var(--sp-3); min-height: 0; flex: 1; }
  .psk-side { display: flex; flex-direction: column; gap: var(--sp-2); flex: none; width: 228px; }
  .psk-list {
    display: flex; flex-direction: column; gap: var(--sp-05); flex: 1; min-height: 120px; overflow-y: auto;
    padding: var(--sp-1); border: 1px solid var(--line); border-radius: var(--r-2); background: var(--ink-2);
  }
  .psk-item {
    display: flex; flex-direction: column; gap: var(--sp-1); align-items: flex-start; width: 100%;
    padding: var(--sp-2); border: 0; border-radius: var(--r-1); background: transparent;
    color: var(--text-2); text-align: left; cursor: pointer;
  }
  .psk-item:hover { background: var(--raise-1); color: var(--text-1); }
  .psk-item.is-on { background: var(--ink-3); color: var(--text-1); }
  .psk-item-name { font-size: var(--fs-sm); }
  .psk-tags { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
  .psk-tag {
    padding: 1px var(--sp-2); border-radius: var(--r-pill); background: var(--raise-2);
    color: var(--text-3); font-size: var(--fs-2xs); font-style: normal;
  }
  .psk-tag.is-default { background: rgb(var(--accent-rgb) / 16%); color: var(--accent-strong); }
  .psk-side-actions { display: flex; flex-direction: column; gap: var(--sp-1); }

  .psk-edit {
    display: flex; flex: 1; flex-direction: column; gap: var(--sp-2); min-width: 0; min-height: 0;
    overflow-y: auto; padding: var(--sp-3); border: 1px solid var(--line); border-radius: var(--r-2); background: var(--ink-2);
  }
  .psk-field { display: flex; flex-direction: column; gap: var(--sp-1); }
  .psk-field-grow { flex: 1; min-height: 96px; }
  .psk-label { color: var(--text-2); font-size: var(--fs-xs); }
  /* 原文一个字都不切，所以写了多少字要摆在标题边上——那是「完整加载」唯一的可见证据。 */
  .psk-count { margin-left: var(--sp-1); color: var(--text-3); font-size: var(--fs-2xs); font-variant-numeric: tabular-nums; }
  .psk-label-inline { margin-left: var(--sp-2); }
  .psk-input, .psk-text {
    box-sizing: border-box; width: 100%; padding: var(--sp-2) var(--sp-2); border: 1px solid var(--line-strong);
    border-radius: var(--r-1); background: var(--ink-1); color: var(--text-1);
    font-family: inherit; font-size: var(--fs-sm);
  }
  .psk-input:focus, .psk-text:focus { border-color: var(--accent); outline: none; }
  .psk-text { flex: 1; min-height: 96px; resize: vertical; line-height: var(--lh-read); }
  .psk-row { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
  .psk-select { width: auto; min-height: var(--ctl-sm); }
  .psk-check { display: inline-flex; align-items: center; gap: var(--sp-1); color: var(--text-1); font-size: var(--fs-sm); cursor: pointer; }
  .psk-hint { color: var(--text-3); font-size: var(--fs-xs); }
  .psk-edit-foot { display: flex; flex-wrap: wrap; gap: var(--sp-1); padding-top: var(--sp-1); }

  .psk-btn {
    display: inline-flex; min-height: var(--ctl-sm); align-items: center; gap: var(--sp-1);
    padding: 0 var(--sp-2); border: 1px solid var(--line-strong); border-radius: var(--r-1);
    background: transparent; color: var(--text-1); font-size: var(--fs-sm); cursor: pointer;
  }
  .psk-btn:hover:not(:disabled) { background: var(--ink-4); }
  .psk-btn:disabled { opacity: .45; cursor: default; }
  .psk-btn.is-primary { border-color: transparent; background: var(--accent); color: var(--accent-ink); }
  /* 保存排在最右：左边那几颗是这条技能的辅助操作，主次一眼分得开。 */
  .psk-edit-foot .psk-btn.is-primary { margin-left: auto; }
  /* 新建 / 导入是这一页的入口，不该压在清单底下：描上 accent，一眼看见。 */
  .psk-side-actions .psk-btn.is-lead {
    border-color: rgb(var(--accent-rgb) / 42%); background: rgb(var(--accent-rgb) / 14%);
    color: var(--accent-strong); font-weight: 600;
  }
  .psk-side-actions .psk-btn.is-lead:hover:not(:disabled) { background: rgb(var(--accent-rgb) / 24%); }
  .psk-btn.is-primary:hover:not(:disabled) { background: var(--accent-strong); }
  .psk-btn.is-danger { color: var(--danger); }
  .psk-btn.is-danger.is-armed { border-color: var(--danger); background: rgb(var(--danger-rgb) / 14%); }

  .psk.is-dropping {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgb(var(--accent-rgb) / 45%), 0 22px 90px var(--shade-2);
  }
  .psk-error { margin: 0; color: var(--danger); font-size: var(--fs-sm); }
  .psk-clash {
    display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
    gap: var(--sp-3); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--line-strong);
    border-radius: var(--r-2); background: var(--ink-2);
  }
  .psk-clash-text { color: var(--text-1); font-size: var(--fs-xs); line-height: var(--lh-ui); }
  .psk-clash-btns { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
  .psk-foot { margin: 0; color: var(--text-2); font-size: var(--fs-xs); }
  .psk-file { display: none; }
  .psk-pkg {
    display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--line); border-radius: var(--r-2); background: var(--ink-2);
  }
  .psk-pkg-head { display: flex; align-items: baseline; gap: var(--sp-2); }
  .psk-pkg-list {
    display: flex; flex-direction: column; gap: 3px; margin: 0; padding: 0;
    list-style: none; max-height: 132px; overflow-y: auto;
  }
  .psk-pkg-list li { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-xs); }
  .psk-pkg-path {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--text-2); direction: rtl; text-align: left;
  }
</style>
