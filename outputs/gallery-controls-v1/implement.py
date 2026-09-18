from pathlib import Path
p=Path('frontend/src/App.svelte');s=p.read_text(encoding='utf-8');s=s.replace('  import HeaderBar from "./components/HeaderBar.svelte";\n','');s=s.replace('  <HeaderBar onOpenSettings={() => (settingsOpen = true)} onOpenOnboarding={() => (onboardingOpen = true)} />\n','');s=s.replace('      <FolderTree />','''      <FolderTree />
      <div class="sidebar-actions fill-interactions flex items-center gap-2 px-4 py-4 shrink-0">
        <button class="w-10 h-10 flex items-center justify-center rounded-lg text-muted" aria-label="设置" title="设置" onclick={() => settingsOpen = true}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="m12 2 9 5v10l-9 5-9-5V7z" /><circle cx="12" cy="12" r="4" /></svg>
        </button>
        <button class="w-10 h-10 flex items-center justify-center rounded-lg text-muted" aria-label="导入目录" title="导入目录" onclick={() => onboardingOpen = true}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 19V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v7m-3-3 3 3 3-3" /></svg>
        </button>
      </div>''');s=s.replace('class="h-full" inert={lightboxOpen}','class="h-full flex flex-col" inert={lightboxOpen}');p.write_text(s,encoding='utf-8')
p=Path('frontend/src/components/Feed.svelte');s=p.read_text(encoding='utf-8').replace('<script lang="ts">','<script lang="ts">\n  import GallerySearch from "./GallerySearch.svelte";\n  import { copyOriginalImage } from "../lib/image-clipboard";');a=s.index('  async function fetchImageBlob');b=s.index('  async function renameImage',a);s=s[:a]+'''  async function copyImageToClipboard(it: ImageSummary) {
    try { await copyOriginalImage(it.id); notify("已复制原图到剪贴板"); }
    catch (e) { notify(`复制原图失败：${(e as Error).message}`); }
  }

'''+s[b:];s=s.replace('class="px-5 pt-4 pb-3 flex items-center gap-4 border-b border-border bg-surface"','class="gallery-toolbar px-4 py-3 grid items-center gap-3 border-b border-border bg-surface shrink-0"');s=s.replace('  <div class="ml-auto flex items-center gap-2 text-[12.5px] text-muted">','  <GallerySearch />\n  <div class="ml-auto flex items-center gap-2 text-[12.5px] text-muted">');s=s.replace('class="columns-slider w-32"','class="columns-slider w-20"');s=s.replace('class="overflow-y-auto p-3 feed-body relative"\n  style="height: calc(100vh - 110px)"','class="overflow-y-auto p-3 feed-body relative flex-1 min-h-0"');s=s.replace('<style>','<style>\n  .gallery-toolbar { grid-template-columns: minmax(0, 1fr) minmax(120px, 2fr) minmax(0, 1fr); }\n  @media (max-width: 760px) { .gallery-toolbar { grid-template-columns: minmax(0, 1fr); } }');p.write_text(s,encoding='utf-8')
p=Path('frontend/src/components/Lightbox.svelte');s=p.read_text(encoding='utf-8').replace('<script lang="ts">','<script lang="ts">\n  import { copyOriginalImage } from "../lib/image-clipboard";');a=s.index('  async function fetchBlob');b=s.index('  async function renameImage',a);s=s[:a]+'''  async function copyImage(it: { id: number }) {
    try { await copyOriginalImage(it.id); notify("已复制原图到剪贴板"); }
    catch (e) { notify(`复制原图失败：${(e as Error).message}`); }
  }

'''+s[b:];s=s.replace('class="absolute inset-0 flex items-center justify-center overflow-hidden"','class="absolute inset-0 flex items-center justify-center overflow-hidden" ondblclick={(e) => { if (e.button === 0 && e.target === e.currentTarget) close(); }}');s=s.replace('双击图片查看 100% 细节','双击图片查看 100% · 双击空白返回');p.write_text(s,encoding='utf-8')
