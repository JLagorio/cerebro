// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listConcepts } from '@/engine/okf';
import type { Entry } from '@/engine/types';
import * as ipc from '@/lib/ipc';
import { sha256Hex } from '@/lib/sha256';
import { todayIso } from '@/lib/templates';
import { useLedgerStore } from '@/stores/ledgerStore';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { ConceptHeading } from './ConceptHeading';
import { ConceptDetailsTab } from './ConceptDetailsTab';
import { ConceptReviewBar } from './ConceptReviewBar';

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return {
    ...actual,
    verifyConcept: vi.fn(async () => undefined),
    beliefChips: vi.fn(async () => []),
  };
});

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
const today = todayIso();
const conceptAt = (path: string) =>
  listConcepts(useVaultStore.getState().entries, today).find((c) => c.entry.path === path)!;

afterEach(() => {
  cleanup();
  useLedgerStore.setState({ vault: null, read: { kind: 'unread' } });
});

describe('ConceptHeading (M50.1)', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({ path: OLD, title: 'The offline window' }),
        concept({
          path: NEW,
          title: 'The offline window, revised',
          properties: { supersedes: '/claims/offline-window.md', description: 'How long.' },
        }),
      ],
    });
  });

  it('warns on a retired concept and leads to what replaced it (M15)', () => {
    render(<ConceptHeading concept={conceptAt(OLD)} />);
    const banner = screen.getByTestId('superseded-banner');
    expect(banner.textContent).toBe('Replaced byThe offline window, revised');
    fireEvent.click(screen.getByRole('button', { name: 'The offline window, revised' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: NEW });
  });

  it('says nothing of the sort on the concept that replaced it', () => {
    render(<ConceptHeading concept={conceptAt(NEW)} />);
    expect(screen.queryByTestId('superseded-banner')).toBeNull();
  });

  it('edits the title and description as frontmatter, through the capture valve', async () => {
    const patch = vi.fn(async () => true);
    const real = useVaultStore.getState().patchFrontmatter;
    useVaultStore.setState({ patchFrontmatter: patch });
    try {
      render(<ConceptHeading concept={conceptAt(NEW)} />);
      const title = screen.getByTestId('concept-title');
      fireEvent.change(title, { target: { value: 'The offline window, v3' } });
      fireEvent.blur(title);
      expect(patch).toHaveBeenCalledWith(NEW, { title: 'The offline window, v3' });
      const description = screen.getByTestId('concept-description');
      fireEvent.change(description, { target: { value: '' } });
      fireEvent.blur(description);
      // Emptied is removed, not written as an empty string.
      expect(patch).toHaveBeenCalledWith(NEW, { description: null });
    } finally {
      useVaultStore.setState({ patchFrontmatter: real });
    }
  });

  it('says the file is not what was recorded, where the concept is read (M49.6)', () => {
    useLedgerStore.setState({
      vault: '/vault',
      read: {
        kind: 'read',
        status: {
          verdict: 'valid',
          detail: 'valid',
          head: null,
          seq: 3,
          segments: 1,
          anomalies: 0,
          reconciliation_open: true,
          divergences: ['k'],
          quarantined: [{ path: OLD, class: 'adoptable', reason: 'edited outside Cerebro' }],
          stopped: false,
          history_unreadable: false,
          approved_supersessions: [],
          recorded_human: [],
          writer: { state: 'held', detail: null },
        },
      },
    });
    render(<ConceptHeading concept={conceptAt(OLD)} />);
    const marker = screen.getByTestId('concept-disputed');
    expect(marker.dataset.class).toBe('adoptable');
    expect(marker.textContent).toContain('differs from its recorded history');
  });
});

