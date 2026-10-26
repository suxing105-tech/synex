<script lang="ts">
  /** 与 App.svelte 完全相同的接线：open / item / term 都由 store 驱动，Esc 才真的关得掉。 */
  import TextReader from '../../components/TextReader.svelte';
  import { readerItem, readerTerm } from '../../lib/stores';
</script>

<TextReader open={Boolean($readerItem)} item={$readerItem} term={$readerTerm} />