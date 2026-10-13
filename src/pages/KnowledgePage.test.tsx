// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry } from '@/engine/types';
import { ReviewPager } from '@/knowledge/ReviewQueue';
import type { ReviewCard } from '@/lib/ipc';
import { __seedReview } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { KnowledgePage } from './KnowledgePage';

afterEach(cleanup);

// The mock's queue holds the demo's cards; these tests stage their own, and
// none unless they say so.
beforeEach(() => __seedReview({ cards: [] }));

function concept(partial: Partial<Entry> & { path: string }): Entry {
  return {
    filename: partial.path.split('/').pop() ?? '',
    folder: partial.path.slice(0, partial.path.lastIndexOf('/')),
    project: null,
    title: 'Untitled',
    type: 'Concept',
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-07-01T00:00:00Z',
    modifiedAt: '2026-07-01T00:00:00Z',
    parseError: null,
    ...partial,
  };
}

const OLD = 'knowledge/claims/offline-window.md';
const NEW = 'knowledge/claims/offline-window-v2.md';

describe('KnowledgePage lists (M50.1)', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({ path: OLD, title: 'The offline window' }),
        concept({
          path: NEW,
          title: 'The offline window, revised',
          properties: { supersedes: '/claims/offline-window.md' },
        }),
      ],
    });
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
  });

  it('labels the retired row, and a row opens the concept as a page', () => {
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' } }} />);
    // A strikethrough alone was the only signal, with no legend anywhere.
    expect(screen.getAllByTestId('replaced-tag')).toHaveLength(1);
    // No reading pane and no provenance column: the concept is a page now.
    expect(screen.queryByTestId('knowledge-panel')).toBeNull();
    fireEvent.click(screen.getAllByTestId('concept-row')[0]);
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: OLD });
  });

  it('has three tabs a reader can follow, and nothing else (M51.1)', () => {
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'review' } }} />);
    expect(screen.getByTestId('knowledge-heading').textContent).toBe('Knowledge');
    const tabs = screen.getByRole('navigation', { name: 'Knowledge views' });
    expect([...tabs.querySelectorAll('button')].map((b) => b.dataset.testid)).toEqual([
      'knowledge-tab-all',
      'knowledge-tab-review',
      'knowledge-tab-activity',
    ]);
    expect(screen.getByTestId('knowledge-tab-review').getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByTestId('knowledge-tab-activity'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'knowledge',
      nav: { tab: 'activity' },
    });
  });

  it('lights Concepts on a folder, which is a filter of it', () => {
    render(
      <KnowledgePage
        selection={{ kind: 'knowledge', nav: { tab: 'section', folder: 'claims' } }}
      />,
    );
    expect(screen.getByTestId('knowledge-tab-all').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('knowledge-heading').textContent).toContain('Claims');
  });

  it('opens on Concepts when the selection names no view', () => {
    render(<KnowledgePage selection={{ kind: 'knowledge' }} />);
    expect(screen.getByTestId('knowledge-tab-all').getAttribute('aria-current')).toBe('page');
    expect(screen.getAllByTestId('concept-row')).toHaveLength(2);
  });

  it('files everything under its folders, each a way into that folder', () => {
    useVaultStore.setState({
      entries: [
        concept({ path: 'knowledge/metrics/a.md', title: 'A metric' }),
        concept({ path: 'knowledge/playbooks/b.md', title: 'A playbook' }),
      ],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' } }} />);
    const sections = screen.getAllByTestId('concept-section');
    expect(sections.map((s) => s.dataset.folder)).toEqual(['metrics', 'playbooks']);
    // The band's name, not its chevron ("Collapse Playbooks"), which folds it.
    fireEvent.click(screen.getByRole('button', { name: 'Playbooks' }));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'knowledge',
      nav: { tab: 'section', folder: 'playbooks' },
    });
  });
});

