// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommentsFile } from '@/engine/comments';
import { buildSchema } from '@/engine/schema';
import type { Concept } from '@/engine/okf';
import type { Entry } from '@/engine/types';
import { resetMockFs } from '@/lib/mockIpc';
import type { CommentsSlot } from '@/stores/commentsStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { commentSections } from './commentSections';
import { DocSidePanel } from './DocSidePanel';
import type { PageCommentsController } from './usePageComments';

/** The side panel's Comments tab (M70.2b): on every page, concepts included.
 *  And its Info's last change (M58.1b) and who can change the page (M58.6),
 *  on every page with an Info tab. */

const PAGE = 'records/decisions/dec-offline-window-72h.md';

const open = (id: string) => ({
  comments: [{ id, author: 'human:owner', created: '2026-10-14T09:00:00Z', body: 'x' }],
});
const TWO_OPEN: CommentsFile = {
  format: 1,
  threads: [
    open('0000000000000001'),
    open('0000000000000002'),
    { ...open('0000000000000003'), resolved: { at: '2026-10-14T10:00:00Z', by: 'human:owner' } },
  ],
};

function controller(slot: CommentsSlot | null): PageCommentsController {
  const nothing = async () => null;
  const no = async () => false;
  return {
    path: PAGE,
    slot,
    sections: slot?.kind === 'ready' ? commentSections(slot.file, null) : null,
    focused: null,
    draft: null,
    start: () => undefined,
    cancelDraft: () => undefined,
    submitDraft: nothing,
    startDiscussion: nothing,
    reply: nothing,
    setResolved: no,
    deleteComment: no,
    deleteThread: no,
    focus: () => undefined,
  };
}

let entry: Entry;

function panel(slot: CommentsSlot | null, concept: Concept | null = null) {
  return (
    <DocSidePanel
      entry={entry}
      schema={buildSchema(useVaultStore.getState().entries)}
      editor={null}
      scrollRef={{ current: null }}
      concept={concept}
      comments={controller(slot)}
    />
  );
}

beforeEach(async () => {
  resetMockFs();
  await useVaultStore.getState().openVault('/demo-vault');
  const found = useVaultStore.getState().entries.find((e) => e.path === PAGE);
  if (found === undefined) throw new Error(`fixture vault has no ${PAGE}`);
  entry = found;
  window.localStorage.removeItem('cerebro.docPanelTab');
  useUiStore.setState({ docPanelTab: 'outline', conceptPanelTab: 'details' });
});
afterEach(cleanup);

describe('DocSidePanel comments', () => {
  it('offers Comments on a page, and remembers it as the chosen tab', () => {
    render(panel({ kind: 'ready', file: { format: 1, threads: [] } }));
    fireEvent.click(screen.getByTestId('doc-panel-tab-comments'));
    expect(useUiStore.getState().docPanelTab).toBe('comments');
    expect(window.localStorage.getItem('cerebro.docPanelTab')).toBe('comments');
    expect(screen.getByTestId('comments-tab')).toBeTruthy();
  });

  it("offers Comments on a concept's panel too", () => {
    // Opened on Comments, so the concept's own Details never renders here.
    useUiStore.setState({ conceptPanelTab: 'comments' });
    render(panel({ kind: 'ready', file: TWO_OPEN }, {} as Concept));
    expect(screen.getByTestId('doc-panel-tab-details')).toBeTruthy();
    expect(screen.getByTestId('doc-panel-tab-comments')).toBeTruthy();
    expect(screen.getByTestId('comments-tab')).toBeTruthy();
    fireEvent.click(screen.getByTestId('doc-panel-tab-outline'));
    expect(useUiStore.getState().conceptPanelTab).toBe('outline');
    expect(useUiStore.getState().docPanelTab).toBe('outline');
  });

  it('counts open threads only once they are known and above zero', () => {
    const count = () => screen.queryByTestId('doc-panel-comment-count')?.textContent ?? null;
    const { rerender } = render(panel({ kind: 'ready', file: TWO_OPEN }));
    expect(count()).toBe('2');
    rerender(panel({ kind: 'ready', file: { format: 1, threads: [] } }));
    expect(count()).toBeNull();
    rerender(panel({ kind: 'loading' }));
    expect(count()).toBeNull();
    rerender(panel({ kind: 'unavailable', reason: 'it is not valid JSON' }));
    expect(count()).toBeNull();
    expect(screen.getByTestId('doc-panel-tab-comments').textContent).toBe('Comments');
  });
});

