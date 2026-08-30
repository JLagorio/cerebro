// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LayoutEditorDialog } from '@/detail/LayoutEditorDialog';
import { resetLayers } from '@/components/ui/layers';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';

/**
 * The group editor popover (M45.3 Task 5), tested through its real mount:
 * a shell click on the LayoutEditorDialog's canvas. Everything it stages
 * goes through the draft's one `update` door, so the assertions read the
 * CANVAS (what the draft now previews) and the Apply payload (what would
 * land) — never the popover's internals.
 */

const DOC = 'types/work-item.md';

/** The LayoutEditorDialog.test fixture shape, with `fields`/`layout`
 * overridable per test — the popover cases differ mostly in visibility. */
function typeDoc(
  fields: Record<string, unknown> = { status: 'text', priority: 'text', notes: 'text' },
  layout: unknown = {
    heading: ['status'],
    groups: [{ id: 'g1', name: 'Planning', fields: ['priority'] }],
  },
) {
  return makeEntry({
    path: DOC,
    title: 'Work item',
    type: 'Type',
    properties: {
      fields,
      display: { show_file: true },
      layout,
    } as unknown as ReturnType<typeof makeEntry>['properties'],
  });
}

const RECORD = makeEntry({
  path: 'items/alpha.md',
  title: 'Alpha record',
  type: 'Work item',
  properties: { status: 'todo', priority: 'high', notes: 'keep' },
});

function setup(entries: ReturnType<typeof makeEntry>[] = [typeDoc(), RECORD]) {
  const patchFrontmatter = vi.fn().mockResolvedValue(true);
  useVaultStore.setState({ entries, vaultPath: '/vault', patchFrontmatter });
  useUiStore.setState({ layoutEditor: { type: 'Work item' }, toasts: [] });
  render(<LayoutEditorDialog />);
  return { patchFrontmatter };
}

const shellOf = (container: string) => {
  const shell = screen
    .getAllByTestId('layout-block')
    .find((b) => b.getAttribute('data-block') === container);
  if (shell === undefined) throw new Error(`${container} shell missing`);
  return shell;
};

const editor = () => within(screen.getByTestId('group-editor'));

/** jsdom has no layout, so give the popover's rows heights for
 * useSortableList to measure midpoints against (its own test's recipe). */
const fakeRects = () => {
  const rows = [...screen.getByTestId('group-editor-rows').children] as HTMLElement[];
  rows.forEach((r, i) => {
    r.getBoundingClientRect = () => ({ top: i * 20, height: 20, left: 0, width: 200 }) as DOMRect;
  });
};

const apply = async (patchFrontmatter: ReturnType<typeof vi.fn>) => {
  fireEvent.click(screen.getByTestId('layout-apply'));
  await waitFor(() => expect(patchFrontmatter).toHaveBeenCalledTimes(1));
  return patchFrontmatter.mock.calls[0][1] as Record<string, unknown>;
};

beforeEach(() => {
  resetLayers();
});
afterEach(() => {
  cleanup();
  useUiStore.setState({ layoutEditor: null });
});

describe('opening the group editor (M45.3 Task 5)', () => {
  it('a group shell click opens its editor listing EVERY field — hidden included', async () => {
    const user = userEvent.setup();
    setup([
      typeDoc({ status: 'text', priority: { kind: 'text', visibility: 'hide' }, notes: 'text' }),
      RECORD,
    ]);
    // The canvas folds the hidden row (Task 1) …
    expect(within(screen.getByTestId('layout-preview')).queryByText('Priority')).toBeNull();
    await user.click(shellOf('g1'));
    // … but the EDITOR lists it (the ruling this slice is built on: the
    // editor is where hidden things stay visible), eye in the hidden state.
    expect(editor().getByText('Priority')).toBeTruthy();
    expect(editor().getByRole('button', { name: 'Show Priority' })).toBeTruthy();
  });

  it('Enter and Space on a focused shell open the same editor', () => {
    setup();
    const shell = shellOf('g1');
    shell.focus();
    fireEvent.keyDown(shell, { key: 'Enter' });
    expect(screen.getByTestId('group-editor')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('group-editor')).toBeNull();
    // Space is role=button's other half of the activation contract.
    fireEvent.keyDown(shell, { key: ' ' });
    expect(screen.getByTestId('group-editor')).toBeTruthy();
  });

  it('Escape closes the popover first — the editor dialog stays', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(shellOf('rest'));
    expect(screen.getByTestId('group-editor')).toBeTruthy();
    // The layer stack hands the popover the keystroke (it registered above
    // the fullscreen dialog): one Escape dismisses one surface.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('group-editor')).toBeNull();
    expect(screen.getByTestId('layout-editor')).toBeTruthy();
  });

  it('the demoted content shell opens nothing', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(shellOf('content'));
    expect(screen.queryByTestId('group-editor')).toBeNull();
  });

  it('heading and rest editors wear their static titles', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(shellOf('heading'));
    expect(editor().getByText('Heading')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await user.click(shellOf('rest'));
    expect(editor().getByText('Properties')).toBeTruthy();
    // Neither is renamable — the name input is the groups' alone.
    expect(editor().queryByRole('textbox', { name: 'Section name' })).toBeNull();
  });
});

