import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddPropertyPanel } from '@/detail/AddPropertyPanel';
import { resetLayers } from '@/components/ui/layers';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault } from '@/test/factories';

afterEach(cleanup);

/**
 * The dismissal this surface shipped without (M16.1).
 *
 * "Clicking away from the add-property menu doesn't close it. I'm forced to
 * press cancel." It had no scrim, no dialog role and no document listener,
 * so Cancel was the only mouse exit — and Escape from anywhere but the name
 * input bubbled to the record panel's global handler and closed the panel.
 */
describe('AddPropertyPanel dismissal', () => {
  beforeEach(() => {
    resetLayers();
    useVaultStore.setState({ entries: fixtureVault(), vaultPath: '/vault' });
  });

  function setup() {
    const onCancel = vi.fn();
    const onAdd = vi.fn();
    render(
      <div>
        <button type="button" data-testid="elsewhere">
          elsewhere
        </button>
        <AddPropertyPanel ownerType="Work item" onAdd={onAdd} onCancel={onCancel} />
      </div>,
    );
    return { onCancel, onAdd };
  }

  it('closes when a press lands outside it', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByTestId('elsewhere'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('stays open when a press lands inside it', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByPlaceholderText('Property name'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('closes on Escape from the name input', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByPlaceholderText('Property name'));
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });

  // The reported bug: focus on a kind tile, not the input, meant Escape was
  // unhandled here and taken by the record panel instead.
  it('closes on Escape with focus on a kind tile', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    screen.getByTestId('property-kind-select').focus();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });

  it('keeps Escape away from a global listener behind it', async () => {
    const user = userEvent.setup();
    const behind = vi.fn();
    document.addEventListener('keydown', behind);
    try {
      setup();
      screen.getByTestId('property-kind-select').focus();
      behind.mockClear();
      await user.keyboard('{Escape}');
      expect(behind).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', behind);
    }
  });

  it('steps Escape back out of relation config instead of discarding it', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByTestId('property-kind-relation'));
    expect(screen.getByTestId('add-relation-panel')).toBeTruthy();

    await user.keyboard('{Escape}');
    // Back to the catalog, and the surface itself is still open.
    expect(screen.getByTestId('add-property-panel')).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('closes outright on a press outside the relation step', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByTestId('property-kind-relation'));
    await user.click(screen.getByTestId('elsewhere'));
    expect(onCancel).toHaveBeenCalled();
  });
});

/**
 * The rebuild (M16.9). It was an inline bordered div that pushed the panel
 * down as it opened, listing 14 kinds with no search and no sections, and
 * exiting only through a Cancel button. Notion's is a popover anchored to the
 * trigger, searchable, with no OK/Cancel at all — picking a type IS the
 * commit.
 */
