// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  LayoutEditorDialog,
  draftDirty,
  seedDraft,
  updateDraft,
} from '@/detail/LayoutEditorDialog';
import type { TypeLayoutDraft } from '@/app/typeActions';
import { resetLayers } from '@/components/ui/layers';
import { DISPLAY_DEFAULTS, type TypeDef } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';

const DOC = 'types/work-item.md';

/** The schema builds a TypeDef only from a Type doc (the DetailHeaderActions
 * idiom), so the fixture seeds one whose `layout:` carries a dead pointer —
 * the seed-prunes-on-Apply path needs it. `display.show_file` deviates from
 * the defaults so Apply always has a real patch to send. */
function typeDoc() {
  return makeEntry({
    path: DOC,
    title: 'Work item',
    type: 'Type',
    properties: {
      fields: { status: 'text', priority: 'text' },
      display: { show_file: true },
      layout: {
        heading: ['status', 'ghost'],
        groups: [{ id: 'g1', name: 'Planning', fields: ['priority'] }],
      },
      // Nested Type-doc blocks, the typeActions.test cast idiom.
    } as unknown as ReturnType<typeof makeEntry>['properties'],
  });
}

function setup(
  opts: {
    patchFrontmatter?: ReturnType<typeof vi.fn>;
    entries?: ReturnType<typeof makeEntry>[];
    initialDraft?: TypeLayoutDraft;
  } = {},
) {
  const patchFrontmatter = opts.patchFrontmatter ?? vi.fn().mockResolvedValue(true);
  useVaultStore.setState({
    entries: opts.entries ?? [typeDoc()],
    vaultPath: '/vault',
    patchFrontmatter,
  });
  useUiStore.setState({ layoutEditor: { type: 'Work item' }, toasts: [] });
  render(<LayoutEditorDialog initialDraft={opts.initialDraft} />);
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

describe('LayoutEditorDialog', () => {
  beforeEach(() => {
    resetLayers();
  });
  afterEach(() => {
    cleanup();
    useUiStore.setState({ layoutEditor: null });
  });

  it('opens from the signal with the type named in the title strip', () => {
    setup();
    expect(screen.getByTestId('layout-editor')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Customize Work item layout' })).toBeTruthy();
    // The body header row carries the type icon + name (spec §3.2).
    expect(screen.getByText('Work item')).toBeTruthy();
    expect(screen.getByTestId('layout-preview')).toBeTruthy();
    expect(screen.getByTestId('layout-rail')).toBeTruthy();
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

  // Dirty is only reachable through the exported reducer until the rail lands
  // (M45.2 Task 3 rewrites this through a real switch).
  it('Cancel with an edited draft confirms; Keep editing returns, Discard closes without a write', async () => {
    const user = userEvent.setup();
    const seed = seedDraft(def({ display: { ...DISPLAY_DEFAULTS, showFile: true } }));
    const { patchFrontmatter } = setup({
      initialDraft: updateDraft(seed, { display: { ...seed.display, showBody: false } }),
    });

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

  it('Escape with the confirm open dismisses the confirm, not the editor', async () => {
    const seed = seedDraft(def({ display: { ...DISPLAY_DEFAULTS, showFile: true } }));
    setup({ initialDraft: updateDraft(seed, { display: { ...seed.display, showBody: false } }) });

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

  it('a failed Apply keeps the editor open with the draft intact', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup({
      patchFrontmatter: vi.fn().mockResolvedValue(false),
    });
    await user.click(screen.getByTestId('layout-apply'));
    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('layout-editor')).toBeTruthy();

    // The draft survived the failure: a second Apply sends the same patch.
    await user.click(screen.getByTestId('layout-apply'));
    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalledTimes(2));
    expect(patchFrontmatter).toHaveBeenNthCalledWith(2, DOC, FIXTURE_PATCH);
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