// M58.4 (D18): History is a side panel tab on every page, after Comments.
// M64.2b: it renders PageHistory, the page's versions merged with its edits.
describe('DocSidePanel history', () => {
  const ids = () =>
    screen
      .getAllByTestId(/^doc-panel-tab-/)
      .map((t) => t.dataset.testid?.replace('doc-panel-tab-', ''));

  it('follows Comments on a page, and shows the page history', async () => {
    render(panel(null));
    expect(ids().slice(-2)).toEqual(['comments', 'history']);
    fireEvent.click(screen.getByTestId('doc-panel-tab-history'));
    expect(useUiStore.getState().docPanelTab).toBe('history');
    const history = await screen.findByTestId('page-history');
    expect(within(history).getByTestId('git-history').dataset.variant).toBe('tab');
  });

  it("follows Comments on a concept's panel too, and shows its history", async () => {
    // Opened on Comments, so the concept's own Details never renders here.
    useUiStore.setState({ conceptPanelTab: 'comments' });
    render(panel(null, {} as Concept));
    expect(ids().slice(-2)).toEqual(['comments', 'history']);
    fireEvent.click(screen.getByTestId('doc-panel-tab-history'));
    expect(useUiStore.getState().conceptPanelTab).toBe('history');
    expect(await screen.findByTestId('page-history')).toBeTruthy();
  });
});

describe('DocSidePanel last change (M58.1b)', () => {
  const before = (a: HTMLElement, b: HTMLElement) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it("leads a page's Info with who last changed it", async () => {
    useUiStore.setState({ docPanelTab: 'info' });
    render(panel(null));
    const last = await screen.findByTestId('last-change');
    expect(before(last, screen.getByTestId('doc-properties'))).toBe(true);
    expect((await screen.findByTestId('last-change-line')).textContent).toBe(
      'Who changed this page was not recorded',
    );
  });

  it("leads an agent page's Info too", async () => {
    const agent = useVaultStore
      .getState()
      .entries.find((e) => e.path === 'records/agents/release-scout.md');
    if (agent === undefined) throw new Error('fixture vault has no release-scout');
    entry = agent;
    useUiStore.setState({ docPanelTab: 'info' });
    render(panel(null));
    const last = await screen.findByTestId('last-change');
    expect(before(last, screen.getByTestId('agent-info'))).toBe(true);
  });

  it('is not on a concept, whose panel has no Info', () => {
    useUiStore.setState({ docPanelTab: 'info', conceptPanelTab: 'outline' });
    render(panel(null, {} as Concept));
    expect(screen.queryByTestId('doc-panel-tab-info')).toBeNull();
    expect(screen.queryByTestId('last-change')).toBeNull();
  });
});

describe('DocSidePanel page access (M58.6)', () => {
  const before = (a: HTMLElement, b: HTMLElement) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it("ends a page's Info with who can change it, after its properties", () => {
    useUiStore.setState({ docPanelTab: 'info' });
    render(panel(null));
    const access = screen.getByTestId('page-access');
    expect(before(screen.getByTestId('doc-properties'), access)).toBe(true);
    expect(screen.getByTestId('page-access-summary').textContent).toBe(
      'No agent can change this page.',
    );
  });

  it("follows an agent page's own note", () => {
    const agent = useVaultStore
      .getState()
      .entries.find((e) => e.path === 'records/agents/release-scout.md');
    if (agent === undefined) throw new Error('fixture vault has no release-scout');
    entry = agent;
    useUiStore.setState({ docPanelTab: 'info' });
    render(panel(null));
    expect(before(screen.getByTestId('agent-info'), screen.getByTestId('page-access'))).toBe(true);
  });

  it('is not on a concept, whose panel has no Info', () => {
    useUiStore.setState({ docPanelTab: 'info', conceptPanelTab: 'outline' });
    render(panel(null, {} as Concept));
    expect(screen.queryByTestId('page-access')).toBeNull();
  });
});
