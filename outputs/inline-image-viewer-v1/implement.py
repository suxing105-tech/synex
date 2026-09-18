from pathlib import Path
p=Path('frontend/src/App.svelte');s=p.read_text(encoding='utf-8');line='<Lightbox bind:open={lightboxOpen} bind:index={lightboxIndex} bind:selectedId={selectedIdValue} />';s=s.replace('\n'+line+'\n','\n');s=s.replace('<main class="min-w-0">','<main class="relative min-w-0 min-h-0 overflow-hidden isolate">');s=s.replace('      <Feed\n','      <div class="h-full" inert={lightboxOpen}>\n      <Feed\n',1);s=s.replace('    </main>','      </div>\n      '+line+'\n    </main>',1);p.write_text(s,encoding='utf-8')
p=Path('frontend/src/components/Lightbox.svelte');s=p.read_text(encoding='utf-8');a=s.index('    if (typeof window !== "undefined") return { w: window.innerWidth');b=s.index('  let fitRatio',a);s=s[:a]+'''    return { w: 0, h: 0 };
  }

  // 以中间预览画布的实际尺寸为准，调整侧栏宽度时自动重新适配。
'''+s[b:];s=s.replace('Math.min((viewportW * 0.92) / safeVisualW, (viewportH * 0.84) / safeVisualH)','Math.min(1, Math.max(1, viewportW - 48) / safeVisualW, Math.max(1, viewportH - 48) / safeVisualH)')
s=s.replace('    dragPointerId = -1;\n    if (dragEl && dragPointerId >= 0)', '    if (dragEl && dragPointerId >= 0)',1).replace('    dragEl = null;\n  }\n\n  function toggleZoom', '    dragPointerId = -1;\n    dragEl = null;\n  }\n\n  function toggleZoom',1)
a=s.index('  <div\n    class="fixed inset-0');b=s.index('    <img\n',a)
s=s[:a]+'''  <section class="inline-viewer absolute inset-0 z-20 flex flex-col bg-bg overflow-hidden fill-interactions" aria-label="图片细节预览">
    <header class="flex items-center gap-2 px-4 py-3 shrink-0 border-b border-border bg-surface">
      <button class="rounded-lg px-3 py-2 text-xs" onclick={close} title="返回缩略图（Esc）">← 返回</button>
      <span class="flex-1 min-w-0 truncate text-xs text-muted" title={it.filename}>{it.filename}</span>
      <button class="rounded-lg px-3 py-2 text-xs" aria-pressed={zoomMode === "fit"} onclick={resetZoom}>适应窗口</button>
      <button class="rounded-lg px-3 py-2 text-xs" aria-pressed={zoomMode === "zoom"} onclick={() => { if (zoomMode !== "zoom") toggleZoom(); }}>100%</button>
    </header>
    <div class="viewer-canvas relative flex-1 min-h-0 overflow-hidden" bind:clientWidth={viewportW} bind:clientHeight={viewportH} oncontextmenu={openMenu}>
      <div class="absolute inset-0 flex items-center justify-center overflow-hidden">
'''+s[b:];s=s.replace('class="rounded-md shadow-2xl select-none lightbox-img"','class="shrink-0 select-none lightbox-img"')
a=s.index('    <div class="absolute bottom-5');b=s.index('\n{/if}',a)
s=s[:a]+'''      </div>
    </div>
    <footer class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 shrink-0 border-t border-border bg-surface text-xs">
      <div class="flex items-center gap-2">
        <button class="rounded-lg px-3 py-2" onclick={prev} title="上一张">‹</button>
        <span class="text-muted">{index + 1} / {$feedItems.length}</span>
        <button class="rounded-lg px-3 py-2" onclick={next} title="下一张">›</button>
      </div>
      <span class="text-muted">{#if it.width && it.height}{it.width} × {it.height} · {/if}{formatSize(it.size_bytes)}</span>
      <span class="text-muted">{zoomMode === "zoom" ? "拖动查看细节 · 双击适应窗口" : "双击图片查看 100% 细节"}</span>
    </footer>
  </section>'''+s[b:]
s=s.replace('copyText, formatDate, formatSize','copyText, formatSize')
# 缩放状态下侧栏拖动改变画布大小，约束偏移以防图片脱离视野。
a=s.index('  let imgCursor =')
s=s[:a]+'''  $effect(() => {
    if (zoomMode !== "zoom") return;
    const bounded = clampPan(pan, { w: safeVisualW, h: safeVisualH }, { w: viewportW, h: viewportH });
    if (bounded.x !== pan.x || bounded.y !== pan.y) pan = bounded;
  });

'''+s[a:];p.write_text(s,encoding='utf-8')
