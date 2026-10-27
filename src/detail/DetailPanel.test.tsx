import { createElement, useLayoutEffect, useState, type ComponentProps } from 'react';
import type { EditorReadyInfo } from '@/editor/MarkdownEditor';
import { __resetOpenPages } from '@/editor/openPages';
import { sha256Hex } from '@/lib/sha256';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DetailPanel } from '@/detail/DetailPanel';
import {
  hasLayers,
  hasModalLayers,
  popLayer,
  pushLayer,
  resetLayers,
} from '@/components/ui/layers';
import { Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { FieldEditor } from '@/detail/FieldEditor';
import { FixedBelowAnchor } from '@/detail/FieldPopover';
import { buildSchema } from '@/engine/schema';
import * as ipc from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { fixtureVault, makeEntry } from '@/test/factories';

const lastEditor = vi.hoisted(() => ({ info: null as EditorReadyInfo | null }));
vi.mock('@/editor/NoteBodyEditor', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/editor/NoteBodyEditor')>();
  const Tracked = (props: ComponentProps<typeof mod.NoteBodyEditor>) =>
    createElement(mod.NoteBodyEditor, {
      ...props,
      onReady: (info: EditorReadyInfo) => {
        lastEditor.info = info;
        props.onReady?.(info);
      },
    });
  return { ...mod, NoteBodyEditor: Tracked };
});

vi.mock('@/lib/ipc', () => ({
  listenOsFileDrop: vi.fn().mockResolvedValue(() => {}),
  readNote: vi.fn().mockResolvedValue('Existing body'),
  readNoteSource: vi.fn().mockResolvedValue({ content: 'Existing body', hash: 'a'.repeat(64) }),
  saveNoteBody: vi.fn(async ({ body }: { body: string }) => ({
    kind: 'file',
    contentHash: sha256Hex(body),
  })),
  setNoteTitle: vi.fn().mockResolvedValue(undefined),
  pickVault: vi.fn(),
  getLastVault: vi.fn(),
  scanVault: vi.fn().mockResolvedValue([]),
  updateFrontmatter: vi.fn().mockResolvedValue(undefined),
  createNote: vi.fn(),
  listViews: vi.fn().mockResolvedValue([]),
  // Missing until M45.6, and its absence was invisible: `rescan` calls it
  // through `loadCollections`, so every rescan in this file threw on
  // `undefined is not a function`, was swallowed by the store-layer catch,
  // and left `entries` untouched. Nothing failed — a rename simply never
  // reached the store, which is exactly what a case about post-rename state
  // needs to be able to see.
  listCollections: vi.fn().mockResolvedValue([]),
  saveView: vi.fn(),
  startWatcher: vi.fn().mockResolvedValue(undefined),
  listFolders: vi.fn().mockResolvedValue([]),
  createFolder: vi.fn(),
  renameNote: vi.fn(),
  deleteNote: vi.fn(),
  // The knowledge panel asks the ingest scheduler whether this note is queued
  // (M26.4j). `null` is what the real backend returns when ambient ingest has
  // never run, which is every vault by default.
  ingestItemState: vi.fn().mockResolvedValue(null),
}));

beforeEach(__resetOpenPages);
afterEach(() => {
  cleanup();
  __resetOpenPages();
});

/**
 * Escape delivered in the commit that opened a surface, before the browser has
 * painted (M16.35).
 *
 * `useLayoutEffect` is what makes this deterministic: layout effects run
 * inside the commit and in tree order, so this one fires with the sibling
 * `Popover` mounted and rendered but with no passive effect anywhere having
 * run yet. That is exactly the window a real fast keystroke lands in, and
 * while the layer stack registered from `useEffect` it was a window in which
 * the stack said nothing was open.
 */
function EscapeOnFirstCommit() {
  useLayoutEffect(() => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  }, []);
  return null;
}

function SurfaceOpenedOverThePanel() {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button type="button" data-testid="open-surface" onClick={() => setOpen(true)}>
        open
      </button>
      {open && (
        <>
          <Popover onClose={() => setOpen(false)} role="menu" ariaLabel="Same-commit surface">
            <button type="button">item</button>
          </Popover>
          <EscapeOnFirstCommit />
        </>
      )}
    </span>
  );
}

/** The record the panel opens on in every case below. */
const FLD_1 = 'projects/onboarding/items/fld-1.md';