describe('AddPropertyPanel catalog', () => {
  beforeEach(() => {
    resetLayers();
    useVaultStore.setState({ entries: fixtureVault(), vaultPath: '/vault' });
  });
  afterEach(cleanup);

  function setup(props: Partial<Parameters<typeof AddPropertyPanel>[0]> = {}) {
    const onCancel = vi.fn();
    const onAdd = vi.fn();
    render(<AddPropertyPanel ownerType="Work item" onAdd={onAdd} onCancel={onCancel} {...props} />);
    return { onCancel, onAdd };
  }

  const kinds = () =>
    screen
      .queryAllByTestId(/^property-kind-/)
      .map((b) => b.getAttribute('data-testid')?.replace('property-kind-', ''));

  it('filters the type list as you search', async () => {
    const user = userEvent.setup();
    setup();
    expect(kinds().length).toBeGreaterThan(10);

    await user.type(screen.getByLabelText('Search property types'), 'sel');
    expect(kinds()).toEqual(['select', 'multiselect']);
  });

  it('matches the kind id too, so "multiselect" finds Multi-select', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Search property types'), 'multiselect');
    expect(kinds()).toEqual(['multiselect']);
  });

  it('says so rather than showing an empty box when nothing matches', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Search property types'), 'zzz');
    expect(kinds()).toEqual([]);
    expect(screen.getByText(/No property type matches/)).toBeTruthy();
  });

  it('commits the first match on Enter, so a search finishes without the pointer', async () => {
    const user = userEvent.setup();
    const { onAdd } = setup();
    await user.type(screen.getByLabelText('Search property types'), 'check{Enter}');
    expect(onAdd).toHaveBeenCalledWith('Checkbox', 'checkbox');
  });

  // The guard DocProperties had and RecordProperties did not.
  it('refuses a name that is already taken, before any write', async () => {
    const user = userEvent.setup();
    const { onAdd } = setup({ existingNames: ['Status', 'Priority'] });
    await user.type(screen.getByLabelText('Property name'), 'priority');

    expect(screen.getByRole('alert').textContent).toContain('already a property here');
    await user.click(screen.getByTestId('property-kind-text'));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('still names a property after its kind when the name is left blank', async () => {
    const user = userEvent.setup();
    const { onAdd } = setup({ existingNames: ['Select'] });
    await user.click(screen.getByTestId('property-kind-select'));
    // "Select" is taken, so the kind-first default steps to "Select 2".
    expect(onAdd).toHaveBeenCalledWith('Select 2', 'select');
  });

  // A browser never renders `title` on a disabled control, so the one
  // explanation these tiles owe a user was invisible on exactly the tiles
  // that needed it (M16.5).
  it('explains a kind an untyped doc cannot have', async () => {
    const user = userEvent.setup();
    setup({ ownerType: null });
    const tile = screen.getByTestId('property-kind-select') as HTMLButtonElement;
    expect(tile.disabled).toBe(true);
    expect(tile.getAttribute('title')).toBeNull();

    await user.hover(tile);
    await waitFor(
      () =>
        expect(screen.getByRole('tooltip').textContent).toBe(
          'Convert this doc to a record to use typed properties',
        ),
      { timeout: 2000 },
    );
  });

  it('keeps a way back only where clicking away would close something else', () => {
    const { unmount } = render(
      <AddPropertyPanel ownerType="Work item" onAdd={vi.fn()} onCancel={vi.fn()} />,
    );
    // Inline: a wizard page inside another popover, so it needs its own exit.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    unmount();

    const anchor = { current: document.createElement('button') };
    document.body.append(anchor.current);
    render(
      <AddPropertyPanel
        anchorRef={anchor}
        ownerType="Work item"
        onAdd={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Anchored: picking a type commits and clicking away dismisses.
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Add a property' })).toBeTruthy();
  });

  // Nesting a layer-registering surface inside a Popover inverts the stack:
  // child effects run first, so the Popover would push last and end up on top
  // of its own content.
  it('registers exactly one layer when anchored', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const anchor = { current: document.createElement('button') };
    document.body.append(anchor.current);
    render(
      <AddPropertyPanel
        anchorRef={anchor}
        ownerType="Work item"
        onAdd={vi.fn()}
        onCancel={onCancel}
      />,
    );
    // Escape reaches the relation step-back, which only the single owning
    // layer can perform.
    await user.click(screen.getByTestId('property-kind-relation'));
    expect(screen.getByTestId('add-relation-panel')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('add-property-panel')).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

/**
 * Person takes the relation route (M16.13b).
 *
 * It used to skip the config step entirely and declare a bare `kind: person`,
 * whose picker then hardcoded `type === 'Person'`. Choosing where its people
 * come from was impossible from anywhere in the app.
 */
describe('AddPropertyPanel person config', () => {
  beforeEach(() => {
    resetLayers();
    useVaultStore.setState({ entries: fixtureVault(), vaultPath: '/vault' });
  });
  afterEach(cleanup);

  function setup() {
    const onAdd = vi.fn();
    render(<AddPropertyPanel ownerType="Work item" onAdd={onAdd} onCancel={vi.fn()} />);
    return { onAdd };
  }

  it('opens the config step and carries the chosen target through', async () => {
    const user = userEvent.setup();
    const { onAdd } = setup();
    await user.click(screen.getByTestId('property-kind-person'));
    expect(screen.getByTestId('add-relation-panel')).toBeTruthy();

    await user.click(screen.getByTestId('relation-target-Person'));
    await user.click(screen.getByTestId('add-relation'));
    expect(onAdd).toHaveBeenCalledWith('Person', 'person', { target: 'Person' });
  });

  // Unlike a relation, a person may decline to name one: the engine falls
  // back to the vault's people types at read time.
  it('can be added without a target, and says so', async () => {
    const user = userEvent.setup();
    const { onAdd } = setup();
    await user.click(screen.getByTestId('property-kind-person'));
    expect(screen.getByTestId('relation-target-any')).toBeTruthy();
    await user.click(screen.getByTestId('add-relation'));
    expect(onAdd).toHaveBeenCalledWith('Person', 'person');
  });

  // The relation step stays enforced — that decision is M12.4's and stands.
  it('still refuses a relation with no data source', async () => {
    const user = userEvent.setup();
    const { onAdd } = setup();
    await user.click(screen.getByTestId('property-kind-relation'));
    expect(screen.queryByTestId('relation-target-any')).toBeNull();
    await user.click(screen.getByTestId('add-relation'));
    expect(onAdd).not.toHaveBeenCalled();
  });
});
