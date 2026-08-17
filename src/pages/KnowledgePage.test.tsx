// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/engine/types';
import { readNote } from '@/lib/ipc';
import { todayIso } from '@/lib/templates';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { KnowledgePage } from './KnowledgePage';

vi.mock('@/lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
  return { ...actual, readNote: vi.fn(async () => '# Body\n') };
});

afterEach(cleanup);

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

describe('KnowledgePage and a replaced concept (M15)', () => {
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
  });

  it('labels the retired row and warns in its reading pane', () => {
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' }, path: OLD }} />);
    // A strikethrough alone was the only signal, with no legend anywhere.
    expect(screen.getAllByTestId('replaced-tag')).toHaveLength(1);
    const banner = screen.getByTestId('superseded-banner');
    expect(banner.textContent).toContain('No longer believed');
    expect(banner.textContent).toContain('The offline window, revised');
  });

  it('says nothing of the sort on the concept that replaced it', () => {
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' }, path: NEW }} />);
    expect(screen.queryByTestId('superseded-banner')).toBeNull();
  });
});

describe('KnowledgePage threads (M33a.3)', () => {
  const anchored = (path: string, target: string): Entry =>
    concept({ path, title: path, relationships: { about: [target] } });

  it('opens on the heaviest thread when the selection names no view', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        anchored('knowledge/a.md', 'mpm-410'),
        anchored('knowledge/b.md', 'mpm-410'),
        anchored('knowledge/c.md', 'kos-3.2'),
      ],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge' }} />);
    expect(screen.getByTestId('knowledge-heading').textContent).toContain('mpm-410');
  });

  it('offers + Create page on a dangling thread, pre-filled with its name (D1/D7)', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [anchored('knowledge/a.md', 'mpm-410')],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge' }} />);
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

  it('opens a thread as a thread, not as whichever concept sorted first', () => {
    render(<KnowledgePage selection={{ kind: 'knowledge' }} />);
    expect(screen.getByTestId('thread-view')).not.toBeNull();
    // Nothing is selected, so there is no single concept to attest to.
    expect(screen.queryByTestId('knowledge-panel')).toBeNull();
  });

  it('shows the concept once one is asked for, and the overview row leads back', () => {
    render(<KnowledgePage selection={{ kind: 'knowledge' }} />);
    fireEvent.click(screen.getAllByTestId('concept-row')[0]);
    expect(screen.queryByTestId('thread-view')).toBeNull();
    expect(screen.getByTestId('knowledge-panel')).not.toBeNull();

    // Without this row, reading one concept is a one-way door out of the only
    // view that reads the subject as a subject.
    fireEvent.click(screen.getByTestId('thread-overview-row'));
    expect(screen.getByTestId('thread-view')).not.toBeNull();
  });

  it('leaves every other view opening on the head of its list', () => {
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' } }} />);
    expect(screen.queryByTestId('thread-view')).toBeNull();
    expect(screen.queryByTestId('thread-overview-row')).toBeNull();
    expect(screen.getByTestId('knowledge-panel')).not.toBeNull();
  });
});

describe('KnowledgePage wikilinks (M33a.4)', () => {
  const RECORD = 'notes/field-report.md';

  beforeEach(() => {
    useUiStore.setState({ toasts: [] });
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({ path: OLD, title: 'The offline window' }),
        concept({ path: NEW, title: 'The offline window, revised' }),
        // An ordinary untyped note: a vault entry that is not a concept.
        {
          ...concept({ path: RECORD, title: 'Field report' }),
          type: null,
          folder: 'notes',
        },
      ],
    });
  });

  const follow = async (body: string) => {
    vi.mocked(readNote).mockResolvedValue(body);
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' }, path: OLD }} />);
    const link = await screen.findByTestId('concept-wikilink');
    fireEvent.click(link);
  };

  it('follows a link to another concept into this reading pane', async () => {
    await follow('See [[offline-window-v2]].\n');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain(
      'The offline window, revised',
    );
  });

  it('follows a link to a vault record out to where that record lives', async () => {
    await follow('See [[field-report]].\n');
    // The bundle does not hold your notes, so this one leaves the tab.
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: RECORD });
  });

  it('says a dangling link names nothing yet, and does not call it broken', async () => {
    await follow('See [[mpm-410]].\n');
    // A dangling link is legitimate (OKF §6.1) and, per D7, an open thread —
    // the base is tracking something nobody has written up.
    const [toast] = useUiStore.getState().toasts;
    expect(toast.message).toBe('Nothing in the vault is named "mpm-410" yet');
    expect(toast.message).not.toContain('broken');
  });
});

describe('KnowledgePage verification (M15)', () => {
  const today = todayIso();

  beforeEach(() => {
    useUiStore.setState({ actorId: 'josef' });
  });

  it('refuses a second identical stamp from the same actor on the same day', () => {
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        concept({
          path: OLD,
          title: 'The offline window',
          // Nested YAML passes through `properties` raw — the type says
          // scalars, the parser does not (see Entry.properties).
          properties: {
            verified: [{ by: 'human:josef', at: `${today}T09:00:00Z` }],
          } as unknown as Entry['properties'],
        }),
      ],
    });
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' } }} />);
    const button = screen.getByRole('button', { name: /Verified by you today/ });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('offers Verify, and a Recheck beside the stale chip that Verify cannot clear', () => {
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
    render(<KnowledgePage selection={{ kind: 'knowledge', nav: { tab: 'all' } }} />);
    expect(screen.getByRole('button', { name: /^Verify$/ }).hasAttribute('disabled')).toBe(false);
    // `verify_concept` may write `verified` and nothing else, so staleness is
    // the agent's to clear — the remedy has to be reachable from the chip.
    expect(screen.getByTestId('recheck-concept')).toBeTruthy();
  });
});
