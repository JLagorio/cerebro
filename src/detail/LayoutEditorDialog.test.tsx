// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  LayoutEditorDialog,
  draftDirty,
  seedDraft,
  updateDraft,
} from '@/detail/LayoutEditorDialog';
import { draftRoster, overlayVisibility } from '@/detail/LayoutCanvas';
import type { TypeLayoutDraft } from '@/app/typeActions';
import { resetLayers } from '@/components/ui/layers';
import { DISPLAY_DEFAULTS, type FieldDef, type TypeDef } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';

const DOC = 'types/work-item.md';

/** The schema builds a TypeDef only from a Type doc (the DetailHeaderActions
 * idiom), so the fixture seeds one whose `layout:` carries a dead pointer —
 * the seed-prunes-on-Apply path needs it. `display.show_file` deviates from
 * the defaults so Apply always has a real patch to send. `tabs` opts a test
 * into the saved-tabs seed (Tabbed active at open). `notes` stays unplaced by
 * `layout:` so the preview canvas has a REST field to render headerless. */
function typeDoc(tabs?: unknown[]) {
  return makeEntry({
    path: DOC,
    title: 'Work item',
    type: 'Type',
    properties: {
      fields: { status: 'text', priority: 'text', notes: 'text' },
      display: { show_file: true },
      layout: {
        heading: ['status', 'ghost'],
        groups: [{ id: 'g1', name: 'Planning', fields: ['priority'] }],
      },
      ...(tabs !== undefined ? { tabs } : {}),
      // Nested Type-doc blocks, the typeActions.test cast idiom.
    } as unknown as ReturnType<typeof makeEntry>['properties'],
  });
}

function setup(
  opts: {
    patchFrontmatter?: ReturnType<typeof vi.fn>;
    entries?: ReturnType<typeof makeEntry>[];
  } = {},
) {
  const patchFrontmatter = opts.patchFrontmatter ?? vi.fn().mockResolvedValue(true);
  useVaultStore.setState({
    entries: opts.entries ?? [typeDoc()],
    vaultPath: '/vault',
    patchFrontmatter,
  });
  useUiStore.setState({ layoutEditor: { type: 'Work item' }, toasts: [] });
  render(<LayoutEditorDialog />);
  return { patchFrontmatter };
}

/** A TypeDef literal for the pure helpers — no vault machinery needed. */
function def(partial: Partial<TypeDef> = {}): TypeDef {
  return {
    name: 'Work item',
    icon: null,
    color: null,
    fields: [
      { name: 'status', kind: 'text' },
      { name: 'priority', kind: 'text' },
    ],
    statuses: [],
    folder: null,
    views: [],
    display: { ...DISPLAY_DEFAULTS },
    layout: { heading: [], groups: [] },
    tabs: [],
    ...partial,
  };
}

/** What Apply is expected to hand patchFrontmatter for the fixture doc:
 * pruned heading, groups verbatim, the deviating display bit, no tabs. */
const FIXTURE_PATCH = {
  display: { show_file: true },
  layout: { heading: ['status'], groups: [{ id: 'g1', name: 'Planning', fields: ['priority'] }] },
  tabs: null,
};

describe('seedDraft', () => {
  it('copies display and tabs verbatim, without aliasing the schema objects', () => {
    const typeDef = def({
      display: { showEmpty: true, showFile: false, showBody: true },
      tabs: [{ id: 'overview', name: 'Overview', icon: null, content: 'overview' }],
    });
    const draft = seedDraft(typeDef);
    expect(draft.display).toEqual(typeDef.display);
    expect(draft.display).not.toBe(typeDef.display);
    expect(draft.tabs).toEqual(typeDef.tabs);
    expect(draft.tabs[0]).not.toBe(typeDef.tabs[0]);
    expect(draft.visibility).toEqual({});
    expect(draft.added).toEqual([]);
  });

  it('prunes dead pointers and keeps empty groups, ids and names verbatim', () => {
    const draft = seedDraft(
      def({
        layout: {
          heading: ['status', 'ghost'],
          groups: [
            { id: 'g1', name: 'Planning', fields: ['phantom', 'priority'] },
            { id: 'g2', name: 'Empty', fields: [] },
          ],
        },
      }),
    );
    expect(draft.layout).toEqual({
      heading: ['status'],
      groups: [
        { id: 'g1', name: 'Planning', fields: ['priority'] },
        { id: 'g2', name: 'Empty', fields: [] },
      ],
    });
  });
});

