// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PropertyMenu } from '@/detail/PropertyMenu';
import { RecordProperties } from '@/detail/RecordProperties';
import { buildSchema } from '@/engine/schema';
import type { Entry } from '@/engine/types';
import { resetLayers } from '@/components/ui/layers';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault, makeEntry } from '@/test/factories';

const TYPE_DOC = 'types/work-item.md';
const RECORD = 'projects/onboarding/wi-1.md';

function setup(recordPartial: Partial<Entry> = {}) {
  const record = makeEntry({
    path: RECORD,
    title: 'Ship it',
    type: 'Work item',
    properties: { status: 'todo', priority: 'high', stray_note: 'left over' },
    ...recordPartial,
  });
  const all = [...fixtureVault(), record];
  const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
  useVaultStore.setState({ entries: all, vaultPath: '/vault', patchFrontmatter });
  render(<RecordProperties entry={record} schema={buildSchema(all)} />);
  return { patchFrontmatter };
}

/** The Type doc's `fields:` mapping as the last write left it. */
const writtenFields = (patch: ReturnType<typeof vi.fn>): Record<string, unknown> => {
  const calls = (patch.mock.calls as [string, { fields: Record<string, unknown> }][]).filter(
    (c) => c[0] === TYPE_DOC,
  );
  return calls[calls.length - 1][1].fields;
};

const openMenu = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(screen.getByRole('button', { name: `${name} property menu` }));
  await screen.findByRole('menu');
};

/**
 * The menu behind a property's name (M16.7).
 *
 * Every action here already existed and every one was reachable only from a
 * TABLE column header — so a user working in the record panel, which is where
 * a record's properties live, could not rename a property, change its kind,
 * duplicate it or delete it at all.
 */
