import type { DefaultReactSuggestionItem } from '@blocknote/react';
import { describe, expect, it } from 'vitest';
import { recordOpen } from '@/engine/openLog';
import { recencyOf } from '@/lib/nameRank';
import { distinctTitles, MENU_PER_GROUP, rankSuggestionItems } from './menuRank';

const row = (title: string, group: string, subtext?: string): DefaultReactSuggestionItem => ({
  title,
  group,
  subtext,
  onItemClick: () => {},
});

const titles = (items: DefaultReactSuggestionItem[]) => items.map((i) => i.title);

describe('rankSuggestionItems', () => {
  it('returns rows best first', () => {
    const items = [
      row('Unplanned work', 'Link page', 'notes/unplanned.md'),
      row('Plan of record', 'Link page', 'notes/por.md'),
      row('The plan', 'Link page', 'notes/the-plan.md'),
    ];
    expect(titles(rankSuggestionItems(items, 'plan'))).toEqual([
      'Plan of record',
      'The plan',
      'Unplanned work',
    ]);
  });

  it('keeps groups contiguous, in the order they first appear', () => {
    const items = [
      row('Ana Plan', 'People', 'Assign'),
      row('Plan page', 'Link page', 'notes/plan.md'),
      row('Plan person', 'People', 'Assign'),
      row('Due today plan', 'Due date', '2026-10-14'),
    ];
    expect(rankSuggestionItems(items, 'plan').map((i) => i.group)).toEqual([
      'People',
      'People',
      'Link page',
      'Due date',
    ]);
  });

  it(`caps each group at ${MENU_PER_GROUP}`, () => {
    const items = [
      ...Array.from({ length: 30 }, (_, i) => row(`Page ${i}`, 'Link page', `p/${i}.md`)),
      ...Array.from({ length: 25 }, (_, i) => row(`Person ${i}`, 'People', 'Assign')),
    ];
    const ranked = rankSuggestionItems(items, '');
    expect(ranked.filter((i) => i.group === 'Link page')).toHaveLength(MENU_PER_GROUP);
    expect(ranked.filter((i) => i.group === 'People')).toHaveLength(MENU_PER_GROUP);
  });

  it('matches a path through the subtext', () => {
    const items = [
      row('Weekly', 'Link page', 'records/rituals/weekly.md'),
      row('Other', 'Link page'),
    ];
    expect(titles(rankSuggestionItems(items, 'rituals'))).toEqual(['Weekly']);
  });

  it('puts an opened page first within its tier', () => {
    const items = [row('Plan a', 'Link page', 'a.md'), row('Plan b', 'Link page', 'b.md')];
    const paths = new Map(items.map((i) => [i, i.subtext as string]));
    const recency = recencyOf(recordOpen([], 'b.md', 1000), 1000);
    expect(
      titles(rankSuggestionItems(items, 'plan', { recency, pathOf: (i) => paths.get(i) })),
    ).toEqual(['Plan b', 'Plan a']);
  });

  it('gives a repeated title distinct keys after ranking (M52.1)', () => {
    const items = [
      row('Knowledge', 'Link page', 'knowledge/index.md'),
      row('Knowledge', 'Link page', 'records/agents/knowledge.md'),
    ];
    const ranked = rankSuggestionItems(items, 'know');
    expect(new Set(titles(ranked)).size).toBe(2);
    expect(ranked[0].title).toBe('Knowledge');
    expect(ranked[1].title).toBe('Knowledge\u200B');
  });
});

describe('distinctTitles', () => {
  it('suffixes each repeat by how many came before', () => {
    expect(titles(distinctTitles([row('A', 'g'), row('A', 'g'), row('A', 'g')]))).toEqual([
      'A',
      'A\u200B',
      'A\u200B\u200B',
    ]);
  });
});