describe('draftDirty', () => {
  it('treats identical deep copies as clean', () => {
    const seed = seedDraft(
      def({
        layout: { heading: ['status'], groups: [{ id: 'g1', name: 'Planning', fields: [] }] },
        tabs: [{ id: 'overview', name: 'Overview', icon: null, content: 'overview' }],
      }),
    );
    const copy: TypeLayoutDraft = {
      display: { ...seed.display },
      layout: {
        heading: [...seed.layout.heading],
        groups: seed.layout.groups.map((g) => ({ ...g, fields: [...g.fields] })),
      },
      tabs: seed.tabs.map((t) => ({ ...t })),
      visibility: {},
      added: [],
    };
    expect(draftDirty(copy, seed)).toBe(false);
  });

  it('a group rename dirties', () => {
    const seed = seedDraft(
      def({ layout: { heading: [], groups: [{ id: 'g1', name: 'Planning', fields: [] }] } }),
    );
    const draft = updateDraft(seed, {
      layout: { heading: [], groups: [{ id: 'g1', name: 'Renamed', fields: [] }] },
    });
    expect(draftDirty(draft, seed)).toBe(true);
  });

  it('array order matters — a reorder is an edit', () => {
    const seed = seedDraft(def({ layout: { heading: ['status', 'priority'], groups: [] } }));
    const draft = updateDraft(seed, { layout: { heading: ['priority', 'status'], groups: [] } });
    expect(draftDirty(draft, seed)).toBe(true);
  });

  it('a display toggle and a tab change both dirty', () => {
    const seed = seedDraft(def());
    expect(
      draftDirty(updateDraft(seed, { display: { ...seed.display, showBody: false } }), seed),
    ).toBe(true);
    expect(
      draftDirty(
        updateDraft(seed, {
          tabs: [{ id: 'overview', name: 'Overview', icon: null, content: 'overview' }],
        }),
        seed,
      ),
    ).toBe(true);
  });
});

describe('overlayVisibility', () => {
  it('overlays staged visibility, clears on null, and keeps untouched defs by reference', () => {
    const fields: FieldDef[] = [
      { name: 'status', kind: 'text', visibility: 'hide' },
      { name: 'priority', kind: 'text' },
      { name: 'notes', kind: 'text' },
    ];
    const out = overlayVisibility(fields, { status: null, priority: 'hide' });
    // A staged null clears back to show — the key deletes on Apply, so the
    // overlay drops the def's own visibility the same way.
    expect(out[0].visibility).toBeUndefined();
    expect(out[1].visibility).toBe('hide');
    expect(out[2]).toBe(fields[2]);
    // Pure: the input defs never mutate.
    expect(fields[0].visibility).toBe('hide');
    expect(fields[1].visibility).toBeUndefined();
  });

  it('an empty stage returns the same array', () => {
    const fields: FieldDef[] = [{ name: 'status', kind: 'text' }];
    expect(overlayVisibility(fields, {})).toBe(fields);
  });
});

describe('draftRoster (M45.3 Task 4)', () => {
  it('appends staged added fields as FieldDefs — config spread under name/kind', () => {
    const fields: FieldDef[] = [{ name: 'status', kind: 'text' }];
    // A hand-built draft through the exported door: `added` stays empty until
    // Task 5 wires AddPropertyPanel, so the seam is exercised the way Apply
    // builds its defs (typeActions' {...config, name, kind} spread).
    const draft = updateDraft(seedDraft(def()), {
      added: [{ name: 'estimate', kind: 'number', config: { visibility: 'hide_when_empty' } }],
    });
    const out = draftRoster(fields, draft.added);
    expect(out).toEqual([
      { name: 'status', kind: 'text' },
      { name: 'estimate', kind: 'number', visibility: 'hide_when_empty' },
    ]);
    // Pure: the declared roster never mutates.
    expect(fields).toHaveLength(1);
  });

  it('no staged additions returns the same array', () => {
    const fields: FieldDef[] = [{ name: 'status', kind: 'text' }];
    expect(draftRoster(fields, [])).toBe(fields);
  });
});

