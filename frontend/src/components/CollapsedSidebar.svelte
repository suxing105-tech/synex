<script lang="ts">
  import Icon from './Icon.svelte';
  import { folderId, scope, switchContent } from '../lib/stores';
  import type { Scope } from '../lib/types';

  let { onexpand }: { onexpand: () => void } = $props();

  const entries: { scope: Scope; label: string; key: string; icon: string }[] = [
    { scope: 'all', label: '所有素材', key: '0', icon: 'layers' },
    { scope: 'image', label: '全部图片', key: 'I', icon: 'image' },
    { scope: 'video', label: '所有视频', key: 'V', icon: 'video' },
    { scope: 'audio', label: '全部音频', key: 'A', icon: 'music' },
    { scope: 'text', label: '全部文本', key: 'T', icon: 'text' },
  ];

  function active(next: Scope) {
    return $scope === next && $folderId === null;
  }
</script>

<nav class="collapsed-nav" aria-label="内容导航">
  <button class="expand" title="展开左侧栏" aria-label="展开左侧栏" onclick={onexpand}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16m4-11 3 3-3 3"/></svg>
  </button>
  {#each entries as entry (entry.scope)}
    <button
      class:active={active(entry.scope)}
      title={`${entry.label} (${entry.key})`}
      aria-label={entry.label}
      aria-keyshortcuts={entry.key.toLowerCase()}
      aria-current={active(entry.scope) ? 'page' : undefined}
      onclick={() => switchContent(entry.scope, true)}
    >
      <Icon name={entry.icon} size={18} />
    </button>
  {/each}
</nav>

<style>
  .collapsed-nav { display: flex; flex-direction: column; align-items: center; gap: 4px; padding-top: 9px; }
  button { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; border: 0; border-radius: 7px; background: transparent; color: #888; cursor: pointer; }
  button:hover, button:focus-visible { color: #eee; background: #29292d; }
  button.active { color: #f24e4e; background: #302326; }
  button:focus-visible { outline: 1px solid #f24e4e; outline-offset: -2px; }
</style>