describe('PropertyMenu', () => {
  beforeEach(() => {
    resetLayers();
    useUiStore.setState({ toasts: [] });
  });
  afterEach(cleanup);

  it('opens from the property name, which nothing used to do', async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.queryByRole('menu')).toBeNull();
    await openMenu(user, 'Priority');
    expect(screen.getByTestId('property-menu-edit')).toBeTruthy();
    expect(screen.getByTestId('property-menu-duplicate')).toBeTruthy();
    expect(screen.getByTestId('property-menu-delete')).toBeTruthy();
  });

  it('renames the field on the type, not just on this record', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await openMenu(user, 'Priority');

    const input = screen.getByLabelText('Rename Priority');
    await user.clear(input);
    await user.type(input, 'Urgency{Enter}');

    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalled());
    const fields = writtenFields(patchFrontmatter);
    expect(Object.keys(fields)).toContain('urgency');
    expect(Object.keys(fields)).not.toContain('priority');
    // The rename keeps its slot: declaration order is panel and column order.
    expect(Object.keys(fields).indexOf('urgency')).toBe(1);
  });

  it('duplicates a property beside the original', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await openMenu(user, 'Priority');
    await user.click(screen.getByTestId('property-menu-duplicate'));

    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalled());
    const names = Object.keys(writtenFields(patchFrontmatter));
    expect(names).toContain('priority_copy');
    expect(names.indexOf('priority_copy')).toBe(names.indexOf('priority') + 1);
  });

  it('deletes a property from the type, once the confirmation is answered', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await openMenu(user, 'Priority');
    await user.click(screen.getByTestId('property-menu-delete'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalled());
    expect(Object.keys(writtenFields(patchFrontmatter))).not.toContain('priority');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  /**
   * One click on "Delete property" destroyed a type's schema (M16.29).
   *
   * The menu already COMPUTES the blast radius — its footer reads "Changes
   * Work item — 45 records" — and then fired `removeFieldFromType` straight
   * off the menu item anyway. The field vanished from every record at once,
   * their frontmatter kept the now-invisible values, and a select's option
   * list and colours were gone with no undo anywhere in the app. Deleting one
   * record has asked first since M16.11; deleting a property from every record
   * of a type asked nothing.
   */
  it('writes nothing until the deletion is confirmed', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await openMenu(user, 'Priority');
    await user.click(screen.getByTestId('property-menu-delete'));

    expect(patchFrontmatter).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('leaves the schema alone when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await openMenu(user, 'Priority');
    await user.click(screen.getByTestId('property-menu-delete'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(patchFrontmatter).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Priority property menu' })).toBeTruthy();
  });

  // The consequence has to be stated in the terms the footer already used —
  // the type and the record count — plus the part no surface said anywhere:
  // the values stay in the files and simply stop being shown.
  it('states the blast radius and what happens to the values on disk', async () => {
    const user = userEvent.setup();
    setup();
    await openMenu(user, 'Priority');
    await user.click(screen.getByTestId('property-menu-delete'));

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/Work item — \d+ records?/);
    expect(dialog.textContent).toContain('frontmatter');
    // A select loses its option set and its colours, and that is the part
    // nothing in the app can rebuild for you.
    expect(dialog.textContent).toContain('option list');
  });

  it('does not promise a select warning to a property that has no options', async () => {
    const user = userEvent.setup();
    setup();
    await openMenu(user, 'Due');
    await user.click(screen.getByTestId('property-menu-delete'));

    expect(screen.getByRole('dialog').textContent).not.toContain('option list');
  });

  // The same button lives in the drilled-in editor, reachable from a table
  // column header and the view settings panel as well as from here.
  it('guards the delete inside the property editor too', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await openMenu(user, 'Priority');
    await user.click(screen.getByTestId('property-menu-edit'));
    await user.click(screen.getByRole('button', { name: 'Delete property' }));

    expect(patchFrontmatter).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalled());
    expect(Object.keys(writtenFields(patchFrontmatter))).not.toContain('priority');
  });

  it('drills into the property editor, and comes back', async () => {
    const user = userEvent.setup();
    setup();
    await openMenu(user, 'Priority');
    await user.click(screen.getByTestId('property-menu-edit'));

    // The editor that only a table column header could reach until now.
    expect(screen.getByTestId('property-editor-type')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back to Edit property' }));
    expect(screen.getByTestId('property-menu-duplicate')).toBeTruthy();
  });

  it('says how far the change reaches, because it edits the type', async () => {
    const user = userEvent.setup();
    setup();
    await openMenu(user, 'Priority');
    // The fixture vault carries Work items besides the open one.
    expect(screen.getByText(/Changes Work item — \d+ records?/)).toBeTruthy();
  });

  // M45.2 — Notion's verbatim order ends `─ · Customize layout`, the slot the
  // docblock held open since M16.7. It edits the TYPE's layout, not this
  // property, so it fires the one uiStore signal and closes the menu.
  it('ends on Customize layout, which opens the layout editor for the type', async () => {
    const user = userEvent.setup();
    useUiStore.setState({ layoutEditor: null });
    setup();
    await openMenu(user, 'Priority');
    const items = screen.getAllByRole('menuitem');
    expect(items[items.length - 1].textContent).toContain('Customize layout');

    await user.click(screen.getByTestId('property-menu-customize-layout'));
    expect(useUiStore.getState().layoutEditor).toEqual({ type: 'Work item' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  // The M16.1 contract, now that a real menu depends on it.
  it('closes on an outside click', async () => {
    const user = userEvent.setup();
    setup();
    await openMenu(user, 'Priority');
    await user.click(document.body);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    setup();
    await openMenu(user, 'Priority');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  // Escape means cancel. Unmounting never fires blur, so abandoning the
  // draft is what closing already did — this pins that it stays abandoned
  // rather than landing on disk.
  it('abandons a half-typed rename on Escape', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await openMenu(user, 'Priority');
    const input = screen.getByLabelText('Rename Priority');
    await user.clear(input);
    await user.type(input, 'Nope');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });

  // The other half of that contract, and the reason `useDismiss` blurs the
  // active element before closing: a click outside is how a user says "yes,
  // that name" — and it used to throw the name away.
  it('commits a typed rename when the click that dismisses it lands outside', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await openMenu(user, 'Priority');
    const input = screen.getByLabelText('Rename Priority');
    await user.clear(input);
    await user.type(input, 'Urgency');

    await user.click(document.body);
    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalled());
    expect(Object.keys(writtenFields(patchFrontmatter))).toContain('urgency');
  });

  it('gives no menu to a key the type does not declare', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'Stray note property menu' })).toBeNull();
    // It is still on the panel, and still removable.
    expect(screen.getByRole('button', { name: 'Remove Stray note' })).toBeTruthy();
  });

  it('gives no menu at all to an untyped record', () => {
    setup({ type: null });
    expect(screen.queryByRole('button', { name: /property menu$/ })).toBeNull();
  });

  it('refuses to rename or delete a built-in of a system type', () => {
    const all = fixtureVault();
    useVaultStore.setState({ entries: all, vaultPath: '/vault' });
    render(
      <PropertyMenu
        def={{ name: 'fields', kind: 'text' }}
        sourceType="Type"
        schema={buildSchema(all)}
        recordCount={3}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByLabelText('Rename Fields')).toBeNull();
    expect(screen.getByText('Built-in')).toBeTruthy();
    expect(screen.queryByTestId('property-menu-delete')).toBeNull();
  });
});

