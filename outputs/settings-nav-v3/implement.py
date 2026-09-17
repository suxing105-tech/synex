from pathlib import Path
p=Path('frontend/src/App.svelte');s=p.read_text(encoding='utf-8');a=s.index('      <div class="sidebar-settings');b=s.index('    </aside>',a);s=s[:a]+s[b:];p.write_text(s,encoding='utf-8')
p=Path('frontend/src/components/SettingsModal.svelte');s=p.read_text(encoding='utf-8');s=s.replace('      <div class="flex items-center justify-between px-8 py-6 shrink-0">\n        <h2 class="text-2xl font-semibold tracking-tight">设置</h2>\n        <button class="w-10 h-10 rounded-xl text-2xl text-muted" aria-label="关闭设置" onclick={() => (open = false)}>×</button>\n      </div>', '''      <div class="flex items-stretch shrink-0 h-[88px]">
        <div class="settings-title w-[240px] shrink-0 bg-surface flex items-center px-8">
          <h2 class="text-2xl font-semibold tracking-tight">设置</h2>
        </div>
        <div class="flex flex-1 items-center justify-end px-8">
          <button class="settings-return flex items-center justify-center w-10 h-10 rounded-xl text-muted" aria-label="返回图库" title="返回图库" onclick={() => (open = false)}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 5-7 7 7 7M3 12h18" /></svg>
          </button>
        </div>
      </div>''')
s=s.replace('<button class="text-sm text-left px-4 py-3 rounded-xl" aria-pressed={tab === item} onclick={() => tab = item}>{item}</button>', '''<button class="flex items-center gap-3 text-sm text-left px-4 py-3 rounded-xl" aria-pressed={tab === item} onclick={() => tab = item}>
            <svg class="shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              {#if item === "通用"}<path d="M4 7h8m4 0h4M4 17h3m4 0h9" /><circle cx="14" cy="7" r="2" /><circle cx="9" cy="17" r="2" />
              {:else if item === "模型与反推"}<rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 4-6 5 7" />
              {:else if item === "快捷键"}<rect x="2" y="5" width="20" height="14" rx="3" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15h10" />
              {:else if item === "ComfyUI"}<rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="15" y="15" width="6" height="6" rx="1.5" /><path d="M9 6h6a3 3 0 0 1 3 3v6M6 9v9h9" />
              {:else}<circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" />{/if}
            </svg>
            <span>{item}</span>
          </button>''')
s=s.replace('.settings-nav { width: 112px; padding: 8px; }','.settings-nav { width: 144px; padding: 8px; }\n    .settings-title { width: 144px; padding: 0 24px; }')
p.write_text(s,encoding='utf-8')
p=Path('frontend/src/app.css');s=p.read_text(encoding='utf-8');s+='''
/* 设置返回入口使用醒目的品牌底色。 */
.fill-interactions button.settings-return:enabled:hover,
.fill-interactions button.settings-return:enabled:focus-visible {
  background-color: #f24e4e;
  color: #0e0e10;
}
''';p.write_text(s,encoding='utf-8')
p=Path('frontend/src/__tests__/settings-fill-interactions.test.ts');s=p.read_text(encoding='utf-8');a=s.index('  it("侧栏入口');b=s.index('  it.each',a);s=s[:a]+'''  it("移除左下设置入口，标题与分类统一底色且分类有线性图标", () => {
    expect(read("App.svelte")).not.toContain('sidebar-settings');
    expect(read("components/HeaderBar.svelte")).toContain('title="设置"');
    const source = read("components/SettingsModal.svelte");
    expect(source).toContain('settings-title w-[240px] shrink-0 bg-surface');
    expect(source).toContain('overflow-y-auto bg-surface');
    expect(source).toContain('width="18" height="18"');
    expect(source).toContain('aria-label="返回图库"');
    expect(source).not.toContain('>×</button>');
    expect(read('components/FolderTree.svelte')).not.toContain('本地缓存');
  });
  it("返回图标悬停与键盘焦点使用品牌底色", () => {
    const states: string[] = [];
    css.walkRules(rule => {
      if (!rule.selector.includes('button.settings-return')) return;
      states.push(rule.selector);
      expect(rule.nodes.some(n => n.type === 'decl' && n.prop === 'background-color' && n.value === '#f24e4e')).toBe(true);
    });
    expect(states.join()).toContain(':enabled:hover');
    expect(states.join()).toContain(':enabled:focus-visible');
  });
'''+s[b:];p.write_text(s,encoding='utf-8')
