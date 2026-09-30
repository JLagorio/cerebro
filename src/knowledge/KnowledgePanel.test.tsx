// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listConcepts } from '@/engine/okf';
import { makeEntry } from '@/engine/testHelpers';
import { useVaultStore } from '@/stores/vaultStore';
import { KnowledgePanel, relativeDay } from './KnowledgePanel';

/**
 * A person is their page (M52.3). The Details tab printed `tom-keller` under
 * "Verified by" and `priya-nair` beside a source — slugs, in a vault that has
 * a page for each of them. These specs are about that one thing: a stamp that
 * names a person reads as their name and opens them, and one that names
 * nobody the vault knows stays as written.
 */

const TODAY = '2026-07-28';
const CONCEPT = 'knowledge/metrics/sync-error-rate.md';

const conceptEntry = makeEntry({
  path: CONCEPT,
  filename: 'sync-error-rate.md',
  folder: 'knowledge/metrics',
  title: 'Sync error rate',
  properties: {
    verified: [
      { by: 'human:tom-keller', at: '2026-07-27T09:10:00Z' },
      { by: 'human:josef', at: '2026-07-26T09:15:00Z' },
    ],
    sources: [
      {
        id: 'standup',
        resource: 'https://example.com/standup',
        title: 'Cutover standup',
        author: 'human:priya-nair',
        last_modified: '2026-07-28',
      },
    ],
  },
});

const people = [
  makeEntry({ path: 'people/tom-keller.md', filename: 'tom-keller.md', title: 'Tom Keller' }),
  makeEntry({ path: 'people/priya-nair.md', filename: 'priya-nair.md', title: 'Priya Nair' }),
];

afterEach(cleanup);

describe('KnowledgePanel — people by name (M52.3)', () => {
  const onOpenEntity = vi.fn();

  beforeEach(() => {
    onOpenEntity.mockClear();
    useVaultStore.setState({ vaultPath: '/vault', entries: [conceptEntry, ...people] });
  });

  const panel = () => {
    const concept = listConcepts(useVaultStore.getState().entries, TODAY).find(
      (c) => c.entry.path === CONCEPT,
    )!;
    return render(
      <KnowledgePanel
        concept={concept}
        today={TODAY}
        onOpenEntity={onOpenEntity}
        onOpenConcept={() => {}}
      />,
    );
  };

  it('reads a verifier as the person, and opens their page', () => {
    panel();
    const tom = screen.getByTestId('concept-person');
    expect(tom.textContent).toContain('Tom Keller');
    expect(tom.getAttribute('title')).toBe('human:tom-keller');
    fireEvent.click(tom);
    expect(onOpenEntity).toHaveBeenCalledWith('people/tom-keller.md');
  });

  it('keeps a stamp no page answers to as written, and not as a link', () => {
    panel();
    // `human:josef` has no `josef.md` and no `slug: josef` in this vault.
    expect(screen.getAllByTestId('concept-person')).toHaveLength(1);
    expect(screen.getByTestId('knowledge-panel').textContent).toContain('josef');
  });

  it("names a source's author and opens them, beside the source's other signals", () => {
    panel();
    const author = screen.getByTestId('source-author');
    expect(author.textContent).toBe('Priya Nair');
    // The date as the rest of the page says it (M52.5); the date itself on hover.
    expect(author.parentElement?.textContent).toBe('Priya Nair · changed today');
    expect(screen.getByTitle('changed 2026-07-28').textContent).toBe('changed today');
    fireEvent.click(author);
    expect(onOpenEntity).toHaveBeenCalledWith('people/priya-nair.md');
    expect(screen.getByTestId('knowledge-panel').textContent).not.toContain('priya-nair');
  });
});

describe('relativeDay on the reader’s calendar (M52.4)', () => {
  const tz = process.env.TZ;
  afterEach(() => {
    // Assigning `undefined` would set the string "undefined".
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it('reads a morning stamp east of Greenwich as today, not yesterday', () => {
    process.env.TZ = 'Australia/Sydney';
    // 22:00 UTC on the 27th is 08:00 on the 28th in Sydney.
    expect(relativeDay('2026-07-27T22:00:00Z', '2026-07-28')).toBe('today');
    expect(relativeDay('2026-07-26T22:00:00Z', '2026-07-28')).toBe('yesterday');
  });

  it('keeps a date-only stamp as written, west of Greenwich too', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(relativeDay('2026-07-26', '2026-07-28')).toBe('2d ago');
    expect(relativeDay('2026-07-28T06:00:00Z', '2026-07-28')).toBe('yesterday');
    expect(relativeDay('not a date', '2026-07-28')).toBeNull();
  });
});
