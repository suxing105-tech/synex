from pathlib import Path
p=Path('frontend/src/App.svelte');s=p.read_text(encoding='utf-8')
s=s.replace('<button class="shrink-0 border-t border-border px-4 py-3 text-left text-[13px] hover:bg-surface-3" onclick={() => (settingsOpen = true)} aria-label="全局设置">⚙ 设置</button>', '''<div class="sidebar-settings flex items-center justify-start shrink-0 h-24 px-5">
        <button class="flex items-center justify-center w-12 h-12 rounded-xl text-zinc-400 hover:bg-surface-3 hover:text-zinc-100 focus-visible:bg-surface-3 focus-visible:text-zinc-100 focus-visible:outline-none transition-colors" onclick={() => (settingsOpen = true)} aria-label="全局设置" title="设置">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m9.5 3-.6 2.1-1.5.9-2.1-.5-2.5 4.3 1.5 1.6v1.8l-1.5 1.6 2.5 4.3 2.1-.5 1.5.9.6 2.1h5l.6-2.1 1.5-.9 2.1.5 2.5-4.3-1.5-1.6v-1.8l1.5-1.6-2.5-4.3-2.1.5-1.5-.9L14.5 3z" />
            <circle cx="12" cy="12.3" r="3.2" />
          </svg>
        </button>
      </div>''')
p.write_text(s,encoding='utf-8')
p=Path('frontend/src/components/SettingsModal.svelte');s=p.read_text(encoding='utf-8')
s=s.replace('fixed inset-0 z-[60] bg-black/75 flex items-center justify-center','fixed inset-0 z-[60] bg-surface-2')
s=s.replace('fill-interactions bg-surface-2 border border-border rounded-[12px] settings-shell w-[900px] max-w-[94vw] h-[min(760px,88vh)] overflow-hidden flex flex-col','fill-interactions settings-shell w-full h-full overflow-hidden flex flex-col')
s=s.replace('justify-between px-6 py-4 border-b border-border','justify-between px-8 py-6 shrink-0')
s=s.replace('text-lg font-semibold','text-2xl font-semibold tracking-tight')
s=s.replace('class="w-8 h-8 rounded bg-surface border border-border"','class="w-10 h-10 rounded-xl text-2xl text-muted"')
s=s.replace('settings-nav flex flex-col gap-2 p-4 w-[170px] shrink-0 border-r border-border overflow-y-auto','settings-nav flex flex-col gap-2 px-5 py-6 w-[240px] shrink-0 overflow-y-auto bg-surface')
s=s.replace('text-sm text-left px-3 py-3 rounded','text-sm text-left px-4 py-3 rounded-xl')
s=s.replace('settings-content flex-1 min-w-0 overflow-y-auto p-6','settings-content flex-1 min-w-0 overflow-y-auto')
s=s.replace('<h3 class="text-base font-semibold mb-5">{tab}</h3>','<div class="settings-page w-full max-w-[960px] mx-auto px-12 py-10">\n      <h3 class="text-2xl font-semibold tracking-tight mb-8">{tab}</h3>')
s=s.replace('      </div>\n      </div>\n      <div class="flex justify-end gap-2 px-6 py-3 border-t border-border">','      <div class="flex justify-end gap-2 pt-8 mt-6 border-t border-border">')
s=s.replace('>关闭</button>\n        {#if', '>返回图库</button>\n        {#if')
s=s.replace('      </div>\n    </div>\n  </div>\n{/if}', '      </div>\n      </div>\n      </div>\n      </div>\n    </div>\n  </div>\n{/if}')
s=s.replace('.settings-content { padding: 12px; }','.settings-page { padding: 24px 16px; }')
p.write_text(s,encoding='utf-8')