describe('eyes and the three-state menu', () => {
  it('the eye stages hide: the canvas folds the row and Apply carries the visibility', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(shellOf('g1'));
    await user.click(editor().getByRole('button', { name: 'Hide Priority' }));
    // The canvas folds what the page WILL fold; the shell persists.
    const preview = within(screen.getByTestId('layout-preview'));
    expect(preview.queryByText('high')).toBeNull();
    expect(shellOf('g1').textContent).toContain('All properties hidden');
    // The editor row is still there, eye flipped to the hidden state.
    expect(editor().getByRole('button', { name: 'Show Priority' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });

    const patch = await apply(patchFrontmatter);
    expect(patch.fields).toEqual({
      status: 'text',
      priority: { kind: 'text', visibility: 'hide' },
      notes: 'text',
    });
  });

  it('the eye on a hidden field stages show — the null that deletes the key', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup([
      typeDoc({ status: 'text', priority: { kind: 'text', visibility: 'hide' }, notes: 'text' }),
      RECORD,
    ]);
    await user.click(shellOf('g1'));
    await user.click(editor().getByRole('button', { name: 'Show Priority' }));
    expect(within(screen.getByTestId('layout-preview')).getByText('high')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });

    const patch = await apply(patchFrontmatter);
    expect(patch.fields).toEqual({ status: 'text', priority: { kind: 'text' }, notes: 'text' });
  });

  it('an eye round-trip on a clean field leaves no phantom edit', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(shellOf('g1'));
    await user.click(editor().getByRole('button', { name: 'Hide Priority' }));
    await user.click(editor().getByRole('button', { name: 'Show Priority' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    // The doc never carried a visibility, so hide→show changed NOTHING —
    // a staged null here would trip deepEqual's exact-key-set rule and make
    // Cancel ask to discard a no-op. The key deletes instead.
    await user.click(screen.getByTestId('layout-cancel'));
    expect(screen.queryByText('Discard layout changes?')).toBeNull();
    expect(useUiStore.getState().layoutEditor).toBeNull();
  });

  it('hide→show on a doc-hidden field keeps the null — a real clear Apply writes', async () => {
    const user = userEvent.setup();
    setup([
      typeDoc({ status: 'text', priority: { kind: 'text', visibility: 'hide' }, notes: 'text' }),
      RECORD,
    ]);
    await user.click(shellOf('g1'));
    await user.click(editor().getByRole('button', { name: 'Show Priority' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    // The doc DOES carry `visibility: hide`, so the staged null is an edit
    // with a destination (Apply deletes the key) — the draft is dirty and
    // Cancel must confirm.
    await user.click(screen.getByTestId('layout-cancel'));
    expect(screen.getByText('Discard layout changes?')).toBeTruthy();
  });

  it('the row ⋯ offers the three-state vocabulary verbatim and stages Hide when empty', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(shellOf('rest'));
    await user.click(editor().getByRole('button', { name: 'Notes options' }));
    // PropertyMenu's VISIBILITIES, verbatim and in its order.
    expect(screen.getByTestId('group-editor-visibility-show')).toBeTruthy();
    expect(screen.getByTestId('group-editor-visibility-hide_when_empty').textContent).toContain(
      'Hide when empty',
    );
    expect(screen.getByTestId('group-editor-visibility-hide').textContent).toContain('Always hide');
    await user.click(screen.getByTestId('group-editor-visibility-hide_when_empty'));
    // The half-state: the eye still reads as showing (Notes has a value) —
    // hide_when_empty's distinct state lives in the ⋯ menu's check.
    expect(editor().getByRole('button', { name: 'Hide Notes' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });

    const patch = await apply(patchFrontmatter);
    expect(patch.fields).toEqual({
      status: 'text',
      priority: 'text',
      notes: { kind: 'text', visibility: 'hide_when_empty' },
    });
  });
});

describe('move actions (spec §3.4)', () => {
  it('Move to heading pulls a group row into the strip', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(shellOf('g1'));
    await user.click(editor().getByRole('button', { name: 'Priority options' }));
    await user.click(screen.getByTestId('group-editor-move-heading'));
    // The strip gains the cell; the emptied group says so structurally.
    expect(
      within(screen.getByTestId('layout-preview'))
        .getByTestId('heading-strip')
        .querySelector('[data-field="priority"]'),
    ).toBeTruthy();
    expect(shellOf('g1').textContent).toContain('No properties yet');
    fireEvent.keyDown(document, { key: 'Escape' });

    const patch = await apply(patchFrontmatter);
    expect(patch.layout).toEqual({
      heading: ['status', 'priority'],
      groups: [{ id: 'g1', name: 'Planning', fields: [] }],
    });
  });

  it('Move to page returns a heading row to the body', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(shellOf('heading'));
    await user.click(editor().getByRole('button', { name: 'Status options' }));
    await user.click(screen.getByTestId('group-editor-move-page'));
    // The strip folds away structurally; the shell persists (Task 1).
    expect(within(screen.getByTestId('layout-preview')).queryByTestId('heading-strip')).toBeNull();
    expect(shellOf('heading').textContent).toContain('No properties yet');
    fireEvent.keyDown(document, { key: 'Escape' });

    const patch = await apply(patchFrontmatter);
    // serializeLayoutConfig writes deviations only: an empty heading IS the
    // default, so its key drops from the payload.
    expect(patch.layout).toEqual({
      groups: [{ id: 'g1', name: 'Planning', fields: ['priority'] }],
    });
  });

  it('a rest row offers Move to heading but not Move to page — it is already there', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(shellOf('rest'));
    await user.click(editor().getByRole('button', { name: 'Notes options' }));
    expect(screen.getByTestId('group-editor-move-heading')).toBeTruthy();
    expect(screen.queryByTestId('group-editor-move-page')).toBeNull();
  });
});

