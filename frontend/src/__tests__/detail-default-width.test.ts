import { ICON_PATHS } from '../lib/icons';
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

it('starts the expanded detail pane at its minimum, independently of window width', () => {
  const source = readFileSync('src/App.svelte', 'utf8');
  expect(source).toContain('const DETAIL_MIN = 320;');
  expect(source).toContain('let detailWidth = $state(DETAIL_MIN);');
  expect(source).toContain('let detailCollapsed = $state(false);');
  expect(source).toContain('Math.max(DETAIL_MIN, Math.min(DETAIL_MAX, startW + dx))');
  // 收起右侧栏时，那两列（分隔条 + 详情）都给 0px。
  // 判断从 detailCollapsed 换成 detailHidden：素材选择器、技能弹窗开着时右侧栏都要让位，
  // 三种「该收起」的情形收在同一个变量里，别再各写一份三元。
  expect(source).toContain("detailHidden ? '0px 0px'");
  expect(source).toContain(
    "const detailHidden = $derived(detailCollapsed || $pickerOpen || $skillModalOpen);");
});

it('points left to expand the right pane and right to collapse it', () => {
  // 2026-11-14：这颗开关从 App.svelte 挪进了 Feed 顶栏那枚 .detail-toggle，
  // 折叠与展开是同一颗按钮的两态（label 与图标都跟着 detailCollapsed 走），
  // 所以这里不再拆两段源码，而是直接钉住那对三元。
  const feed = readFileSync('src/components/Feed.svelte', 'utf8');
  expect(feed).toContain('aria-label={detailCollapsed ? "展开右侧栏" : "收起右侧栏"}');
  expect(feed).toContain('name={detailCollapsed ? "panel-right-expand" : "panel-right-collapse"}');
  // 折线从 x=15 那条竖线出发：展开那枚往左收（11→8→11），收起那枚往右顶（8→11→8）
  expect(ICON_PATHS['panel-right-expand']).toContain('M15 4v16m-4-11-3 3 3 3');
  expect(ICON_PATHS['panel-right-collapse']).toContain('M15 4v16m-7-11 3 3-3 3');
});
