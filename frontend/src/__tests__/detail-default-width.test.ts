import { ICON_PATHS } from '../lib/icons';
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

it('starts the expanded detail pane at its minimum, independently of window width', () => {
  const source = readFileSync('src/App.svelte', 'utf8');
  expect(source).toContain('const DETAIL_MIN = 320;');
  expect(source).toContain('let detailWidth = $state(DETAIL_MIN);');
  expect(source).toContain('let detailCollapsed = $state(false);');
  expect(source).toContain('Math.max(DETAIL_MIN, Math.min(DETAIL_MAX, startW + dx))');
  expect(source).toContain('{detailCollapsed ? 44 : detailWidth}px');
});

it('points left to expand the right pane and right to collapse it', () => {
  const source = readFileSync('src/App.svelte', 'utf8');
  const expand = source.split('aria-label="展开右侧栏"')[1].split('</button>')[0];
  const collapse = source.split('aria-label="收起右侧栏"')[1].split('</button>')[0];
  // 2026-11-11 图标统一：形状搬进 lib/icons.ts，App 里只剩「用哪个图标」。
  // 这条断言因此分两层钉 —— App 选对图标，形状本身仍然是一个朝左一个朝右。
  expect(expand).toContain('<Icon name="panel-right-expand"');
  expect(collapse).toContain('<Icon name="panel-right-collapse"');
  // 折线从 x=15 那条竖线出发：展开那枚往左收（11→8→11），收起那枚往右顶（8→11→8）
  expect(ICON_PATHS['panel-right-expand']).toContain('M15 4v16m-4-11-3 3 3 3');
  expect(ICON_PATHS['panel-right-collapse']).toContain('M15 4v16m-7-11 3 3-3 3');
});
