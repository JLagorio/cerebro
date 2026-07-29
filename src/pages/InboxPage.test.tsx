// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORGANIZED_KEY } from '@/engine/inbox';
import type { Entry } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { InboxPage } from './InboxPage';

// The editor is a heavy BlockNote surface with its own async load — the
// Inbox's own behaviour (queue, checklist, organize) is what's under test.
vi.mock('@/editor/NoteBodyEditor', () => ({
  NoteBodyEditor: ({ path }: { path: string }) => <div data-testid="body-editor">{path}</div>,
}));

const TYPE_DOC = makeEntry({
  path: 'types/work-item.md',
  title: 'Work item',
  type: 'Type',
  // Nested YAML the way the Rust parser stores it — same cast the shared
  // fixture vault uses for type docs.
  properties: {
    fields: { status: { kind: 'status' } },
    statuses: [
      { id: 'todo', group: 'active' },
      { id: 'done', group: 'done' },
    ],
  } as unknown as Entry['properties'],
});

const capture = makeEntry({
  path: 'inbox/capture-a.md',
  title: 'Capture a',
  createdAt: '2026-07-27T09:00:00Z',
});
const older = makeEntry({
  path: 'inbox/capture-b.md',
  title: 'Capture b',
  createdAt: '2026-07-20T09:00:00Z',
});
const organized = makeEntry({
  path: 'records/risks/r-1.md',
  title: 'Scanner delivery',
  type: 'Risk',
  createdAt: '2026-07-26T09:00:00Z',
});

const patchFrontmatter = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  patchFrontmatter.mockClear();
  useVaultStore.setState({
    vaultPath: '/vault',
    entries: [TYPE_DOC, capture, older, organized],
    patchFrontmatter,
  });
  useNavStore.setState({ selection: { kind: 'inbox' }, history: [{ kind: 'inbox' }], historyIndex: 0 });
  // inboxSelectedPath is store state so the agent can open the capture its
  // proposal is about; that also means it outlives a render and has to be
  // cleared, or each test starts on whatever the last one left open.
  useUiStore.setState({
    inboxEnabled: true,
    inboxAutoAdvance: true,
    inboxPeriod: 'all',
    inboxSelectedPath: null,
  });
});

afterEach(cleanup);

describe('InboxPage', () => {
  it('queues only unorganized notes, newest first', () => {
    render(<InboxPage />);
    const rows = screen.getAllByTestId('inbox-row');
    expect(rows.map((r) => r.textContent)).toHaveLength(2);
    expect(rows[0].textContent).toContain('Capture a');
    expect(rows[1].textContent).toContain('Capture b');
    // The typed record is organized by default and must not appear.
    expect(screen.queryByText('Scanner delivery')).toBeNull();
  });

  it('opens the newest capture and shows its outstanding checks', () => {
    render(<InboxPage />);
    expect(screen.getByTestId('body-editor').textContent).toBe('inbox/capture-a.md');
    const checklist = screen.getByTestId('organize-checklist');
    expect(checklist.textContent).toContain('Has a type');
    expect(checklist.textContent).toContain('Connected to something');
  });

  it('writes _organized when the note is marked organized', async () => {
    const user = userEvent.setup();
    render(<InboxPage />);
    await user.click(screen.getByRole('button', { name: /mark organized/i }));
    expect(patchFrontmatter).toHaveBeenCalledWith('inbox/capture-a.md', { [ORGANIZED_KEY]: true });
  });

  it('organizes the open capture on Cmd+E', async () => {
    const user = userEvent.setup();
    render(<InboxPage />);
    await user.keyboard('{Meta>}e{/Meta}');
    await waitFor(() =>
      expect(patchFrontmatter).toHaveBeenCalledWith('inbox/capture-a.md', {
        [ORGANIZED_KEY]: true,
      }),
    );
  });

  it('assigns a type from the organize panel', async () => {
    const user = userEvent.setup();
    render(<InboxPage />);
    await user.selectOptions(screen.getByRole('combobox'), 'Work item');
    expect(patchFrontmatter).toHaveBeenCalledWith('inbox/capture-a.md', { type: 'Work item' });
  });

  it('keeps the note being organized in the queue after it gains a type', async () => {
    // Membership is derived (untyped ⇒ queued), so without pinning the note
    // would leave the list the instant a type was assigned — and the next
    // "Mark organized" would silently hit whichever note slid into its place.
    const user = userEvent.setup();
    const { rerender } = render(<InboxPage />);
    await user.selectOptions(screen.getByRole('combobox'), 'Work item');

    // Simulate the store settling after the write.
    useVaultStore.setState({
      entries: [TYPE_DOC, { ...capture, type: 'Work item' }, older, organized],
    });
    rerender(<InboxPage />);

    expect(screen.getAllByTestId('inbox-row')).toHaveLength(2);
    expect(screen.getByTestId('body-editor').textContent).toBe('inbox/capture-a.md');

    await user.click(screen.getByRole('button', { name: /mark organized/i }));
    expect(patchFrontmatter).toHaveBeenLastCalledWith('inbox/capture-a.md', {
      [ORGANIZED_KEY]: true,
    });
  });

  it('narrows the queue by period', async () => {
    // Pinned: the fixtures sit 1 and 8 days back from this instant, so the
    // week pill must drop exactly one of them. On the real clock the split
    // would drift and the assertion would rot.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-07-28T12:00:00Z'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    try {
      render(<InboxPage />);
      expect(screen.getAllByTestId('inbox-row')).toHaveLength(2);
      await user.click(screen.getByRole('tab', { name: /week/i }));
      expect(screen.getAllByTestId('inbox-row')).toHaveLength(1);
      expect(screen.getByTestId('inbox-row').textContent).toContain('Capture a');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads as Inbox zero when nothing is queued', () => {
    useVaultStore.setState({ entries: [TYPE_DOC, organized] });
    render(<InboxPage />);
    expect(screen.getByText('Inbox zero')).toBeTruthy();
    expect(screen.queryAllByTestId('inbox-row')).toHaveLength(0);
  });

  it('explains itself when the workflow is switched off', () => {
    useUiStore.setState({ inboxEnabled: false });
    render(<InboxPage />);
    expect(screen.getByText('Inbox workflow is off')).toBeTruthy();
    expect(screen.queryAllByTestId('inbox-row')).toHaveLength(0);
  });
});