describe('KnowledgePage review queue (M51.2)', () => {
  it('lists what waits for a person, each row saying why, in the order to work it', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({ path: 'knowledge/new.md', title: 'Fresh' }),
        concept({
          path: 'knowledge/due.md',
          title: 'Due',
          properties: {
            stale_after: '2020-01-01',
            verified: [{ by: 'process:nightly', at: '2026-07-01' }],
          } as unknown as Entry['properties'],
        }),
        concept({
          path: 'knowledge/retired.md',
          title: 'Retired',
          properties: {
            lifecycle: 'deprecated',
            verified: [{ by: 'human:josef', at: '2026-07-01' }],
          } as unknown as Entry['properties'],
        }),
      ],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'review' } }} />);
    const rows = screen.getAllByTestId('queue-row');
    // A retired concept a person already reviewed is not theirs to clear.
    expect(rows.map((r) => r.dataset.reason)).toEqual(['stale', 'new']);
    // M52.5 — the reason's word in the cell, its sentence on hover: how far
    // overdue, said once.
    const reasons = screen.getAllByTestId('queue-reason');
    expect(reasons.map((r) => r.textContent)).toEqual(['Due a recheck', 'Unreviewed']);
    expect(reasons[0].getAttribute('title')).toMatch(/^Due a recheck · \d+ years overdue$/);
    expect(reasons[1].getAttribute('title')).toBe('New — who wrote it is not recorded');
    fireEvent.click(rows[0]);
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'knowledge/due.md' });
  });

  // M52.4 — an empty horizon is stale by the shared rule, and the row printed
  // it as a date: "Due a recheck since null".
  it('says a recheck date that cannot be read cannot be read', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({
          path: 'knowledge/blank.md',
          properties: {
            stale_after: '',
            verified: [{ by: 'process:nightly', at: '2026-07-01' }],
          } as unknown as Entry['properties'],
        }),
      ],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'review' } }} />);
    const [row] = screen.getAllByTestId('queue-row');
    expect(row.dataset.reason).toBe('stale');
    expect(screen.getByTestId('queue-reason').getAttribute('title')).toBe(
      "Due a recheck — its recheck date can't be read",
    );
  });

  // M52.3 — the row says what the queue and the review bar say. "Stale" read
  // as "wrong"; the claim is only past its recheck date.
  it('marks a concept past its recheck date in the words the queue uses', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({
          path: 'knowledge/due.md',
          title: 'Due',
          properties: {
            stale_after: '2020-01-01',
            verified: [{ by: 'process:nightly', at: '2026-07-01' }],
          } as unknown as Entry['properties'],
        }),
      ],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' } }} />);
    expect(screen.getByTestId('concept-row-due').textContent).toBe('Due a recheck');
    expect(screen.getByTestId('concept-row').textContent).not.toContain('Stale');
  });

  // M52.5 — a concept nobody has reviewed leads with that, as its page does;
  // the recheck it also owes is the reason's sentence, not a second status.
  it('leads a never-reviewed concept with Unreviewed, its overdue recheck on hover', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({
          path: 'knowledge/due.md',
          title: 'Due',
          properties: { stale_after: '2020-01-01' },
        }),
      ],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'review' } }} />);
    const reason = screen.getByTestId('queue-reason');
    expect(screen.getByTestId('queue-row').dataset.reason).toBe('new');
    expect(reason.textContent).toBe('Unreviewed');
    expect(reason.getAttribute('title')).toMatch(
      /^New — who wrote it is not recorded — Due a recheck · \d+ years overdue$/,
    );
  });

  it('keeps the review count on the tab', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [concept({ path: 'knowledge/new.md', title: 'Fresh' })],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' } }} />);
    expect(screen.getByTestId('knowledge-tab-review').textContent).toBe('Review1');
  });
});

describe('KnowledgePage subjects (M33a.3, a deep link since M51)', () => {
  const anchored = (path: string, target: string): Entry =>
    concept({ path, title: path, relationships: { about: [target] } });

  it('offers + Create page on a dangling subject, pre-filled with its name (D1/D7)', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [anchored('knowledge/a.md', 'mpm-410')],
    });
    render(
      <KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'entity', key: 'mpm-410' } }} />,
    );
    // Not `Open …`: there is nothing to open, and the offer is to write it.
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
    fireEvent.click(screen.getByTestId('promote-thread'));
    // The New menu's own dialog, carrying the thread's name — a suggestion the
    // human can edit, which is the whole of D1: the agent never gets here.
    expect(screen.getByDisplayValue('mpm-410')).not.toBeNull();
  });
});

describe('KnowledgePage thread view (M33a.4)', () => {
  const anchored = (path: string, title: string): Entry =>
    concept({ path, title, relationships: { about: ['mpm-410'] } });

  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [anchored('knowledge/a.md', 'Alpha'), anchored('knowledge/b.md', 'Beta')],
    });
  });

  it("opens a subject as one list, and one of its concepts as that concept's page", () => {
    render(
      <KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'entity', key: 'mpm-410' } }} />,
    );
    expect(screen.getByTestId('thread-view')).not.toBeNull();
    fireEvent.click(screen.getAllByTestId('thread-concept')[0]);
    expect(useNavStore.getState().selection.kind).toBe('doc');
  });

  it('leaves every other view a list', () => {
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' } }} />);
    expect(screen.queryByTestId('thread-view')).toBeNull();
    expect(screen.getAllByTestId('concept-row')).toHaveLength(2);
  });
});

