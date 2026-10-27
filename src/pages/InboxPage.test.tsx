import * as ingest from '@/lib/ingest';
import { navSeed } from '@/test/navSeed';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORGANIZED_KEY } from '@/engine/inbox';
import type { Entry } from '@/engine/types';
import { PaneContext, useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { sha256Hex } from '@/lib/sha256';
import { chooseOption, optionLabels } from '@/test/chooseOption';
import { makeEntry } from '@/test/factories';
import { InboxPage } from './InboxPage';

// The editor is a heavy BlockNote surface with its own async load — the
// Inbox's own behaviour (queue, organize) is what's under test.
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

const patchFrontmatter = vi.fn().mockResolvedValue(true);
// The real create, put back before each case, since the paste case stubs it.
const realCreateItem = useVaultStore.getState().createItem;

/** The capture's inspector: the panel's own acts are found inside it, since
 *  the toolbar carries a Mark organized of its own. */
const panel = () => screen.getByTestId('doc-side-panel');

/** The Type row's value: the design system's select, a listbox button. */
const typeTrigger = () => within(panel()).getByRole('button', { name: 'Type' });

// The toolbar's Details button hides the inspector the way a page's does: the
// panel unmounts, the capture's editor stays the same instance, and neither
// direction writes anything.
it('hiding the panel keeps the capture editor in place and writes nothing', async () => {
  render(<InboxPage />);
  const editor = await screen.findByTestId('body-editor');
  expect(typeTrigger().getAttribute('aria-haspopup')).toBe('listbox');
  const details = screen.getByRole('button', { name: 'Details' });
  expect(details.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(details);
  expect(screen.queryByTestId('doc-side-panel')).toBeNull();
  expect(screen.getByTestId('body-editor')).toBe(editor);
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(typeTrigger().getAttribute('aria-haspopup')).toBe('listbox');
  expect(screen.getByTestId('body-editor')).toBe(editor);
  expect(patchFrontmatter).not.toHaveBeenCalled();
});

beforeEach(() => {
  patchFrontmatter.mockClear();
  useVaultStore.setState({
    vaultPath: '/vault',
    entries: [TYPE_DOC, capture, older, organized],
    entriesVault: null,
    patchFrontmatter,
    createItem: realCreateItem,
  });
  useNavStore.setState({
    selection: { kind: 'inbox' },
    history: [navSeed({ kind: 'inbox' })],
    historyIndex: 0,
  });
  // inboxSelectedPath is store state so the agent can open the capture its
  // proposal is about; that also means it outlives a render and has to be
  // cleared, or each test starts on whatever the last one left open.
  useUiStore.setState({
    inboxEnabled: true,
    inboxAutoAdvance: true,
    inboxSelectedPath: null,
    // The inspector's folds and the Inbox's panel are shared store state too:
    // a case that folds Organize must not hand the next one a folded section.
    inboxPanel: 'details',
    inspectorCollapsed: [],
  });
});

afterEach(cleanup);

describe('InboxPage', () => {
  it('walks with j/k, selects with x, and Escape keeps the capture before Enter opens its page', () => {
    render(<InboxPage />);
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(screen.getByTestId('body-editor').textContent).toBe(older.path);
    fireEvent.keyDown(document.activeElement!, { key: 'k' });
    expect(screen.getByTestId('body-editor').textContent).toBe(capture.path);
    fireEvent.keyDown(document.activeElement!, { key: 'x' });
    expect(screen.getByTestId('list-selection').textContent).toContain('1 selected');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByTestId('list-selection')).toBeNull();
    expect(screen.getByTestId('body-editor').textContent).toBe(capture.path);
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: capture.path });
  });

  it('queues only unorganized notes, newest first', () => {
    render(<InboxPage />);
    const rows = screen.getAllByTestId('inbox-row');
    expect(rows.map((r) => r.textContent)).toHaveLength(2);
    expect(rows[0].textContent).toContain('Capture a');
    expect(rows[1].textContent).toContain('Capture b');
    // The typed record is organized by default and must not appear.
    expect(screen.queryByText('Scanner delivery')).toBeNull();
  });

  // Organize is the type and its fields, then the acts: no checklist grades
  // the capture first (owner, 2026-10-19).
  it('opens the newest capture, with no checklist in Organize', () => {
    render(<InboxPage />);
    expect(screen.getByTestId('body-editor').textContent).toBe('inbox/capture-a.md');
    expect(within(panel()).queryByText('Checklist')).toBeNull();
    expect(within(panel()).queryByText('Has a type')).toBeNull();
  });

  // M52.3 — one name per act: the button, and the bubble it leaves, say what
  // was pressed and about which capture — never the prompt behind it.
  it('asks the Assistant to file it by the same name it wears', async () => {
    const user = userEvent.setup();
    useUiStore.setState({ handoffs: [] });
    render(<InboxPage />);
    // The inspector's Knowledge section keeps the one Learn button, by the
    // one name — Organize no longer carries a second.
    expect(screen.getByRole('button', { name: 'Learn from this page' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Ask the Assistant to file it' }));
    const pending = useUiStore.getState().handoffs.at(-1);
    expect(pending?.label).toBe('Ask the Assistant to file it · Capture a');
    expect(pending?.subject).toBe('inbox/capture-a.md');
    expect(pending?.text).toContain('propose_organize');
  });

  // M91.14 — the fetch is a Suggestion too: its counted label is the row and
  // the bubble, and the prompt it sends names what to fetch.
  it('offers the fetch of an uncached reference by its label, and sends its prompt', async () => {
    const user = userEvent.setup();
    const linked = {
      ...capture,
      snippet: 'See https://linear.app/acme/issue/ENG-142/fix-login for the bug.',
    };
    useVaultStore.setState({ entries: [TYPE_DOC, linked, older] });
    useUiStore.setState({ handoffs: [], agentConnectors: true });
    try {
      render(<InboxPage />);
      const acts = within(panel()).getByRole('group', { name: 'File this capture' });
      const fetch = within(acts).getByRole('button', { name: 'Fetch 1 reference' });
      expect(fetch.dataset.slot).toBe('suggestion');
      await user.click(fetch);
      const pending = useUiStore.getState().handoffs.at(-1);
      expect(pending?.label).toBe('Fetch 1 reference · Capture a');
      expect(pending?.subject).toBe('inbox/capture-a.md');
      expect(pending?.text).toContain('The note at inbox/capture-a.md refers to');
      expect(pending?.text).toContain('cache_source');
    } finally {
      useUiStore.setState({ agentConnectors: false });
    }
  });

  // M64.7 — a transcript gets the meeting ask, its speakers as matched now.
  it('sends the meeting ask for a transcript, and the plain ask otherwise', async () => {
    const user = userEvent.setup();
    const person = makeEntry({
      path: 'people/marcus-webb.md',
      title: 'Marcus Webb',
      type: 'Person',
    });
    const personType = makeEntry({ path: 'types/person.md', title: 'Person', type: 'Type' });
    const standup = makeEntry({
      path: 'inbox/standup.md',
      title: 'Standup',
      createdAt: '2026-07-28T09:00:00Z',
      properties: { ingest_format: 'vtt', speakers: ['Marcus Webb', 'Jo Nobody'] },
    });
    useVaultStore.setState({ entries: [TYPE_DOC, personType, person, standup, capture] });
    useUiStore.setState({ handoffs: [] });
    render(<InboxPage />);
    await user.click(screen.getByRole('button', { name: 'Ask the Assistant to file it' }));
    const meeting = useUiStore.getState().handoffs.at(-1);
    expect(meeting?.subject).toBe('inbox/standup.md');
    expect(meeting?.text).toContain('File the meeting transcript at inbox/standup.md ("Standup").');
    expect(meeting?.text).toContain('- "Marcus Webb" is [[marcus-webb]]');
    expect(meeting?.text).toContain('- "Jo Nobody" has no page here');
    expect(screen.getAllByTestId('speaker-row').map((r) => r.dataset.match)).toEqual([
      'matched',
      'none',
    ]);

    await user.click(screen.getByRole('option', { name: /Capture a/ }));
    await user.click(screen.getByRole('button', { name: 'Ask the Assistant to file it' }));
    expect(useUiStore.getState().handoffs.at(-1)?.text).toBe(
      'Look at the Inbox capture at inbox/capture-a.md and propose how to file it. Use propose_organize.',
    );
    expect(screen.queryByTestId('transcript-speakers')).toBeNull();
  });

  it('names the filed copy when the same text is pasted again, and writes nothing', async () => {
    const text = 'The rollback is written down, not rehearsed, and nobody owns it. '.repeat(5);
    const filed = makeEntry({
      path: 'records/notes/rollback.md',
      title: 'Rollback is not rehearsed',
      type: 'Risk',
      properties: { source_sha256: sha256Hex(text) },
    });
    const createItem = vi.fn();
    useVaultStore.setState({
      entries: [TYPE_DOC, capture, older, filed],
      entriesVault: '/vault',
      createItem,
    });
    useUiStore.setState({ toasts: [] });
    render(<InboxPage />);
    fireEvent.paste(screen.getByTestId('inbox-page'), {
      clipboardData: { getData: () => text },
    });
    await waitFor(() =>
      expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([
        'Already filed as Rollback is not rehearsed',
      ]),
    );
    expect(createItem).not.toHaveBeenCalled();
    expect(useUiStore.getState().inboxSelectedPath).not.toBe('records/notes/rollback.md');
  });

  it('writes _organized when the note is marked organized', async () => {
    const user = userEvent.setup();
    render(<InboxPage />);
    await user.click(within(panel()).getByRole('button', { name: 'Mark organized' }));
    expect(patchFrontmatter).toHaveBeenCalledWith('inbox/capture-a.md', { [ORGANIZED_KEY]: true });
    await screen.findByTestId('inbox-undo');
  });

  // The act the Inbox exists for sits in its toolbar too, before the star,
  // as Tolaria's breadcrumb bar carries it: one press, its keys in the tip.
  it('files the open capture from the toolbar, with its keys in the tooltip', async () => {
    const user = userEvent.setup();
    render(<InboxPage />);
    const header = screen.getByTestId('inbox-pane-header');
    const names = within(header)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(names.indexOf('Mark organized')).toBe(names.indexOf('Add to favorites') - 1);
    const file = within(header).getByRole('button', { name: 'Mark organized' });
    fireEvent.focus(file);
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain('Mark organized');
    expect(tip.querySelector('[data-keys]')?.getAttribute('data-keys')).toBe('mod+e');
    await user.click(file);
    expect(patchFrontmatter).toHaveBeenCalledWith('inbox/capture-a.md', { [ORGANIZED_KEY]: true });
    expect((await screen.findByTestId('inbox-undo')).textContent).toContain('Capture a');
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
    await screen.findByTestId('inbox-undo');
  });

  it('leaves Cmd+E alone while the caret is in a text field', async () => {
    // Ctrl+E is end-of-line in every editable on this screen — the capture
    // body sits right beside the list — and filing is not undoable from the
    // keyboard, so the binding must not fire from inside one.
    const user = userEvent.setup();
    render(<InboxPage />);
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();
    try {
      await user.keyboard('{Control>}e{/Control}');
      await user.keyboard('{Meta>}e{/Meta}');
      expect(patchFrontmatter).not.toHaveBeenCalled();
      // Not prevented either: ⌃E stays end-of-line in the field (M65.1).
      expect(fireEvent.keyDown(field, { key: 'e', metaKey: true })).toBe(true);
    } finally {
      field.remove();
    }
  });

  it('leaves Cmd+E alone, unprevented, with no capture open', () => {
    useVaultStore.setState({ entries: [TYPE_DOC, organized] });
    render(<InboxPage />);
    expect(fireEvent.keyDown(document.body, { key: 'e', metaKey: true })).toBe(true);
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });

  it('offers an undo after filing, and it returns the note to the queue', async () => {
    const user = userEvent.setup();
    render(<InboxPage />);
    await user.click(within(panel()).getByRole('button', { name: 'Mark organized' }));
    const undo = await screen.findByTestId('inbox-undo');
    expect(undo.textContent).toContain('Capture a');
    // On a line of its own over the page, which opens and closes as it
    // comes and goes (inbox.css), never drawn over what the page shows.
    expect(undo.parentElement?.classList.contains('m75-inbox-notices')).toBe(true);
    expect(screen.getByTestId('body-editor').textContent).toBe('inbox/capture-b.md');
    await user.click(screen.getByRole('button', { name: /^undo$/i }));
    expect(patchFrontmatter).toHaveBeenLastCalledWith('inbox/capture-a.md', {
      [ORGANIZED_KEY]: false,
    });
    expect(screen.queryByTestId('inbox-undo')).toBeNull();
    // It comes back as the open capture, its row holding focus.
    expect(screen.getByTestId('body-editor').textContent).toBe('inbox/capture-a.md');
    expect(document.activeElement?.getAttribute('data-path')).toBe('inbox/capture-a.md');
  });

  it('offers no way back from a filing that did not land', async () => {
    patchFrontmatter.mockResolvedValueOnce(false);
    const user = userEvent.setup();
    render(<InboxPage />);
    await user.click(within(panel()).getByRole('button', { name: 'Mark organized' }));
    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('inbox-undo')).toBeNull();
  });

  it('walks the queue with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<InboxPage />);
    const rows = screen.getAllByTestId('inbox-row');
    // Roving tabindex: only the open capture is a tab stop.
    expect(rows[0].getAttribute('tabindex')).toBe('0');
    expect(rows[1].getAttribute('tabindex')).toBe('-1');
    rows[0].focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('body-editor').textContent).toBe('inbox/capture-b.md');
    expect(document.activeElement).toBe(screen.getAllByTestId('inbox-row')[1]);
    await user.keyboard('{Home}');
    expect(screen.getByTestId('body-editor').textContent).toBe('inbox/capture-a.md');
  });

  it('names the Type control', () => {
    render(<InboxPage />);
    expect(screen.getByLabelText('Type')).toBe(typeTrigger());
  });

  it('names the capture in the reading pane', () => {
    render(<InboxPage />);
    const header = screen.getByTestId('inbox-pane-header');
    expect(header.textContent).toContain('Capture a');
    expect(header.textContent).toContain('1 of 2');
  });

  it('walks the queue from the toolbar pager', async () => {
    const user = userEvent.setup();
    render(<InboxPage />);
    const header = screen.getByTestId('inbox-pane-header');
    const previous = within(header).getByRole('button', { name: 'Previous capture' });
    const next = within(header).getByRole('button', { name: 'Next capture' });
    expect(previous).toHaveProperty('disabled', true);
    await user.click(next);
    expect(screen.getByTestId('body-editor').textContent).toBe(older.path);
    expect(header.textContent).toContain('2 of 2');
    expect(next).toHaveProperty('disabled', true);
    await user.click(previous);
    expect(screen.getByTestId('body-editor').textContent).toBe(capture.path);
  });

  it('keeps the filed note in place when auto-advance is off', async () => {
    // Turning the setting off used to throw you to the TOP of the queue on
    // every file — the filed note stopped matching and the resolver fell
    // through to entries[0].
    useUiStore.setState({ inboxAutoAdvance: false });
    const user = userEvent.setup();
    render(<InboxPage />);
    await user.click(screen.getAllByTestId('inbox-row')[1]);
    expect(screen.getByTestId('body-editor').textContent).toBe('inbox/capture-b.md');
    await user.click(within(panel()).getByRole('button', { name: 'Mark organized' }));
    await screen.findByTestId('inbox-undo');
    expect(screen.getByTestId('body-editor').textContent).toBe('inbox/capture-b.md');
  });

  // The period pills are gone: the queue is every capture still waiting,
  // however old, and nothing on the page narrows it.
  it('lists every capture however old, with no period to narrow it', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Far enough out that both fixtures are older than a week and a month.
    vi.setSystemTime(new Date('2026-09-01T12:00:00Z'));
    try {
      render(<InboxPage />);
      expect(screen.getAllByTestId('inbox-row')).toHaveLength(2);
      expect(screen.queryByRole('tablist', { name: 'Capture period' })).toBeNull();
      expect(screen.queryByRole('tab', { name: /week|month/i })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // The page's highest heading is the capture's own title, which the body's
  // H1 projects (the editor is mocked here); the Inbox itself is the first
  // crumb of the toolbar every page shares, never a heading block of its own.
  it('names the Inbox in its toolbar, and every row carries a full-title tooltip', () => {
    render(<InboxPage />);
    const header = screen.getByTestId('inbox-pane-header');
    expect(header.className).toBe('cb-document-toolbar');
    expect(header.querySelector('.cb-document-breadcrumbs')?.textContent).toBe('InboxCapture a');
    expect(screen.queryByRole('heading', { name: 'Inbox' })).toBeNull();
    expect(screen.queryByText('Capture now. Make sense of it when you’re ready.')).toBeNull();
    const titled = screen
      .getAllByTestId('inbox-row')
      .map((r) => r.querySelector('span[title]')?.getAttribute('title'));
    expect(titled).toContain('Capture a');
  });

  // The page's projected title falls back to the filename, and so does the
  // queue's row: the crumb names it the same way, never a third name.
  it('names a capture with no title of its own by its filename in the toolbar', () => {
    const stamped = makeEntry({
      path: 'inbox/capture-2026-07-28-0914.md',
      title: 'Capture 2026 07 28 0914',
      createdAt: '2026-07-28T09:14:00Z',
    });
    useVaultStore.setState({ entries: [TYPE_DOC, stamped, capture] });
    render(<InboxPage />);
    const header = screen.getByTestId('inbox-pane-header');
    expect(header.textContent).toContain('Capture 2026 07 28 0914');
    expect(header.textContent).not.toContain('Untitled capture');
  });

  // The list is the queue and nothing else: no heading block, no count, no
  // period pills above the rows — the sidebar's own "Inbox" heading names it.
  it('lists the captures as rows alone, each with its date the short way', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-07-28T12:00:00Z'));
    try {
      useVaultStore.setState({
        entries: [
          TYPE_DOC,
          makeEntry({ path: 'inbox/a.md', title: 'Today one', createdAt: '2026-07-28T12:00:00Z' }),
          makeEntry({
            path: 'inbox/b.md',
            title: 'Yesterday one',
            createdAt: '2026-07-27T12:00:00Z',
          }),
          makeEntry({ path: 'inbox/c.md', title: 'Last week', createdAt: '2026-07-20T12:00:00Z' }),
          makeEntry({ path: 'inbox/d.md', title: 'Last year', createdAt: '2025-12-01T12:00:00Z' }),
        ],
      });
      render(<InboxPage />);
      const list = screen.getByRole('listbox', { name: 'Captures' });
      expect(list.previousElementSibling).toBeNull();
      expect(screen.queryByText('Captures')).toBeNull();
      const days = screen
        .getAllByTestId('inbox-row')
        .map((row) => row.querySelector('.m75-capture-row-meta')?.firstElementChild?.textContent);
      expect(days).toEqual(['Today', 'Yesterday', 'Jul 20', 'Dec 1, 2025']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('files the open capture from Capture options, with the same undo', async () => {
    const user = userEvent.setup();
    render(<InboxPage />);
    await user.click(screen.getByRole('button', { name: 'Capture options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Mark organized' }));
    expect(patchFrontmatter).toHaveBeenCalledWith('inbox/capture-a.md', { [ORGANIZED_KEY]: true });
    expect((await screen.findByTestId('inbox-undo')).textContent).toContain('Capture a');
  });

  it('opens the open capture as a page from Capture options', async () => {
    const user = userEvent.setup();
    render(<InboxPage />);
    await user.click(screen.getAllByTestId('inbox-row')[1]);
    await user.click(screen.getByRole('button', { name: 'Capture options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Open as page' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: older.path });
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });

  // The inspector is the page inspector, in the Inbox's own slot: choosing a
  // panel here never moves the panel a document page left open.
  it('keeps its inspector panel apart from the pages one', async () => {
    const user = userEvent.setup();
    useUiStore.setState({ docPanel: 'history' });
    render(<InboxPage />);
    const panel = screen.getByTestId('doc-side-panel');
    expect(panel.getAttribute('aria-label')).toBe('Capture panel');
    expect(panel.dataset.panel).toBe('details');
    expect(screen.getByRole('button', { name: 'Details' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // Organize leads Details, in place of the generic Properties section.
    const sections = [...panel.querySelectorAll('[data-section]')].map(
      (s) => (s as HTMLElement).dataset.section,
    );
    expect(sections[0]).toBe('organize');
    expect(sections).not.toContain('properties');
    await user.click(screen.getByRole('button', { name: 'Comments' }));
    expect(useUiStore.getState().inboxPanel).toBe('comments');
    expect(screen.getByTestId('doc-side-panel').dataset.panel).toBe('comments');
    expect(screen.getByTestId('doc-side-panel').getAttribute('aria-label')).toBe('Comments');
    expect(useUiStore.getState().docPanel).toBe('history');
  });

  it('assigns a type from the organize panel', () => {
    render(<InboxPage />);
    chooseOption(typeTrigger(), 'Work item');
    expect(patchFrontmatter).toHaveBeenCalledWith('inbox/capture-a.md', { type: 'Work item' });
  });

  // No native select draws anywhere (owner, 2026-10-18): the Type value is
  // the design system's ghost select, in the property row its fields use.
  it('draws the Type row as a property row holding the ghost select', () => {
    render(<InboxPage />);
    expect(document.querySelector('select')).toBeNull();
    const row = typeTrigger().closest<HTMLElement>('[data-testid="property-row"]');
    expect(row?.dataset.property).toBe('Type');
    expect(row?.querySelector('[data-icon="shapes"]')).toBeTruthy();
    expect(typeTrigger().closest('.cb-select')?.classList.contains('cb-select-ghost')).toBe(true);
    // Untyped, "No type" is a muted placeholder, and the list holds the types.
    expect(typeTrigger().getAttribute('data-value')).toBe('');
    expect(typeTrigger().querySelector('.cb-select-placeholder')?.textContent).toBe('No type');
    expect(optionLabels(typeTrigger())).toEqual(['Work item']);
  });

  // The vault's types are many: the list opens on a search over them, each
  // type drawn in its own colour.
  it('searches the Type list, each type in its own colour', () => {
    const keyResult = makeEntry({
      path: 'types/key-result.md',
      title: 'Key result',
      type: 'Type',
      properties: { icon: 'target', color: 'rgb(31, 157, 97)' },
    });
    useVaultStore.setState({ entries: [TYPE_DOC, keyResult, capture, older, organized] });
    render(<InboxPage />);
    fireEvent.click(typeTrigger());
    const search = screen.getByRole('combobox', { name: 'Type' });
    expect(document.activeElement).toBe(search);
    const icon = screen
      .getByRole('option', { name: 'Key result' })
      .querySelector<SVGElement>('[data-icon="target"]');
    expect(icon?.style.color).toBe('rgb(31, 157, 97)');
    fireEvent.change(search, { target: { value: 'work' } });
    expect(optionLabels(typeTrigger())).toEqual(['Work item']);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(patchFrontmatter).toHaveBeenCalledWith('inbox/capture-a.md', { type: 'Work item' });
  });

  it('offers No type first once the capture is typed, and clears the type with it', () => {
    useVaultStore.setState({
      entries: [
        TYPE_DOC,
        { ...capture, type: 'Work item', properties: { [ORGANIZED_KEY]: false } },
        older,
      ],
    });
    render(<InboxPage />);
    expect(typeTrigger().getAttribute('data-value')).toBe('Work item');
    expect(optionLabels(typeTrigger())).toEqual(['No type', 'Work item']);
    chooseOption(typeTrigger(), 'No type');
    expect(patchFrontmatter).toHaveBeenCalledWith('inbox/capture-a.md', { type: null });
  });

  // A type no Type doc declares still names itself, rather than reading as
  // "No type" on a capture that has one.
  it('names a held type no Type doc declares', () => {
    useVaultStore.setState({
      entries: [
        TYPE_DOC,
        { ...capture, type: 'Meeting', properties: { [ORGANIZED_KEY]: false } },
        older,
      ],
    });
    render(<InboxPage />);
    expect(typeTrigger().textContent).toBe('Meeting');
    expect(optionLabels(typeTrigger())).toContain('Meeting');
  });

  // The acts are rows, not a stack of outlined buttons: Mark organized wears
  // its keys, which stay out of its name, and nothing says them in prose.
  it('draws the acts as rows, with the keys riding Mark organized', () => {
    render(<InboxPage />);
    const acts = within(panel()).getByRole('group', { name: 'File this capture' });
    expect(
      within(acts)
        .getAllByRole('button')
        .map((b) => b.textContent?.trim()),
    ).toEqual(['Ask the Assistant to file it', expect.stringMatching(/^Mark organized/)]);
    // M91.14 — the ask is a Suggestion in the act row's voice.
    const ask = within(acts).getByRole('button', { name: 'Ask the Assistant to file it' });
    expect(ask.dataset.slot).toBe('suggestion');
    expect(ask.dataset.tone).toBe('ai');
    const file = within(acts).getByRole('button', { name: 'Mark organized' });
    expect(file.dataset.tone).toBe('primary');
    expect(file.querySelector('[aria-hidden="true"] [data-keys]')?.getAttribute('data-keys')).toBe(
      'mod+e',
    );
    expect(within(panel()).queryByText(/removes it from the Inbox/i)).toBeNull();
  });

  it('keeps the note being organized in the queue after it gains a type', async () => {
    // Membership is derived (untyped ⇒ queued), so without pinning the note
    // would leave the list the instant a type was assigned — and the next
    // "Mark organized" would silently hit whichever note slid into its place.
    const user = userEvent.setup();
    const { rerender } = render(<InboxPage />);
    chooseOption(typeTrigger(), 'Work item');

    // Simulate the store settling after the write.
    useVaultStore.setState({
      entries: [TYPE_DOC, { ...capture, type: 'Work item' }, older, organized],
    });
    rerender(<InboxPage />);

    expect(screen.getAllByTestId('inbox-row')).toHaveLength(2);
    expect(screen.getByTestId('body-editor').textContent).toBe('inbox/capture-a.md');

    await user.click(within(panel()).getByRole('button', { name: 'Mark organized' }));
    expect(patchFrontmatter).toHaveBeenLastCalledWith('inbox/capture-a.md', {
      [ORGANIZED_KEY]: true,
    });
    await screen.findByTestId('inbox-undo');
  });

  // M45.1 — the Organize section of the capture's inspector is a
  // RecordProperties HOST, so a laid-out
  // type's heading fields must render in a strip here too. The whole-slice
  // review found them rendering NOWHERE on Inbox: the strip-owning hosts
  // excluded them from the stack, and this host mounted only the stack.
  describe('heading strip (M45.1)', () => {
    const LAID_OUT_TYPE = makeEntry({
      path: 'types/work-item.md',
      title: 'Work item',
      type: 'Type',
      properties: {
        fields: {
          status: { kind: 'status' },
          priority: { kind: 'select', options: [{ id: 'high' }, { id: 'low' }] },
        },
        statuses: [
          { id: 'todo', group: 'active' },
          { id: 'done', group: 'done' },
        ],
        layout: { heading: ['status'] },
      } as unknown as Entry['properties'],
    });
    // Typed, but pinned in the queue the way the real flow pins it: an
    // explicit `_organized: false` (the undo write) outranks having a type.
    const typedCapture = makeEntry({
      path: 'inbox/capture-a.md',
      title: 'Capture a',
      type: 'Work item',
      properties: { [ORGANIZED_KEY]: false, status: 'todo' },
      createdAt: '2026-07-27T09:00:00Z',
    });

    it('renders the heading strip; the stack rides the expander and omits heading fields', async () => {
      const user = userEvent.setup();
      useVaultStore.setState({ entries: [LAID_OUT_TYPE, typedCapture, older] });
      render(<InboxPage />);
      const strip = screen.getByTestId('heading-strip');
      expect(strip.querySelector('[data-field="status"]')).toBeTruthy();
      // The stack starts collapsed behind the strip, like the record surfaces.
      expect(screen.queryByRole('button', { name: 'Add property' })).toBeNull();
      await user.click(screen.getByTestId('view-details-toggle'));
      expect(screen.getByRole('button', { name: 'Add property' })).toBeTruthy();
      // Heading-claimed fields live in the strip, not the stack.
      const rows = screen
        .getAllByTestId('property-row')
        .map((r) => r.getAttribute('data-property'));
      expect(rows).toContain('priority');
      expect(rows).not.toContain('status');
    });

    // The Task 5 ruling's trap, on this host too: a heading whose one field
    // is empty under hide_when_empty folds the strip to NOTHING — the stack
    // must render despite the expander never being touched.
    it('a strip that folds to nothing shows the stack untoggled', () => {
      // A fresh type doc, not a mutated copy of LAID_OUT_TYPE — makeEntry
      // shares the properties object, and cross-test pollution through it is
      // exactly the kind of pass-for-the-wrong-reason this suite avoids.
      const foldingType = makeEntry({
        path: 'types/work-item.md',
        title: 'Work item',
        type: 'Type',
        properties: {
          fields: {
            status: { kind: 'status' },
            due: { kind: 'date', visibility: 'hide_when_empty' },
          },
          statuses: [{ id: 'todo', group: 'active' }],
          layout: { heading: ['due'] },
        } as unknown as Entry['properties'],
      });
      useVaultStore.setState({ entries: [foldingType, typedCapture, older] });
      render(<InboxPage />);
      expect(screen.queryByTestId('heading-strip')).toBeNull();
      expect(screen.queryByTestId('view-details-toggle')).toBeNull();
      expect(screen.getByRole('button', { name: 'Add property' })).toBeTruthy();
    });

    it('an un-laid-out type keeps the stack as the whole form', () => {
      useVaultStore.setState({
        entries: [TYPE_DOC, { ...typedCapture, properties: { [ORGANIZED_KEY]: false } }, older],
      });
      render(<InboxPage />);
      expect(screen.queryByTestId('heading-strip')).toBeNull();
      expect(screen.getByRole('button', { name: 'Add property' })).toBeTruthy();
    });
  });

  it('reads as Inbox zero when nothing is queued', () => {
    useVaultStore.setState({ entries: [TYPE_DOC, organized] });
    render(<InboxPage />);
    expect(screen.getByText('Inbox zero')).toBeTruthy();
    expect(screen.queryAllByTestId('inbox-row')).toHaveLength(0);
    // With nothing open the toolbar keeps only the ways to add one.
    const header = screen.getByTestId('inbox-pane-header');
    expect(header.querySelector('.cb-document-breadcrumbs')?.textContent).toBe('Inbox');
    expect(
      within(header)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Add files', 'New capture']);
    expect(screen.queryByTestId('doc-side-panel')).toBeNull();
  });

  it('explains itself when the workflow is switched off', () => {
    useUiStore.setState({ inboxEnabled: false });
    render(<InboxPage />);
    expect(screen.getByText('Inbox workflow is off')).toBeTruthy();
    expect(screen.queryAllByTestId('inbox-row')).toHaveLength(0);
  });
});

it('offers Show instead of a second editor for a capture held in another pane (M65.8)', () => {
  useNavStore.getState().reset();
  useNavStore.getState().setPaneCapacity(4);
  const inbox = useNavStore.getState().active;
  useNavStore.getState().navigate({ kind: 'inbox' });
  const other = useNavStore.getState().openPane({ kind: 'doc', path: capture.path }).pane;
  const mounted = render(
    <PaneContext value={inbox}>
      <InboxPage />
    </PaneContext>,
  );
  expect(screen.getByTestId('inbox-held-editor').textContent).toContain('Open in another pane');
  expect(screen.queryByTestId('body-editor')).toBeNull();
  act(() => useNavStore.getState().focusPane(inbox));
  fireEvent.click(screen.getByRole('button', { name: 'Show' }));
  expect(useNavStore.getState().active).toBe(other);
  act(() => useNavStore.getState().closePane(other));
  expect(screen.getByTestId('body-editor').textContent).toBe(capture.path);
  mounted.unmount();
  useNavStore.getState().reset();
});

it('queues local calendar previews without capturing them, then Cancel opens the next', async () => {
  render(<InboxPage />);
  const input = screen.getByTestId('inbox-page').querySelector('input[type="file"]')!;
  const bytes = new TextEncoder().encode('BEGIN:VCALENDAR\nEND:VCALENDAR');
  fireEvent.change(input, {
    target: {
      files: ['one.ics', 'two.ics'].map((name) => ({
        name,
        size: bytes.length,
        arrayBuffer: async () => bytes.buffer,
      })),
    },
  });
  await screen.findByText('one.ics');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await screen.findByText('two.ics');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByTestId('ics-import-dialog')).toBeNull());
});

it('offers document kinds and names the documents still being read', async () => {
  let finish!: (result: ingest.IngestResult) => void;
  const read = vi.spyOn(ingest, 'ingestFiles').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    render(<InboxPage />);
    const input = screen
      .getByTestId('inbox-page')
      .querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toContain('.docx');
    expect(input.accept).toContain('.pdf');
    expect(input.accept).toContain('.ics');
    const file = new File(['bytes'], 'Plan.docx');
    fireEvent.change(input, { target: { files: [file] } });
    // One document is one document, and the words say they are working.
    const status = screen.getByText('Reading 1 document…').closest('[role="status"]');
    if (!(status instanceof HTMLElement))
      throw new Error('Reading document notice is not a status');
    expect(status.textContent).toBe('Reading 1 document…');
    expect(status.querySelector('.cb-working-text')?.textContent).toBe('Reading 1 document…');
    // It floats over the page with the other notices, moving nothing.
    expect(status.parentElement?.classList.contains('m75-inbox-notices')).toBe(true);
    expect(read).toHaveBeenCalledWith([file], expect.any(Function), expect.any(Function));
    await act(async () => finish({ paths: [], duplicates: [], skipped: [] }));
    expect(screen.queryByText('Reading 1 document…')).toBeNull();
  } finally {
    read.mockRestore();
  }
});

// An agent's filing proposal is the card the assistant tells the person to
// answer in the Inbox: a panel or a fold left over from before must not hide it.
it('brings an agent filing proposal into view whatever panel or fold was left', async () => {
  useUiStore.setState({ inboxPanel: 'comments', inspectorCollapsed: ['organize'] });
  try {
    render(<InboxPage />);
    await screen.findByTestId('body-editor');
    act(() =>
      useUiStore.setState({
        proposals: {
          [capture.path]: { path: capture.path, type: 'Work item', reasoning: 'Reads as a task' },
        },
      }),
    );
    expect(useUiStore.getState().inboxPanel).toBe('details');
    expect(useUiStore.getState().inspectorCollapsed).not.toContain('organize');
    const card = await screen.findByTestId('proposal-card');
    expect(card.closest('[hidden]')).toBeNull();
  } finally {
    act(() => useUiStore.setState({ proposals: {} }));
  }
});

// A version opened from the inspector's History reads in place of the
// editor, as on a page, and moving to another capture closes that lens.
it('reads a version in place of the editor and closes it on the next capture', async () => {
  try {
    render(<InboxPage />);
    await screen.findByTestId('body-editor');
    act(() => useUiStore.setState({ diffView: { path: capture.path, commit: null } }));
    expect(screen.getByTestId('inline-diff')).toBeTruthy();
    expect(screen.queryByTestId('body-editor')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next capture' }));
    await waitFor(() => expect(useUiStore.getState().diffView).toBeNull());
    expect(screen.getByTestId('body-editor').textContent).toBe(older.path);
  } finally {
    act(() => useUiStore.setState({ diffView: null }));
  }
});

/** The store's own way with a frontmatter patch: it lands in `entries` at
 *  once, and the write behind it is still pending. */
function patchOptimistically(path: string, patch: Entry['properties']) {
  useVaultStore.setState((s) => ({
    entries: s.entries.map((e) =>
      e.path === path ? { ...e, properties: { ...e.properties, ...patch } } : e,
    ),
  }));
  return new Promise<boolean>(() => undefined);
}

const third = makeEntry({
  path: 'inbox/capture-c.md',
  title: 'Capture c',
  createdAt: '2026-07-10T09:00:00Z',
});

// Filing advances in the commit whose optimistic patch takes the capture
// out of the queue: steered after the write instead, the selection fell
// back to the head for as long as the write took, and the reader and the
// keyboard went there first.
it('opens the next capture, keys and all, in the commit that files the open one', async () => {
  useVaultStore.setState({ entries: [TYPE_DOC, capture, older, third, organized] });
  patchFrontmatter.mockImplementationOnce(patchOptimistically);
  const user = userEvent.setup();
  render(<InboxPage />);
  await user.click(screen.getAllByTestId('inbox-row')[1]);
  expect(screen.getByTestId('body-editor').textContent).toBe(older.path);
  await user.keyboard('{Meta>}e{/Meta}');
  const rows = screen.getAllByTestId('inbox-row');
  expect(rows.map((row) => row.dataset.path)).toEqual([capture.path, third.path]);
  expect(screen.getByTestId('body-editor').textContent).toBe(third.path);
  await waitFor(() => expect(document.activeElement).toBe(rows[1]));
  expect(patchFrontmatter).toHaveBeenCalledWith(older.path, { [ORGANIZED_KEY]: true });
});

// Walking the queue fades each capture into the reader as a page fades into
// its column (pageFrame.css): the fade's two names alternate, so it plays
// again over the same reader, which keeps its focus and opens at the top.
it('fades each capture in over the same reader, at its top', async () => {
  const user = userEvent.setup();
  render(<InboxPage />);
  const reader = screen.getByTestId('capture-reader');
  expect(reader.dataset.pageTurn).toBe('a');
  reader.scrollTop = 120;
  await user.click(screen.getByRole('button', { name: 'Next capture' }));
  expect(screen.getByTestId('body-editor').textContent).toBe(older.path);
  expect(screen.getByTestId('capture-reader')).toBe(reader);
  expect(reader.dataset.pageTurn).toBe('b');
  expect(reader.scrollTop).toBe(0);
  await user.click(screen.getByRole('button', { name: 'Previous capture' }));
  expect(reader.dataset.pageTurn).toBe('a');
});

/**
 * The queue where motion plays (QueueMotion). jsdom has no Web Animations,
 * so every case above sees rows change in the commit that changed them; these
 * hand every element a stand-in for the animation its CSS would start, whose
 * end the case decides (as components/ui/motion.test.tsx does).
 */
describe('the queue in motion', () => {
  let end: () => Promise<void> = async () => undefined;

  beforeEach(() => {
    let release: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const animation = {
      playState: 'running',
      finished,
      finish: () => undefined,
      effect: { getComputedTiming: () => ({ iterations: 1 }) },
    } as unknown as Animation;
    Object.defineProperty(Element.prototype, 'getAnimations', {
      configurable: true,
      writable: true,
      value: vi.fn(() => [animation]),
    });
    end = async () => {
      release();
      await act(async () => {
        await finished;
        await Promise.resolve();
      });
    };
  });

  afterEach(() => {
    cleanup();
    delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
  });

  it('leaves an inert, nameless copy where a filed row stood until its room has closed', async () => {
    patchFrontmatter.mockImplementationOnce(patchOptimistically);
    const user = userEvent.setup();
    render(<InboxPage />);
    const list = screen.getByRole('listbox', { name: 'Captures' });
    await user.keyboard('{Meta>}e{/Meta}');
    // The row itself went in the commit that filed it: the queue, the cursor
    // and every spec see one capture, and the next one is open.
    const rows = screen.getAllByTestId('inbox-row');
    expect(rows.map((row) => row.dataset.path)).toEqual([older.path]);
    expect(screen.getByTestId('body-editor').textContent).toBe(older.path);
    const ghost = list.querySelector<HTMLElement>('[data-ghost]');
    expect(ghost).not.toBeNull();
    // Where the filed row stood, above the row that followed it.
    expect(ghost!.nextElementSibling).toBe(rows[0]);
    expect(ghost!.textContent).toContain('Capture a');
    expect(ghost!.classList.contains('m75-row-leave')).toBe(true);
    expect(ghost!.getAttribute('aria-hidden')).toBe('true');
    expect(ghost!.hasAttribute('inert')).toBe(true);
    for (const node of [ghost!, ...ghost!.querySelectorAll('*')]) {
      for (const name of [
        'role',
        'id',
        'tabindex',
        'title',
        'aria-selected',
        'data-testid',
        'data-path',
        'data-cursor-key',
      ]) {
        expect(node.hasAttribute(name)).toBe(false);
      }
    }
    await end();
    expect(list.querySelector('[data-ghost]')).toBeNull();
  });

  it('opens room for a capture that arrives, and settles it once it has dropped in', async () => {
    render(<InboxPage />);
    const fresh = makeEntry({
      path: 'inbox/capture-new.md',
      title: 'Capture new',
      createdAt: '2026-07-28T09:00:00Z',
    });
    act(() => useVaultStore.setState({ entries: [TYPE_DOC, fresh, capture, older, organized] }));
    const rows = screen.getAllByTestId('inbox-row');
    expect(rows.map((row) => row.dataset.path)).toEqual([fresh.path, capture.path, older.path]);
    // Only the new row moves; the ones it pushed down go with its room.
    expect(rows.map((row) => row.dataset.motion ?? null)).toEqual(['arrive', null, null]);
    expect(rows[0].style.getPropertyValue('--row-h')).not.toBe('');
    await end();
    expect(rows[0].hasAttribute('data-motion')).toBe(false);
    expect(rows[0].style.getPropertyValue('--row-h')).toBe('');
  });

  // Another vault's queue replaces this one whole; none of it was filed or
  // captured here, so nothing in it leaves or arrives.
  it('moves nothing when another vault replaces the queue', () => {
    useVaultStore.setState({ entriesVault: '/vault' });
    render(<InboxPage />);
    const list = screen.getByRole('listbox', { name: 'Captures' });
    act(() => useVaultStore.setState({ entriesVault: '/other', entries: [TYPE_DOC, third] }));
    expect(screen.getAllByTestId('inbox-row').map((row) => row.dataset.path)).toEqual([third.path]);
    expect(list.querySelector('[data-ghost]')).toBeNull();
    expect(screen.getAllByTestId('inbox-row')[0].hasAttribute('data-motion')).toBe(false);
  });

  it('keeps the drop target to fade as a drag leaves the page', async () => {
    render(<InboxPage />);
    const page = screen.getByTestId('inbox-page');
    fireEvent.dragEnter(page, { dataTransfer: { types: ['Files'] } });
    expect(screen.getByTestId('inbox-dropzone').dataset.state).toBe('open');
    fireEvent.dragLeave(page);
    expect(screen.getByTestId('inbox-dropzone').dataset.state).toBe('closed');
    await end();
    expect(screen.queryByTestId('inbox-dropzone')).toBeNull();
  });
});
