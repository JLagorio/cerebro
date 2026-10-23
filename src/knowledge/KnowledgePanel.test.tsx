// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listConcepts } from '@/engine/okf';
import { makeEntry } from '@/engine/testHelpers';
import { useVaultStore } from '@/stores/vaultStore';
import { KnowledgePanel, relativeDay } from './KnowledgePanel';

/**
 * A person is their page (M52.3). The Details panel printed `tom-keller` under
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

// Owner, 2026-10-18: the uppercase overlines read as a form, not a panel.
describe('KnowledgePanel — in the inspector’s voice', () => {
  const onOpenEntity = vi.fn();

  const panel = (properties: Record<string, unknown>) => {
    const entry = makeEntry({ ...conceptEntry, properties });
    useVaultStore.setState({ vaultPath: '/vault', entries: [entry, ...people] });
    const concept = listConcepts(useVaultStore.getState().entries, TODAY).find(
      (c) => c.entry.path === CONCEPT,
    )!;
    render(
      <KnowledgePanel
        concept={concept}
        today={TODAY}
        onOpenEntity={onOpenEntity}
        onOpenConcept={() => {}}
      />,
    );
    return screen.getByTestId('knowledge-panel');
  };

  it('names each group in sentence case, with the inspector’s subhead', () => {
    const root = panel({ ...conceptEntry.properties, tags: ['reliability', 'offline-sync'] });
    expect([...root.querySelectorAll('.cb-inspector-subhead')].map((el) => el.textContent)).toEqual(
      ['Written by', 'Verified by', 'Sources', 'Tags'],
    );
    expect(root.querySelector('.uppercase')).toBeNull();
  });

  it('says its tags as words, not chips', () => {
    const root = panel({ ...conceptEntry.properties, tags: ['reliability', 'offline-sync'] });
    expect(within(root).getByTestId('concept-tags').textContent).toBe(
      'Tags#reliability#offline-sync',
    );
    expect(root.querySelector('.cb-tag')).toBeNull();
  });

  it('says nobody verified it when nobody did, as a quiet line', () => {
    const root = panel({});
    expect(within(root).getByText('Nobody yet')).toBeTruthy();
    expect(within(root).getByText('Not recorded')).toBeTruthy();
  });
});

describe('KnowledgePanel — sources named by their links (M69.2)', () => {
  const LINEAR = 'https://linear.app/acme/issue/ENG-142/fix-login';
  const UNKNOWN = 'https://example.com/fix-login';

  beforeEach(() => {
    const linked = makeEntry({
      path: CONCEPT,
      filename: 'sync-error-rate.md',
      folder: 'knowledge/metrics',
      title: 'Sync error rate',
      properties: {
        sources: [
          { id: 'issue', resource: LINEAR },
          { id: 'titled', resource: LINEAR, title: 'The login bug' },
          { id: 'unknown', resource: UNKNOWN },
        ],
      },
    });
    useVaultStore.setState({ vaultPath: '/vault', entries: [linked] });
  });

  const links = () => {
    const concept = listConcepts(useVaultStore.getState().entries, TODAY).find(
      (c) => c.entry.path === CONCEPT,
    )!;
    render(
      <KnowledgePanel
        concept={concept}
        today={TODAY}
        onOpenEntity={() => {}}
        onOpenConcept={() => {}}
      />,
    );
    return screen
      .getAllByRole('link')
      .map((a) => [
        a.querySelector('[data-slot="trace-title"]')?.textContent,
        a.getAttribute('title'),
        a.getAttribute('href'),
      ]);
  };

  // M91.14 — the Sources element names an untitled page it knows nothing
  // about by its host, as every Sources list does; the URL stays on hover.
  it('shows the name a link carries, a title it was given, or its host, each with the URL on hover', () => {
    expect(links()).toEqual([
      ['ENG-142 Fix login', LINEAR, LINEAR],
      ['The login bug', LINEAR, LINEAR],
      ['example.com', UNKNOWN, UNKNOWN],
    ]);
    // A link out says so, and opens in a new tab.
    expect(
      screen.getByRole('link', { name: /^The login bug.*\(opens in a new tab\)$/ }),
    ).toBeTruthy();
  });
});

// M91.14 — the concept's sources are the Sources element's rows: a web page
// links out only when it is http(s), a vault page opens in the app through
// the panel's own callback, never an href (CV-16), and the rest is words.
describe('KnowledgePanel — sources as the Sources element (M91.14, CV-16)', () => {
  const onOpenEntity = vi.fn();

  const panel = (properties: Record<string, unknown>) => {
    const entry = makeEntry({ ...conceptEntry, properties });
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        entry,
        ...people,
        makeEntry({ path: 'records/decision.md', filename: 'decision.md', title: 'The decision' }),
      ],
    });
    const concept = listConcepts(useVaultStore.getState().entries, TODAY).find(
      (c) => c.entry.path === CONCEPT,
    )!;
    render(
      <KnowledgePanel
        concept={concept}
        today={TODAY}
        onOpenEntity={onOpenEntity}
        onOpenConcept={() => {}}
      />,
    );
    return screen.getByTestId('knowledge-panel');
  };

  beforeEach(() => onOpenEntity.mockClear());

  it('links out only to http(s), and opens a vault page through the callback', () => {
    const root = panel({
      sources: [
        { id: 'web', resource: 'https://example.com/standup', title: 'Standup' },
        { id: 'page', resource: '/records/decision.md' },
        { id: 'script', resource: 'javascript:alert(1)', title: 'Not a link' },
        { id: 'file', resource: 'file:///etc/passwd' },
        { id: 'scope', resource: 'all queries in project X' },
      ],
      resource: 'records/decision.md',
    });
    for (const link of root.querySelectorAll('a')) {
      expect(link.getAttribute('href') ?? '', link.outerHTML).toMatch(/^https?:\/\//);
    }
    expect(root.querySelectorAll('a')).toHaveLength(1);
    const rows = within(root).getAllByTestId('concept-source');
    expect(rows.map((row) => [row.dataset.kind, row.dataset.path])).toEqual([
      ['url', undefined],
      ['vault', 'records/decision.md'],
      ['url', undefined],
      ['url', undefined],
      ['vault', undefined],
    ]);
    // A vault page opens in the app, named by its page's title.
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Open The decision' }));
    expect(onOpenEntity).toHaveBeenCalledWith('records/decision.md');
    // The rest are words: no link, no button.
    for (const row of [rows[2], rows[3], rows[4]]) {
      expect(within(row).queryByRole('link')).toBeNull();
      expect(within(row).queryByRole('button')).toBeNull();
    }
    expect(rows[2].textContent).toContain('Not a link');
    expect(rows[4].textContent).toContain('all queries in project X');
    // The concept's own Resource reads the same way: a vault page opens.
    fireEvent.click(within(root).getAllByRole('button', { name: 'Open The decision' })[1]);
    expect(onOpenEntity).toHaveBeenLastCalledWith('records/decision.md');
  });

  it('keeps each row’s citation number, its author and its signals', () => {
    const root = panel(conceptEntry.properties);
    const [row] = within(root).getAllByTestId('concept-source');
    expect(row.textContent).toMatch(/^1Cutover standup/);
    expect(within(row).getByTestId('source-author').textContent).toBe('Priya Nair');
    expect(row.querySelector('[data-slot="source"]')?.getAttribute('data-via')).toBe('text');
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