describe('LayoutEditorDialog', () => {
  beforeEach(() => {
    resetLayers();
  });
  afterEach(() => {
    cleanup();
    useUiStore.setState({ layoutEditor: null });
  });

  it('opens from the signal with ONE header naming the type', () => {
    setup();
    expect(screen.getByTestId('layout-editor')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Customize Work item layout' })).toBeTruthy();
    // One-header anatomy (spec §3.2): the Dialog's title bar names the type;
    // the toolbar carries only the icon — no duplicate name span.
    expect(screen.queryByText('Work item')).toBeNull();
    expect(screen.getByTestId('layout-preview')).toBeTruthy();
    expect(screen.getByTestId('layout-rail')).toBeTruthy();
  });

  it('a retargeted signal reseeds the draft — no confirm, no carried edits', async () => {
    const user = userEvent.setup();
    const bugDoc = makeEntry({
      path: 'types/bug.md',
      title: 'Bug',
      type: 'Type',
      properties: {
        fields: { severity: 'text' },
      } as unknown as ReturnType<typeof makeEntry>['properties'],
    });
    setup({ entries: [typeDoc(), bugDoc] });
    // Dirty Work item's draft: Show body flips its default true → false.
    await user.click(screen.getByRole('switch', { name: 'Show body' }));
    expect((screen.getByRole('switch', { name: 'Show body' }) as HTMLInputElement).checked).toBe(
      false,
    );

    // Retarget the SIGNAL under the open editor — key={signal.type} must
    // remount the card, not edit Work item's draft under Bug's name.
    act(() => {
      useUiStore.setState({ layoutEditor: { type: 'Bug' } });
    });
    expect(screen.getByRole('dialog', { name: 'Customize Bug layout' })).toBeTruthy();
    // No confirm fired: the old card unmounted; it did not "close dirty".
    expect(screen.queryByText('Discard layout changes?')).toBeNull();
    // Bug's CLEAN seed, not Work item's edited draft: Show body back at its
    // default, and Show file at Bug's false where the fixture deviated true.
    expect((screen.getByRole('switch', { name: 'Show body' }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(
      (screen.getByRole('switch', { name: 'Show file path' }) as HTMLInputElement).checked,
    ).toBe(false);
    // And the reseeded draft IS clean: Cancel closes without a confirm.
    await user.click(screen.getByTestId('layout-cancel'));
    expect(screen.queryByText('Discard layout changes?')).toBeNull();
    expect(useUiStore.getState().layoutEditor).toBeNull();
  });

  it('renders nothing and puts the signal down when the type vanished', async () => {
    setup({ entries: [] });
    expect(screen.queryByTestId('layout-editor')).toBeNull();
    await waitFor(() => expect(useUiStore.getState().layoutEditor).toBeNull());
  });

  it('Cancel with an untouched draft closes without a confirm and without a write', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(screen.getByTestId('layout-cancel'));
    expect(screen.queryByText('Discard layout changes?')).toBeNull();
    expect(useUiStore.getState().layoutEditor).toBeNull();
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });

  it('Cancel with an edited draft confirms; Keep editing returns, Discard closes without a write', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(screen.getByRole('switch', { name: 'Show body' }));

    await user.click(screen.getByTestId('layout-cancel'));
    expect(screen.getByText('Discard layout changes?')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByText('Discard layout changes?')).toBeNull();
    expect(screen.getByTestId('layout-editor')).toBeTruthy();

    await user.click(screen.getByTestId('layout-cancel'));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(useUiStore.getState().layoutEditor).toBeNull();
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });

  it('Escape with the confirm open dismisses the confirm, not the editor', () => {
    setup();
    fireEvent.click(screen.getByRole('switch', { name: 'Show body' }));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByText('Discard layout changes?')).toBeTruthy();

    // The confirm is a SIBLING Dialog registered above the fullscreen one, so
    // the layers stack hands it the keystroke (ownsEscape) — one Escape must
    // dismiss one surface, and the editor stays.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Discard layout changes?')).toBeNull();
    expect(screen.getByTestId('layout-editor')).toBeTruthy();
  });

  it('Apply writes the draft once — pruned layout included — and closes on true', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(screen.getByTestId('layout-apply'));
    await waitFor(() => expect(useUiStore.getState().layoutEditor).toBeNull());
    expect(patchFrontmatter).toHaveBeenCalledTimes(1);
    expect(patchFrontmatter).toHaveBeenCalledWith(DOC, FIXTURE_PATCH);
  });

  it('a failed Apply keeps the editor open with the EDITED draft intact', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup({
      patchFrontmatter: vi.fn().mockResolvedValue(false),
    });
    // Edit first: an untouched draft cannot distinguish survived from
    // reseeded — the M14.8 claim is that the user's WORK survives a failure.
    await user.click(screen.getByRole('switch', { name: 'Show body' }));
    await user.click(screen.getByTestId('layout-apply'));
    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('layout-editor')).toBeTruthy();

    // The second Apply CARRIES the edit: a reseeded draft would send the
    // fixture's saved display without show_body.
    await user.click(screen.getByTestId('layout-apply'));
    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalledTimes(2));
    expect(patchFrontmatter).toHaveBeenNthCalledWith(2, DOC, {
      ...FIXTURE_PATCH,
      display: { show_file: true, show_body: false },
    });
  });

  it('busy disables Apply, so a double-fire writes once', async () => {
    let resolvePatch: ((v: boolean) => void) | undefined;
    const patchFrontmatter = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePatch = resolve;
        }),
    );
    setup({ patchFrontmatter });

    const apply = screen.getByTestId('layout-apply') as HTMLButtonElement;
    fireEvent.click(apply);
    expect(apply.disabled).toBe(true);
    fireEvent.click(apply);

    await act(async () => {
      resolvePatch?.(true);
      await Promise.resolve();
    });
    expect(patchFrontmatter).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(useUiStore.getState().layoutEditor).toBeNull());
  });
});

