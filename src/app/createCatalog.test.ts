import { describe, expect, it } from 'vitest';
import { makeEntry } from '@/test/factories';
import {
  CREATE_ROWS,
  availableRows,
  groupRows,
  pruneRecents,
  recentRows,
  recordUse,
} from './createCatalog';
const ctx = { ready: true, page: null, inbox: true };
describe('creation catalog', () => {
  it('owns unique ids and chords, reserving n for the launcher', () => {
    expect(new Set(CREATE_ROWS.map((row) => row.id)).size).toBe(CREATE_ROWS.length);
    expect(new Set(CREATE_ROWS.map((row) => row.chord)).size).toBe(CREATE_ROWS.length);
    expect(CREATE_ROWS.some((row) => String(row.chord) === 'n')).toBe(false);
  });
  it('orders the nonempty groups and waits for a current vault scan', () => {
    expect(groupRows(availableRows(ctx)).map((group) => group.label)).toEqual([
      'Write',
      'Organize',
      'Data',
      'Diagram',
      'Build',
      'AI',
      'Capture',
    ]);
    expect(availableRows({ ...ctx, ready: false })).toEqual([]);
    expect(
      groupRows(availableRows({ ...ctx, inbox: false })).map((group) => group.label),
    ).not.toContain('Capture');
  });
  it('offers a sub-page only on a page that can grow', () => {
    const offered = (page: ReturnType<typeof makeEntry> | null) =>
      availableRows({ ...ctx, page }).some((row) => row.id === 'sub-page');
    expect(offered(null)).toBe(false);
    expect(offered(makeEntry({ path: 'notes/a.md' }))).toBe(true);
    expect(offered(makeEntry({ path: 'knowledge/a.md' }))).toBe(false);
    expect(offered(makeEntry({ path: 'records/agents/a.md', type: 'Agent' }))).toBe(false);
  });
  it('describes where every creation lands', () => {
    const page = makeEntry({ path: 'plan.md', title: 'Plan' });
    const lands = Object.fromEntries(
      availableRows({ ...ctx, page }).map((row) => [row.id, row.lands({ ...ctx, page })]),
    );
    expect(lands.page).toBe('At the top of the vault.');
    expect(lands['sub-page']).toBe('Inside “Plan”, beside its other sub-pages.');
    expect(lands.agent).toBe('In records/agents/, born paused.');
    expect(Object.values(lands).every((text) => text.endsWith('.'))).toBe(true);
  });
  it('remembers real uses once, caps ten, and shows only three available recents', () => {
    const history = CREATE_ROWS.reduce(
      (recent, row) => recordUse(recent, row.id),
      pruneRecents([]),
    );
    expect(history).toHaveLength(10);
    expect(recordUse(history, 'database').slice(0, 2)).toEqual(['database', 'capture']);
    expect(pruneRecents(['page', 'retired', 'page', null, 'agent'])).toEqual(['page', 'agent']);
    expect(
      recentRows(availableRows({ ...ctx, inbox: false }), history).map((row) => row.id),
    ).toEqual(['skill', 'agent', 'prototype']);
  });
});
