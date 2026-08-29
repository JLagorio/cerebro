// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