describe('ConceptReviewBar (M51.3)', () => {
  beforeEach(() => {
    useUiStore.setState({ actorId: 'josef' });
    vi.mocked(ipc.verifyConcept).mockClear();
  });

  it('pins Verify to the body the page loaded (M49.3)', async () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [concept({ path: OLD, title: 'The offline window' })],
    });
    render(
      <ConceptReviewBar concept={conceptAt(OLD)} viewedBody={'\n# Body\n'} verifyBlocked={null} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Verify$/ }));
    await waitFor(() => expect(ipc.verifyConcept).toHaveBeenCalled());
    const [, path, patch, hash] = vi.mocked(ipc.verifyConcept).mock.calls[0];
    expect(path).toBe(OLD);
    expect(Object.keys(patch)).toEqual(['verified']);
    expect(hash).toBe(sha256Hex('\n# Body\n'));
  });

  it('waits while an edit is still saving, and while the page is loading', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [concept({ path: OLD, title: 'The offline window' })],
    });
    render(
      <ConceptReviewBar
        concept={conceptAt(OLD)}
        viewedBody="# Body"
        verifyBlocked="Saving your edit — Verify when it lands."
      />,
    );
    expect(screen.getByRole('button', { name: /^Verify$/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Saving your edit — Verify when it lands.')).toBeTruthy();
    cleanup();
    render(<ConceptReviewBar concept={conceptAt(OLD)} viewedBody={null} verifyBlocked={null} />);
    expect(screen.getByRole('button', { name: /^Verify$/ }).hasAttribute('disabled')).toBe(true);
  });

  it('refuses a second identical stamp from the same actor on the same day (M15)', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({
          path: OLD,
          title: 'The offline window',
          properties: {
            verified: [{ by: 'human:josef', at: `${today}T09:00:00Z` }],
          } as unknown as Entry['properties'],
        }),
      ],
    });
    render(<ConceptReviewBar concept={conceptAt(OLD)} viewedBody="# Body" verifyBlocked={null} />);
    const button = screen.getByRole('button', { name: /Verified by you today/ });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('makes the second act a recheck on a stale concept, which Verify cannot clear', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({
          path: OLD,
          title: 'The offline window',
          properties: { stale_after: '2020-01-01' },
        }),
      ],
    });
    render(<ConceptReviewBar concept={conceptAt(OLD)} viewedBody="# Body" verifyBlocked={null} />);
    expect(screen.getByRole('button', { name: /^Verify$/ }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('recheck-concept')).toBeTruthy();
    // M52.3 — the recheck leads; Verify alone leaves it due.
    expect(screen.getByTestId('recheck-concept').className).toContain('cb-btn-primary');
    expect(screen.getByRole('button', { name: /^Verify$/ }).className).toContain(
      'cb-btn-secondary',
    );
  });

  // M52.5 — the bar leads with the word the concept's row wears: a reviewed
  // concept past its date is "Due a recheck" in the table, and led with
  // "Reviewed" here.
  it('leads with the state its row names: a recheck due, then a retirement, then its review', () => {
    const lead = () =>
      screen.getByTestId('concept-review-bar').firstElementChild?.firstElementChild?.textContent ??
      '';
    const reviewed = { verified: [{ by: 'human:tom', at: '2026-07-01T09:00:00Z' }] };
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({
          path: OLD,
          title: 'The offline window',
          properties: {
            ...reviewed,
            stale_after: '2020-01-01',
            lifecycle: 'deprecated',
          } as unknown as Entry['properties'],
        }),
        concept({
          path: NEW,
          title: 'Retired',
          properties: { ...reviewed, lifecycle: 'deprecated' } as unknown as Entry['properties'],
        }),
      ],
    });
    render(<ConceptReviewBar concept={conceptAt(OLD)} viewedBody="# Body" verifyBlocked={null} />);
    expect(lead()).toMatch(/^Due a recheck/);
    cleanup();
    render(<ConceptReviewBar concept={conceptAt(NEW)} viewedBody="# Body" verifyBlocked={null} />);
    expect(lead()).toBe('Deprecated');
    // What is wrong with the review itself leads over both.
    useVaultStore.setState({
      entries: [
        concept({
          path: OLD,
          title: 'The offline window',
          properties: { stale_after: '2020-01-01' },
        }),
      ],
    });
    cleanup();
    render(<ConceptReviewBar concept={conceptAt(OLD)} viewedBody="# Body" verifyBlocked={null} />);
    expect(lead()).toBe('Unreviewed');
  });

  it('asks to revise a concept that is due nothing, and says so in the bubble (M52.3)', () => {
    useUiStore.setState({ agentPendingPrompt: null });
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [concept({ path: OLD, title: 'The offline window' })],
    });
    render(<ConceptReviewBar concept={conceptAt(OLD)} viewedBody="# Body" verifyBlocked={null} />);
    expect(screen.getByRole('button', { name: /^Verify$/ }).className).toContain('cb-btn-primary');
    fireEvent.click(screen.getByTestId('revise-concept'));
    const pending = useUiStore.getState().agentPendingPrompt;
    expect(pending?.label).toBe('Ask to revise · The offline window');
    expect(pending?.subject).toBe(OLD);
    expect(pending?.text.split('\n')[0]).toBe(
      `Revise the knowledge concept at ${OLD} ("The offline window").`,
    );
    expect(pending?.text).not.toContain('recheck date has passed');
  });

  it('says a verified stale concept is still owed a recheck, not that it stays in Review', async () => {
    useUiStore.setState({ toasts: [] });
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({
          path: OLD,
          title: 'The offline window',
          properties: { stale_after: '2020-01-01' },
        }),
      ],
    });
    render(<ConceptReviewBar concept={conceptAt(OLD)} viewedBody="# Body" verifyBlocked={null} />);
    fireEvent.click(screen.getByRole('button', { name: /^Verify$/ }));
    await waitFor(() =>
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
        'Verified "The offline window" — it stays due a recheck until an agent rechecks it',
      ),
    );
  });

  it('offers a replaced concept nothing but the way to its replacement (M52.3)', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({
          path: OLD,
          title: 'The offline window',
          properties: { stale_after: '2020-01-01' },
        }),
        concept({
          path: NEW,
          title: 'The offline window, revised',
          properties: { supersedes: '/claims/offline-window.md' },
        }),
      ],
    });
    render(<ConceptReviewBar concept={conceptAt(OLD)} viewedBody="# Body" verifyBlocked={null} />);
    const bar = screen.getByTestId('concept-review-bar');
    expect(bar.textContent).toContain('Replaced');
    expect(screen.queryByTestId('review-chip')).toBeNull();
    // Due nothing once replaced: no recheck flag, no Verify, no Ask.
    expect(bar.textContent).not.toContain('Due a recheck');
    expect(screen.queryByRole('button', { name: /Verify/ })).toBeNull();
    expect(screen.queryByTestId('recheck-concept')).toBeNull();
    expect(screen.queryByTestId('revise-concept')).toBeNull();
    const open = screen.getByTestId('open-replacement');
    expect(open.textContent).toBe('Open The offline window, revised');
    expect(open.className).toContain('cb-btn-primary');
    fireEvent.click(open);
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: NEW });
  });

  it('keeps the separator with the source count, so a wrap never strands it (M52.3)', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [concept({ path: OLD, title: 'The offline window' })],
    });
    render(<ConceptReviewBar concept={conceptAt(OLD)} viewedBody="# Body" verifyBlocked={null} />);
    const sources = screen.getByTestId('review-bar-sources');
    expect(sources.parentElement?.textContent).toBe('·Sources not recorded');
  });

  it('reads the author as the Assistant or as the agent it names, and opens it (M50.3)', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({
          path: OLD,
          title: 'The offline window',
          properties: {
            generated: { by: 'process:knowledge', at: '2026-07-01T00:00:00Z' },
          } as unknown as Entry['properties'],
        }),
        concept({
          path: 'records/agents/knowledge.md',
          title: 'Knowledge',
          type: 'Agent',
          properties: { slug: 'knowledge' },
        }),
      ],
    });
    render(<ConceptReviewBar concept={conceptAt(OLD)} viewedBody="# Body" verifyBlocked={null} />);
    const author = screen.getByTestId('review-bar-author');
    expect(author.dataset.author).toBe('agent');
    expect(author.textContent).toContain('Knowledge');
    fireEvent.click(author);
    expect(useNavStore.getState().selection).toEqual({
      kind: 'agents',
      actor: 'process:knowledge',
    });
  });
});