describe('the Page settings rail (M45.2 Task 3)', () => {
  beforeEach(() => {
    resetLayers();
  });
  afterEach(() => {
    cleanup();
    useUiStore.setState({ layoutEditor: null });
  });

  const railSwitch = (name: string) => screen.getByRole('switch', { name }) as HTMLInputElement;

  const OVERVIEW_TAB = { id: 'overview', name: 'Overview', icon: null, content: 'overview' };
  const SAVED_TABS = [
    { id: 'plan', name: 'Plan', icon: null, content: 'sections' },
    { id: 'props', name: 'Props', icon: null, content: 'properties' },
  ];

  it('shows Structure tiles and Options switches seeded from the type', () => {
    setup();
    const rail = screen.getByTestId('layout-rail');
    expect(rail.textContent).toContain('Structure');
    expect(rail.textContent).toContain('Options');
    // Tabbed active ⟺ draft.tabs.length > 0 — the fixture has no tabs.
    expect(screen.getByTestId('layout-structure-simple').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('layout-structure-tabbed').getAttribute('aria-pressed')).toBe(
      'false',
    );
    // Seeded from the fixture's display: show_file deviates, the rest default.
    expect(railSwitch('Show empty properties').checked).toBe(false);
    expect(railSwitch('Show file path').checked).toBe(true);
    expect(railSwitch('Show body').checked).toBe(true);
  });

  it('a switch toggle edits the DRAFT only; Apply carries it', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(railSwitch('Show body'));
    expect(railSwitch('Show body').checked).toBe(false);
    // Nothing writes until Apply — the draft is the only thing that moved.
    expect(patchFrontmatter).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('layout-apply'));
    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalledTimes(1));
    expect(patchFrontmatter).toHaveBeenCalledWith(DOC, {
      ...FIXTURE_PATCH,
      display: { show_file: true, show_body: false },
    });
  });

  it('Simple→Tabbed on an empty draft seeds the explicit Overview tab', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(screen.getByTestId('layout-structure-tabbed'));
    expect(screen.getByTestId('layout-structure-tabbed').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('layout-structure-simple').getAttribute('aria-pressed')).toBe(
      'false',
    );

    await user.click(screen.getByTestId('layout-apply'));
    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalledTimes(1));
    expect(patchFrontmatter).toHaveBeenCalledWith(DOC, { ...FIXTURE_PATCH, tabs: [OVERVIEW_TAB] });
  });

  it('a type WITH saved tabs seeds Tabbed active, and Simple empties them', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup({ entries: [typeDoc(SAVED_TABS)] });
    expect(screen.getByTestId('layout-structure-tabbed').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('layout-structure-simple').getAttribute('aria-pressed')).toBe(
      'false',
    );

    await user.click(screen.getByTestId('layout-structure-simple'));
    expect(screen.getByTestId('layout-structure-simple').getAttribute('aria-pressed')).toBe('true');

    await user.click(screen.getByTestId('layout-apply'));
    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalledTimes(1));
    // tabs: [] serializes to null — the key deletes at the default.
    expect(patchFrontmatter).toHaveBeenCalledWith(DOC, FIXTURE_PATCH);
  });

  it('clicking the already-active tile is a no-op — no dirty, no confirm', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(screen.getByTestId('layout-structure-simple'));
    await user.click(screen.getByTestId('layout-cancel'));
    expect(screen.queryByText('Discard layout changes?')).toBeNull();
    expect(useUiStore.getState().layoutEditor).toBeNull();
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });

  it('clicking Tabbed while Tabbed keeps the saved tabs — never reseeds Overview', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup({ entries: [typeDoc(SAVED_TABS)] });
    await user.click(screen.getByTestId('layout-structure-tabbed'));
    await user.click(screen.getByTestId('layout-cancel'));
    expect(screen.queryByText('Discard layout changes?')).toBeNull();
    expect(useUiStore.getState().layoutEditor).toBeNull();
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });
});

