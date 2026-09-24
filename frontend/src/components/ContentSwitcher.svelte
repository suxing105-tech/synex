<script lang="ts">
  import { textMode, kind, switchContent } from '../lib/stores';
  const types = [
    { id: 'image', label: '图片', key: 'I', path: 'M3 17l5-5 4 4 4-6 5 7M8 8h.01' },
    { id: 'video', label: '视频', key: 'V', path: 'm10 8 6 4-6 4z' },
    { id: 'text', label: '文本', key: 'T', path: 'M8 8h8M8 12h8M8 16h5' },
  ] as const;
</script>
<nav aria-label="内容类型" class="content-switcher">
  {#each types as type}
    <button aria-label={type.label} title={`${type.label} (${type.key})`} aria-keyshortcuts={type.key.toLowerCase()}
      aria-pressed={type.id === 'text' ? $textMode : !$textMode && $kind === type.id}
      onclick={() => switchContent(type.id, false, true)}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d={type.path}/></svg>
    </button>
  {/each}
</nav>
<style>
  .content-switcher { display:flex; gap:3px; flex-shrink:0; }
  button { display:grid; place-items:center; width:30px; height:30px; border-radius:6px; color:#999; }
  button:hover,button:focus-visible { background:#303039; color:#eee; }
  button[aria-pressed="true"] { background:#39313b; color:#e9b3b3; }
</style>
