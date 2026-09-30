<script lang="ts">
  import { get } from "svelte/store";
  import { shortcutActions, shortcutSettings, defaultShortcuts, eventShortcut, shortcutLabel, validateShortcuts, saveShortcuts, type ShortcutId } from "../lib/shortcut-settings";
  let draft = $state({ ...get(shortcutSettings) });
  let recording = $state<ShortcutId | null>(null);
  let message = $state("");
  function capture(e: KeyboardEvent, id: ShortcutId) {
    if (recording !== id) return;
    if (e.key === "Tab" && e.shiftKey) { recording = null; return; }
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

<section class="shortcut-settings space-y-4">
  <p class="text-xs text-muted">点击按键后按下新组合，支持 Ctrl、Alt、Shift、Win / Cmd。Esc 取消录制，Shift + Tab 移动焦点；录制时可直接按 Tab 进行绑定。</p>
  <p class="text-xs text-muted">图片操作需选中图片；预览需鼠标停在图片上。输入文字和打开设置时不触发。Esc 保留用于关闭或取消。系统占用的组合可能无法使用。</p>
  <p class="text-xs text-muted">侧栏默认：Tab 切换右侧栏，~ / ` 键切换左侧栏。仅在主界面且未输入文字时生效。</p>
  <div class="space-y-2">
    {#each shortcutActions as action}
      <div class="shortcut-row">
        <span class="flex-1 text-sm">{action.label}</span>
        <button class="rounded px-3 py-2 text-xs bg-surface-3 min-w-[110px]" aria-label={`设置${action.label}快捷键`} aria-pressed={recording === action.id}
          onclick={() => { recording = action.id; message = "请按下新快捷键"; }}
          onblur={() => recording = null} onkeydown={(e) => capture(e, action.id)}>{recording === action.id ? "请按键…" : shortcutLabel(draft[action.id])}</button>
        <button class="rounded px-2 py-2 text-xs text-muted" onclick={() => { draft[action.id] = ""; message = "尚未保存"; }}>清除</button>
      </div>
    {/each}
  </div>
  <p class="text-xs text-muted" role="status">{message || "保存在当前设备，重启后保留。修改后点击保存。"}</p>
  <div class="flex gap-2 pt-3">
    <button class="rounded px-3 py-2 text-xs" onclick={() => { draft = { ...defaultShortcuts }; recording = null; message = "已恢复默认，点击保存生效"; }}>恢复默认</button>
    <button class="rounded px-3 py-2 text-xs bg-accent text-bg" onclick={save}>保存快捷键</button>
  </div>
</section>

<style>
  .shortcut-settings { max-width: 640px; }
  .shortcut-settings > p { line-height: 1.8; font-size: 13px; }
  .shortcut-row { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 8px 0; border-bottom: 1px solid #2e2e33; }
  .shortcut-row button { background: transparent; border: 1px solid #3f3f46; font-size: 12px; }
  .shortcut-row button:last-child { border: 0; }
</style>