describe('the review bar and the details it opens (M51.3)', () => {
  beforeEach(() => {
    useUiStore.setState({ conceptPanelOpen: false, conceptPanelTab: 'outline' });
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({
          path: OLD,
          title: 'The offline window',
          properties: {
            generated: { by: 'claude-code', at: '2026-07-01T00:00:00Z' },
            sources: [{ id: 's1', resource: '/records/decision.md', title: 'The decision' }],
          } as unknown as Entry['properties'],
        }),
      ],
    });
  });

  it('counts the sources, and opens the details panel on them', () => {
    render(<ConceptReviewBar concept={conceptAt(OLD)} viewedBody="# Body" verifyBlocked={null} />);
    fireEvent.click(screen.getByTestId('review-bar-sources'));
    expect(screen.getByTestId('review-bar-sources').textContent).toBe('1 source');
    expect(useUiStore.getState().conceptPanelOpen).toBe(true);
    expect(useUiStore.getState().conceptPanelTab).toBe('details');
  });

  it('says a concept citing nothing cites nothing — never "0 sources"', () => {
    useVaultStore.setState({
      entries: [
        concept({
          path: OLD,
          title: 'The offline window',
          properties: { sources: [] } as unknown as Entry['properties'],
        }),
      ],
    });
    render(<ConceptReviewBar concept={conceptAt(OLD)} viewedBody="# Body" verifyBlocked={null} />);
    expect(screen.getByTestId('review-bar-sources').textContent).toBe('Cites no source');
  });

  // M52.5 — a file that keeps no `sources` list has not recorded any, which
  // is not the same claim as an empty one; the table already said so.
  it('says a concept whose file keeps no sources list has not recorded them', () => {
    useVaultStore.setState({ entries: [concept({ path: OLD, title: 'The offline window' })] });
    render(<ConceptReviewBar concept={conceptAt(OLD)} viewedBody="# Body" verifyBlocked={null} />);
    const sources = screen.getByTestId('review-bar-sources');
    expect(sources.textContent).toBe('Sources not recorded');
    expect(sources.className).not.toContain('text-warn-700');
  });

  it('offers to write the page an open subject names, from its About row (D1/D7)', () => {
    useVaultStore.setState({
      entries: [
        concept({ path: OLD, title: 'The offline window', relationships: { about: ['mpm-410'] } }),
      ],
    });
    render(<ConceptDetailsTab concept={conceptAt(OLD)} />);
    fireEvent.click(screen.getByTestId('promote-subject'));
    // The New menu's own dialog, carrying the subject's name — a suggestion a
    // person edits, which is the whole of D1: the agent never gets here.
    expect(screen.getByDisplayValue('mpm-410')).toBeTruthy();
  });

  it('keeps the evidence in Details, without a second Verify', () => {
    render(<ConceptDetailsTab concept={conceptAt(OLD)} />);
    expect(screen.getByTestId('knowledge-panel')).toBeTruthy();
    expect(screen.getByTestId('concept-author').dataset.author).toBe('assistant');
    expect(screen.queryByRole('button', { name: /Verify/ })).toBeNull();
  });
});
