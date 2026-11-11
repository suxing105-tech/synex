<script lang="ts">
  import { get } from "svelte/store";
  import { shortcutActions, shortcutSettings, defaultShortcuts, eventShortcut, shortcutLabel, validateShortcuts, saveShortcuts, type ShortcutId } from "../lib/shortcut-settings";
  import SettingsRow from "./SettingsRow.svelte";
  let draft = $state({ ...get(shortcutSettings) });
  let recording = $state<ShortcutId | null>(null);
  let message = $state("");
  function capture(e: KeyboardEvent, id: ShortcutId) {
    if (recording !== id) return;
    // Tab 不吞：录制中按 Tab 就是放弃录制、把焦点交给下一个控件。
    // 快捷键永远不许绑 Tab（绑了就会卡死键盘焦点遍历，WCAG 2.1.2），这里没什么可录的。
    if (e.key === "Tab") { recording = null; message = "Tab 用于移动焦点，不能绑定"; return; }
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") { recording = null; return; }
    const key = eventShortcut(e);
    if (!key) return;
    const next = { ...draft, [id]: key };
    const error = validateShortcuts(next);
    if (error) { message = error; return; }
    draft = next;
    recording = null;
    message = "尚未保存";
  }
  function save() {
    try { saveShortcuts(draft); message = "快捷键已保存，立即生效"; }
    catch (e) { message = (e as Error).message; }
  }
</script>

<section class="shortcut-settings">
  <div class="settings-card">
    <div class="settings-card-body">
      {#each shortcutActions as action}
        <SettingsRow title={action.label}>
          {#snippet control()}
            <button class="shortcut-key" aria-label={`设置${action.label}快捷键`} aria-pressed={recording === action.id}
              onclick={() => { recording = action.id; message = "请按下新快捷键"; }}
              onblur={() => recording = null} onkeydown={(e) => capture(e, action.id)}>{recording === action.id ? "请按键…" : shortcutLabel(draft[action.id])}</button>
            <button class="shortcut-clear" onclick={() => { draft[action.id] = ""; message = "尚未保存"; }}>清除</button>
          {/snippet}
        </SettingsRow>
      {/each}
      <div class="settings-card-footer">
        <span class="settings-hint" role="status">{message || "保存在当前设备，重启后保留。"}</span>
        <button class="setting-button" onclick={() => { draft = { ...defaultShortcuts }; recording = null; message = "已恢复默认，点击保存生效"; }}>恢复默认</button>
        <button class="setting-button bg-accent text-bg" onclick={save}>保存快捷键</button>
      </div>
    </div>
  </div>
  <p class="settings-hint">
    点击按键后按下新组合，支持 Ctrl、Alt、Shift、Win / Cmd。Esc 取消录制；Tab 只用来移动焦点，不能绑定成快捷键。
    输入文字、输入法和打开设置时不触发；图片操作需选中图片，预览需鼠标停在图片上。系统占用的组合可能无法使用。
  </p>
</section>

<style>
  .shortcut-settings { display: flex; flex-direction: column; gap: 12px; }
  .shortcut-settings > .settings-hint { padding: 0 2px; }
  .shortcut-key { min-width: 118px; padding: 7px 12px; font-size: 12px; background: #101013; border: 1px solid #3f3f46; border-radius: 7px; color: #e4e4e7; }
  /* 无障碍：命中区 24 高起（WCAG 2.5.8），字色收进 --text-3（同值，不再写 hex） */
  .shortcut-clear { min-height: 24px; display: inline-flex; align-items: center; font-size: 12px; color: var(--text-3); }
  .shortcut-clear:hover { color: #e4e4e7; }
</style>