describe('KnowledgePage names its maintainer (M35.3)', () => {
  const agent = (properties: Entry['properties']) =>
    concept({
      path: 'records/agents/knowledge.md',
      title: 'Knowledge',
      type: 'Agent',
      properties,
    });

  it('the byline names the knowledge-capable agent and opens it on Agents (M50.3)', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({ path: OLD, title: 'The offline window' }),
        agent({ slug: 'knowledge', capabilities: ['knowledge'] }),
      ],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' } }} />);
    const byline = screen.getByTestId('knowledge-maintainer');
    expect(byline.textContent).toContain('Maintained by Knowledge');
    fireEvent.click(byline);
    expect(useNavStore.getState().selection).toEqual({
      kind: 'agents',
      actor: 'process:knowledge',
    });
  });

  it('resolved by capability, never by slug or title', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({ path: OLD, title: 'The offline window' }),
        // An agent NAMED Knowledge without the capability earns no byline —
        // the name is not the grant.
        agent({ slug: 'knowledge' }),
      ],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' } }} />);
    expect(screen.queryByTestId('knowledge-maintainer')).toBeNull();
    // And no byline naming nobody in its place (M51).
    expect(screen.queryByText(/Maintained by/)).toBeNull();
  });
});

describe('KnowledgePage as a table (M52.5)', () => {
  const row = (title: string) => {
    const found = screen
      .getAllByTestId('concept-row')
      .find((r) => r.querySelector('[data-concept-title]')?.textContent === title);
    if (found === undefined) throw new Error(`no row for ${title}`);
    return found;
  };
  const cell = (title: string, column: string) =>
    column === 'concept'
      ? row(title).querySelector('[data-concept-title]')?.textContent
      : row(title).querySelector(`[data-column="${column}"]`)?.textContent;
  // Frontmatter as the scanner hands it over: nested lists and maps.
  const props = (p: Record<string, unknown>) => p as unknown as Entry['properties'];

  beforeEach(() => {
    useUiStore.setState({ collapsed: {} });
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
  });

  it('gives each row one status: what a person owes it, then what is true of it, then its review', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({ path: 'knowledge/fresh.md', title: 'Fresh' }),
        concept({
          path: 'knowledge/signed.md',
          title: 'Signed',
          properties: props({ verified: [{ by: 'human:josef', at: '2026-07-01' }] }),
        }),
        concept({
          path: 'knowledge/retired.md',
          title: 'Retired',
          properties: props({
            lifecycle: 'deprecated',
            verified: [{ by: 'human:josef', at: '2026-07-01' }],
          }),
        }),
      ],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' } }} />);
    // Queued, so the queue's word — the one its own page's chip says.
    expect(cell('Fresh', 'status')).toBe('Unreviewed');
    const signed = row('Signed').querySelector('[data-testid="review-chip"]');
    expect(signed?.getAttribute('data-review')).toBe('current');
    expect(signed?.getAttribute('data-by')).toBe('human');
    // Settled reads quiet: "Reviewed", with who in the hover only.
    expect(signed?.textContent).toBe('Reviewed');
    expect(signed?.getAttribute('title')).toContain('by a person');
    // Retired and already reviewed: out of the queue, and one chip, not two.
    expect(cell('Retired', 'status')).toBe('Deprecated');
    expect(row('Retired').querySelector('[data-testid="review-chip"]')).toBeNull();
  });

  it('counts sources, and never prints 0 for a list nobody wrote', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({
          path: 'knowledge/cited.md',
          title: 'Cited',
          properties: props({ sources: [{ resource: 'a' }, { resource: 'b' }] }),
        }),
        concept({ path: 'knowledge/bare.md', title: 'Bare', properties: props({ sources: [] }) }),
        concept({ path: 'knowledge/silent.md', title: 'Silent' }),
      ],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' } }} />);
    expect(cell('Cited', 'sources')).toBe('2');
    expect(cell('Bare', 'sources')).toBe('0');
    expect(cell('Silent', 'sources')).toBe('not recorded');
  });

  it('names who wrote each, says when nobody recorded it, and leaves no summary blank-filled', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({
          path: 'knowledge/a.md',
          title: 'Written',
          properties: props({
            description: 'What it says',
            generated: { by: 'claude-code', at: '2026-07-01T00:00:00Z' },
          }),
        }),
        concept({ path: 'knowledge/b.md', title: 'Unsigned' }),
      ],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' } }} />);
    expect(cell('Written', 'author')).toBe('Assistant');
    expect(cell('Written', 'summary')).toBe('What it says');
    expect(cell('Unsigned', 'author')).toBe('not recorded');
    // No description: the table's own "none", as a view's empty cell says it
    // — a blank strip read as a row that failed to load (M52.5).
    expect(cell('Unsigned', 'summary')).toBe('—');
  });

  it('says how many there are and how many wait, and Start review opens the first the queue would', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({ path: 'knowledge/new.md', title: 'Fresh' }),
        concept({
          path: 'knowledge/due.md',
          title: 'Due',
          properties: { stale_after: '2020-01-01' },
        }),
      ],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' } }} />);
    // The count beside the title, as a view's; the summary says what waits.
    expect(screen.getByTestId('knowledge-count').textContent).toBe('2');
    expect(screen.getByTestId('knowledge-summary').textContent).toBe('2 to verify');
    // The number that matters most rides on the button.
    expect(screen.getByTestId('knowledge-start-count').textContent).toBe('2');
    fireEvent.click(screen.getByTestId('knowledge-start-review'));
    // Past its date outranks new, as the Review tab orders it.
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'knowledge/due.md' });
  });

  it('offers no Start review with nothing waiting, and says so', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({
          path: 'knowledge/signed.md',
          title: 'Signed',
          properties: props({ verified: [{ by: 'human:josef', at: '2026-07-01' }] }),
        }),
      ],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' } }} />);
    expect(screen.queryByTestId('knowledge-start-review')).toBeNull();
    expect(screen.getByTestId('knowledge-count').textContent).toBe('1');
    expect(screen.getByTestId('knowledge-summary').textContent).toBe('nothing to review');
  });

  it("counts and starts a folder's own review in a folder's view", () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        // First in the whole queue — and not in this folder.
        concept({
          path: 'knowledge/metrics/due.md',
          title: 'Due',
          properties: { stale_after: '2020-01-01' },
        }),
        concept({ path: 'knowledge/playbooks/fresh.md', title: 'Fresh' }),
        concept({
          path: 'knowledge/playbooks/signed.md',
          title: 'Signed',
          properties: props({ verified: [{ by: 'human:josef', at: '2026-07-01' }] }),
        }),
      ],
    });
    render(
      <KnowledgePage
        selection={{ kind: 'knowledge', nav: { tab: 'section', folder: 'playbooks' } }}
      />,
    );
    expect(screen.getAllByTestId('concept-row')).toHaveLength(2);
    expect(screen.getByTestId('knowledge-count').textContent).toBe('2');
    expect(screen.getByTestId('knowledge-summary').textContent).toBe('1 to verify');
    // The crumb names the folder, so its one section draws no band.
    expect(screen.queryByTestId('concept-group')).toBeNull();
    // The tabs count the bundle, so a folder's view draws no count on them.
    expect(screen.getByTestId('knowledge-tab-all').textContent).toBe('Concepts');
    expect(screen.getByTestId('knowledge-tab-review').textContent).toBe('Review');
    fireEvent.click(screen.getByTestId('knowledge-start-review'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'doc',
      path: 'knowledge/playbooks/fresh.md',
    });
    cleanup();

    // And the pager walks the folder, not the bundle: one of one, no Next
    // into another folder — Done, back to the folder (M52.5).
    render(<ReviewPager path="knowledge/playbooks/fresh.md" />);
    expect(screen.getByTestId('review-pager').textContent).toBe('Review 1 of 1 in PlaybooksDone');
    expect(screen.queryByTestId('review-next')).toBeNull();
    fireEvent.click(screen.getByTestId('review-done'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'knowledge',
      nav: { tab: 'section', folder: 'playbooks' },
    });
  });

  it('counts the whole queue again once the walk is left', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({
          path: 'knowledge/metrics/due.md',
          title: 'Due',
          properties: { stale_after: '2020-01-01' },
        }),
        concept({ path: 'knowledge/playbooks/fresh.md', title: 'Fresh' }),
      ],
    });
    render(
      <KnowledgePage
        selection={{ kind: 'knowledge', nav: { tab: 'section', folder: 'playbooks' } }}
      />,
    );
    fireEvent.click(screen.getByTestId('knowledge-start-review'));
    cleanup();
    // Back on Knowledge — from the Review tab, a row is the whole queue's.
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'review' } }} />);
    cleanup();
    render(<ReviewPager path="knowledge/playbooks/fresh.md" />);
    // Two of two in the whole queue — and the whole queue ends there too
    // (M52.5): Done, back to Review, where it used to wrap round to one.
    expect(screen.getByTestId('review-pager').textContent).toBe('Review 2 of 2Done');
    fireEvent.click(screen.getByTestId('review-done'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'knowledge',
      nav: { tab: 'review' },
    });
    cleanup();
    render(<ReviewPager path="knowledge/metrics/due.md" />);
    expect(screen.getByTestId('review-pager').textContent).toBe('Review 1 of 2Next');
  });

  it('ends a walk of the whole queue too, once nothing in it waits', () => {
    const fresh = 'knowledge/playbooks/fresh.md';
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [concept({ path: fresh, title: 'Fresh' })],
    });
    // A Review-tab row starts the whole queue's walk.
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'review' } }} />);
    fireEvent.click(screen.getByTestId('queue-row'));
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: fresh });
    cleanup();
    // Its last concept verified, the pager says the walk is over rather than
    // vanishing — and Done goes back to Review, where the walk began.
    useVaultStore.setState({
      entries: [
        concept({
          path: fresh,
          title: 'Fresh',
          properties: props({ verified: [{ by: 'human:josef', at: '2026-07-01' }] }),
        }),
      ],
    });
    render(<ReviewPager path={fresh} />);
    expect(screen.getByTestId('review-pager').textContent).toBe('Nothing left to reviewDone');
    fireEvent.click(screen.getByTestId('review-done'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'knowledge',
      nav: { tab: 'review' },
    });
  });

  it("folds a folder's rows under its band, and unfolds them", () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({ path: 'knowledge/metrics/a.md', title: 'A metric' }),
        concept({ path: 'knowledge/playbooks/b.md', title: 'A playbook' }),
      ],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' } }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Metrics' }));
    expect(screen.getAllByTestId('concept-row').map((r) => r.dataset.path)).toEqual([
      'knowledge/playbooks/b.md',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Expand Metrics' }));
    expect(screen.getAllByTestId('concept-row')).toHaveLength(2);
  });

  it('lists the queue in the order it is worked, with the folder as a column', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({ path: 'knowledge/playbooks/new.md', title: 'Fresh' }),
        concept({
          path: 'knowledge/metrics/due.md',
          title: 'Due',
          properties: { stale_after: '2020-01-01' },
        }),
      ],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'review' } }} />);
    const rows = screen.getAllByTestId('queue-row');
    expect(rows.map((r) => r.querySelector('[data-column="folder"]')?.textContent)).toEqual([
      'Metrics',
      'Playbooks',
    ]);
    // Not filed: the queue's order is the point of it.
    expect(screen.queryByTestId('concept-section')).toBeNull();
  });

  it('counts the proposals waiting beside the concepts to verify', async () => {
    const waiting = (id: string, path: string): ReviewCard => ({
      proposal_id: id,
      commit_set_id: `c-${id}`,
      run_id: 'run',
      actor: 'process:release-scout',
      op: 'update_belief',
      effective_risk: 'HIGH',
      review: null,
      queued_for: [],
      intended_use_kind: 'ReversibleWork',
      intended_use_stakes: 'HIGH',
      transition_cause: 'new_evidence',
      evidence_refs: [],
      coverage_refs: [],
      authority_refs: [],
      targets: [
        {
          target_class: 'belief',
          target_id: id.padEnd(32, '0'),
          expected_version: 1,
          current_version: 1,
          stale: false,
          path,
        },
      ],
      reason: 'it moved',
      set_members: [id],
      set_ready: true,
    });
    __seedReview({
      cards: [waiting('p1', 'knowledge/metrics/signed.md'), waiting('p2', 'knowledge/other.md')],
    });
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({ path: 'knowledge/metrics/fresh.md', title: 'Fresh' }),
        concept({
          path: 'knowledge/metrics/signed.md',
          title: 'Signed',
          properties: props({ verified: [{ by: 'human:josef', at: '2026-07-01' }] }),
        }),
      ],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' } }} />);
    // Six decisions are not three: the Review count is both queues.
    expect(await screen.findByText('1 to verify · 2 proposals')).not.toBeNull();
    expect(screen.getByTestId('knowledge-tab-review').textContent).toBe('Review3');
    // And the reviewed concept with a change waiting says so, loudly.
    expect(row('Signed').querySelector('[data-testid="concept-proposal"]')).not.toBeNull();
    // Start review walks the concepts; the cards are decided under Review.
    expect(screen.getByTestId('knowledge-start-count').textContent).toBe('1');
  });
});
