import { navSeed } from '@/test/navSeed';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_HEAD_CHROME } from '@/components/PageToolbar';
import { resetMockFs } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import {
  DOC_COLUMN_MIN_WIDTH,
  DOC_PANEL_MIN_WIDTH,
  DOC_PANEL_WIDTH,
  useUiStore,
} from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { DocPage } from './DocPage';
import { InboxPage } from './InboxPage';

/**
 * A page's frame against the widths it measures (components/pageFrame.css):
 * when the side panel docks, folds and comes back as a drawer, and when the
 * outline draws. jsdom lays nothing out, so the widths are handed in, by what
 * each page asks the hook for: the frame (before paint), the toolbar's actions
 * (their border box), and the reading column or the reader (neither). Null is
 * unmeasured, which the pages read as "draw what is stored".
 */
const widths = vi.hoisted(() => ({
  frame: null as number | null,
  actions: null as number | null,
  column: null as number | null,
}));
vi.mock('@/hooks/useMeasuredWidth', () => ({
  useMeasuredWidth: (options?: { beforePaint?: boolean; box?: 'content' | 'border' }) => [
    () => undefined,
    options?.box === 'border'
      ? widths.actions
      : options?.beforePaint === true
        ? widths.frame
        : widths.column,
  ],
}));

const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const PAGE = 'delivery/how-we-schedule.md';
/** The toolbar's actions on a page, about as wide as the real ones draw. */
const ACTIONS = 179;
/** The side panel's floor beside them: the wider of its own and theirs. */
const floorFor = (actions: number) => Math.max(DOC_PANEL_MIN_WIDTH, actions + PANEL_HEAD_CHROME);

const frameState = () => screen.getByTestId('doc-page').dataset.panel;

beforeEach(async () => {
  resetMockFs();
  await useVaultStore.getState().openVault('/demo-vault');
  useNavStore.setState({
    selection: { kind: 'doc', path: PAGE },
    history: [navSeed({ kind: 'home' })],
    historyIndex: 0,
  });
  useUiStore.setState({
    docPanelOpen: true,
    docPanel: 'details',
    inboxPanel: 'details',
    inspectorCollapsed: [],
  });
  widths.frame = null;
  widths.actions = null;
  widths.column = null;
});
afterEach(cleanup);

describe("DocPage's frame", () => {
  it("docks the panel while the column keeps its floor beside the actions' floor, folds it a pixel short, and opens it as a drawer", () => {
    widths.actions = ACTIONS;
    widths.frame = DOC_COLUMN_MIN_WIDTH + floorFor(ACTIONS);
    const { unmount } = render(<DocPage selection={{ kind: 'doc', path: PAGE }} />);
    expect(frameState()).toBe('docked');
    expect(screen.getByTestId('doc-side-panel').hasAttribute('data-overlay')).toBe(false);
    unmount();

    widths.frame = DOC_COLUMN_MIN_WIDTH + floorFor(ACTIONS) - 1;
    render(<DocPage selection={{ kind: 'doc', path: PAGE }} />);
    // Folded, not closed: the stored word is untouched, and Details offers it.
    expect(frameState()).toBeUndefined();
    expect(screen.queryByTestId('doc-side-panel')).toBeNull();
    expect(useUiStore.getState().docPanelOpen).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(frameState()).toBe('drawer');
    expect(screen.getByTestId('doc-side-panel').dataset.overlay).toBe('true');
  });

  it("keeps the panel's own floor when the actions are narrower than it", () => {
    widths.actions = 100;
    widths.frame = DOC_COLUMN_MIN_WIDTH + DOC_PANEL_MIN_WIDTH;
    const { unmount } = render(<DocPage selection={{ kind: 'doc', path: PAGE }} />);
    expect(frameState()).toBe('docked');
    unmount();
    widths.frame -= 1;
    render(<DocPage selection={{ kind: 'doc', path: PAGE }} />);
    expect(frameState()).toBeUndefined();
  });

  it('draws the outline over a column that keeps its gutter, and not under a drawer', async () => {
    widths.column = 560;
    const { rerender } = render(<DocPage selection={{ kind: 'doc', path: PAGE }} />);
    const outline = await screen.findByTestId('doc-outline', undefined, { timeout: 5_000 });
    expect(within(outline).getAllByRole('button')).toHaveLength(3);
    // The column trims the gutter the outline sits in: no outline there.
    widths.column = 559;
    rerender(<DocPage selection={{ kind: 'doc', path: PAGE }} />);
    expect(screen.queryByTestId('doc-outline')).toBeNull();
    widths.column = 560;
    rerender(<DocPage selection={{ kind: 'doc', path: PAGE }} />);
    expect(screen.getByTestId('doc-outline')).toBeTruthy();

    // Folded, the panel's drawer covers the outline's corner: no outline while
    // it is up, and back once it closes.
    widths.actions = ACTIONS;
    widths.frame = DOC_COLUMN_MIN_WIDTH + floorFor(ACTIONS) - 1;
    rerender(<DocPage selection={{ kind: 'doc', path: PAGE }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(frameState()).toBe('drawer');
    expect(screen.queryByTestId('doc-outline')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(frameState()).toBeUndefined();
    expect(screen.getByTestId('doc-outline')).toBeTruthy();
  });
});

describe("the Inbox's frame", () => {
  const CAPTURE = 'inbox/outline-capture.md';

  beforeEach(async () => {
    fs().set(
      CAPTURE,
      '# Outline capture\n\nWhat came in.\n\n## First thing\n\nOne.\n\n## Second thing\n\nTwo.\n',
    );
    await useVaultStore.getState().rescan();
    useUiStore.setState({ inboxEnabled: true, inboxSelectedPath: CAPTURE });
    useNavStore.setState({
      selection: { kind: 'inbox' },
      history: [navSeed({ kind: 'inbox' })],
      historyIndex: 0,
    });
  });

  /** Where the inspector folds: the reader keeps what 760 always left it
   *  beside a 300px panel, and a panel the actions widen folds that sooner. */
  const foldAt = (actions: number) =>
    760 - DOC_PANEL_WIDTH + Math.max(DOC_PANEL_WIDTH, actions + PANEL_HEAD_CHROME);

  it('docks the inspector from its fold up, and folds it a pixel below', () => {
    const actions = 257;
    widths.actions = actions;
    widths.frame = foldAt(actions);
    const { unmount } = render(<InboxPage />);
    const page = () => screen.getByTestId('inbox-page');
    expect(page().dataset.panel).toBe('docked');
    unmount();
    widths.frame = foldAt(actions) - 1;
    render(<InboxPage />);
    expect(page().dataset.panel).toBeUndefined();
    expect(screen.queryByTestId('doc-side-panel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(page().dataset.panel).toBe('drawer');
  });

  it("outlines the capture's headings under its title over the reader, and not under a drawer", async () => {
    widths.column = 560;
    widths.actions = 257;
    widths.frame = foldAt(257);
    const { rerender } = render(<InboxPage />);
    const outline = await screen.findByTestId('doc-outline', undefined, { timeout: 5_000 });
    expect(
      within(outline)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['First thing', 'Second thing']);
    widths.column = 559;
    rerender(<InboxPage />);
    expect(screen.queryByTestId('doc-outline')).toBeNull();
    widths.column = 560;
    widths.frame = foldAt(257) - 1;
    rerender(<InboxPage />);
    await waitFor(() => expect(screen.getByTestId('doc-outline')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByTestId('inbox-page').dataset.panel).toBe('drawer');
    expect(screen.queryByTestId('doc-outline')).toBeNull();
  });
});