describe('rename and delete (groups only)', () => {
  it('the group name blur-commits through renameGroup and Apply carries it', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(shellOf('g1'));
    const input = editor().getByRole('textbox', { name: 'Section name' });
    await user.clear(input);
    await user.type(input, 'Sprint');
    fireEvent.blur(input);
    // The canvas group label reads the DRAFT's name.
    expect(shellOf('g1').textContent).toContain('Sprint');
    fireEvent.keyDown(document, { key: 'Escape' });

    const patch = await apply(patchFrontmatter);
    expect(patch.layout).toEqual({
      heading: ['status'],
      groups: [{ id: 'g1', name: 'Sprint', fields: ['priority'] }],
    });
  });

  // renameGroup no-ops the empty commit, but the LOCAL draft was showing ""
  // — an input that keeps displaying a name the commit refused is lying, so
  // the no-op blur falls back to the standing name (M45.3).
  it('an empty rename no-ops and the input falls back to the standing name', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(shellOf('g1'));
    const input = editor().getByRole('textbox', { name: 'Section name' });
    await user.clear(input);
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe('Planning');
    expect(shellOf('g1').textContent).toContain('Planning');
  });

  it('Escape abandons the rename — unmounting never fires blur', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(shellOf('g1'));
    const input = editor().getByRole('textbox', { name: 'Section name' });
    await user.clear(input);
    await user.type(input, 'Sprint');
    // No blur: Escape closes the popover, and the un-blurred draft leaves
    // with it (PropertyMenu's abandon-by-construction).
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('group-editor')).toBeNull();
    expect(shellOf('g1').textContent).toContain('Planning');
    // Nothing staged: Cancel closes clean, no confirm.
    await user.click(screen.getByTestId('layout-cancel'));
    expect(screen.queryByText('Discard layout changes?')).toBeNull();
    expect(useUiStore.getState().layoutEditor).toBeNull();
  });

  it('Delete section on a populated group confirms, then its fields fall to rest', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(shellOf('g1'));
    await user.click(editor().getByTestId('group-editor-delete-section'));
    // Populated: a confirm stands between the click and the removal.
    expect(screen.getByText('Delete Planning?')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Delete section' }));
    // The popover closed with its container; the field re-homes to rest —
    // rest is derived, so falling out of every container IS landing there.
    expect(screen.queryByTestId('group-editor')).toBeNull();
    expect(screen.getAllByTestId('layout-block').every((b) => b.dataset.block !== 'g1')).toBe(true);
    expect(within(shellOf('rest')).getByText('Priority')).toBeTruthy();

    const patch = await apply(patchFrontmatter);
    // Deviations only: the group list emptied back to its default and drops;
    // the heading pointer survives the delete untouched.
    expect(patch.layout).toEqual({ heading: ['status'] });
  });

  it('an empty group deletes without a confirm', async () => {
    const user = userEvent.setup();
    setup([
      typeDoc(
        { status: 'text', priority: 'text', notes: 'text' },
        {
          heading: ['status'],
          groups: [
            { id: 'g1', name: 'Planning', fields: ['priority'] },
            { id: 'g2', name: 'Later', fields: [] },
          ],
        },
      ),
      RECORD,
    ]);
    await user.click(shellOf('g2'));
    await user.click(editor().getByTestId('group-editor-delete-section'));
    expect(screen.queryByText('Delete Later?')).toBeNull();
    expect(screen.getAllByTestId('layout-block').every((b) => b.dataset.block !== 'g2')).toBe(true);
  });

  it('heading and rest editors carry no Delete section', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(shellOf('heading'));
    expect(editor().queryByTestId('group-editor-delete-section')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    await user.click(shellOf('rest'));
    expect(editor().queryByTestId('group-editor-delete-section')).toBeNull();
  });
});