describe('DetailPanel', () => {
  beforeEach(() => {
    // Layers are module state; a case that leaves one pushed would make every
    // later Escape assertion pass for the wrong reason.
    resetLayers();
    lastEditor.info = null;
    useVaultStore.setState({ entries: fixtureVault(), vaultPath: '/vault' });
    useUiStore.setState({ detailPath: 'projects/onboarding/items/fld-1.md' });
  });

  it('steps j/k through the supplied neighbours, clamps the ends, and leaves title typing alone', async () => {
    const next = makeEntry({ path: 'next.md', title: 'Next' });
    useVaultStore.setState({ entries: [...fixtureVault(), next] });
    useUiStore.setState({ detailSiblings: [FLD_1, next.path] });
    render(<DetailPanel />);
    const panel = screen.getByTestId('detail-panel');
    fireEvent.pointerDown(panel);
    fireEvent.keyDown(panel, { key: 'j' });
    expect(useUiStore.getState().detailPath).toBe(next.path);
    fireEvent.keyDown(panel, { key: 'j' });
    expect(useUiStore.getState().detailPath).toBe(next.path);
    const title = await screen.findByRole('textbox', { name: 'Document title' });
    title.focus();
    fireEvent.keyDown(title, { key: 'k' });
    expect(useUiStore.getState().detailPath).toBe(next.path);
    title.blur();
    fireEvent.pointerDown(panel);
    fireEvent.keyDown(panel, { key: 'k' });
    expect(useUiStore.getState().detailPath).toBe(FLD_1);
    fireEvent.keyDown(panel, { key: 'k' });
    expect(useUiStore.getState().detailPath).toBe(FLD_1);
  });

  it('writes a frontmatter patch when a status option is picked', async () => {
    const user = userEvent.setup();
    const patchFrontmatter = vi.fn().mockResolvedValue(true);
    useVaultStore.setState({ patchFrontmatter });
    render(<DetailPanel />);
    await user.click(screen.getByRole('button', { name: 'Show Status property' }));
    await user.click(screen.getByRole('button', { name: 'Todo' }));
    await user.click(screen.getByRole('option', { name: 'Doing' }));
    expect(patchFrontmatter).toHaveBeenCalledWith('projects/onboarding/items/fld-1.md', {
      status: 'doing',
    });
  });

  // M55.11 — the peek wears the page's chrome too: its icon beside the
  // title, its cover as a compact band, and neither as a property row.
  it("a record's icon precedes the document title, and its cover draws the compact band", () => {
    const vault = fixtureVault().map((e) =>
      e.path === FLD_1
        ? { ...e, properties: { ...e.properties, icon: '\u{1F680}', cover: 'green' } }
        : e,
    );
    useVaultStore.setState({ entries: vault });
    render(<DetailPanel />);
    const chrome = screen.getByTestId('page-chrome');
    expect(
      chrome.compareDocumentPosition(screen.getByRole('heading', { level: 1 })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId('page-icon').textContent).toBe('\u{1F680}');
    const band = screen.getByTestId('page-cover');
    expect(band.className).toContain('h-[72px]');
    expect(band.style.background).toBe('var(--opt-green)');
    expect(screen.queryByText('Icon')).toBeNull();
    expect(screen.queryByText('Cover')).toBeNull();
  });

  // M59.1 — the type badge calls an untyped page a Page, as ⌘K does.
  it('labels an untyped page Page in the type badge', () => {
    const vault = fixtureVault().map((e) => (e.path === FLD_1 ? { ...e, type: null } : e));
    useVaultStore.setState({ entries: vault });
    render(<DetailPanel />);
    const badge = screen.getByTestId('detail-type');
    expect(badge.textContent).toBe('Page');
    expect(badge.getAttribute('title')).toBe('Page');
  });

  it('a record with no icon or cover draws neither in the peek', () => {
    render(<DetailPanel />);
    expect(screen.queryByTestId('page-icon')).toBeNull();
    expect(screen.queryByTestId('page-cover')).toBeNull();
  });

  it('shows undeclared frontmatter keys as advisory text', () => {
    render(<DetailPanel />);
    fireEvent.click(screen.getByTestId('record-properties-toggle'));
    expect(screen.getByText('Channel')).toBeTruthy();
    expect(screen.getByText('field-ops')).toBeTruthy();
  });

  // M34.5.3 — a cached copy says its own freshness. Gated on the fetch
  // bookkeeping properties, never on `type: Source`; extreme dates keep the
  // assertions clock-proof without pinning the system time.
  it('keeps import provenance beside the record in the peek', () => {
    const path = 'records/imported-copy.md';
    useVaultStore.setState({
      entries: [
        ...fixtureVault(),
        makeEntry({
          path,
          title: 'Imported copy',
          properties: { source_system: 'linear', imported_at: '2026-10-13', import_hash: 'abc' },
        }),
      ],
    });
    useUiStore.setState({ detailPath: path });
    render(<DetailPanel />);
    expect(screen.getByTestId('import-provenance').textContent).toContain(
      'Imported from Linear · 2026-10-13',
    );
    expect(screen.queryByText('Import hash')).toBeNull();
  });

  it('a cached copy past its refresh date says stale, and when it was fetched', () => {
    useVaultStore.setState({
      entries: [
        ...fixtureVault(),
        makeEntry({
          path: 'sources/issues/phx-421.md',
          title: 'PHX-421',
          properties: { stale_after: '2020-01-01', fetched_at: '2019-12-20T10:00:00Z' },
        }),
      ],
    });
    useUiStore.setState({ detailPath: 'sources/issues/phx-421.md' });
    render(<DetailPanel />);
    const line = screen.getByTestId('detail-source-freshness');
    expect(line.textContent).toContain('stale since 2020-01-01');
    expect(line.textContent).toContain('fetched 2019-12-20');
  });

  it('a copy nobody gave a refresh date says so — and an unrecorded fetch is said, not zero', () => {
    useVaultStore.setState({
      entries: [
        ...fixtureVault(),
        makeEntry({
          path: 'sources/web/wiki.md',
          title: 'Wiki page',
          properties: { fetched_at: '2026-08-20T10:00:00Z' },
        }),
        makeEntry({
          path: 'sources/web/unstamped.md',
          title: 'Unstamped',
          properties: { stale_after: '2999-01-01' },
        }),
      ],
    });
    useUiStore.setState({ detailPath: 'sources/web/wiki.md' });
    const { unmount } = render(<DetailPanel />);
    expect(screen.getByTestId('detail-source-freshness').textContent).toContain(
      'no refresh date set',
    );
    unmount();
    useUiStore.setState({ detailPath: 'sources/web/unstamped.md' });
    render(<DetailPanel />);
    const line = screen.getByTestId('detail-source-freshness');
    expect(line.textContent).toContain('fresh until 2999-01-01');
    expect(line.textContent).toContain('fetch not recorded');
  });

  // M61.8: an instant prints the day this machine's clock said, not UTC's.
  describe('stamps print the local date', () => {
    const tz = process.env.TZ;
    afterEach(() => {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    });

    it('fetched, Created and Modified in Sydney', () => {
      process.env.TZ = 'Australia/Sydney';
      useVaultStore.setState({
        entries: [
          ...fixtureVault(),
          makeEntry({
            path: 'sources/web/late.md',
            title: 'Late',
            // 22:00Z is 08:00 the NEXT day in Sydney.
            properties: { fetched_at: '2026-08-20T22:00:00Z' },
            createdAt: '2026-07-01T22:00:00Z',
            modifiedAt: '2026-07-02T22:00:00Z',
          }),
        ],
      });
      useUiStore.setState({ detailPath: 'sources/web/late.md' });
      render(<DetailPanel />);
      expect(screen.getByTestId('detail-source-freshness').textContent).toContain(
        'fetched 2026-08-21',
      );
      expect(screen.getByText('Created 2026-07-02')).toBeTruthy();
      expect(screen.getByText('Modified 2026-07-03')).toBeTruthy();
    });
  });

  it('a record without fetch bookkeeping gets no freshness line at all', () => {
    render(<DetailPanel />);
    expect(screen.queryByTestId('detail-source-freshness')).toBeNull();
  });

  it('closes on Escape', () => {
    render(<DetailPanel />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().detailPath).toBeNull();
  });

  // M65.1: the peek docks beside the page, so it is a layer the keymap's
  // letters do not stand down for — and still the one Escape closes.
  it('registers a non-modal layer, and Escape still closes it', () => {
    render(<DetailPanel />);
    expect(hasLayers()).toBe(true);
    expect(hasModalLayers()).toBe(false);
    expect(screen.getByTestId('detail-panel').getAttribute('data-key-scope')).toBe('peek');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().detailPath).toBeNull();
  });

  // M15: one Escape must dismiss ONE surface. The window listener sits above
  // the null-guard (hooks are unconditional), so the guard is in the handler.
  it('leaves the record panel open when QuickOpen owns the Escape', () => {
    render(<DetailPanel />);
    useUiStore.setState({ quickOpenVisible: true });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().detailPath).not.toBeNull();
    useUiStore.setState({ quickOpenVisible: false });
  });

  it('leaves the record panel open when the inline diff owns the Escape', () => {
    render(<DetailPanel />);
    useUiStore.setState({ diffView: { path: 'projects/onboarding/items/fld-1.md', commit: null } });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().detailPath).not.toBeNull();
    useUiStore.setState({ diffView: null });
  });

  // M16.1: "something is on top" is now a registered layer, not a rendered
  // `role="dialog"`. The old probe only saw surfaces that happened to carry
  // that role, so the add-property panel — which carries none — was invisible
  // to it, and Escape inside it closed this whole panel.
  it('leaves the record panel open when any dismissable layer is on top', () => {
    render(<DetailPanel />);
    pushLayer('some-popover');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().detailPath).not.toBeNull();
    popLayer('some-popover');
  });

  it('closes once the layer above it has gone', () => {
    render(<DetailPanel />);
    pushLayer('some-popover');
    popLayer('some-popover');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().detailPath).toBeNull();
  });

  /**
   * Escape closed the wrong layer across the panel boundary (M16.29).
   *
   * Within the panel, precedence was already right: a property menu is a
   * `Popover`, which registers a layer and swallows the keystroke, so Escape
   * closed the menu and left the panel. Across the boundary it inverted. The
   * View settings popover mounts through `FixedBelowAnchor` — the pre-M16.1
   * positioner six surfaces still use — which registered nothing, so
   * `hasLayers()` answered false with a popover open on screen and this panel
   * took the keystroke. The record vanished and the popover was left floating
   * over an empty canvas.
   *
   * The panel now registers a layer of its own and asks whether it is the
   * innermost one, instead of asking whether anything at all is open.
   */
  it('leaves the record panel open when a popover outside it is on top', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <DetailPanel />
        {/* What ViewControlIcons mounts the View settings panel in. */}
        <span style={{ position: 'relative' }}>
          <FixedBelowAnchor onClose={() => {}}>
            <div data-testid="view-settings">View settings</div>
          </FixedBelowAnchor>
        </span>
      </div>,
    );
    await user.keyboard('{Escape}');
    expect(useUiStore.getState().detailPath).not.toBeNull();
  });

  /**
   * A layer must be true on the FIRST commit, not a paint later (M16.35).
   *
   * `useLayer` pushed from a passive effect, which React runs after the
   * browser paints. So for one frame the add-property surface was on screen
   * and the stack still answered "nothing is open" — and an Escape in that
   * window came straight here and closed the whole record instead of the
   * surface the user was looking at. Registration moved to the layout phase,
   * which runs inside the commit.
   *
   * Both assertions matter: unregistered, the panel closed AND the popover
   * stayed open, because nothing had claimed the keystroke.
   */
  it('leaves the record panel open when a surface opened in the same commit takes the Escape', () => {
    render(
      <div>
        <DetailPanel />
        <SurfaceOpenedOverThePanel />
      </div>,
    );
    fireEvent.click(screen.getByTestId('open-surface'));

    expect(useUiStore.getState().detailPath).not.toBeNull();
    expect(screen.queryByRole('menu', { name: 'Same-commit surface' })).toBeNull();
  });

  /**
   * One Escape dismissed a tooltip AND this panel (M16.35).
   *
   * `Tooltip` hid itself on a bubble-phase `window` listener that stopped
   * nothing and registered no layer, so this panel was told the keystroke was
   * unclaimed and took it — the record vanished because the user wanted a hint
   * out of the way. A tooltip is a layer now, of a non-blocking kind, and the
   * panel asks who OWNS the Escape rather than which surface is innermost.
   */
  it('leaves the record panel open when a visible tooltip takes the Escape', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <DetailPanel />
        <Tooltip label="Archive this" delayMs={0}>
          <button type="button" data-testid="tipped">
            go
          </button>
        </Tooltip>
      </div>,
    );
    await user.hover(screen.getByTestId('tipped'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeTruthy());

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    expect(useUiStore.getState().detailPath).not.toBeNull();
  });

  // The other half: the panel is a layer, so it must stop being one the
  // moment it closes — a stale entry would sit on top of every popover
  // opened afterwards and eat their Escape instead.
  it('leaves the stack when it closes', () => {
    const { rerender } = render(<DetailPanel />);
    expect(hasLayers()).toBe(true);
    useUiStore.setState({ detailPath: null });
    rerender(<DetailPanel />);
    expect(hasLayers()).toBe(false);
  });

  it('is not a layer while it has no record to show', () => {
    useUiStore.setState({ detailPath: null });
    render(<DetailPanel />);
    expect(hasLayers()).toBe(false);
  });

  it('renders nothing when no detail path is open', () => {
    useUiStore.setState({ detailPath: null });
    const { container } = render(<DetailPanel />);
    expect(container.firstChild).toBeNull();
  });

  // --- Tests below cover reported deviations from the plan's verbatim code ---

  // Task 12: the body renders in the rich editor; NoteBodyEditor covers
  // save-failure toasts and the note-10 newline normalization at its level.
  it('renders the note body in the rich markdown editor', async () => {
    vi.mocked(ipc.readNote).mockResolvedValueOnce('\n# Design first-run flow\n\nBody text\n');
    render(<DetailPanel />);
    await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
      timeout: 5_000,
    });
    await waitFor(() => expect(screen.getByText('Body text')).toBeTruthy());
    expect(screen.queryByRole('textbox', { name: 'Description' })).toBeNull();
  });

  it('retains a native title draft when its document save fails', async () => {
    useUiStore.setState({ toasts: [] });
    vi.mocked(ipc.saveNoteBody).mockRejectedValueOnce(new Error('read-only vault'));
    vi.mocked(ipc.readNote).mockResolvedValueOnce('# Design first-run flow\n\nBody text\n');
    render(<DetailPanel />);
    await waitFor(() => expect(lastEditor.info).not.toBeNull());
    act(() =>
      lastEditor.info!.editor.updateBlock(lastEditor.info!.editor.document[0], {
        content: 'Renamed flow',
      }),
    );
    await act(() => lastEditor.info!.flushPendingSave());
    expect(screen.getByRole('heading', { name: 'Renamed flow' })).toBeTruthy();
    expect(
      useUiStore.getState().toasts.some((t) => t.message.startsWith("Couldn't save page")),
    ).toBe(true);
    expect(ipc.setNoteTitle).not.toHaveBeenCalled();
  });

  it('shows a direct knowledge peek with its frontmatter title and no generic mutation path', async () => {
    const path = 'knowledge/systems/guarded.md';
    useVaultStore.setState({
      entries: [...fixtureVault(), makeEntry({ path, title: 'Guarded concept' })],
    });
    useUiStore.setState({ detailPath: path });
    vi.mocked(ipc.readNote).mockResolvedValueOnce('# Evidence section\n\nGuarded body.\n');
    render(<DetailPanel />);
    expect(screen.getByRole('heading', { name: 'Guarded concept' })).toBeTruthy();
    await waitFor(() => expect(lastEditor.info).not.toBeNull());
    expect(lastEditor.info!.editor.isEditable).toBe(false);
    expect(screen.queryByTestId('page-editor-chrome')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add property' })).toBeNull();
    expect(screen.queryByTestId('doc-title-heading')).toBeNull();
  });

  it('toasts when the body cannot be loaded (note 16a guard discipline)', async () => {
    useUiStore.setState({ toasts: [] });
    vi.mocked(ipc.readNote).mockRejectedValueOnce(new Error('gone'));
    render(<DetailPanel />);
    await waitFor(() => {
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain("Couldn't load page");
    });
  });

  it('owns repeated title edits in the same document and undo history', async () => {
    vi.mocked(ipc.readNote).mockResolvedValueOnce('# Design first-run flow\n\nBody text\n');
    vi.mocked(ipc.scanVault).mockResolvedValue(fixtureVault());
    render(<DetailPanel />);
    await waitFor(() => expect(lastEditor.info).not.toBeNull());
    const info = lastEditor.info!;
    const titleId = info.editor.document[0].id;
    act(() => info.editor.updateBlock(titleId, { content: 'Renamed once' }));
    await act(() => info.flushPendingSave());
    act(() => info.editor.updateBlock(titleId, { content: 'Renamed twice' }));
    await act(() => info.flushPendingSave());
    expect(lastEditor.info).toBe(info);
    expect(info.editor.document[0].id).toBe(titleId);
    expect(screen.getByRole('heading', { name: 'Renamed twice' })).toBeTruthy();
    expect(vi.mocked(ipc.saveNoteBody).mock.calls.at(-1)?.[0].body).toContain('# Renamed twice');
    expect(vi.mocked(ipc.saveNoteBody).mock.calls.at(-1)?.[0].body).toContain('Body text');
    expect(ipc.setNoteTitle).not.toHaveBeenCalled();
  });

  // M14.2: which knowledge surface answers is capability-gated — a record the
  // base holds concepts ABOUT gets its dossier (projects became ordinary
  // records in the M12.5 aftermath, so the dossier rides the panel now); any
  // other record keeps the wide-net related list.
  it('shows the entity dossier when the base holds concepts about the record', async () => {
    const user = userEvent.setup();
    useVaultStore.setState({
      entries: [
        ...fixtureVault(),
        makeEntry({
          path: 'knowledge/systems/first-run.md',
          title: 'First-run flow',
          // The scanner hands wikilink fields over bracket-stripped, in
          // relationships — not properties (M12.4a).
          relationships: { about: ['fld-1'] },
        }),
      ],
    });
    render(<DetailPanel />);
    // M50.2: open by default when Knowledge holds something about the record.
    expect(screen.getByTestId('detail-knowledge-toggle').getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(screen.getByTestId('entity-dossier')).toBeTruthy();
    expect(screen.queryByTestId('related-knowledge')).toBeNull();
    // And a person's own toggle still wins.
    await user.click(screen.getByTestId('detail-knowledge-toggle'));
    expect(screen.queryByTestId('entity-dossier')).toBeNull();
  });

  it('keeps the related list when the base only knows around the record', async () => {
    const user = userEvent.setup();
    useVaultStore.setState({
      entries: [
        ...fixtureVault(),
        // About the record's assignee, not the record: knowledge AROUND it.
        makeEntry({
          path: 'knowledge/people/ana.md',
          title: 'Ana owns field onboarding',
          relationships: { about: ['ana-rios'] },
        }),
      ],
    });
    render(<DetailPanel />);
    // Nothing is about the record, and nothing was learned from it: closed.
    expect(screen.getByTestId('detail-knowledge-toggle').getAttribute('aria-expanded')).toBe(
      'false',
    );
    await user.click(screen.getByTestId('detail-knowledge-toggle'));
    expect(screen.getByTestId('related-knowledge')).toBeTruthy();
    expect(screen.getByText('Related to this page')).toBeTruthy();
    expect(screen.queryByTestId('entity-dossier')).toBeNull();
  });

  // M52.3 — the peek and the page tab read Knowledge the same way: one empty
  // sentence when there is nothing, never a heading per sub-surface.
  it('says Knowledge holds nothing once, when it holds nothing', async () => {
    const user = userEvent.setup();
    render(<DetailPanel />);
    await user.click(screen.getByTestId('detail-knowledge-toggle'));
    expect(screen.getByTestId('page-knowledge-empty').textContent).toBe(
      'Knowledge holds nothing about this page yet.',
    );
    expect(screen.queryByText('Not in Knowledge')).toBeNull();
    expect(screen.queryByText('Nothing yet about this.')).toBeNull();
  });

  // M33a.6 — the gate above decides WHICH surface answers, and for a while it
  // also decided whether you could ask anything at all: asking the base
  // shipped on the related list only, so the records the base knew most about
  // were exactly the ones with no way to question it. Asserted on both arms
  // of the gate, because that is what let the two drift apart.
  it('offers Ask the base on whichever knowledge surface the gate picked', async () => {
    const user = userEvent.setup();
    render(<DetailPanel />);
    await user.click(screen.getByTestId('detail-knowledge-toggle'));
    expect(
      screen.getByRole('button', { name: 'What does Knowledge say about this?' }),
    ).toBeTruthy();

    cleanup();
    useVaultStore.setState({
      entries: [
        ...fixtureVault(),
        makeEntry({
          path: 'knowledge/systems/first-run.md',
          title: 'First-run flow',
          relationships: { about: ['fld-1'] },
        }),
      ],
    });
    render(<DetailPanel />);
    expect(screen.getByTestId('entity-dossier')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'What does Knowledge say about this?' }),
    ).toBeTruthy();
    // Still distinct from the write-side act it used to sit alone beside —
    // and there is ONE of that act now, not one per sub-surface (M52.3).
    expect(screen.getAllByRole('button', { name: 'Learn from this page' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: "What's missing?" })).toBeTruthy();
  });

  // M45.1 — the type's `layout.heading` renders as the key-property strip
  // between the title and the property stack; the stack starts collapsed
  // behind the strip and the expander reveals it.
  describe('heading strip (M45.1)', () => {
    const withLayout = (
      layout: Record<string, unknown>,
      mutateFields?: (fields: Record<string, unknown>) => void,
    ) => {
      const entries = fixtureVault();
      const typeDoc = entries.find((e) => e.path === 'types/work-item.md')!;
      const typeProps = typeDoc.properties as unknown as Record<string, unknown>;
      mutateFields?.(typeProps.fields as Record<string, unknown>);
      typeProps.layout = layout;
      useVaultStore.setState({ entries, vaultPath: '/vault' });
      useUiStore.setState({ detailPath: 'projects/onboarding/items/fld-1.md' });
    };

    it('mounts the strip after the title; the toggle expands and collapses the stack', () => {
      withLayout({ heading: ['status', 'priority'] });
      render(<DetailPanel />);
      const strip = screen.getByTestId('heading-strip');
      // Between title and properties: the strip FOLLOWS the title input.
      const title = screen.getByRole('heading', { level: 1 });
      expect(title.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // The stack starts collapsed behind the strip…
      expect(screen.queryByRole('button', { name: 'Add property' })).toBeNull();
      // …while the body section is untouched by the collapse (M44.1 display
      // config still owns it).
      expect(screen.getByTestId('page-body-start')).toBeTruthy();
      fireEvent.click(screen.getByTestId('view-details-toggle'));
      expect(screen.getByRole('button', { name: 'Add property' })).toBeTruthy();
      fireEvent.click(screen.getByTestId('view-details-toggle'));
      expect(screen.queryByRole('button', { name: 'Add property' })).toBeNull();
    });

    it('resets to the collapsed strip when the panel switches records', () => {
      withLayout({ heading: ['status'] });
      render(<DetailPanel />);
      fireEvent.click(screen.getByTestId('view-details-toggle'));
      expect(screen.getByRole('button', { name: 'Add property' })).toBeTruthy();
      // act: a store write outside any event needs its re-render flushed
      // before the DOM assertion sees it.
      act(() => useUiStore.setState({ detailPath: 'projects/onboarding/items/fld-2.md' }));
      expect(screen.queryByRole('button', { name: 'Add property' })).toBeNull();
      // …and COMING BACK resets too: the lens forgets a record it left, like
      // RecordProperties' keyed `revealed`. A one-slot {path, shown} cache
      // resurrected A's toggle on A→B→A while A→B(toggled)→A reset —
      // remembering was an accident of whose write survived, not a feature.
      act(() => useUiStore.setState({ detailPath: 'projects/onboarding/items/fld-1.md' }));
      expect(screen.queryByRole('button', { name: 'Add property' })).toBeNull();
    });

    it('no layout opens on a summary with the full manager one action away', () => {
      render(<DetailPanel />);
      expect(screen.queryByTestId('heading-strip')).toBeNull();
      expect(screen.queryByTestId('view-details-toggle')).toBeNull();
      expect(screen.getByTestId('record-summary')).toBeTruthy();
      expect(screen.queryByTestId('page-properties')).toBeNull();
      fireEvent.click(screen.getByTestId('record-properties-toggle'));
      expect(screen.getByRole('button', { name: 'Add property' })).toBeTruthy();
    });

    // The Task 5 ruling's trap: a heading whose one field is empty under
    // hide_when_empty folds the strip to NOTHING — the stack must render
    // despite `detailsShown` never being touched, or the record's properties
    // are stranded behind a strip that is not on screen.
    it('a strip that folds to nothing shows the stack untoggled', () => {
      withLayout({ heading: ['due'] }, (fields) => {
        fields.due = { kind: 'date', visibility: 'hide_when_empty' };
      });
      render(<DetailPanel />);
      expect(screen.queryByTestId('heading-strip')).toBeNull();
      expect(screen.getByRole('button', { name: 'Add property' })).toBeTruthy();
    });
  });

  /**
   * M45.6 — the peek shows the record's tabs.
   *
   * The defect (user, 2026-08-29: "the tabs dont render in the UI"): the strip
   * mounted on the record PAGE and in the layout editor only, so a type whose
   * tabs were saved showed none on the surface a table row actually opens
   * into. Same gate as the page (SAVED tabs, never the synthesized Overview),
   * the same content arms, panel geometry — and the selection is LOCAL,
   * because a peek is not a place the back button returns to.
   */
  describe('record tabs (M45.6)', () => {
    const OVERVIEW = { id: 'overview', name: 'Overview', content: 'overview' };
    const SPEC = { id: 'spec', name: 'Spec', content: 'sections' };

    const withTabs = (tabs: Record<string, unknown>[], layout?: Record<string, unknown>) => {
      const entries = fixtureVault();
      const typeDoc = entries.find((e) => e.path === 'types/work-item.md')!;
      const typeProps = typeDoc.properties as unknown as Record<string, unknown>;
      typeProps.tabs = tabs;
      if (layout !== undefined) typeProps.layout = layout;
      useVaultStore.setState({ entries, vaultPath: '/vault' });
      useUiStore.setState({ detailPath: 'projects/onboarding/items/fld-1.md' });
      return entries;
    };

    it('a Runs tab renders the page-scoped feed in the peek', () => {
      withTabs([OVERVIEW, { id: 'runs', name: 'Runs', content: 'runs' }]);
      render(<DetailPanel />);
      fireEvent.click(screen.getByTestId('record-tab-runs'));
      expect(screen.getByTestId('page-runs')).toBeTruthy();
      expect(screen.queryByTestId('page-body-start')).toBeNull();
    });

    it('an Agents tab renders the capability surface in the peek', () => {
      withTabs([OVERVIEW, { id: 'agents', name: 'Agents', content: 'agents' }]);
      render(<DetailPanel />);
      fireEvent.click(screen.getByTestId('record-tab-agents'));
      expect(screen.getByTestId('page-agents-unconfigured').textContent).toContain(
        'Work item pages have no relation to Agent',
      );
      expect(screen.queryByTestId('page-body-start')).toBeNull();
    });

    it('a type with no saved tabs raises no strip, and the peek is what it was', () => {
      render(<DetailPanel />);
      fireEvent.click(screen.getByTestId('record-properties-toggle'));
      expect(screen.queryByTestId('record-tabs')).toBeNull();
      // The synthesized Overview drives the content, never a one-tab strip.
      expect(screen.getByRole('button', { name: 'Add property' })).toBeTruthy();
      expect(screen.getByTestId('page-body-start')).toBeTruthy();
    });

    it('an untyped note has no tabs at all', () => {
      useVaultStore.setState({
        entries: [...fixtureVault(), makeEntry({ path: 'notes/plain.md', title: 'Plain note' })],
      });
      useUiStore.setState({ detailPath: 'notes/plain.md' });
      render(<DetailPanel />);
      fireEvent.click(screen.getByTestId('record-properties-toggle'));
      expect(screen.queryByTestId('record-tabs')).toBeNull();
      // …and its properties still render: no tabs is not no record surface.
      expect(screen.getByRole('button', { name: 'Add property' })).toBeTruthy();
    });

    it('saved tabs raise the strip, under the heading strip and over the content', () => {
      withTabs([OVERVIEW, SPEC], { heading: ['status', 'priority'] });
      render(<DetailPanel />);
      const strip = screen.getByTestId('record-tabs');
      const heading = screen.getByTestId('heading-strip');
      const body = screen.getByTestId('page-body-start');
      expect(
        heading.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(strip.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // The first tab opens by default — no selection to read.
      expect(screen.getByTestId('record-tab-overview').getAttribute('aria-selected')).toBe('true');
    });

    it('the overview arm is the peek as it was: properties and the body', () => {
      withTabs([OVERVIEW, SPEC]);
      render(<DetailPanel />);
      fireEvent.click(screen.getByTestId('record-properties-toggle'));
      expect(screen.getByRole('button', { name: 'Add property' })).toBeTruthy();
      expect(screen.getByTestId('page-body-start')).toBeTruthy();
    });

    it('a sections tab is its own free text — the stack stays, the body goes', () => {
      withTabs([SPEC, OVERVIEW]);
      render(<DetailPanel />);
      fireEvent.click(screen.getByTestId('record-properties-toggle'));
      expect(screen.getByTestId('tab-sections')).toBeTruthy();
      // M46.1: the stack is the RECORD's, so it stands on this tab too.
      expect(screen.getByRole('button', { name: 'Add property' })).toBeTruthy();
      expect(screen.queryByTestId('page-body-start')).toBeNull();
    });

    it('a view tab embeds its database in the peek', () => {
      withTabs([
        { id: 'items', name: 'Items', content: 'view', source: { type: 'Work item' } },
        OVERVIEW,
      ]);
      render(<DetailPanel />);
      fireEvent.click(screen.getByTestId('record-properties-toggle'));
      expect(screen.getByTestId('view-tab-embed')).toBeTruthy();
      expect(screen.getByText('Wire field sync banner')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Add property' })).toBeTruthy();
      expect(screen.queryByTestId('page-body-start')).toBeNull();
    });

    it('a dead source renders the sentence, never an empty database', () => {
      withTabs([{ id: 'ghost', name: 'Ghost', content: 'view', source: { type: 'Ghost' } }]);
      render(<DetailPanel />);
      expect(screen.getByTestId('view-tab-broken').textContent).toContain(
        'This tab points at a type called “Ghost” that is no longer in the vault.',
      );
      expect(screen.queryByTestId('view-tab-embed')).toBeNull();
    });

    /**
     * The load-bearing half of the decision to embed a real database in a
     * 360px column: the embed does NOT renumber the peek.
     *
     * `detailSiblings` is "the records the canvas behind you is showing", and
     * it drives the header's `3 of 45` and its next/prev arrows. A view tab
     * mounts a whole second canvas INSIDE the panel; if that canvas registered
     * its own rows, stepping "next" from a record would walk the rows of a
     * table embedded in that record's own peek. `ViewCanvas` takes an
     * `embedded` early return before the registration effect, so it neither
     * writes the list nor clears it — asserted here, because the comment in
     * `DetailPanel` argues from it and a silent change upstream would make
     * that argument false without failing anything.
     */
    it('an embedded view leaves the peek’s own record list alone', async () => {
      // Deliberately NOT the rows the embed shows: seeded with the two Work
      // items, an embed that DID register its rows would write back the same
      // array and this case would pass on a coincidence.
      const siblings = ['docs/one.md', 'docs/two.md', 'docs/three.md'];
      withTabs([
        { id: 'items', name: 'Items', content: 'view', source: { type: 'Work item' } },
        OVERVIEW,
      ]);
      useUiStore.setState({ detailSiblings: siblings });
      render(<DetailPanel />);
      // The embed really did render — otherwise this passes for the boring
      // reason that no second canvas ever mounted.
      expect(screen.getByTestId('view-tab-embed')).toBeTruthy();
      expect(screen.getByText('Wire field sync banner')).toBeTruthy();
      // Effects have run by now; the list is neither replaced nor emptied.
      await waitFor(() => expect(useUiStore.getState().detailSiblings).toEqual(siblings));
    });

    it('pressing a tab swaps the content, and the selection is the peek’s own', () => {
      withTabs([OVERVIEW, SPEC]);
      const where = useNavStore.getState().selection;
      render(<DetailPanel />);
      fireEvent.click(screen.getByTestId('record-tab-spec'));
      expect(screen.getByTestId('tab-sections')).toBeTruthy();
      expect(screen.queryByTestId('page-body-start')).toBeNull();
      // A peek is not a place: the tab is local state, so nothing moved the
      // navigation selection the back button reads.
      expect(useNavStore.getState().selection).toEqual(where);
      fireEvent.click(screen.getByTestId('record-tab-overview'));
      expect(screen.getByTestId('page-body-start')).toBeTruthy();
    });

    it('switching records reopens on the first tab', () => {
      withTabs([OVERVIEW, SPEC]);
      render(<DetailPanel />);
      fireEvent.click(screen.getByTestId('record-tab-spec'));
      expect(screen.getByTestId('tab-sections')).toBeTruthy();
      act(() => useUiStore.setState({ detailPath: 'projects/onboarding/items/fld-2.md' }));
      expect(screen.queryByTestId('tab-sections')).toBeNull();
      expect(screen.getByTestId('record-tab-overview').getAttribute('aria-selected')).toBe('true');
    });

    /**
     * A tab the type no longer has is a dead pointer, and a dead pointer
     * falls back — it never renders nothing.
     *
     * The peek holds its tab in local state, so the store can drop the open
     * tab underneath it: another window, the layout editor's Apply, or a hand
     * edit of the Type doc. The panel then holds an id nothing answers to,
     * and the fallback is the first tab (`tabs[0]`), the same idiom the
     * layout canvas uses. Without it the arms all miss and the peek renders a
     * title over a blank column.
     */
    it('a tab deleted under the peek falls back to the first, not to nothing', () => {
      const entries = withTabs([OVERVIEW, SPEC]);
      render(<DetailPanel />);
      fireEvent.click(screen.getByTestId('record-properties-toggle'));
      fireEvent.click(screen.getByTestId('record-tab-spec'));
      expect(screen.getByTestId('tab-sections')).toBeTruthy();

      // The type loses the open tab while the peek is standing on it.
      const typeDoc = entries.find((e) => e.path === 'types/work-item.md')!;
      (typeDoc.properties as unknown as Record<string, unknown>).tabs = [OVERVIEW];
      act(() => useVaultStore.setState({ entries: [...entries] }));

      expect(screen.queryByTestId('tab-sections')).toBeNull();
      // Overview's content, not an empty panel: the body and the stack.
      expect(screen.getByTestId('page-body-start')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Add property' })).toBeTruthy();
      // And the strip says so. This is the assertion that discriminates: a
      // panel that let `activeTab` go null would render no strip at all (the
      // mount is gated on it) while still showing a body, so the two
      // assertions above would pass on a peek that had lost its tabs.
      expect(screen.getByTestId('record-tab-overview').getAttribute('aria-selected')).toBe('true');
    });

    it('keeps the native title draft and editor owner when you press another tab', async () => {
      withTabs([OVERVIEW, { id: 'props', name: 'Fields', content: 'sections' }]);
      vi.mocked(ipc.readNote).mockResolvedValueOnce('# Original title\n\nBody text\n');
      render(<DetailPanel />);
      await waitFor(() => expect(lastEditor.info).not.toBeNull());
      const info = lastEditor.info!;
      act(() => info.editor.updateBlock(info.editor.document[0], { content: 'Half typed' }));
      fireEvent.click(screen.getByTestId('record-tab-props'));
      expect(screen.queryByTestId('page-body-start')).toBeNull();
      expect(screen.getByRole('heading', { name: 'Half typed' })).toBeTruthy();
      expect(lastEditor.info).toBe(info);
      expect(screen.getByTestId('markdown-editor')).toBeTruthy();
    });

    // Supporting knowledge follows whichever content the record tab shows;
    // opening it must no longer push the record body below an action cluster.
    it('keeps supporting knowledge after the tab content on every tab', () => {
      withTabs([
        OVERVIEW,
        { id: 'items', name: 'Items', content: 'view', source: { type: 'Work item' } },
      ]);
      render(<DetailPanel />);
      const above = (first: HTMLElement, second: HTMLElement) =>
        Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
      // Overview: after the body owner.
      expect(
        above(screen.getByTestId('page-body-start'), screen.getByTestId('detail-knowledge')),
      ).toBe(true);
      // Related data: still after the content, in the same supporting section.
      fireEvent.click(screen.getByTestId('record-tab-items'));
      expect(
        above(screen.getByTestId('view-tab-embed'), screen.getByTestId('detail-knowledge')),
      ).toBe(true);
    });

    /**
     * `RecordProperties` is keyed by PATH, never by tab — pinned here because
     * adding the tab id to that key breaks nothing else in the suite.
     *
     * The state the stack owns is about the RECORD (a reveal the user asked
     * for, an open add-property flyout), never about a tab: the fields it
     * shows are derived from props on every render. Keying by tab would
     * discard that state on every press and buy nothing back, so a press
     * must leave it standing.
     */
    it('keeps a reveal the user asked for across a tab press', () => {
      // No layout: the stack is flat, so this case turns on the keying alone
      // and not on which sections a tab holds. `due` is empty on fld-1, so
      // hide_when_empty folds it and the expander appears.
      const entries = withTabs([OVERVIEW, { id: 'props', name: 'Fields', content: 'sections' }]);
      const typeProps = entries.find((e) => e.path === 'types/work-item.md')!.properties as unknown;
      (typeProps as { fields: Record<string, unknown> }).fields.due = {
        kind: 'date',
        visibility: 'hide_when_empty',
      };
      useVaultStore.setState({ entries: [...entries] });
      render(<DetailPanel />);
      fireEvent.click(screen.getByTestId('record-properties-toggle'));
      const toggle = () => screen.getByTestId('hidden-properties-toggle');
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(toggle());
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      // A different tab, the same stack: the reveal is still open.
      fireEvent.click(screen.getByTestId('record-tab-props'));
      expect(screen.queryByTestId('page-body-start')).toBeNull();
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
    });

    // The peek's own chrome is about the RECORD, not about a tab: it stays
    // reachable whichever lens is open.
    it('keeps the knowledge block on a tab that is not Overview', () => {
      withTabs([SPEC, OVERVIEW]);
      render(<DetailPanel />);
      expect(screen.getByTestId('detail-knowledge')).toBeTruthy();
    });

    it('a tab edit in the peek writes the type doc', async () => {
      const patchFrontmatter = vi.fn().mockResolvedValue(true);
      withTabs([OVERVIEW, SPEC]);
      useVaultStore.setState({ patchFrontmatter });
      render(<DetailPanel />);
      fireEvent.click(screen.getByTestId('record-tab-overview'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
      const input = screen.getByLabelText('Tab name');
      fireEvent.change(input, { target: { value: 'Summary' } });
      fireEvent.blur(input);
      await waitFor(() =>
        expect(patchFrontmatter).toHaveBeenCalledWith('types/work-item.md', {
          tabs: [
            { id: 'overview', name: 'Summary', icon: null, content: 'overview' },
            { id: 'spec', name: 'Spec', icon: null, content: 'sections' },
          ],
        }),
      );
    });

    /**
     * M46.1 — the reversal: a section belongs to the RECORD, so the whole
     * stack stands above the strip on every tab and the tab below carries
     * only its own content. M45.6's per-tab cases are deleted, not weakened.
     */
    describe('properties stand above the tabs (M46.1)', () => {
      const SPEC_TAB = { id: 'spec', name: 'Spec', content: 'sections' };
      const ITEMS_TAB = {
        id: 'items',
        name: 'Items',
        content: 'view',
        source: { type: 'Work item' },
      };
      // An authored empty heading keeps the full manager open. These cases
      // exercise group placement independently of the automatic summary.
      const SECTIONED = {
        heading: [],
        groups: [
          { id: 'g-alpha', name: 'Alpha', fields: ['priority'] },
          { id: 'g-beta', name: 'Beta', fields: ['assignee'] },
        ],
      };
      const groupIds = () =>
        screen.queryAllByTestId('property-group').map((g) => g.getAttribute('data-group'));
      const above = (first: HTMLElement, second: HTMLElement) =>
        Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

      it('a sections tab carries every section, above the strip', () => {
        withTabs([SPEC_TAB, OVERVIEW], SECTIONED);
        render(<DetailPanel />);
        expect(screen.getByTestId('tab-sections')).toBeTruthy();
        expect(groupIds()).toEqual(['g-alpha', 'g-beta']);
        expect(
          above(screen.getAllByTestId('property-group')[0], screen.getByTestId('record-tabs')),
        ).toBe(true);
      });

      it('and so does a view tab — the embed is the tab, not the record', () => {
        withTabs([ITEMS_TAB, OVERVIEW], SECTIONED);
        render(<DetailPanel />);
        expect(screen.getByTestId('view-tab-embed')).toBeTruthy();
        expect(groupIds()).toEqual(['g-alpha', 'g-beta']);
        expect(
          above(screen.getAllByTestId('property-group')[0], screen.getByTestId('record-tabs')),
        ).toBe(true);
      });

      it('a press swaps the tab’s content and leaves the stack standing', () => {
        withTabs([OVERVIEW, SPEC_TAB], SECTIONED);
        render(<DetailPanel />);
        expect(groupIds()).toEqual(['g-alpha', 'g-beta']);
        expect(screen.getByTestId('page-body-start')).toBeTruthy();
        fireEvent.click(screen.getByTestId('record-tab-spec'));
        // The body is the Overview tab's alone; the sections are the
        // record's, so they did not move.
        expect(screen.queryByTestId('page-body-start')).toBeNull();
        expect(groupIds()).toEqual(['g-alpha', 'g-beta']);
      });

      // The heading strip stands on every tab, and so does the expander that
      // opens the stack behind it — the stack it opens is the same one on
      // every tab, so a tab without the toggle would strand it.
      it('the strip and its expander stand on a view tab', () => {
        withTabs([ITEMS_TAB, OVERVIEW], { heading: ['status'], groups: SECTIONED.groups });
        render(<DetailPanel />);
        expect(screen.getByTestId('heading-strip')).toBeTruthy();
        expect(groupIds()).toEqual([]);
        fireEvent.click(screen.getByTestId('view-details-toggle'));
        expect(groupIds()).toEqual(['g-alpha', 'g-beta']);
      });
    });
  });

  describe('display config (M44.1)', () => {
    const withDisplay = (display: Record<string, unknown>) => {
      const entries = fixtureVault();
      const typeDoc = entries.find((e) => e.path === 'types/work-item.md')!;
      (typeDoc.properties as unknown as Record<string, unknown>).display = display;
      useVaultStore.setState({ entries, vaultPath: '/vault' });
      useUiStore.setState({ detailPath: 'projects/onboarding/items/fld-1.md' });
    };

    it('shows the document body by default and hides it on show_body: false', () => {
      withDisplay({});
      const { unmount } = render(<DetailPanel />);
      expect(screen.getByTestId('page-body-start')).toBeTruthy();
      unmount();
      withDisplay({ show_body: false });
      render(<DetailPanel />);
      expect(screen.queryByTestId('page-body-start')).toBeNull();
    });

    it('show_file adds a muted path row; absent means none', () => {
      withDisplay({ show_file: true });
      render(<DetailPanel />);
      expect(screen.getByTestId('detail-file').textContent).toContain(
        'projects/onboarding/items/fld-1.md',
      );
      // and the default case:
      cleanup();
      withDisplay({});
      render(<DetailPanel />);
      expect(screen.queryByTestId('detail-file')).toBeNull();
    });
  });
});

// spliceTitle (string splice) was replaced by spliceTitleIntoBlocks in Task
// 12 — equivalent coverage lives in src/editor/markdown.test.ts.

// M1.x .nan guard: Number('junk') is NaN and serde_yaml writes it as `.nan`.
describe('FieldEditor number guard', () => {
  beforeEach(() => {
    useUiStore.setState({ toasts: [] });
  });

  function setupNumberEditor() {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    const entry = entries.find((e) => e.path === 'projects/onboarding/items/fld-1.md')!;
    const patchFrontmatter = vi.fn().mockResolvedValue(true);
    useVaultStore.setState({ entries, patchFrontmatter });
    render(<FieldEditor entry={entry} def={{ name: 'effort', kind: 'number' }} schema={schema} />);
    return patchFrontmatter;
  }

  it('retains a non-numeric draft with an accessible error instead of writing .nan', async () => {
    const user = userEvent.setup();
    const patchFrontmatter = setupNumberEditor();
    await user.click(screen.getByRole('button'));
    await user.type(screen.getByLabelText('Effort'), 'abc');
    fireEvent.blur(screen.getByLabelText('Effort'));
    expect(patchFrontmatter).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Effort').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('status').textContent).toContain('Enter a finite number.');
  });

  it('commits a numeric draft as a number', async () => {
    const user = userEvent.setup();
    const patchFrontmatter = setupNumberEditor();
    await user.click(screen.getByRole('button'));
    await user.type(screen.getByLabelText('Effort'), '5');
    fireEvent.blur(screen.getByLabelText('Effort'));
    expect(patchFrontmatter).toHaveBeenCalledWith('projects/onboarding/items/fld-1.md', {
      effort: 5,
    });
  });

  // M15: the read view seeded the draft from the FORMATTED display, so a
  // percent field opened holding "76%" and commit rejected the app's own
  // display string with "Enter a number" — the field was unusable.
  function setupFormattedEditor(format: 'percent' | 'currency') {
    const entries = fixtureVault();
    // The format lives on the TYPE — resolveField reads the declared def, not
    // the one handed to FieldEditor — so declare it there.
    const typeDoc = entries.find((e) => e.path === 'types/work-item.md')!;
    (typeDoc.properties as unknown as { fields: Record<string, unknown> }).fields.effort = {
      kind: 'number',
      format,
      precision: 0,
    };
    const entry = entries.find((e) => e.path === 'projects/onboarding/items/fld-1.md')!;
    entry.properties.effort = 1840;
    const schema = buildSchema(entries);
    const def = schema.types.get('Work item')!.fields.find((f) => f.name === 'effort')!;
    const patchFrontmatter = vi.fn().mockResolvedValue(true);
    useVaultStore.setState({ entries, patchFrontmatter });
    render(<FieldEditor entry={entry} def={def} schema={schema} />);
    return patchFrontmatter;
  }

  it('opens a currency field on the raw number, not "$1,840"', async () => {
    const user = userEvent.setup();
    setupFormattedEditor('currency');
    expect(screen.getByRole('button').textContent).toBe('$1,840');
    await user.click(screen.getByRole('button'));
    expect((screen.getByLabelText('Effort') as HTMLInputElement).value).toBe('1840');
  });

  it('accepts a retyped formatted value instead of toasting at it', async () => {
    const user = userEvent.setup();
    const patchFrontmatter = setupFormattedEditor('percent');
    await user.click(screen.getByRole('button'));
    const input = screen.getByLabelText('Effort');
    await user.clear(input);
    await user.type(input, '76%');
    fireEvent.blur(input);
    expect(patchFrontmatter).toHaveBeenCalledWith('projects/onboarding/items/fld-1.md', {
      effort: 76,
    });
    expect(useUiStore.getState().toasts.map((t) => t.message)).not.toContain('Enter a number');
  });
});
