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
  import { errorMessage, reverseApi } from "../lib/reverse-prompts";
  import { pushToast } from "../lib/toast";
  import Icon from "./Icon.svelte";
  import {
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
  let fileEl = $state<HTMLInputElement | null>(null);
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

  /** 交出去的是读到的原文：截断规则只有后端一处，这里不许自己先切一刀。 */
  async function onFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    await run(async () => {
      const saved = await promptSkillsApi.import(file.name, await file.text());
      promptSkills.update((list) => [...list, saved]);
      selectedId = saved.id;
      if (saved.truncated) {
        pushToast("「" + saved.name + "」太长，超出的那截没进来，自己收一下", { kind: "error", ttl: 6000 });
      }
    }, "已导入「" + file.name + "」");
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
  <div class="psk-scrim" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="psk" role="dialog" aria-modal="true" aria-label="提示词优化技能" tabindex="-1" use:modalFocus>
      <header class="psk-head">
        <div>
          <h2>提示词优化技能</h2>
          <p class="psk-sub">左键点提示词框右下角那颗 <Icon name="sparkle" size={12} /> 用默认技能重写一句，右键换一条。</p>
        </div>
        <button class="psk-x" aria-label="关闭" onclick={onClose}><Icon name="x" size={16} /></button>
      </header>

      <div class="psk-body">
        <div class="psk-side">
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
              <p class="psk-hint">还没有技能。新建一条，或者直接导入一份现成的 SKILL.md。</p>
            {/each}
          </div>
          <div class="psk-side-foot">
            <button class="psk-btn" disabled={busy} onclick={() => void create()}><Icon name="plus" size={12} />新建技能</button>
            <button class="psk-btn" disabled={busy} onclick={() => fileEl?.click()}><Icon name="folder" size={12} />导入 SKILL.md</button>
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
              <span class="psk-label">这条技能怎么写</span>
              <textarea class="psk-text" rows="10" bind:value={instruction} aria-label="技能写法"
                placeholder={"交给模型的指令，例如：\n· 保留原有主体与动作，补上景别、机位、镜头焦段\n· 材质与光影各写一句\n· 只输出提示词本身，不要解释"}></textarea>
            </label>

            <div class="psk-edit-foot">
              <button class="psk-btn" disabled={busy || !useImage} onclick={() => void markDefault("image")}>设为图片默认</button>
              <button class="psk-btn" disabled={busy || !useVideo} onclick={() => void markDefault("video")}>设为视频默认</button>
              {#if selected.builtin_key}
                <button class="psk-btn" disabled={busy} onclick={() => void restore()}>恢复默认写法</button>
              {:else}
                <button class="psk-btn is-danger" class:is-armed={confirmDelete} disabled={busy} onclick={() => void remove()}>
                  {confirmDelete ? "确认删除" : "删除这条技能"}
                </button>
              {/if}
              <button class="psk-btn is-primary" disabled={busy || !dirty} onclick={() => void save()}>保存</button>
            </div>
          {:else}
            <p class="psk-hint">左边挑一条，或者新建一条。</p>
          {/if}
        </div>
      </div>

      {#if error}<p class="psk-error" role="alert">{error}</p>{/if}
      <p class="psk-foot">模型沿用「反推提示词」那一份默认配置{modelNote ? "：现在吃的是 " + modelNote : "，目前还没配好"}。要换模型去 设置 › 反推提示词。</p>
      <input bind:this={fileEl} class="psk-file" type="file" accept=".md,.markdown,.txt" aria-label="选择 SKILL.md 文件"
        onchange={(e) => void onFile(e)} />
    </div>
  </div>
{/if}

<style>
  .psk-scrim {
    position: fixed; inset: var(--desktop-titlebar-height, 0px) 0 0; z-index: 95;
    display: flex; align-items: center; justify-content: center; padding: 24px;
    background: var(--shade-2);
  }
  .psk {
    display: flex; flex-direction: column; gap: 12px; width: 880px; max-width: 96vw; max-height: 92vh;
    padding: 16px; border: 1px solid var(--line-strong); border-radius: var(--r-3);
    background: var(--ink-1); color: var(--text-1); box-shadow: 0 22px 90px var(--shade-2);
    font-size: var(--fs-sm);
  }
  .psk-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .psk-head h2 { margin: 0; font-size: var(--fs-md); font-weight: 600; }
  .psk-sub { margin: 4px 0 0; color: var(--text-2); font-size: var(--fs-xs); }
  .psk-x {
    display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; flex: none;
    padding: 0; border: 1px solid var(--line); border-radius: var(--r-1); background: transparent;
    color: var(--text-2); cursor: pointer;
  }
  .psk-x:hover { background: var(--ink-4); color: var(--text-1); }

  .psk-body { display: flex; gap: 12px; min-height: 0; flex: 1; }
  .psk-side { display: flex; flex-direction: column; gap: 8px; flex: none; width: 228px; }
  .psk-list {
    display: flex; flex-direction: column; gap: 2px; flex: 1; min-height: 120px; overflow-y: auto;
    padding: 4px; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--ink-2);
  }
  .psk-item {
    display: flex; flex-direction: column; gap: 4px; align-items: flex-start; width: 100%;
    padding: 8px; border: 0; border-radius: var(--r-1); background: transparent;
    color: var(--text-2); text-align: left; cursor: pointer;
  }
  .psk-item:hover { background: var(--raise-1); color: var(--text-1); }
  .psk-item.is-on { background: var(--ink-3); color: var(--text-1); }
  .psk-item-name { font-size: var(--fs-sm); }
  .psk-tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .psk-tag {
    padding: 1px 6px; border-radius: var(--r-pill); background: var(--raise-2);
    color: var(--text-3); font-size: var(--fs-2xs); font-style: normal;
  }
  .psk-tag.is-default { background: rgb(var(--accent-rgb) / 16%); color: var(--accent-strong); }
  .psk-side-foot { display: flex; flex-direction: column; gap: 4px; }

  .psk-edit {
    display: flex; flex: 1; flex-direction: column; gap: 8px; min-width: 0; min-height: 0;
    overflow-y: auto; padding: 12px; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--ink-2);
  }
  .psk-field { display: flex; flex-direction: column; gap: 4px; }
  .psk-field-grow { flex: 1; min-height: 96px; }
  .psk-label { color: var(--text-2); font-size: var(--fs-xs); }
  .psk-label-inline { margin-left: 8px; }
  .psk-input, .psk-text {
    box-sizing: border-box; width: 100%; padding: 6px 8px; border: 1px solid var(--line-strong);
    border-radius: var(--r-1); background: var(--ink-1); color: var(--text-1);
    font-family: inherit; font-size: var(--fs-sm);
  }
  .psk-input:focus, .psk-text:focus { border-color: var(--accent); outline: none; }
  .psk-text { flex: 1; min-height: 96px; resize: vertical; line-height: 1.6; }
  .psk-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .psk-select { width: auto; min-height: var(--ctl-sm); }
  .psk-check { display: inline-flex; align-items: center; gap: 4px; color: var(--text-1); font-size: var(--fs-sm); cursor: pointer; }
  .psk-hint { color: var(--text-3); font-size: var(--fs-xs); }
  .psk-edit-foot { display: flex; flex-wrap: wrap; gap: 4px; padding-top: 4px; }

  .psk-btn {
    display: inline-flex; min-height: var(--ctl-sm); align-items: center; gap: 4px;
    padding: 0 8px; border: 1px solid var(--line-strong); border-radius: var(--r-1);
    background: transparent; color: var(--text-1); font-size: var(--fs-sm); cursor: pointer;
  }
  .psk-btn:hover:not(:disabled) { background: var(--ink-4); }
  .psk-btn:disabled { opacity: .45; cursor: default; }
  .psk-btn.is-primary { border-color: transparent; background: var(--accent); color: var(--accent-ink); }
  .psk-btn.is-primary:hover:not(:disabled) { background: var(--accent-strong); }
  .psk-btn.is-danger { color: var(--danger); }
  .psk-btn.is-danger.is-armed { border-color: var(--danger); background: rgb(var(--danger-rgb) / 14%); }

  .psk-error { margin: 0; color: var(--danger); font-size: var(--fs-sm); }
  .psk-foot { margin: 0; color: var(--text-2); font-size: var(--fs-xs); }
  .psk-file { display: none; }
</style>