describe('search', () => {
  it('filters rows by substring, case-insensitive', async () => {
    const user = userEvent.setup();
    setup([
      typeDoc(
        { status: 'text', priority: 'text', notes: 'text', estimate: 'text' },
        { heading: [], groups: [] },
      ),
      RECORD,
    ]);
    await user.click(shellOf('rest'));
    await user.type(editor().getByRole('textbox', { name: 'Search properties' }), 'EST');
    expect(editor().queryByText('Status')).toBeNull();
    expect(editor().queryByText('Notes')).toBeNull();
    expect(editor().getByText('Estimate')).toBeTruthy();
  });
});

describe('the heading preview folds staged visibility (Task 1 review gap)', () => {
  it('a heading field eyed to hide folds from the strip preview', async () => {
    const user = userEvent.setup();
    setup();
    expect(within(screen.getByTestId('layout-preview')).getByTestId('heading-strip')).toBeTruthy();
    await user.click(shellOf('heading'));
    await user.click(editor().getByRole('button', { name: 'Hide Status' }));
    // The strip previews the STAGED visibility: the cell folds now, and the
    // persistent shell says why the strip shows nothing.
    expect(within(screen.getByTestId('layout-preview')).queryByTestId('heading-strip')).toBeNull();
    expect(shellOf('heading').textContent).toContain('All properties hidden');
  });
});

describe('Add a property (M45.3 Task 5)', () => {
  it('the existing-fields drill-in pulls a field in via moveField', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(shellOf('g1'));
    await user.click(editor().getByTestId('group-editor-add'));
    // Fields NOT in this container: the heading's and the rest's.
    expect(screen.getByTestId('group-editor-pull-status')).toBeTruthy();
    expect(screen.getByTestId('group-editor-pull-notes')).toBeTruthy();
    expect(screen.queryByTestId('group-editor-pull-priority')).toBeNull();
    await user.click(screen.getByTestId('group-editor-pull-notes'));
    // Back on the main step, the row landed; the canvas group carries it.
    expect(editor().getByText('Notes')).toBeTruthy();
    expect(within(shellOf('g1')).getByText('keep')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });

    const patch = await apply(patchFrontmatter);
    expect(patch.layout).toEqual({
      heading: ['status'],
      groups: [{ id: 'g1', name: 'Planning', fields: ['priority', 'notes'] }],
    });
  });

  it('Create new stages a normalized FieldDef-shaped addition into this container', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(shellOf('g1'));
    await user.click(editor().getByTestId('group-editor-add'));
    await user.click(screen.getByTestId('group-editor-create-new'));
    await user.type(screen.getByRole('textbox', { name: 'Property name' }), 'Story Points');
    await user.click(screen.getByTestId('property-kind-text'));
    // Normalized at STAGING time (obligation: preview and Apply must agree),
    // so the canvas previews the name Apply will write.
    expect(editor().getByText('Story points')).toBeTruthy();
    expect(within(shellOf('g1')).getByText('Story points')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });

    const patch = await apply(patchFrontmatter);
    expect(patch.fields).toEqual({
      status: 'text',
      priority: 'text',
      notes: 'text',
      story_points: { kind: 'text' },
    });
    expect(patch.layout).toEqual({
      heading: ['status'],
      groups: [{ id: 'g1', name: 'Planning', fields: ['priority', 'story_points'] }],
    });
  });

  it('a duplicate the panel guard cannot see refuses inline — a form, not a toast', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(shellOf('g1'));
    await user.click(editor().getByTestId('group-editor-add'));
    await user.click(screen.getByTestId('group-editor-create-new'));
    // "Story  Points" (double space) normalizes to the staged name but does
    // NOT match it by the panel's trim+lowercase compare — the staging guard
    // mirrors applyTypeLayout's normalized compare, where the panel's cannot.
    await user.type(screen.getByRole('textbox', { name: 'Property name' }), 'Story points');
    await user.click(screen.getByTestId('property-kind-text'));
    await user.click(editor().getByTestId('group-editor-add'));
    await user.click(screen.getByTestId('group-editor-create-new'));
    await user.type(screen.getByRole('textbox', { name: 'Property name' }), 'Story  Points');
    await user.click(screen.getByTestId('property-kind-text'));
    expect(screen.getByRole('alert').textContent).toContain('already a property');
    expect(useUiStore.getState().toasts).toEqual([]);
    // Nothing staged twice: the first addition is the only new row.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(within(shellOf('g1')).getAllByText('Story points')).toHaveLength(1);
  });

  it('a reserved key refuses inline with applyTypeLayout’s reason', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(shellOf('g1'));
    await user.click(editor().getByTestId('group-editor-add'));
    await user.click(screen.getByTestId('group-editor-create-new'));
    await user.type(screen.getByRole('textbox', { name: 'Property name' }), 'Tabs');
    await user.click(screen.getByTestId('property-kind-text'));
    expect(screen.getByRole('alert').textContent).toContain('reserved');
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('Discard new property sweeps the stage clean — added, layout pointer, and eye', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(shellOf('g1'));
    await user.click(editor().getByTestId('group-editor-add'));
    await user.click(screen.getByTestId('group-editor-create-new'));
    await user.type(screen.getByRole('textbox', { name: 'Property name' }), 'Story Points');
    await user.click(screen.getByTestId('property-kind-text'));
    // Eye it too: the discard must sweep the staged visibility along.
    await user.click(editor().getByRole('button', { name: 'Hide Story points' }));

    await user.click(editor().getByRole('button', { name: 'Story points options' }));
    await user.click(screen.getByTestId('group-editor-discard-new'));
    expect(editor().queryByText('Story points')).toBeNull();
    expect(within(shellOf('g1')).queryByText('Story points')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });

    // The strongest sweep assertion there is: the draft is CLEAN again, so
    // Cancel closes without a confirm. A dead layout pointer or a stale
    // visibility key would each leave it dirty (obligation: Apply must not
    // persist a dead pointer).
    await user.click(screen.getByTestId('layout-cancel'));
    expect(screen.queryByText('Discard layout changes?')).toBeNull();
    expect(useUiStore.getState().layoutEditor).toBeNull();
  });

  it('declared rows carry no Discard new property', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(shellOf('g1'));
    await user.click(editor().getByRole('button', { name: 'Priority options' }));
    expect(screen.queryByTestId('group-editor-discard-new')).toBeNull();
  });
});

