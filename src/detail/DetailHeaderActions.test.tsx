// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DetailHeaderActions } from '@/detail/DetailHeaderActions';
import { resetLayers } from '@/components/ui/layers';
import { useNavStore } from '@/stores/navStore';
import { DETAIL_WIDTH_DEFAULT, DETAIL_WIDTH_MAX, useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';

const A = 'records/work/a.md';
const B = 'records/work/b.md';
const C = 'records/work/c.md';

const deleteNote = vi.fn().mockResolvedValue(undefined);
const readNote = vi.fn().mockResolvedValue('# A\n\nbody text\n');
vi.mock('@/lib/ipc', async (orig) => ({
  ...(await orig<typeof import('@/lib/ipc')>()),
  deleteNote: (...args: unknown[]) => deleteNote(...args),
  readNote: (...args: unknown[]) => readNote(...args),
}));

function setup(siblings: string[] = [A, B, C], open = B) {
  const entries = [A, B, C].map((p) =>
    makeEntry({
      path: p,
      title: p.slice(-4, -3).toUpperCase(),
      type: 'Work item',
      properties: { key: 'WI-2', status: 'todo' },
      relationships: { epic: ['Launch'] },
    }),
  );
  const createItem = vi.fn().mockResolvedValue('records/work/b-copy.md');
  const rescan = vi.fn().mockResolvedValue(undefined);
  useVaultStore.setState({ entries, vaultPath: '/vault', createItem, rescan });
  useUiStore.setState({
    detailPath: open,
    detailSiblings: siblings,
    detailWidth: DETAIL_WIDTH_DEFAULT,
    toasts: [],
  });
  const entry = entries.find((e) => e.path === open);
  if (entry === undefined) throw new Error('no entry');
  render(<DetailHeaderActions entry={entry} />);
  return { createItem, rescan };
}

/**
 * What Notion's peek header offers and ours did not (M16.11): the header was
 * a type icon, a key, a crumb and a close button, so a record you were
 * reading could not be duplicated, deleted, linked to, or stepped past
 * without going back to the list.
 */
describe('DetailHeaderActions', () => {
  beforeEach(() => {
    resetLayers();
    deleteNote.mockClear();
    readNote.mockClear();
  });
  afterEach(cleanup);

  it('steps to the next and previous record in the view', async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.getByText('2/3')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Next record' }));
    expect(useUiStore.getState().detailPath).toBe(C);

    useUiStore.setState({ detailPath: B });
    await user.click(screen.getByRole('button', { name: 'Previous record' }));
    expect(useUiStore.getState().detailPath).toBe(A);
  });

  it('stops at both ends rather than wrapping', () => {
    cleanup();
    setup([A, B, C], A);
    expect(
      (screen.getByRole('button', { name: 'No previous record' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();
    setup([A, B, C], C);
    expect(
      (screen.getByRole('button', { name: 'No next record' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('offers no stepping when the record is on its own', () => {
    setup([B], B);
    expect(screen.queryByRole('button', { name: /record$/ })).toBeNull();
  });

  // M38.2 — the peek stopped being a wall: a record can be a full page.
  it('opens the record in a full page and closes the peek', async () => {
    const user = userEvent.setup();
    setup();
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
    await user.click(screen.getByRole('button', { name: 'Open in full page' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: B });
    // The same record twice — peeked and paged — is one time too many.
    expect(useUiStore.getState().detailPath).toBeNull();
  });

  // The panel is a COLUMN, not an overlay, so Notion's three peek modes
  // collapse to one question: how wide.
  it('toggles the panel between its default width and its widest', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Widen the panel' }));
    expect(useUiStore.getState().detailWidth).toBe(DETAIL_WIDTH_MAX);

    await user.click(screen.getByRole('button', { name: 'Narrow the panel' }));
    expect(useUiStore.getState().detailWidth).toBe(DETAIL_WIDTH_DEFAULT);
  });

  it('copies the wikilink the rest of the app understands, not a URL', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Record actions' }));
    await user.click(await screen.findByTestId('record-copy-link'));
    // Read back through userEvent's own clipboard stub, which it installs on
    // setup() and which therefore replaces anything the test put there first.
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('[[B]]'));
  });

  it('duplicates without copying the key, and re-wraps relationships', async () => {
    const user = userEvent.setup();
    const { createItem } = setup();
    await user.click(screen.getByRole('button', { name: 'Record actions' }));
    await user.click(await screen.findByTestId('record-duplicate'));

    await waitFor(() => expect(createItem).toHaveBeenCalled());
    const arg = createItem.mock.calls[0][0] as {
      frontmatter: Record<string, unknown>;
      body: string;
    };
    // Two records answering to one key is worse than a copy with none.
    expect('key' in arg.frontmatter).toBe(false);
    expect(arg.frontmatter.status).toBe('todo');
    expect(arg.frontmatter.type).toBe('Work item');
    // The scanner strips brackets; disk wants them back.
    expect(arg.frontmatter.epic).toEqual(['[[Launch]]']);
    expect(arg.body).toContain('body text');
    expect(useUiStore.getState().detailPath).toBe('records/work/b-copy.md');
  });

  it('confirms a delete, naming what links here', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Record actions' }));
    await user.click(await screen.findByTestId('record-delete'));

    expect(screen.getByText('Delete "B"?')).toBeTruthy();
    expect(screen.getByText(/Nothing links to it/)).toBeTruthy();
    expect(deleteNote).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteNote).toHaveBeenCalledWith('/vault', B));
  });

  // Deleting from a list should leave you in the list.
  it('lands on a neighbour after deleting, not on nothing', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Record actions' }));
    await user.click(await screen.findByTestId('record-delete'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(useUiStore.getState().detailPath).toBe(C));
  });

  // Deleting the last record in the list has no next to land on.
  it('falls back to the previous record when the deleted one was last', async () => {
    const user = userEvent.setup();
    setup([A, B, C], C);
    await user.click(screen.getByRole('button', { name: 'Record actions' }));
    await user.click(await screen.findByTestId('record-delete'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(useUiStore.getState().detailPath).toBe(B));
    expect(deleteNote).toHaveBeenCalledWith('/vault', C);
  });

  it('closes the panel when the deleted record was the only one', async () => {
    const user = userEvent.setup();
    setup([B], B);
    await user.click(screen.getByRole('button', { name: 'Record actions' }));
    await user.click(await screen.findByTestId('record-delete'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(useUiStore.getState().detailPath).toBeNull());
  });

  // Opened from a backlink or search, the record is not in the list the canvas
  // put in `detailSiblings` at all. `siblings[-1 + 1]` is `siblings[0]`, so
  // without a guard the delete lands on an unrelated record.
  it('closes the panel rather than jumping when the record is not a sibling', async () => {
    const user = userEvent.setup();
    setup([A, C], B);
    await user.click(screen.getByRole('button', { name: 'Record actions' }));
    await user.click(await screen.findByTestId('record-delete'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteNote).toHaveBeenCalledWith('/vault', B));
    await waitFor(() => expect(useUiStore.getState().detailPath).not.toBe(B));
    expect(useUiStore.getState().detailPath).not.toBe(A);
    expect(useUiStore.getState().detailPath).toBeNull();
  });

  it('keeps the record when the delete fails, and says so', async () => {
    const user = userEvent.setup();
    deleteNote.mockRejectedValueOnce(new Error('locked'));
    setup();
    await user.click(screen.getByRole('button', { name: 'Record actions' }));
    await user.click(await screen.findByTestId('record-delete'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
        "Couldn't delete this record",
      ),
    );
    expect(useUiStore.getState().detailPath).toBe(B);
  });
});

describe('detail sibling stepping', () => {
  afterEach(cleanup);

  it('is a no-op for a record the view is not showing', () => {
    useUiStore.setState({ detailPath: 'records/elsewhere.md', detailSiblings: [A, B] });
    useUiStore.getState().stepDetail(1);
    expect(useUiStore.getState().detailPath).toBe('records/elsewhere.md');
  });

  // The list is set from a render-time effect on every canvas render, so an
  // unchanged list must not produce a new array or the panel re-renders
  // forever.
  it('keeps the same array when the paths have not changed', () => {
    useUiStore.getState().setDetailSiblings([A, B]);
    const first = useUiStore.getState().detailSiblings;
    useUiStore.getState().setDetailSiblings([A, B]);
    expect(useUiStore.getState().detailSiblings).toBe(first);

    useUiStore.getState().setDetailSiblings([A, C]);
    expect(useUiStore.getState().detailSiblings).not.toBe(first);
  });
});
