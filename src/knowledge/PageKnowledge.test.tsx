// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DetailPanel } from '@/detail/DetailPanel';
import { DocSidePanel } from '@/detail/DocSidePanel';
import type { Entry } from '@/engine/types';
import * as ipc from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { fixtureVault, makeEntry } from '@/test/factories';
import { PageKnowledge } from './PageKnowledge';

/**
 * One anatomy for a page's Knowledge (M52.3).
 *
 * The record peek and the page tab used to stack three sub-surfaces each,
 * with a heading and an empty sentence apiece and two Learn buttons between
 * them. What is held here: both hosts render the same thing, it says it holds
 * nothing ONCE, and there is one Learn button, held while the base reads.
 */

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return {
    ...actual,
    ingestItemState: vi.fn(async () => null),
    beliefChips: vi.fn(async () => []),
    readNote: vi.fn(async () => 'Existing body'),
  };
});

// The editor is a heavy BlockNote surface with its own async load — what is
// under test is the Knowledge beside it.
vi.mock('@/editor/NoteBodyEditor', () => ({
  NoteBodyEditor: ({ path }: { path: string }) => <div data-testid="body-editor">{path}</div>,
}));

const RECORD = 'projects/onboarding/items/fld-1.md';

const LEARNED = makeEntry({
  path: 'knowledge/playbooks/first-run.md',
  title: 'First run takes one screen',
  properties: {
    sources: [{ id: 's1', resource: RECORD, title: 'Design first-run flow' }],
  } as unknown as Entry['properties'],
});
const ABOUT = makeEntry({
  path: 'knowledge/systems/first-run-flow.md',
  title: 'First-run flow',
  relationships: { about: ['fld-1'] },
});
const AROUND = makeEntry({
  path: 'knowledge/people/ana.md',
  title: 'Ana owns field onboarding',
  relationships: { about: ['ana-rios'] },
});

const record = () => useVaultStore.getState().entries.find((e) => e.path === RECORD)!;

function SidePanel() {
  const schema = useSchema();
  return (
    <DocSidePanel entry={record()} schema={schema} editor={null} scrollRef={{ current: null }} />
  );
}

/** The testids under the page's Knowledge, in document order. */
function anatomy(): (string | undefined)[] {
  const root = screen.getByTestId('page-knowledge');
  return [...root.querySelectorAll<HTMLElement>('[data-testid]')].map((el) => el.dataset.testid);
}

beforeEach(() => {
  useVaultStore.setState({
    vaultPath: '/vault',
    entries: [...fixtureVault(), LEARNED, ABOUT, AROUND],
  });
  useUiStore.setState({ detailPath: RECORD, docPanelTab: 'knowledge', agentPendingPrompt: null });
  vi.mocked(ipc.ingestItemState).mockClear();
  vi.mocked(ipc.ingestItemState).mockResolvedValue(null);
});

afterEach(cleanup);

