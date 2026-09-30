import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

it('starts the expanded detail pane at its minimum, independently of window width', () => {
  const source = readFileSync('src/App.svelte', 'utf8');
  expect(source).toContain('const DETAIL_MIN = 320;');
  expect(source).toContain('let detailWidth = $state(DETAIL_MIN);');
  expect(source).toContain('let detailCollapsed = $state(false);');
  expect(source).toContain('Math.max(DETAIL_MIN, Math.min(DETAIL_MAX, startW + dx))');
  expect(source).toContain('${detailCollapsed ? 44 : detailWidth}px');
});

it('points left to expand the right pane and right to collapse it', () => {
  const source = readFileSync('src/App.svelte', 'utf8');
  const expand = source.split('aria-label="展开右侧栏"')[1].split('</button>')[0];
  const collapse = source.split('aria-label="收起右侧栏"')[1].split('</button>')[0];
  expect(expand).toContain('M15 4v16m-4-11-3 3 3 3');
  expect(collapse).toContain('M15 4v16m-7-11 3 3-3 3');
});
