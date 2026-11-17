<script lang="ts">
  /**
   * 一颗服务商标识：有厂商 LOGO 就画 LOGO，没有才退回字母块。
   * 两个地方共用——设置·模型API配置 的厂商卡与标题行，还有反推下拉左边那一列。
   *
   * 尺寸只有两档，都走图标那把尺子上的数（ICON_SIZES）：卡片里 36 的块装 24 的图，
   * 下拉里挤，用 24 的块装 16 的图。字母块跟原来的长相一致，只是跟着变大。
   */
  import { brandLogo, brandInitials } from "../lib/brand-logos";

  let { id = "", name = "", glyph = "", compact = false }: {
    id?: string | null;
    name?: string;
    /** 字母块要显的字（自定义那张卡用「＋」）；留空就取名字头两个字。 */
    glyph?: string;
    /** 下拉那一列用小的。 */
    compact?: boolean;
  } = $props();

  const logo = $derived(brandLogo(id));
  const letters = $derived(glyph || brandInitials(name));
</script>

<span class="brand-mark" class:brand-compact={compact} aria-hidden="true">
  {#if logo}<img class="brand-img" src={logo} alt="" draggable="false" />{:else}{letters}{/if}
</span>

<style>
  .brand-mark {
    display: grid; place-items: center; width: 36px; height: 36px; flex: none;
    border-radius: var(--r-1); background: #26262c;
    font-size: var(--fs-sm); font-weight: 600; color: #d4d4d8;
  }
  .brand-compact { width: 24px; height: 24px; border-radius: var(--r-0); font-size: var(--fs-2xs); }
  .brand-img { display: block; width: 24px; height: 24px; }
  .brand-compact .brand-img { width: 16px; height: 16px; }
</style>
