<script lang="ts">
  import { get } from "svelte/store";
  import { shortcutActions, shortcutSettings, defaultShortcuts, eventShortcut, shortcutLabel, validateShortcuts, saveShortcuts, type ShortcutId } from "../lib/shortcut-settings";
  import SettingsRow from "./SettingsRow.svelte";
  let draft = $state({ ...get(shortcutSettings) });
  let recording = $state<ShortcutId | null>(null);
  let message = $state("");
  function capture(e: KeyboardEvent, id: ShortcutId) {
    if (recording !== id) return;
    // Tab 只给「展开 / 收起右侧栏」这一条当快捷键（2026-11-16 苏醒要回来的那一手）。
    // 录右栏时 Tab 是一次有效输入，所以照样吞掉按键：焦点若在录制中途被移走，onblur 会把录制打断。
    if (e.key === "Tab" && id !== "rightSidebar") {
      recording = null; message = "Tab 只给「展开 / 收起右侧栏」，这一条请用带修饰键的组合"; return;
    }
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
    点击按键后按下新组合，支持 Ctrl、Alt、Shift、Win / Cmd。Esc 取消录制。
    Tab 是「展开 / 收起右侧栏」的默认键，只在中间这一列（工具栏与素材网格）接管；焦点在输入框、左侧栏、右侧栏、设置或弹层里时，Tab 照旧移动焦点，Shift+Tab 任何时候都走焦点。
    输入文字、输入法和打开设置时不触发；图片操作需选中图片，空格预览的是当前选中的那一张（没选中才用鼠标停在的那张）。系统占用的组合可能无法使用。
  </p>
</section>

<style>
  .shortcut-settings { display: flex; flex-direction: column; gap: var(--sp-3); }
  .shortcut-settings > .settings-hint { padding: 0 var(--sp-05); }
  .shortcut-key { min-width: 118px; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-xs); background: #101013; border: 1px solid #3f3f46; border-radius: var(--r-1); color: #e4e4e7; }
  /* 无障碍：命中区 24 高起（WCAG 2.5.8），字色收进 --text-3（同值，不再写 hex） */
  .shortcut-clear { min-height: 24px; display: inline-flex; align-items: center; font-size: var(--fs-xs); color: var(--text-3); }
  .shortcut-clear:hover { color: #e4e4e7; }
</style>
