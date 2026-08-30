import { useLayoutEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DetailPanel } from '@/detail/DetailPanel';
import { hasLayers, popLayer, pushLayer, resetLayers } from '@/components/ui/layers';
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

vi.mock('@/lib/ipc', () => ({
  readNote: vi.fn().mockResolvedValue('Existing body'),
  saveNote: vi.fn().mockResolvedValue(undefined),
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

afterEach(cleanup);

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
    useVaultStore.setState({ entries: fixtureVault(), vaultPath: '/vault' });
    useUiStore.setState({ detailPath: 'projects/onboarding/items/fld-1.md' });
  });

  it('writes a frontmatter patch when a status option is picked', async () => {
    const user = userEvent.setup();
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    useVaultStore.setState({ patchFrontmatter });
    render(<DetailPanel />);
    await user.click(screen.getByRole('button', { name: 'Todo' }));
    await user.click(screen.getByRole('option', { name: 'Doing' }));
    expect(patchFrontmatter).toHaveBeenCalledWith('projects/onboarding/items/fld-1.md', {
      status: 'doing',
    });
  });

  it('shows undeclared frontmatter keys as advisory text', () => {
    render(<DetailPanel />);
    expect(screen.getByText('Channel')).toBeTruthy();
    expect(screen.getByText('field-ops')).toBeTruthy();
  });

  // M34.5.3 — a cached copy says its own freshness. Gated on the fetch
  // bookkeeping properties, never on `type: Source`; extreme dates keep the
  // assertions clock-proof without pinning the system time.
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

  it('a record without fetch bookkeeping gets no freshness line at all', () => {
    render(<DetailPanel />);
    expect(screen.queryByTestId('detail-source-freshness')).toBeNull();
  });

  it('closes on Escape', () => {
    render(<DetailPanel />);
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

  it('toasts and reverts the title when the H1 rename fails (note 16a)', async () => {
    useUiStore.setState({ toasts: [] });
    vi.mocked(ipc.setNoteTitle).mockRejectedValueOnce(new Error('read-only vault'));
    render(<DetailPanel />);
    const input = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Renamed flow' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain("Couldn't rename item");
    });
    expect(input.value).toBe('Design first-run flow');
  });

  it('toasts when the body cannot be loaded (note 16a guard discipline)', async () => {
    useUiStore.setState({ toasts: [] });
    vi.mocked(ipc.readNote).mockRejectedValueOnce(new Error('gone'));
    render(<DetailPanel />);
    await waitFor(() => {
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain("Couldn't load page");
    });
  });

  // M1.x stale-body-after-rename, block edition: the editor keeps its
  // document across a rename (the file path doesn't change) — without the
  // splice, its next debounced save writes the OLD H1 back over the renamed
  // file. spliceTitleIntoBlocks unit coverage lives in markdown.test.ts.
  it('splices the new H1 into the live editor after a rename', async () => {
    vi.mocked(ipc.readNote).mockResolvedValueOnce('# Design first-run flow\n\nBody text\n');
    vi.mocked(ipc.scanVault).mockResolvedValue(fixtureVault());
    render(<DetailPanel />);
    await waitFor(() => expect(screen.getByText('Body text')).toBeTruthy(), { timeout: 5_000 });
    const input = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Renamed flow' } });
    fireEvent.blur(input);
    // The editor's H1 block now carries the new title...
    await waitFor(() => {
      expect(screen.getByTestId('markdown-editor').textContent).toContain('Renamed flow');
    });
    // ...and the splice-triggered debounced save writes it to disk.
    await waitFor(
      () => {
        const bodies = vi.mocked(ipc.saveNote).mock.calls.map((c) => c[2]);
        expect(bodies.some((b) => b.startsWith('# Renamed flow'))).toBe(true);
      },
      { timeout: 3_000 },
    );
  });

  /**
   * The SECOND rename must splice too (M45.6 review).
   *
   * `entry.title` sat in the editor-handle effect's dependency list, and a
   * rename changes exactly that and nothing else the panel keys on — the
   * path does not move (the case above states it: the file is rewritten in
   * place). So the effect fired, nulled `editorRef.current`, and the
   * NoteBodyEditor it was pointing at stayed mounted the whole time: nothing
   * ever handed the handle back. The next rename found null, skipped the
   * splice, and M1.x came back — the editor's next debounced save writing
   * the previous H1 over the newly renamed file.
   *
   * The fixture has to be able to SEE that: `scanVault` replays whatever
   * `setNoteTitle` was last given, so the rescan really does change
   * `entry.title` the way the app does. With a fixture that returns the
   * original titles forever, the effect never re-fires and this passes
   * whether or not the bug is present.
   */
  it('splices the second rename too — the handle survives the first', async () => {
    let renamed: string | null = null;
    vi.mocked(ipc.setNoteTitle).mockImplementation(async (_vault, _path, title) => {
      renamed = title;
    });
    vi.mocked(ipc.scanVault).mockImplementation(async () =>
      fixtureVault().map((e) =>
        e.path === 'projects/onboarding/items/fld-1.md' && renamed !== null
          ? { ...e, title: renamed }
          : e,
      ),
    );
    vi.mocked(ipc.readNote).mockResolvedValueOnce('# Design first-run flow\n\nBody text\n');
    render(<DetailPanel />);
    await waitFor(() => expect(screen.getByText('Body text')).toBeTruthy(), { timeout: 5_000 });
    const input = screen.getByLabelText('Title') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'Renamed once' } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(screen.getByTestId('markdown-editor').textContent).toContain('Renamed once'),
    );
    // The precondition, asserted rather than assumed: the rescan really did
    // change `entry.title`, which is the ONLY input the buggy dependency list
    // reacted to. Without this the case passes vacuously — a fixture whose
    // rescan replays the original titles never re-fires the effect, so it
    // cannot tell a fixed panel from a broken one.
    await waitFor(() =>
      expect(useVaultStore.getState().entries.find((e) => e.path === FLD_1)?.title).toBe(
        'Renamed once',
      ),
    );

    fireEvent.change(input, { target: { value: 'Renamed twice' } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(screen.getByTestId('markdown-editor').textContent).toContain('Renamed twice'),
    );
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
    await user.click(screen.getByTestId('detail-knowledge-toggle'));
    expect(screen.getByTestId('entity-dossier')).toBeTruthy();
    expect(screen.queryByTestId('related-knowledge')).toBeNull();
  });

  it('keeps the related list when the base only knows around the record', async () => {
    const user = userEvent.setup();
    render(<DetailPanel />);
    await user.click(screen.getByTestId('detail-knowledge-toggle'));
    expect(screen.getByTestId('related-knowledge')).toBeTruthy();
    expect(screen.queryByTestId('entity-dossier')).toBeNull();
  });

  // M33a.6 — the gate above decides WHICH surface answers, and for a while it
  // also decided whether you could ask anything at all: `Ask the base` shipped
  // on the related list only, so the records the base knew most about were
  // exactly the ones with no way to question it. Asserted on both arms of the
  // gate, because that is what let the two drift apart.
  it('offers Ask the base on whichever knowledge surface the gate picked', async () => {
    const user = userEvent.setup();
    render(<DetailPanel />);
    await user.click(screen.getByTestId('detail-knowledge-toggle'));
    expect(screen.getByRole('button', { name: 'Ask the base' })).toBeTruthy();

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
    await user.click(screen.getByTestId('detail-knowledge-toggle'));
    expect(screen.getByTestId('entity-dossier')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask the base' })).toBeTruthy();
    // Still distinct from the write-side act it used to sit alone beside.
    expect(screen.getByRole('button', { name: 'Learn from this page' })).toBeTruthy();
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
      const title = screen.getByTestId('detail-title');
      expect(title.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // The stack starts collapsed behind the strip…
      expect(screen.queryByRole('button', { name: '+ Add property' })).toBeNull();
      // …while the body section is untouched by the collapse (M44.1 display
      // config still owns it).
      expect(screen.getByTestId('detail-body-heading')).toBeTruthy();
      fireEvent.click(screen.getByTestId('view-details-toggle'));
      expect(screen.getByRole('button', { name: '+ Add property' })).toBeTruthy();
      fireEvent.click(screen.getByTestId('view-details-toggle'));
      expect(screen.queryByRole('button', { name: '+ Add property' })).toBeNull();
    });

    it('resets to the collapsed strip when the panel switches records', () => {
      withLayout({ heading: ['status'] });
      render(<DetailPanel />);
      fireEvent.click(screen.getByTestId('view-details-toggle'));
      expect(screen.getByRole('button', { name: '+ Add property' })).toBeTruthy();
      // act: a store write outside any event needs its re-render flushed
      // before the DOM assertion sees it.
      act(() => useUiStore.setState({ detailPath: 'projects/onboarding/items/fld-2.md' }));
      expect(screen.queryByRole('button', { name: '+ Add property' })).toBeNull();
      // …and COMING BACK resets too: the lens forgets a record it left, like
      // RecordProperties' keyed `revealed`. A one-slot {path, shown} cache
      // resurrected A's toggle on A→B→A while A→B(toggled)→A reset —
      // remembering was an accident of whose write survived, not a feature.
      act(() => useUiStore.setState({ detailPath: 'projects/onboarding/items/fld-1.md' }));
      expect(screen.queryByRole('button', { name: '+ Add property' })).toBeNull();
    });

    it('no layout → no strip, and the stack renders exactly as today', () => {
      render(<DetailPanel />);
      expect(screen.queryByTestId('heading-strip')).toBeNull();
      expect(screen.queryByTestId('view-details-toggle')).toBeNull();
      expect(screen.getByRole('button', { name: '+ Add property' })).toBeTruthy();
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
      expect(screen.getByRole('button', { name: '+ Add property' })).toBeTruthy();
    });
  });

  /**
   * M45.6 — the peek shows the record's tabs.
   *
   * The defect (user, 2026-08-29: "the tabs dont render in the UI"): the strip
   * mounted on the record PAGE and in the layout editor only, so a type whose
   * tabs were saved showed none on the surface a table row actually opens
   * into. Same gate as the page (SAVED tabs, never the synthesized Overview),
   * same four content arms, panel geometry — and the selection is LOCAL,
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

    it('a type with no saved tabs raises no strip, and the peek is what it was', () => {
      render(<DetailPanel />);
      expect(screen.queryByTestId('record-tabs')).toBeNull();
      // The synthesized Overview drives the content, never a one-tab strip.
      expect(screen.getByRole('button', { name: '+ Add property' })).toBeTruthy();
      expect(screen.getByTestId('detail-body-heading')).toBeTruthy();
    });

    it('an untyped note has no tabs at all', () => {
      useVaultStore.setState({
        entries: [...fixtureVault(), makeEntry({ path: 'notes/plain.md', title: 'Plain note' })],
      });
      useUiStore.setState({ detailPath: 'notes/plain.md' });
      render(<DetailPanel />);
      expect(screen.queryByTestId('record-tabs')).toBeNull();
      // …and its properties still render: no tabs is not no record surface.
      expect(screen.getByRole('button', { name: '+ Add property' })).toBeTruthy();
    });

    it('saved tabs raise the strip, under the heading strip and over the content', () => {
      withTabs([OVERVIEW, SPEC], { heading: ['status', 'priority'] });
      render(<DetailPanel />);
      const strip = screen.getByTestId('record-tabs');
      const heading = screen.getByTestId('heading-strip');
      const body = screen.getByTestId('detail-body-heading');
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
      expect(screen.getByRole('button', { name: '+ Add property' })).toBeTruthy();
      expect(screen.getByTestId('detail-body-heading')).toBeTruthy();
    });

    it('a properties tab is the stack alone — no body', () => {
      withTabs([{ id: 'props', name: 'Fields', content: 'properties' }, SPEC]);
      render(<DetailPanel />);
      expect(screen.getByRole('button', { name: '+ Add property' })).toBeTruthy();
      expect(screen.queryByTestId('detail-body-heading')).toBeNull();
    });

    it('a sections tab is its own free text — no stack, no body', () => {
      withTabs([SPEC, OVERVIEW]);
      render(<DetailPanel />);
      expect(screen.getByTestId('tab-sections')).toBeTruthy();
      expect(screen.queryByRole('button', { name: '+ Add property' })).toBeNull();
      expect(screen.queryByTestId('detail-body-heading')).toBeNull();
    });

    it('a view tab embeds its database in the peek', () => {
      withTabs([
        { id: 'items', name: 'Items', content: 'view', source: { type: 'Work item' } },
        OVERVIEW,
      ]);
      render(<DetailPanel />);
      expect(screen.getByTestId('view-tab-embed')).toBeTruthy();
      expect(screen.getByText('Wire field sync banner')).toBeTruthy();
      expect(screen.queryByRole('button', { name: '+ Add property' })).toBeNull();
      expect(screen.queryByTestId('detail-body-heading')).toBeNull();
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
      expect(screen.queryByTestId('detail-body-heading')).toBeNull();
      // A peek is not a place: the tab is local state, so nothing moved the
      // navigation selection the back button reads.
      expect(useNavStore.getState().selection).toEqual(where);
      fireEvent.click(screen.getByTestId('record-tab-overview'));
      expect(screen.getByTestId('detail-body-heading')).toBeTruthy();
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
      fireEvent.click(screen.getByTestId('record-tab-spec'));
      expect(screen.getByTestId('tab-sections')).toBeTruthy();

      // The type loses the open tab while the peek is standing on it.
      const typeDoc = entries.find((e) => e.path === 'types/work-item.md')!;
      (typeDoc.properties as unknown as Record<string, unknown>).tabs = [OVERVIEW];
      act(() => useVaultStore.setState({ entries: [...entries] }));

      expect(screen.queryByTestId('tab-sections')).toBeNull();
      // Overview's content, not an empty panel: the body and the stack.
      expect(screen.getByTestId('detail-body-heading')).toBeTruthy();
      expect(screen.getByRole('button', { name: '+ Add property' })).toBeTruthy();
      // And the strip says so. This is the assertion that discriminates: a
      // panel that let `activeTab` go null would render no strip at all (the
      // mount is gated on it) while still showing a body, so the two
      // assertions above would pass on a peek that had lost its tabs.
      expect(screen.getByTestId('record-tab-overview').getAttribute('aria-selected')).toBe('true');
    });

    /**
     * A tab press must not discard a rename in progress (M45.6 review).
     *
     * The panel's title input is state, seeded from `entry.title` by an
     * effect. That effect used to share a dependency list with the one that
     * drops the editor handle — and pressing a tab changes `showsBody`, which
     * the handle effect has to watch. Merged, the two would re-seed the input
     * from disk truth on every tab press, silently throwing away whatever the
     * user had typed and not yet committed. Split, only the handle reacts.
     */
    it('keeps an uncommitted rename when you press another tab', () => {
      withTabs([OVERVIEW, { id: 'props', name: 'Fields', content: 'properties' }]);
      render(<DetailPanel />);
      const input = screen.getByTestId('detail-title') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Half typed' } });
      fireEvent.click(screen.getByTestId('record-tab-props'));
      // The tab really did change (the body is gone), and the draft survived.
      expect(screen.queryByTestId('detail-body-heading')).toBeNull();
      expect((screen.getByTestId('detail-title') as HTMLInputElement).value).toBe('Half typed');
    });

    /**
     * The peek's chrome holds ONE position, whichever tab is open.
     *
     * Two things are pinned here, and they are the same fact. The Overview
     * tab is the pre-M45.6 panel line for line — the knowledge loop sits
     * above the Description, where it sat before tabs existed, so growing
     * tabs moved nothing for the vaults that have none. And on a view tab
     * the same block sits above the embedded table rather than however many
     * rows below it, which is what the alternative — hoisting the chrome on
     * view tabs only — was trying to buy, at the price of chrome that moves
     * when you press a tab.
     */
    it('puts the knowledge block in one place: above the tab’s content, always', () => {
      withTabs([
        OVERVIEW,
        { id: 'items', name: 'Items', content: 'view', source: { type: 'Work item' } },
      ]);
      render(<DetailPanel />);
      const above = (first: HTMLElement, second: HTMLElement) =>
        Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
      // Overview: exactly where it was before tabs.
      expect(
        above(screen.getByTestId('detail-knowledge'), screen.getByTestId('detail-body-heading')),
      ).toBe(true);
      // View: above the table, not buried under its rows.
      fireEvent.click(screen.getByTestId('record-tab-items'));
      expect(
        above(screen.getByTestId('detail-knowledge'), screen.getByTestId('view-tab-embed')),
      ).toBe(true);
    });

    /**
     * A record's properties must be reachable from at least ONE surface, and
     * the peek is the only surface a peek user has (M45.6 review).
     *
     * A type may declare tabs that ALL refuse the stack — every one Sections
     * or View. The record PAGE survives it: `DocSidePanel` renders the whole
     * unscoped stack beside the canvas whatever tab is open. The peek has no
     * side panel, so the same type left the record's groups and loose fields
     * with nowhere at all to render — only the heading strip survived,
     * because it sits outside the tab gate. The peek takes the side panel's
     * job instead: no tab bears properties, so the stack renders unscoped.
     */
    it('shows the whole stack when NO tab of the type bears properties', () => {
      withTabs(
        [
          { id: 'items', name: 'Items', content: 'view', source: { type: 'Work item' } },
          { id: 'notes', name: 'Notes', content: 'sections' },
        ],
        // A heading too, because it hides the second half of the hole: the
        // strip's expander is offered on Overview tabs only, so a stack
        // folded behind a toggle nothing renders is just as unreachable.
        {
          heading: ['status'],
          groups: [{ id: 'g-alpha', name: 'Alpha', fields: ['priority'] }],
        },
      );
      render(<DetailPanel />);
      // The view tab's own content still renders…
      expect(screen.getByTestId('view-tab-embed')).toBeTruthy();
      // …and so does every property that would otherwise have vanished: the
      // grouped one, the loose remainder, and the way to add more. Scoped to
      // the GROUP, because the embedded table below carries a column of the
      // same name — the peek shows `Priority` twice here, and only one of
      // them is the record's own property.
      const group = screen.getByTestId('property-group');
      expect(group.getAttribute('data-group')).toBe('g-alpha');
      expect(within(group).getByText('Priority')).toBeTruthy();
      // The undeclared key rides the stack's remainder, outside every group.
      expect(within(group).queryByText('Channel')).toBeNull();
      expect(screen.getAllByText('field-ops').length).toBeGreaterThan(0);
      expect(screen.getByRole('button', { name: '+ Add property' })).toBeTruthy();
      // Unscoped, so pressing the other tab changes the tab's content and
      // nothing about the stack — there is no tab to filter it for.
      fireEvent.click(screen.getByTestId('record-tab-notes'));
      expect(screen.getByTestId('tab-sections')).toBeTruthy();
      expect(screen.getByTestId('property-group').getAttribute('data-group')).toBe('g-alpha');
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
      const entries = withTabs([OVERVIEW, { id: 'props', name: 'Fields', content: 'properties' }]);
      const typeProps = entries.find((e) => e.path === 'types/work-item.md')!.properties as unknown;
      (typeProps as { fields: Record<string, unknown> }).fields.due = {
        kind: 'date',
        visibility: 'hide_when_empty',
      };
      useVaultStore.setState({ entries: [...entries] });
      render(<DetailPanel />);
      const toggle = () => screen.getByTestId('hidden-properties-toggle');
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(toggle());
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      // A different tab, the same stack: the reveal is still open.
      fireEvent.click(screen.getByTestId('record-tab-props'));
      expect(screen.queryByTestId('detail-body-heading')).toBeNull();
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
     * M45.6 Task 3 — and the tabs HOLD things. The peek resolves its layout
     * FOR the open tab, so a section shows on its own tab and nowhere else,
     * while an untabbed one keeps the only home it ever had.
     */
    describe('sections belong to tabs', () => {
      const ONE = { id: 'one', name: 'One', content: 'overview' };
      const TWO = { id: 'two', name: 'Two', content: 'properties' };
      // No heading here: the strip would fold the Overview tab's stack behind
      // its toggle, which is a different case (asserted below).
      const SECTIONED = {
        groups: [
          { id: 'g-alpha', name: 'Alpha', fields: ['priority'], tab: 'one' },
          { id: 'g-beta', name: 'Beta', fields: ['assignee'], tab: 'two' },
          { id: 'g-gamma', name: 'Gamma', fields: ['due'] },
        ],
      };
      const groupIds = () =>
        screen.queryAllByTestId('property-group').map((g) => g.getAttribute('data-group'));

      it('the peek shows the open tab’s sections, and swaps them on a press', () => {
        withTabs([ONE, TWO], SECTIONED);
        render(<DetailPanel />);
        // The default tab: its own section plus the untabbed one.
        expect(groupIds()).toEqual(['g-alpha', 'g-gamma']);
        fireEvent.click(screen.getByTestId('record-tab-two'));
        expect(groupIds()).toEqual(['g-beta']);
        expect(screen.queryByText('Alpha')).toBeNull();
        expect(screen.queryByText('Gamma')).toBeNull();
      });

      // The leak `rest` would spring if the tab filter ran before the roster
      // was counted: a field another tab's section claims would look
      // unclaimed here and render loose, showing one property on two tabs.
      it('a field another tab’s section claims never renders loose', () => {
        withTabs([ONE, TWO], SECTIONED);
        render(<DetailPanel />);
        expect(screen.queryByText('Assignee')).toBeNull();
        fireEvent.click(screen.getByTestId('record-tab-two'));
        expect(screen.getByText('Assignee')).toBeTruthy();
        expect(screen.queryByText('Priority')).toBeNull();
        expect(screen.queryByText('Due')).toBeNull();
      });

      // The heading is global by decision — Notion's heading block sits above
      // the tab bar, and ours renders over the strip on every tab.
      it('the heading strip stands on every tab', () => {
        withTabs([{ id: 'one', name: 'One', content: 'properties' }, TWO], {
          heading: ['status'],
          groups: SECTIONED.groups,
        });
        render(<DetailPanel />);
        expect(screen.getByTestId('heading-strip')).toBeTruthy();
        expect(groupIds()).toEqual(['g-alpha', 'g-gamma']);
        fireEvent.click(screen.getByTestId('record-tab-two'));
        expect(screen.getByTestId('heading-strip')).toBeTruthy();
        expect(groupIds()).toEqual(['g-beta']);
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

    it('shows the Description section by default and drops it on show_body: false', () => {
      withDisplay({});
      const { unmount } = render(<DetailPanel />);
      expect(screen.getByTestId('detail-body-heading')).toBeTruthy();
      unmount();
      withDisplay({ show_body: false });
      render(<DetailPanel />);
      expect(screen.queryByTestId('detail-body-heading')).toBeNull();
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
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    useVaultStore.setState({ entries, patchFrontmatter });
    render(<FieldEditor entry={entry} def={{ name: 'effort', kind: 'number' }} schema={schema} />);
    return patchFrontmatter;
  }

  it('refuses a non-numeric draft with a toast instead of writing .nan', async () => {
    const user = userEvent.setup();
    const patchFrontmatter = setupNumberEditor();
    await user.click(screen.getByRole('button'));
    await user.type(screen.getByLabelText('Effort'), 'abc');
    fireEvent.blur(screen.getByLabelText('Effort'));
    expect(patchFrontmatter).not.toHaveBeenCalled();
    expect(useUiStore.getState().toasts.map((t) => t.message)).toContain('Enter a number');
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
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
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
