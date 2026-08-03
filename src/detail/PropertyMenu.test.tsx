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

  it('deletes a property from the type', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await openMenu(user, 'Priority');
    await user.click(screen.getByTestId('property-menu-delete'));

    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalled());
    expect(Object.keys(writtenFields(patchFrontmatter))).not.toContain('priority');
    expect(screen.queryByRole('menu')).toBeNull();
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
