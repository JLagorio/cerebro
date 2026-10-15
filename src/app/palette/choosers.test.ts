import { expect, it } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { chooserRows } from './choosers';
it('offers the three theme modes in order', () => {
  expect(chooserRows('theme', [], [], '').map((r) => r.mode)).toEqual(['light', 'dark', 'system']);
});
it('skips dead favorites and keeps their path order', () => {
  const a = makeEntry({ path: 'a.md', title: 'Alpha' });
  const b = makeEntry({ path: 'b.md', title: 'Beta' });
  expect(
    chooserRows('favorites', [a, b], ['gone.md', 'b.md', 'a.md'], '').map((r) => r.path),
  ).toEqual(['b.md', 'a.md']);
  expect(chooserRows('favorites', [a, b], ['a.md', 'b.md'], 'Alpha').map((r) => r.path)).toEqual([
    'a.md',
  ]);
});
it('names agent handles and their paused state', () => {
  const agent = makeEntry({
    path: 'records/agents/helper.md',
    title: 'Helper',
    type: 'Agent',
    properties: { slug: 'helper', paused: true },
  });
  expect(chooserRows('agents', [agent], [], '')[0]).toMatchObject({
    label: 'Helper',
    hint: '@helper · paused',
    path: agent.path,
  });
});
