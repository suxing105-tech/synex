from pathlib import Path
p=Path('frontend/src/App.svelte');s=p.read_text(encoding='utf-8')
s=s.replace('text-zinc-400 hover:bg-surface-3 hover:text-zinc-100 focus-visible:bg-surface-3 focus-visible:text-zinc-100','text-zinc-400 hover:text-accent focus-visible:text-accent')
s=s.replace('svg width="28" height="28"','svg width="14" height="14"').replace('stroke-width="1.6"','stroke-width="2"')
a=s.index('            <path d="m9.5');b=s.index('          </svg>',a)
s=s[:a]+'''            <path d="M10.5 2.9a3 3 0 0 1 3 0l6.3 3.6a3 3 0 0 1 1.5 2.6v7.2a3 3 0 0 1-1.5 2.6l-6.3 3.6a3 3 0 0 1-3 0l-6.3-3.6a3 3 0 0 1-1.5-2.6V9.1a3 3 0 0 1 1.5-2.6z" transform="translate(0 -0.7)" />
            <circle cx="12" cy="12" r="4" />
'''+s[b:]
p.write_text(s,encoding='utf-8')
p=Path('frontend/src/components/FolderTree.svelte');s=p.read_text(encoding='utf-8');s=s.replace('''<div class="border-t border-border px-4 py-[10px] text-[11px] text-muted flex justify-between">
  <span>{$stats.total_images} 张图片</span>
  <span>本地缓存</span>
</div>
''','');p.write_text(s,encoding='utf-8')
p=Path('frontend/src/__tests__/settings-fill-interactions.test.ts');s=p.read_text(encoding='utf-8').replace('svg width="28" height="28"','svg width="14" height="14"')
s=s.replace("    expect(source).not.toContain('>⚙ 设置</button>');",'''    expect(source).not.toContain('>⚙ 设置</button>');
    const entry = source.slice(source.indexOf('sidebar-settings'), source.indexOf('</aside>', source.indexOf('sidebar-settings')));
    expect(entry).toContain('hover:text-accent');
    expect(entry).not.toContain('hover:bg-');
    expect(entry).toContain('<circle cx="12" cy="12" r="4"');
    expect(read('components/FolderTree.svelte')).not.toContain('本地缓存');
    expect(read('components/FolderTree.svelte')).not.toContain(' 张图片</span>');''');p.write_text(s,encoding='utf-8')