describe('Add section (rest/heading footers only)', () => {
  it('appends an empty group and retargets the editor onto it', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(shellOf('rest'));
    await user.click(editor().getByTestId('group-editor-add-section'));
    // The fresh group's shell stands (structurally empty) …
    expect(shellOf('group-1').textContent).toContain('New group');
    expect(shellOf('group-1').textContent).toContain('No properties yet');
    // … and the editor moved onto it, rename box ready (the {layout, id}
    // return exists for exactly this hand-off).
    expect(
      (editor().getByRole('textbox', { name: 'Section name' }) as HTMLInputElement).value,
    ).toBe('New group');
    fireEvent.keyDown(document, { key: 'Escape' });

    const patch = await apply(patchFrontmatter);
    expect(patch.layout).toEqual({
      heading: ['status'],
      groups: [
        { id: 'g1', name: 'Planning', fields: ['priority'] },
        { id: 'group-1', name: 'New group', fields: [] },
      ],
    });
  });

  it('group editors offer no Add section; heading does', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(shellOf('g1'));
    expect(editor().queryByTestId('group-editor-add-section')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    await user.click(shellOf('heading'));
    expect(editor().getByTestId('group-editor-add-section')).toBeTruthy();
  });
});

// M45.5 Task 4 — the user's fourth parity defect: "that's also how we move
// properties within a section, on hover there's a draggable icon". The panel
// rows carry hover grips that reorder WITHIN their container through
// moveField. This closes M45.3's recorded within-heading-reorder limitation:
// the strip is no longer arrival order.
describe('panel rows reorder within their container (M45.5 Task 4)', () => {
  const gripFor = (label: string) =>
    editor().getByRole('button', { name: new RegExp(`^Reorder ${label},`) });

  const groupOrder = (id: string) =>
    [
      ...screen
        .getByTestId('layout-preview')
        .querySelectorAll(`[data-group="${id}"] [data-testid="property-row"]`),
    ].map((r) => r.getAttribute('data-property'));

  it('a group row moves down a slot; the canvas and Apply both carry it', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup([
      typeDoc(undefined, {
        heading: ['status'],
        groups: [{ id: 'g1', name: 'Planning', fields: ['priority', 'notes'] }],
      }),
      RECORD,
    ]);
    await user.click(shellOf('g1'));
    expect(groupOrder('g1')).toEqual(['priority', 'notes']);
    gripFor('Priority').focus();
    await user.keyboard('{ArrowDown}');
    expect(groupOrder('g1')).toEqual(['notes', 'priority']);
    fireEvent.keyDown(document, { key: 'Escape' });

    const patch = await apply(patchFrontmatter);
    expect(patch.layout).toEqual({
      heading: ['status'],
      groups: [{ id: 'g1', name: 'Planning', fields: ['notes', 'priority'] }],
    });
  });

  it('a HEADING row reorders too — the M45.3 arrival-order limitation closes', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup([
      typeDoc(undefined, { heading: ['status', 'priority'], groups: [] }),
      RECORD,
    ]);
    await user.click(shellOf('heading'));
    gripFor('Status').focus();
    await user.keyboard('{ArrowDown}');
    fireEvent.keyDown(document, { key: 'Escape' });

    const patch = await apply(patchFrontmatter);
    expect(patch.layout).toEqual({ heading: ['priority', 'status'] });
  });

  it('rest rows carry NO grip — its order is the roster’s, not the config’s', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(shellOf('rest'));
    expect(editor().queryAllByTestId('group-editor-grip')).toHaveLength(0);
    // Vacuity guard: a group's rows do carry one, so the absence above is
    // about rest and not about the grips failing to render at all.
    fireEvent.keyDown(document, { key: 'Escape' });
    await user.click(shellOf('g1'));
    expect(editor().getAllByTestId('group-editor-grip').length).toBeGreaterThan(0);
  });

  it('a pointer drag past the next row commits the move', async () => {
    const user = userEvent.setup();
    setup([
      typeDoc(undefined, {
        heading: ['status'],
        groups: [{ id: 'g1', name: 'Planning', fields: ['priority', 'notes'] }],
      }),
      RECORD,
    ]);
    await user.click(shellOf('g1'));
    fakeRects();
    // useSortableList's jsdom recipe: its listeners are native window
    // handlers and jsdom implements no PointerEvent, so a MouseEvent carries
    // the coordinates the handler actually reads.
    fireEvent.pointerDown(gripFor('Priority'), { button: 0 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 45 }));
      window.dispatchEvent(new MouseEvent('pointerup', { clientY: 45 }));
    });
    expect(groupOrder('g1')).toEqual(['notes', 'priority']);
  });

  it('a drop back on its own slot commits nothing — the draft stays clean', async () => {
    const user = userEvent.setup();
    setup([
      typeDoc(undefined, {
        heading: ['status'],
        groups: [{ id: 'g1', name: 'Planning', fields: ['priority', 'notes'] }],
      }),
      RECORD,
    ]);
    await user.click(shellOf('g1'));
    fakeRects();
    fireEvent.pointerDown(gripFor('Priority'), { button: 0 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 5 }));
      window.dispatchEvent(new MouseEvent('pointerup', { clientY: 5 }));
    });
    expect(groupOrder('g1')).toEqual(['priority', 'notes']);
    fireEvent.keyDown(document, { key: 'Escape' });
    // The strongest no-op assertion available: an identity drop staged
    // nothing, so Cancel closes without asking to discard anything.
    await user.click(screen.getByTestId('layout-cancel'));
    expect(screen.queryByText('Discard layout changes?')).toBeNull();
    expect(useUiStore.getState().layoutEditor).toBeNull();
  });

  it('a config pointer the roster STOPS declaring never shifts the landing', async () => {
    const user = userEvent.setup();
    // A dead pointer cannot be seeded: seedDraft resolves the config and maps
    // the DEFS back to names, so a doc pointing at an undeclared field starts
    // the draft already pruned. It arises exactly one way — the Type doc
    // changes under an open dialog (the draft is seeded once; the roster is
    // re-read every render) — so that is what this drives, and it is the case
    // the space conversion exists for.
    const fields = { status: 'text', priority: 'text', notes: 'text', legacy: 'text' };
    const withLegacy = {
      heading: [],
      groups: [{ id: 'g1', name: 'Planning', fields: ['legacy', 'priority', 'notes', 'status'] }],
    };
    setup([typeDoc(fields, withLegacy), RECORD]);
    // Seeded whole: four config slots, four rows.
    expect(groupOrder('g1')).toEqual(['legacy', 'priority', 'notes', 'status']);
    // The doc drops `legacy` from `fields:` mid-session. The row goes; the
    // draft's config pointer stays, so slot 0 is now dead.
    const { legacy: _dropped, ...survivors } = fields;
    act(() => {
      useVaultStore.setState({ entries: [typeDoc(survivors, withLegacy), RECORD] });
    });
    expect(groupOrder('g1')).toEqual(['priority', 'notes', 'status']);

    await user.click(shellOf('g1'));
    // Forward, from the first VISIBLE row, with the dead slot before it: the
    // visual landing (1) and the config landing (2) differ, which is what
    // makes this discriminate. Dropping the conversion — or decrementing on
    // top of it — resolves to the row's own slot and moveField no-ops.
    gripFor('Priority').focus();
    await user.keyboard('{ArrowDown}');
    expect(groupOrder('g1')).toEqual(['notes', 'priority', 'status']);
  });

  it('a FILTERED list shows no grips — its visible slots are not the data’s', async () => {
    const user = userEvent.setup();
    setup([
      typeDoc(undefined, {
        heading: [],
        groups: [{ id: 'g1', name: 'Planning', fields: ['priority', 'notes', 'status'] }],
      }),
      RECORD,
    ]);
    await user.click(shellOf('g1'));
    expect(editor().getAllByTestId('group-editor-grip')).toHaveLength(3);
    await user.type(editor().getByRole('textbox', { name: 'Search properties' }), 'ot');
    // The grips leave with the slots they addressed — an inert grip would
    // promise a reorder the filtered list cannot place.
    expect(editor().queryAllByTestId('group-editor-grip')).toHaveLength(0);
  });
});

