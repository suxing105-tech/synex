<script lang="ts">
  import { query } from "../lib/stores";
  let { value, onsearch, onfocus, label = '搜索图片', placeholder = '搜索 prompt、文件名、标签…' }: {
    value?: string; onsearch?: (value: string) => void; onfocus?: () => void; label?: string; placeholder?: string;
  } = $props();
</script>
<div class="relative w-full max-w-[480px] mx-auto min-w-0">
  <svg class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
  <input type="search" aria-label={label} {placeholder} {onfocus} autocomplete="off" class="w-full bg-bg text-zinc-200 py-2 pl-9 pr-3 rounded-lg text-xs outline-none border-0 focus:bg-surface-3" value={value ?? $query} oninput={(e) => onsearch ? onsearch(e.currentTarget.value) : query.set(e.currentTarget.value)} />
</div>
