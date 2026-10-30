# -*- coding: utf-8 -*-
"""设置页加「已隐藏的内置工作流 + 恢复」。"""
import io

ROOT = "C:/Users/Administrator/Documents/ChatGPT/苏醒图库/"
SVELTE = ROOT + "frontend/src/components/CloneTemplates.svelte"
ARROW = chr(0x2192)

P1_OLD = "    type CloneInspect, type CloneSlot, type CloneTemplate,"
P1_NEW = "    type CloneHiddenBuiltin, type CloneInspect, type CloneSlot, type CloneTemplate,"

P2_OLD = '''  let error = $state("");
  let notice = $state("");'''
P2_NEW = '''  let error = $state("");
  let notice = $state("");
  // 删掉的内置工作流。以前删了就是永别，这一栏是后悔药；老后端没这个接口时留空。
  let hidden = $state<CloneHiddenBuiltin[]>([]);'''

P3_OLD = '''      templates = Array.isArray(res?.items) ? res.items : [];
      failed = false;'''
P3_NEW = '''      templates = Array.isArray(res?.items) ? res.items : [];
      failed = false;
      // 隐藏列表读不到不能牵连模板本身（老后端根本没这个接口），单独吞掉。
      hidden = await cloneApi.hiddenTemplates().catch(() => []);'''

P4_OLD = '''  async function run(fn: () => Promise<void>, okMessage = "") {'''
P4_NEW = '''  /** 恢复一条内置工作流。产出族别的中文名自己判：隐藏项没有模板那些字段。 */
  function hiddenKindWord(kind: string): string {
    return kind === "video" || kind === "audio" || kind === "image"
      ? WF_KIND_WORDS[kind as "image" | "video" | "audio"] : kind;
  }

  async function run(fn: () => Promise<void>, okMessage = "") {'''

P5_OLD = '''      </ul>
    {/if}
  </SettingsRow>
</div>

<div class="settings-card">
  <SettingsRow title="导入或替换工作流"'''
P5_NEW = '''      </ul>
    {/if}
    {#if hidden.length}
      <!-- 删内置工作流以前是单向门：拉黑名单看不见也没有反悔，删错只能进库改。
           v0.2.31 那次「音频少一种模式」就是这个洞，所以这栏既是列表也是解药。 -->
      <p class="settings-hint clone-hidden-title">已隐藏的内置工作流 {hidden.length} 条：删掉之后启动不会再自动装回来，要用的话在这里恢复。</p>
      <ul class="clone-tpl-list">
        {#each hidden as one (one.key)}
          <li class="clone-tpl clone-tpl-hidden">
            <div class="clone-tpl-main">
              <span class="clone-tpl-name" title={one.name}>{templateDisplayName(one.name)}</span>
              <span class="clone-tpl-kind" class:is-video={one.media_kind === "video"}
                class:is-audio={one.media_kind === "audio"}>{hiddenKindWord(one.media_kind)}</span>
            </div>
            <div class="clone-tpl-actions">
              <button class="setting-button" disabled={busy}
                onclick={() => void run(async () => {
                  await cloneApi.restoreHidden(one.key);
                  await reload(true);
                }, `已恢复「${templateDisplayName(one.name)}」，弹窗里重新能选它了。`)}>恢复</button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </SettingsRow>
</div>

<div class="settings-card">
  <SettingsRow title="导入或替换工作流"'''

P6_OLD = "tpl.is_builtin ? \"内置模板已删除，以后启动不会再自动装回来。已生成的素材不受影响。\""
P6_NEW = "tpl.is_builtin ? \"内置模板已删除，启动不会再自动装回来；下面「已隐藏的内置工作流」里可以恢复。已生成的素材不受影响。\""

P7_OLD = 'title="安装包自带的官方工作流。删掉就不会下次启动又装回来；自己改过之后，版本更新也不会覆盖你这份。"'
P7_NEW = 'title="安装包自带的官方工作流。删掉后不再自动装回来，设置页下方可以恢复；自己改过之后，版本更新也不会覆盖你这份。"'

P8_OLD = "  .clone-tpl-name { font-weight: 600; color: #ececed; }"
P8_NEW = "  .clone-tpl-name { font-weight: 600; color: #ececed; }\n  .clone-hidden-title { margin: 14px 0 6px; }\n  .clone-tpl-hidden { background: #17171a; }\n  .clone-tpl-hidden .clone-tpl-name { font-weight: 500; color: #a1a1aa; }"


def patch(path, pairs):
    t = io.open(path, encoding="utf-8", newline="").read()
    nl = "\r\n" if "\r\n" in t[:4000] else "\n"
    for a, b in pairs:
        a2, b2 = a.replace("\n", nl), b.replace("\n", nl)
        if t.count(a2) != 1:
            raise SystemExit("anchor miss :: %s :: %d" % (a.splitlines()[0][:50], t.count(a2)))
        t = t.replace(a2, b2)
    io.open(path, "w", encoding="utf-8", newline="").write(t)
    print("patched", path.rsplit("/", 1)[-1])


patch(SVELTE, [(P1_OLD, P1_NEW), (P2_OLD, P2_NEW), (P3_OLD, P3_NEW), (P4_OLD, P4_NEW),
               (P5_OLD, P5_NEW), (P6_OLD, P6_NEW), (P7_OLD, P7_NEW), (P8_OLD, P8_NEW)])