// M46.1 — the second Add-section door. The canvas `+` and this footer entry
// share ONE `stageNewSection`, and that sharing is the whole point: M45.6 gave
// them a tab argument and a gate apiece, and the reversal took both away. The
// canvas door kept its cases; this one lost all of its when "Move to tab…"
// went, so the gate could come back — or the doors could part — in silence.
describe('the group editor’s Add section, on a tabbed type (M46.1)', () => {
  const TABS = [
    { id: 'ov', name: 'Overview', icon: null, content: 'overview' },
    { id: 'v1', name: 'Blocked', icon: null, content: 'view', source: { type: 'Work item' } },
  ];

  function tabbedDoc() {
    return makeEntry({
      path: DOC,
      title: 'Work item',
      type: 'Type',
      properties: {
        fields: { status: 'text', priority: 'text', notes: 'text' },
        display: { show_file: true },
        layout: {
          heading: ['status'],
          groups: [{ id: 'g1', name: 'Planning', fields: ['priority'] }],
        },
        tabs: TABS,
      } as unknown as ReturnType<typeof makeEntry>['properties'],
    });
  }

  const stagedGroups = (patch: Record<string, unknown>) =>
    (patch.layout as { groups: Record<string, unknown>[] }).groups;

  it('is offered from the heading while standing on a VIEW tab, and stages a real section', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup([tabbedDoc(), RECORD]);
    fireEvent.click(screen.getByTestId('record-tab-v1'));
    // The heading shell renders on every tab, so this editor is reachable
    // from a view tab. Under M45.6 the footer entry stood DOWN here, because
    // the section would have landed on a tab that could not show it. A
    // section belongs to the record now, so the door is open — and if a gate
    // is ever re-added, this line is where it fails.
    await user.click(shellOf('heading'));
    expect(editor().getByTestId('group-editor-add-section')).toBeTruthy();
    await user.click(editor().getByTestId('group-editor-add-section'));

    // Staged and VISIBLE from the very tab it was pressed on — the stack
    // stands above the strip, so there is nowhere for it to hide.
    expect(shellOf('group-1').textContent).toContain('New group');
    fireEvent.keyDown(document, { key: 'Escape' });

    const patch = await apply(patchFrontmatter);
    expect(stagedGroups(patch)).toEqual([
      { id: 'g1', name: 'Planning', fields: ['priority'] },
      { id: 'group-1', name: 'New group', fields: [] },
    ]);
    // `toEqual` fails on a surplus key, but absent and undefined read alike
    // through it — so the no-tab claim is made in its own words too. It
    // pins the WRITE CONTRACT, not a draft guard: serializeLayoutConfig
    // rebuilds every group as {id,name,fields}, so a stray draft `tab`
    // could never reach the payload. The behavioural guard against
    // re-scoping lives in LayoutCanvas.test.tsx.
    for (const g of stagedGroups(patch)) expect('tab' in g).toBe(false);
  });

  it('stages byte-identically to the canvas +, from the same tab — two doors, one function', async () => {
    const user = userEvent.setup();
    // Door one: the canvas's circular +.
    const first = setup([tabbedDoc(), RECORD]);
    fireEvent.click(screen.getByTestId('record-tab-v1'));
    await user.click(screen.getByTestId('layout-add-section'));
    fireEvent.keyDown(document, { key: 'Escape' });
    const viaCanvas = stagedGroups(await apply(first.patchFrontmatter));

    cleanup();
    resetLayers();
    useUiStore.setState({ layoutEditor: null });

    // Door two: the group editor's footer entry, same tab, same fixture.
    const second = setup([tabbedDoc(), RECORD]);
    fireEvent.click(screen.getByTestId('record-tab-v1'));
    await user.click(shellOf('heading'));
    await user.click(editor().getByTestId('group-editor-add-section'));
    fireEvent.keyDown(document, { key: 'Escape' });
    const viaFooter = stagedGroups(await apply(second.patchFrontmatter));

    // The drift guard: give either door back an argument the other does not
    // pass — a tab, a different minted id, a different name — and these part.
    expect(viaFooter).toEqual(viaCanvas);
  });

  it('offers a group placement, never a tab — "Move to tab…" is gone', async () => {
    const user = userEvent.setup();
    setup([tabbedDoc(), RECORD]);
    await user.click(shellOf('g1'));
    // A section has no tab to be moved between, so the drill-in, its
    // "Untabbed (default tab)" entry, and the whole `tab` step retire. The
    // group footer still governs the section's existence.
    expect(editor().queryByTestId('group-editor-move-tab')).toBeNull();
    expect(editor().queryByTestId('group-editor-untabbed')).toBeNull();
    expect(editor().queryByTestId('group-editor-tab-list')).toBeNull();
    expect(editor().queryByText('Move to tab…')).toBeNull();
    expect(editor().getByTestId('group-editor-delete-section')).toBeTruthy();
  });
});

