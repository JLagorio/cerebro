import { useLayoutEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DetailPanel } from '@/detail/DetailPanel';
import { hasLayers, popLayer, pushLayer, resetLayers } from '@/components/ui/layers';
import { Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { FieldEditor } from '@/detail/FieldEditor';
import { FixedBelowAnchor } from '@/detail/FieldPopover';
import { buildSchema } from '@/engine/schema';
import * as ipc from '@/lib/ipc';
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