describe('PageKnowledge (M52.3)', () => {
  it('reads the same from the record peek and from the page tab', () => {
    render(<DetailPanel />);
    const peek = anatomy();
    cleanup();
    render(<SidePanel />);
    expect(anatomy()).toEqual(peek);
    expect(peek).toEqual(
      expect.arrayContaining([
        'knowledge-commit',
        'committed-concept',
        'entity-dossier',
        'dossier-concept',
      ]),
    );
  });

  it('names its two groups, and leads with what was learned from the page', () => {
    render(<PageKnowledge entry={record()} />);
    const root = screen.getByTestId('page-knowledge');
    const text = root.textContent ?? '';
    expect(text.indexOf('Learned from this page')).toBeLessThan(text.indexOf('About this page'));
    expect(screen.getByTestId('knowledge-commit').dataset.state).toBe('committed');
    // The retired headings are gone; the groups say what they hold.
    expect(root.querySelector('h3')).toBeNull();
    expect(text).not.toContain('In Knowledge');
  });

  it('shows what is around the page when nothing is about it', () => {
    useVaultStore.setState({ entries: [...fixtureVault(), AROUND] });
    render(<PageKnowledge entry={record()} />);
    expect(screen.getByText('Related to this page')).toBeTruthy();
    expect(screen.getByTestId('related-concept').textContent).toContain('Ana owns field');
    expect(screen.queryByText('About this page')).toBeNull();
  });

  it('says it holds nothing once, and still offers every ask', () => {
    useVaultStore.setState({ entries: fixtureVault() });
    render(<PageKnowledge entry={record()} />);
    const root = screen.getByTestId('page-knowledge');
    expect(
      within(root)
        .getAllByText(/nothing/i)
        .map((el) => el.textContent),
    ).toEqual(['Knowledge holds nothing about this page yet.']);
    // The learned group is still there to say the page was never learned
    // from — just not drawn.
    expect(screen.getByTestId('knowledge-commit').dataset.state).toBe('uncommitted');
    expect(
      within(root)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['What does Knowledge say about this?', "What's missing?", 'Learn from this page']);
  });

  it('has one Learn button, held while the base is reading the page', async () => {
    vi.mocked(ipc.ingestItemState).mockResolvedValue({ state: 'pending', route: 'm26_queued' });
    render(<PageKnowledge entry={record()} />);
    await waitFor(() => expect(screen.getByTestId('learn-queued')).toBeTruthy());
    const learn = screen.getAllByRole('button', { name: 'Learn from this page' });
    expect(learn).toHaveLength(1);
    expect(learn[0].hasAttribute('disabled')).toBe(true);
    // Asked about once for both, not once per sub-surface.
    expect(vi.mocked(ipc.ingestItemState)).toHaveBeenCalledTimes(1);
  });

  // M52.4 — a concept both anchored to the page and learned from it was
  // listed twice, once in each group.
  it('lists a concept that is about the page AND cites it once, under About', () => {
    const both = makeEntry({
      path: 'knowledge/systems/first-run-flow.md',
      title: 'First-run flow',
      relationships: { about: ['fld-1'] },
      properties: {
        sources: [{ id: 's1', resource: RECORD, title: 'Design first-run flow' }],
      } as unknown as Entry['properties'],
    });
    useVaultStore.setState({ entries: [...fixtureVault(), both] });
    render(<PageKnowledge entry={record()} />);
    const listed = [
      ...screen.getByTestId('page-knowledge').querySelectorAll<HTMLElement>('[data-path]'),
    ].filter((el) => el.dataset.path === both.path);
    expect(listed.map((el) => el.dataset.testid)).toEqual(['dossier-concept']);
    expect(screen.queryByTestId('committed-concept')).toBeNull();
    expect(screen.queryByText('Learned from this page')).toBeNull();
    // The page was still learned from — the state says so.
    expect(screen.getByTestId('knowledge-commit').dataset.state).toBe('committed');
    expect(screen.getByTestId('knowledge-commit').dataset.count).toBe('1');
  });

  it('shows the queued line without a heading over no rows', async () => {
    useVaultStore.setState({ entries: fixtureVault() });
    vi.mocked(ipc.ingestItemState).mockResolvedValue({ state: 'pending', route: 'm26_queued' });
    render(<PageKnowledge entry={record()} />);
    const queued = await screen.findByTestId('learn-queued');
    expect(queued.closest('[hidden]')).toBeNull();
    expect(screen.queryByText('Learned from this page')).toBeNull();
  });

  it('asks about the page by the act and the page’s name', () => {
    render(<PageKnowledge entry={record()} />);
    fireEvent.click(screen.getByRole('button', { name: "What's missing?" }));
    const pending = useUiStore.getState().agentPendingPrompt;
    expect(pending?.label).toBe("What's missing? · Design first-run flow");
    expect(pending?.subject).toBe(RECORD);
    expect(pending?.text).toContain('**Missing**');
  });
});