// The staging guards `stageNew` mirrors from applyTypeLayout, and the shape a
// relation stages. Each refuses (or stages) BEFORE the write, inline where the
// typo is — the store-layer toast contract is for vault writes, and nothing
// here writes.
describe('what Create new refuses, and what a relation stages', () => {
  const openCreate = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(shellOf('g1'));
    await user.click(editor().getByTestId('group-editor-add'));
    await user.click(screen.getByTestId('group-editor-create-new'));
  };

  it('a name that NORMALIZES to nothing refuses inline — the panel cannot see it', async () => {
    const user = userEvent.setup();
    setup();
    await openCreate(user);
    // Underscores are not whitespace, so the panel's own blank check passes
    // them through; `normalizeFieldName` strips leading underscores and is
    // left with nothing. Same class of gap as the double-space duplicate:
    // the guard exists because the panel's compare cannot reach it.
    await user.type(screen.getByRole('textbox', { name: 'Property name' }), '___');
    await user.click(screen.getByTestId('property-kind-text'));
    expect(screen.getByRole('alert').textContent).toContain('needs a name');
    expect(useUiStore.getState().toasts).toEqual([]);
    // Nothing staged: the container's rows are what they were.
    // The refusal keeps the user ON the create step, so the assertion reads
    // the CANVAS, which is mounted throughout: g1 still holds its one row.
    expect(within(shellOf('g1')).getAllByTestId('property-row')).toHaveLength(1);
  });

  it('a two-way relation refuses outright — Apply cannot write the other type', async () => {
    const user = userEvent.setup();
    setup();
    await openCreate(user);
    await user.type(screen.getByRole('textbox', { name: 'Property name' }), 'Blocked by');
    await user.click(screen.getByTestId('property-kind-relation'));
    await user.click(screen.getByTestId('relation-target-Work item'));
    await user.click(screen.getByRole('switch', { name: 'Add related property' }));
    await user.type(screen.getByRole('textbox', { name: 'Related property name' }), 'Blocks');
    await user.click(screen.getByTestId('add-relation'));
    // The reciprocal declares a field on the TARGET type — a second doc the
    // one-write atomic Apply can never carry. Half-staging it would be worse
    // than refusing, so the refusal names the two ways out.
    expect(screen.getByRole('alert').textContent).toContain('writes the other type');
    expect(useUiStore.getState().toasts).toEqual([]);
    // The refusal keeps the user ON the create step, so the assertion reads
    // the CANVAS, which is mounted throughout: g1 still holds its one row.
    expect(within(shellOf('g1')).getAllByTestId('property-row')).toHaveLength(1);
  });

  it('a one-way relation stages its target and limit into the addition', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await openCreate(user);
    await user.type(screen.getByRole('textbox', { name: 'Property name' }), 'Blocked by');
    await user.click(screen.getByTestId('property-kind-relation'));
    await user.click(screen.getByTestId('relation-target-Work item'));
    await user.click(screen.getByRole('switch', { name: 'Limit to 1 record' }));
    await user.click(screen.getByTestId('add-relation'));
    fireEvent.keyDown(document, { key: 'Escape' });

    const patch = await apply(patchFrontmatter);
    // The FieldDef members typeActions spreads under {name, kind}: `limit`
    // rides only because the switch was thrown, and the placement is the
    // container the editor was opened on.
    expect((patch.fields as Record<string, unknown>).blocked_by).toEqual({
      kind: 'relation',
      target: 'Work item',
      limit: 1,
    });
    expect((patch.layout as { groups: { fields: string[] }[] }).groups[0].fields).toEqual([
      'priority',
      'blocked_by',
    ]);
  });
});