/**
 * Dragging a property to a new position (M16.8).
 *
 * `moveFieldOnType` has existed since M9.6 — hardened, toast-wired, and with
 * zero call sites. Declaration order drives this panel AND the default column
 * order in every view, and the only way to change it was to hand-edit YAML.
 */
describe('property reorder', () => {
  beforeEach(() => {
    resetLayers();
    useUiStore.setState({ toasts: [] });
  });
  afterEach(cleanup);

  const gripFor = (name: string) =>
    screen.getByRole('button', { name: new RegExp(`^Reorder ${name},`) });

  it('gives every declared field a grip that says where it sits', () => {
    setup();
    // The fixture type declares status, priority, assignee, due.
    expect(gripFor('Status').getAttribute('aria-label')).toBe('Reorder Status, position 1 of 4');
    expect(gripFor('Due').getAttribute('aria-label')).toBe('Reorder Due, position 4 of 4');
  });

  it('moves a property one slot per arrow press, from the keyboard alone', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    gripFor('Priority').focus();
    await user.keyboard('{ArrowUp}');

    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalled());
    // The whole mapping is rewritten: YAML has no reorder operation, and
    // patchFrontmatter merges keys, so a partial write would change nothing.
    expect(Object.keys(writtenFields(patchFrontmatter))).toEqual([
      'priority',
      'status',
      'assignee',
      'due',
    ]);
  });

  it('refuses to walk a property off either end', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    gripFor('Status').focus();
    await user.keyboard('{ArrowUp}');
    expect(patchFrontmatter).not.toHaveBeenCalled();

    gripFor('Due').focus();
    await user.keyboard('{ArrowDown}');
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });

  // Reordering here rewrites the type's schema, so it reaches every record
  // of that type — not just the one on screen. The hint names that rather
  // than saying "drag to reorder".
  it('says what a drag actually changes, which is the type', async () => {
    const user = userEvent.setup();
    setup();
    await user.hover(gripFor('Priority'));
    await waitFor(
      () =>
        expect(screen.getByRole('tooltip').textContent).toBe(
          'Drag to reorder — changes every Work item',
        ),
      { timeout: 2000 },
    );
  });

  it('gives an undeclared key no grip — it is not in the type at all', () => {
    setup();
    expect(screen.queryByRole('button', { name: /^Reorder Stray note/ })).toBeNull();
  });

  it('gives an untyped record no grips', () => {
    setup({ type: null });
    expect(screen.queryByRole('button', { name: /^Reorder / })).toBeNull();
  });
});

/**
 * Per-property visibility (M16.10).
 *
 * There was no model at all: `ColumnSpec.hidden` is per-VIEW and a record
 * panel has no view to read it from, so a type with twenty optional
 * properties showed a wall of "Empty" on every record with no way to quiet it.
 */