describe('the inert preview canvas + record picker (M45.2 Task 4)', () => {
  beforeEach(() => {
    resetLayers();
  });
  afterEach(() => {
    cleanup();
    useUiStore.setState({ layoutEditor: null });
  });

  /** Deliberately out of title order: the roster must sort, not inherit. */
  const RECORDS = [
    makeEntry({
      path: 'items/beta.md',
      title: 'Beta record',
      type: 'Work item',
      properties: { status: 'doing', priority: 'low' },
    }),
    makeEntry({
      path: 'items/alpha.md',
      title: 'Alpha record',
      type: 'Work item',
      properties: { status: 'todo', priority: 'high' },
    }),
  ];
  /** Sorts FIRST by title — if the isTemplate filter were missing, this
   * would become the default preview record, not just an extra option. */
  const TEMPLATE = makeEntry({
    path: 'templates/work-item.md',
    title: 'A work item template',
    type: 'Work item',
  });

  const recordSetup = () => setup({ entries: [typeDoc(), ...RECORDS, TEMPLATE] });

  it('renders the draft on the first record by title — heading cell, group, rest', () => {
    recordSetup();
    const preview = within(screen.getByTestId('layout-preview'));
    // Draft heading (pruned to survivors): the status cell, with Alpha's value.
    const strip = preview.getByTestId('heading-strip');
    expect(strip.querySelector('[data-field="status"]')).toBeTruthy();
    expect(strip.textContent).toContain('todo');
    // The draft group renders as a container; its name lives on the SHELL's
    // always-visible header, not inside the content (M45.5 one label per zone).
    const group = preview.getByTestId('property-group');
    expect(group.getAttribute('data-group')).toBe('g1');
    expect(group.textContent).not.toContain('Planning');
    expect(group.textContent).toContain('high');
    const shell = group.closest('[data-testid="layout-block"]');
    expect(shell?.textContent).toContain('Planning');
    // The unplaced field lands after the groups, headerless.
    expect(preview.getByText('Notes')).toBeTruthy();
  });

  it('the picker lists the roster by title, template excluded, first as default', () => {
    recordSetup();
    const picker = screen.getByTestId('layout-preview-picker') as HTMLSelectElement;
    const labels = within(picker)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).toEqual(['Alpha record', 'Beta record']);
    expect(picker.value).toBe('items/alpha.md');
  });

  it('switching the preview record re-renders the values', async () => {
    const user = userEvent.setup();
    recordSetup();
    const picker = screen.getByTestId('layout-preview-picker');
    await user.selectOptions(picker, 'items/beta.md');
    const preview = within(screen.getByTestId('layout-preview'));
    expect(preview.queryByText('todo')).toBeNull();
    expect(preview.getByTestId('heading-strip').textContent).toContain('doing');
    expect(preview.getByTestId('property-group').textContent).toContain('low');
  });

  it('Show body gates the body block live — the draft is the single source', async () => {
    const user = userEvent.setup();
    recordSetup();
    // The fixture leaves show_body at its default (true).
    expect(screen.getByTestId('layout-preview-body')).toBeTruthy();
    await user.click(screen.getByRole('switch', { name: 'Show body' }));
    expect(screen.queryByTestId('layout-preview-body')).toBeNull();
    await user.click(screen.getByRole('switch', { name: 'Show body' }));
    expect(screen.getByTestId('layout-preview-body')).toBeTruthy();
  });

  it('the tab strip renders only while the draft has tabs', async () => {
    const user = userEvent.setup();
    recordSetup();
    expect(screen.queryByTestId('record-tabs')).toBeNull();
    await user.click(screen.getByTestId('layout-structure-tabbed'));
    expect(screen.getByTestId('record-tabs')).toBeTruthy();
    await user.click(screen.getByTestId('layout-structure-simple'));
    expect(screen.queryByTestId('record-tabs')).toBeNull();
  });

  it('Show file path gates the muted file row live', async () => {
    const user = userEvent.setup();
    recordSetup();
    // The fixture's display deviates with show_file: true, so the row is up.
    const row = screen.getByTestId('layout-preview-file');
    expect(row.textContent).toBe('items/alpha.md');
    await user.click(screen.getByRole('switch', { name: 'Show file path' }));
    expect(screen.queryByTestId('layout-preview-file')).toBeNull();
    await user.click(screen.getByRole('switch', { name: 'Show file path' }));
    expect(screen.getByTestId('layout-preview-file')).toBeTruthy();
  });

  it('the synthetic record never shows a file row — it has no path, and absent is never faked', () => {
    // Zero records; the fixture's show_file is ON, so only the missing path
    // can be what keeps the row down.
    setup();
    expect(
      (screen.getByRole('switch', { name: 'Show file path' }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.queryByTestId('layout-preview-file')).toBeNull();
  });

  it('the heading strip folds an empty cell by the DRAFT showEmpty, not the live type', async () => {
    const user = userEvent.setup();
    // Folding is `hide_when_empty`'s job (a default `show` field renders an
    // unfolded "Empty" cell — M16.10), so the fixture marks the heading field
    // and the record leaves it valueless.
    setup({
      entries: [
        makeEntry({
          path: DOC,
          title: 'Work item',
          type: 'Type',
          properties: {
            fields: { status: { kind: 'text', visibility: 'hide_when_empty' }, priority: 'text' },
            display: { show_file: true },
            layout: {
              heading: ['status'],
              groups: [{ id: 'g1', name: 'Planning', fields: ['priority'] }],
            },
          } as unknown as ReturnType<typeof makeEntry>['properties'],
        }),
        makeEntry({
          path: 'items/bare.md',
          title: 'Bare record',
          type: 'Work item',
          properties: { priority: 'high' },
        }),
      ],
    });
    const preview = () => within(screen.getByTestId('layout-preview'));
    // Draft showEmpty is false: the empty status cell folds, and with it the
    // whole strip (its only cell).
    expect(preview().queryByTestId('heading-strip')).toBeNull();
    // The rail switch edits the DRAFT only — the live type still says false,
    // so a live-display read would keep the strip folded here.
    await user.click(screen.getByRole('switch', { name: 'Show empty properties' }));
    expect(
      preview().getByTestId('heading-strip').querySelector('[data-field="status"]'),
    ).toBeTruthy();
    await user.click(screen.getByRole('switch', { name: 'Show empty properties' }));
    expect(preview().queryByTestId('heading-strip')).toBeNull();
  });

  it('a picked record deleted mid-session falls back to the first by title', async () => {
    const user = userEvent.setup();
    recordSetup();
    await user.selectOptions(screen.getByTestId('layout-preview-picker'), 'items/beta.md');
    const strip = () => within(screen.getByTestId('layout-preview')).getByTestId('heading-strip');
    expect(strip().textContent).toContain('doing');

    // Beta vanishes from the store under the open editor.
    act(() => {
      useVaultStore.setState({ entries: [typeDoc(), RECORDS[1], TEMPLATE] });
    });
    const picker = screen.getByTestId('layout-preview-picker') as HTMLSelectElement;
    expect(picker.value).toBe('items/alpha.md');
    expect(strip().textContent).toContain('todo');
  });

  it('the inert boundary sits at each preview FRAGMENT — canvas, shells and drag layer are live', () => {
    recordSetup();
    // The boundary moved inward twice (M45.3): Task 4 took it off the canvas
    // onto each block's content, and Task 6 split that content into
    // per-fragment wrappers so drag slots and grips could stand LIVE between
    // them. The claim is unchanged in spirit: everything preview is inert,
    // everything interactive is not (the drag layer's own placement is
    // asserted in LayoutCanvas.test.tsx).
    expect(screen.getByTestId('layout-preview').hasAttribute('inert')).toBe(false);
    const contents = screen.getAllByTestId('layout-preview-content');
    expect(contents.length).toBeGreaterThan(0);
    for (const content of contents) {
      expect(content.hasAttribute('inert')).toBe(true);
      // inert already removes the subtree from the a11y tree; a second claim
      // via aria-hidden could only drift from the first (plan Decision).
      expect(content.hasAttribute('aria-hidden')).toBe(false);
    }
    for (const shell of screen.getAllByTestId('layout-block')) {
      expect(shell.hasAttribute('inert')).toBe(false);
    }
  });

  it('zero records renders the synthetic preview — no crash, no picker, no store write', () => {
    // Default setup: the Type doc only, no records of the type.
    const { patchFrontmatter } = setup();
    expect(screen.getByTestId('layout-preview')).toBeTruthy();
    expect(screen.queryByTestId('layout-preview-picker')).toBeNull();
    // The synthetic entry lives in memory only — never written, never stored.
    expect(patchFrontmatter).not.toHaveBeenCalled();
    expect(useVaultStore.getState().entries).toHaveLength(1);
  });
});

describe('the canvas folds what the page folds (M45.3 Task 1)', () => {
  beforeEach(() => {
    resetLayers();
  });
  afterEach(() => {
    cleanup();
    useUiStore.setState({ layoutEditor: null });
  });

  it('a visibility:hide field folds out, but its emptied group KEEPS its shell', () => {
    setup({
      entries: [
        makeEntry({
          path: DOC,
          title: 'Work item',
          type: 'Type',
          properties: {
            fields: {
              status: 'text',
              priority: { kind: 'text', visibility: 'hide' },
              notes: 'text',
            },
            layout: {
              heading: ['status'],
              groups: [{ id: 'g1', name: 'Planning', fields: ['priority'] }],
            },
          } as unknown as ReturnType<typeof makeEntry>['properties'],
        }),
        makeEntry({
          path: 'items/alpha.md',
          title: 'Alpha record',
          type: 'Work item',
          properties: { status: 'todo', priority: 'high', notes: 'keep' },
        }),
      ],
    });
    const preview = within(screen.getByTestId('layout-preview'));
    // The page folds `hide` behind its expander; the canvas has no expander —
    // the ROW renders nothing. But the group's SHELL persists (the Task 4
    // review ruling: "the editor is where hidden things stay visible") — a
    // fold-emptied container must stay clickable, or the only door to
    // un-hiding its fields would fold away with them.
    expect(preview.queryByText('Priority')).toBeNull();
    expect(preview.queryByText('high')).toBeNull();
    expect(preview.queryByTestId('property-group')).toBeNull();
    const shell = screen
      .getAllByTestId('layout-block')
      .find((b) => b.getAttribute('data-block') === 'g1');
    if (shell === undefined) throw new Error('fold-emptied group shell missing');
    expect(shell.textContent).toContain('Planning');
    // Fold-emptied says so — DISTINCT from the structurally-empty hint,
    // because "hidden" and "absent" are different sentences.
    expect(shell.textContent).toContain('All properties hidden');
    expect(shell.textContent).not.toContain('No properties yet');
    // The rest field still renders — folding is per-row, not per-canvas.
    expect(preview.getByText('Notes')).toBeTruthy();
  });

  it('the heading shell persists when the strip folds empty — it is the promote target', () => {
    setup({
      entries: [
        makeEntry({
          path: DOC,
          title: 'Work item',
          type: 'Type',
          properties: {
            fields: { status: { kind: 'text', visibility: 'hide_when_empty' }, priority: 'text' },
            layout: {
              heading: ['status'],
              groups: [{ id: 'g1', name: 'Planning', fields: ['priority'] }],
            },
          } as unknown as ReturnType<typeof makeEntry>['properties'],
        }),
        makeEntry({
          path: 'items/bare.md',
          title: 'Bare record',
          type: 'Work item',
          properties: { priority: 'high' },
        }),
      ],
    });
    // The strip itself folds away (stripCells' own rule, asserted in the
    // M45.2 suite) — but the SHELL stays: "Move to heading" needs somewhere
    // to point even while nothing currently shows there.
    expect(within(screen.getByTestId('layout-preview')).queryByTestId('heading-strip')).toBeNull();
    const shell = screen
      .getAllByTestId('layout-block')
      .find((b) => b.getAttribute('data-block') === 'heading');
    if (shell === undefined) throw new Error('heading shell missing');
    expect(shell.textContent).toContain('All properties hidden');
  });

  it('a structurally empty heading and rest keep shells with the empty hint', () => {
    // Every field claimed by the group: heading and rest both resolve empty.
    setup({
      entries: [
        makeEntry({
          path: DOC,
          title: 'Work item',
          type: 'Type',
          properties: {
            fields: { status: 'text', priority: 'text' },
            layout: {
              heading: [],
              groups: [{ id: 'g1', name: 'Planning', fields: ['status', 'priority'] }],
            },
          } as unknown as ReturnType<typeof makeEntry>['properties'],
        }),
        makeEntry({
          path: 'items/alpha.md',
          title: 'Alpha record',
          type: 'Work item',
          properties: { status: 'todo', priority: 'high' },
        }),
      ],
    });
    const shellOf = (container: string) =>
      screen.getAllByTestId('layout-block').find((b) => b.getAttribute('data-block') === container);
    const heading = shellOf('heading');
    const rest = shellOf('rest');
    if (heading === undefined || rest === undefined) throw new Error('persistent shell missing');
    // Structurally empty — nothing is hidden here, there is just nothing yet.
    expect(heading.textContent).toContain('No properties yet');
    expect(rest.textContent).toContain('No properties yet');
  });

  it("the rail's show-empty switch reveals a hide_when_empty rest field live", async () => {
    const user = userEvent.setup();
    setup({
      entries: [
        makeEntry({
          path: DOC,
          title: 'Work item',
          type: 'Type',
          properties: {
            fields: {
              status: 'text',
              notes: { kind: 'text', visibility: 'hide_when_empty' },
            },
            layout: { heading: ['status'], groups: [] },
          } as unknown as ReturnType<typeof makeEntry>['properties'],
        }),
        makeEntry({
          path: 'items/alpha.md',
          title: 'Alpha record',
          type: 'Work item',
          properties: { status: 'todo' },
        }),
      ],
    });
    const preview = () => within(screen.getByTestId('layout-preview'));
    // Draft showEmpty is false: the valueless field folds out of the canvas.
    expect(preview().queryByText('Notes')).toBeNull();
    // The rail switch edits the DRAFT's showEmpty — the live type still says
    // false, so a live-display read would keep the row folded here.
    await user.click(screen.getByRole('switch', { name: 'Show empty properties' }));
    expect(preview().getByText('Notes')).toBeTruthy();
    await user.click(screen.getByRole('switch', { name: 'Show empty properties' }));
    expect(preview().queryByText('Notes')).toBeNull();
  });
});

describe('block shells around inert content (M45.3 Task 4)', () => {
  beforeEach(() => {
    resetLayers();
  });
  afterEach(() => {
    cleanup();
    useUiStore.setState({ layoutEditor: null });
  });

  const RECORD = makeEntry({
    path: 'items/alpha.md',
    title: 'Alpha record',
    type: 'Work item',
    properties: { status: 'todo', priority: 'high', notes: 'keep' },
  });

  const shellSetup = () => setup({ entries: [typeDoc(), RECORD] });

  const blockIds = () =>
    screen.getAllByTestId('layout-block').map((b) => b.getAttribute('data-block'));

  it('property containers wear focusable shells; tabs and content are demoted chrome', async () => {
    const user = userEvent.setup();
    shellSetup();
    await user.click(screen.getByTestId('layout-structure-tabbed'));
    // Notion's canvas order (M45.5): heading first, THEN the tab strip.
    expect(blockIds()).toEqual(['heading', 'tabs', 'g1', 'rest', 'content']);
    for (const shell of screen.getAllByTestId('layout-block')) {
      const container = shell.getAttribute('data-block');
      // At least one inert fragment inside each shell, editor or chrome —
      // Task 6 split the single content div into per-fragment wrappers
      // (rows, strip, hint) so the drag layer can interleave.
      expect(within(shell).getAllByTestId('layout-preview-content').length).toBeGreaterThanOrEqual(
        1,
      );
      if (container === 'tabs' || container === 'content') {
        // No group editor exists for these two, so they are DEMOTED to plain
        // chrome (Task 5 review ruling): a role=button that Enter cannot
        // activate is a promise the a11y tree has no way to keep.
        expect(shell.getAttribute('role')).toBeNull();
        expect(shell.hasAttribute('tabindex')).toBe(false);
        expect(shell.hasAttribute('aria-label')).toBe(false);
      } else {
        expect(shell.getAttribute('role')).toBe('button');
        expect(shell.tabIndex).toBe(0);
      }
    }
  });

  it('the tab strip gains a shell while the draft has tabs', async () => {
    const user = userEvent.setup();
    shellSetup();
    await user.click(screen.getByTestId('layout-structure-tabbed'));
    expect(blockIds()).toEqual(['heading', 'tabs', 'g1', 'rest', 'content']);
    const tabsShell = screen
      .getAllByTestId('layout-block')
      .find((b) => b.getAttribute('data-block') === 'tabs');
    if (tabsShell === undefined) throw new Error('tabs shell missing');
    // The strip itself renders INSIDE the shell's inert content.
    expect(
      within(tabsShell)
        .getByTestId('layout-preview-content')
        .querySelector('[data-testid="record-tabs"]'),
    ).toBeTruthy();
  });

  it('the name chip is persistent shell chrome — outside the content div, naming the block', () => {
    shellSetup();
    const shells = screen.getAllByTestId('layout-block');
    const chipOf = (container: string, text: string) => {
      const shell = shells.find((b) => b.getAttribute('data-block') === container);
      if (shell === undefined) throw new Error(`${container} shell missing`);
      const hits = within(shell)
        .getAllByText(text)
        .filter((el) => el.closest('[data-testid="layout-preview-content"]') === null);
      expect(hits).toHaveLength(1);
      // Always-visible titled-panel anatomy (M45.5): the chip must not hide
      // behind a hover reveal.
      expect(hits[0].className).not.toContain('opacity-0');
      return shell;
    };
    expect(chipOf('heading', 'Heading').getAttribute('aria-label')).toBe('Heading');
    // The group's chip wears the group NAME — and since M45.5 it is the
    // zone's ONLY label (the inner GroupLabel left the canvas); the filter
    // proves the chip is chrome, standing outside the inert preview.
    expect(chipOf('g1', 'Planning').getAttribute('aria-label')).toBe('Planning');
    expect(chipOf('rest', 'Properties').getAttribute('aria-label')).toBe('Properties');
    // Content keeps its chip but no aria-label: a label with no role labels
    // nothing (the demoted shells are plain chrome).
    expect(chipOf('content', 'Content').hasAttribute('aria-label')).toBe(false);
  });

  it('an EMPTY group regains a visible shell — its label and an empty hint', () => {
    setup({
      entries: [
        makeEntry({
          path: DOC,
          title: 'Work item',
          type: 'Type',
          properties: {
            fields: { status: 'text', priority: 'text' },
            layout: {
              heading: ['status'],
              groups: [
                { id: 'g1', name: 'Planning', fields: ['priority'] },
                // Structurally empty — the editor's drop target, which the
                // fold rule must NOT erase the way it erases a group whose
                // rows all folded.
                { id: 'g2', name: 'Later', fields: [] },
              ],
            },
          } as unknown as ReturnType<typeof makeEntry>['properties'],
        }),
        RECORD,
      ],
    });
    const empty = screen
      .getAllByTestId('layout-block')
      .find((b) => b.getAttribute('data-block') === 'g2');
    if (empty === undefined) throw new Error('empty group shell missing');
    expect(empty.textContent).toContain('Later');
    expect(empty.textContent).toContain('No properties yet');
    // The populated sibling still renders its rows as before.
    expect(screen.getByTestId('property-group').textContent).toContain('high');
  });
});
