from pathlib import Path
root=Path('frontend/src')
p=root/'components/SettingsModal.svelte'
s=p.read_text(encoding='utf-8').replace('  import UpdatePanel', '  import ShortcutSettings from "./ShortcutSettings.svelte";\n  import UpdatePanel')
s=s.replace('role="dialog">', 'role="dialog" aria-modal="true" aria-label="设置" data-settings-dialog>')
s=s.replace('p-7 w-[640px] max-w-[92vw] max-h-[85vh] overflow-y-auto', 'settings-shell w-[900px] max-w-[94vw] h-[min(760px,88vh)] overflow-hidden flex flex-col')
s=s.replace('justify-between mb-5', 'justify-between px-6 py-4 border-b border-border')
s=s.replace('<nav class="flex gap-2 mb-5 flex-wrap"', '<div class="settings-body flex flex-1 min-h-0">\n      <nav class="settings-nav flex flex-col gap-2 p-4 w-[170px] shrink-0 border-r border-border overflow-y-auto"')
s=s.replace('["通用", "模型与反推", "ComfyUI", "关于与更新"]', '["通用", "模型与反推", "快捷键", "ComfyUI", "关于与更新"]')
s=s.replace('class="text-xs px-3 py-2 rounded border border-border" aria-pressed', 'class="text-sm text-left px-3 py-3 rounded" aria-pressed')
s=s.replace('</nav>','</nav>\n      <div class="settings-content flex-1 min-w-0 overflow-y-auto p-6">\n      <h3 class="text-base font-semibold mb-5">{tab}</h3>\n      {#if tab === "快捷键"}<ShortcutSettings />{/if}')
s=s.replace('      <div class="flex justify-end gap-2 pt-3 border-t border-border">','      </div>\n      </div>\n      <div class="flex justify-end gap-2 px-6 py-3 border-t border-border">')
s+='\n<style>\n  @media (max-width: 600px) {\n    .settings-nav { width: 112px; padding: 8px; }\n    .settings-content { padding: 12px; }\n  }\n</style>\n'
p.write_text(s,encoding='utf-8')
p=root/'lib/shortcuts.ts';s=p.read_text(encoding='utf-8');s='import { matchesAction, type ShortcutId } from "./shortcut-settings";\n'+s
s=s.replace('  key: string; //','  action?: ShortcutId;\n  key: string; //')
s=s.replace('if (!(e instanceof KeyboardEvent)) return;', 'if (!(e instanceof KeyboardEvent)) return;\n    if (e.isComposing || e.repeat || document.querySelector("[data-settings-dialog]")) return;')
s=s.replace('if (!matches(e, b.parsed)) continue;', 'if (b.action ? !matchesAction(e, b.action) : !matches(e, b.parsed)) continue;')
p.write_text(s,encoding='utf-8')
p=root/'components/DetailPanel.svelte';s=p.read_text(encoding='utf-8')
for key,action in [('p','positive'),('n','negative'),('s','seed'),('shift+c','comfy'),('f','favorite'),('t','tags')]:
 s=s.replace(f'key: "{key}",',f'key: "{key}", action: "{action}",')
p.write_text(s,encoding='utf-8')
for file in ['Feed','Lightbox']:
 p=root/f'components/{file}.svelte';s=p.read_text(encoding='utf-8').replace('<script lang="ts">','<script lang="ts">\n  import { matchesAction, shortcutBlocked } from "../lib/shortcut-settings";')
 s=s.replace('function handleKey(e: KeyboardEvent) {','function handleKey(e: KeyboardEvent) {\n    if (shortcutBlocked(e)) return;')
 s=s.replace('e.key === " " || e.code === "Space"','matchesAction(e, "preview")').replace('e.key === "ArrowLeft"','matchesAction(e, "previous")').replace('e.key === "ArrowRight"','matchesAction(e, "next")').replace('e.key === " "','matchesAction(e, "preview")')
 p.write_text(s,encoding='utf-8')