describe('property visibility', () => {
  beforeEach(() => {
    resetLayers();
    useUiStore.setState({ toasts: [] });
  });
  afterEach(cleanup);

  /** Rebuild the fixture's Work item type with visibility on some fields. */
  function setupWithVisibility(vis: Record<string, string>) {
    const entries = fixtureVault().map((e) => {
      if (e.path !== TYPE_DOC) return e;
      const props = e.properties as unknown as { fields: Record<string, Record<string, unknown>> };
      const fields: Record<string, unknown> = {};
      for (const [name, spec] of Object.entries(props.fields)) {
        const base = typeof spec === 'string' ? { kind: spec } : { ...spec };
        fields[name] = vis[name] === undefined ? base : { ...base, visibility: vis[name] };
      }
      // A Type doc's `fields:` is a nested mapping; `properties` is typed for
      // scalars, and the scanner hands the mapping through as-is.
      return {
        ...e,
        properties: { ...e.properties, fields } as unknown as Entry['properties'],
      };
    });
    const record = makeEntry({
      path: RECORD,
      title: 'Ship it',
      type: 'Work item',
      properties: { status: 'todo', priority: 'high' },
    });
    const all = [...entries, record];
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    useVaultStore.setState({ entries: all, vaultPath: '/vault', patchFrontmatter });
    render(<RecordProperties entry={record} schema={buildSchema(all)} />);
    return { patchFrontmatter };
  }

  const rowNames = () =>
    screen.queryAllByTestId('property-row').map((r) => r.getAttribute('data-property'));

  it('shows everything when the type declares no visibility', () => {
    setupWithVisibility({});
    expect(rowNames()).toEqual(['status', 'priority', 'assignee', 'due']);
    expect(screen.queryByTestId('hidden-properties-toggle')).toBeNull();
  });

  it('folds an always-hidden property behind a counted expander', async () => {
    const user = userEvent.setup();
    setupWithVisibility({ due: 'hide' });
    expect(rowNames()).toEqual(['status', 'priority', 'assignee']);

    const toggle = screen.getByTestId('hidden-properties-toggle');
    expect(toggle.textContent).toContain('1 hidden property');

    await user.click(toggle);
    // Folded, not dropped — it comes back in its declared position.
    expect(rowNames()).toEqual(['status', 'priority', 'assignee', 'due']);
    expect(screen.getByTestId('hidden-properties-toggle').textContent).toContain('Hide 1 property');
  });

  it('folds hide-when-empty only for the records where it is empty', () => {
    // `assignee` and `due` are unset on this record; `priority` is set.
    setupWithVisibility({ priority: 'hide_when_empty', assignee: 'hide_when_empty' });
    expect(rowNames()).toEqual(['status', 'priority', 'due']);
    expect(screen.getByTestId('hidden-properties-toggle').textContent).toContain(
      '1 hidden property',
    );
  });

  it('counts several as properties, plural', () => {
    setupWithVisibility({ assignee: 'hide', due: 'hide' });
    expect(screen.getByTestId('hidden-properties-toggle').textContent).toContain(
      '2 hidden properties',
    );
  });

  it('sets visibility from the property menu, writing the type', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setupWithVisibility({});
    await openMenu(user, 'Due');
    await user.click(screen.getByTestId('property-menu-visibility'));
    await user.click(screen.getByTestId('property-visibility-hide_when_empty'));

    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalled());
    const fields = writtenFields(patchFrontmatter) as Record<string, { visibility?: string }>;
    expect(fields.due.visibility).toBe('hide_when_empty');
  });

  // A Type doc should not carry the absence of an opinion.
  it('deletes the key rather than writing the default back', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setupWithVisibility({ due: 'hide' });
    await user.click(screen.getByTestId('hidden-properties-toggle'));
    await openMenu(user, 'Due');
    await user.click(screen.getByTestId('property-menu-visibility'));
    await user.click(screen.getByTestId('property-visibility-show'));

    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalled());
    const fields = writtenFields(patchFrontmatter) as Record<string, { visibility?: string }>;
    expect('visibility' in fields.due).toBe(false);
  });

  it('shows which state a property is in without drilling in', async () => {
    const user = userEvent.setup();
    setupWithVisibility({ due: 'hide' });
    await user.click(screen.getByTestId('hidden-properties-toggle'));
    await openMenu(user, 'Due');
    expect(screen.getByTestId('property-menu-visibility').textContent).toContain('Always hide');
  });

  // Dragging over a partial list must not scatter what it cannot see.
  it('reorders against the full mapping, not the visible index', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setupWithVisibility({ priority: 'hide' });
    expect(rowNames()).toEqual(['status', 'assignee', 'due']);

    // Move `due` (visible slot 3) up one, to sit before `assignee`.
    screen.getByRole('button', { name: /^Reorder Due,/ }).focus();
    await user.keyboard('{ArrowUp}');

    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalled());
    expect(Object.keys(writtenFields(patchFrontmatter))).toEqual([
      'status',
      'priority',
      'due',
      'assignee',
    ]);
  });
});
