// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateMenu } from '@/app/CreateMenu';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault } from '@/test/factories';

afterEach(cleanup);

// M12.5: the New menu creates the three things that exist — a record (a page
// of a type), a doc (untyped prose), and a collection (a container). "New
// item" and "New project" died with the system types that defined them.
describe('CreateMenu', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
    useUiStore.setState({ toasts: [] });
  });

  it('creates a record of the picked type in its records folder', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('records/work-items/ship-the-fix.md');
    useVaultStore.setState({ createItem });
    render(<CreateMenu />);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('menuitem', { name: 'New record' }));
    await user.type(screen.getByPlaceholderText('What is it called?'), 'Ship the fix');
    await user.selectOptions(screen.getByRole('combobox'), 'Work item');
    await user.click(screen.getByRole('button', { name: 'Create record' }));
    // No project context → the type's records folder; no key without a
    // container prefix (M12.2).
    expect(createItem).toHaveBeenCalledWith({
      folder: 'records/work-items',
      slug: 'ship-the-fix',
      frontmatter: { type: 'Work item' },
      body: '# Ship the fix\n',
    });
  });

  it('creates an untyped doc at the vault root', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('meeting-notes.md');
    useVaultStore.setState({ createItem });
    render(<CreateMenu />);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('menuitem', { name: 'New doc' }));
    await user.type(screen.getByPlaceholderText('Doc title'), 'Meeting notes');
    await user.click(screen.getByRole('button', { name: 'Create doc' }));
    expect(createItem).toHaveBeenCalledWith({
      folder: '',
      slug: 'meeting-notes',
      frontmatter: {},
      body: '# Meeting notes\n',
    });
  });

  it('offers New collection', async () => {
    const user = userEvent.setup();
    render(<CreateMenu />);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('menuitem', { name: 'New collection' }));
    // The shared CollectionDialog opens; its behavior is covered by its own
    // tests — here it only matters that the menu reaches it.
    expect(screen.getByText(/collection/i)).toBeTruthy();
  });

  // Deviation guards (16a/17b): createItem throws to callers by design — the
  // dialog surfaces the failure and stays open for retry.
  it('surfaces a failed record create via toast and keeps the dialog open', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockRejectedValue(new Error('disk full'));
    useVaultStore.setState({ createItem });
    render(<CreateMenu />);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('menuitem', { name: 'New record' }));
    await user.type(screen.getByPlaceholderText('What is it called?'), 'Doomed');
    await user.click(screen.getByRole('button', { name: 'Create record' }));
    await vi.waitFor(() => {
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
        'Couldn\'t create "Doomed"',
      );
    });
    expect(screen.getByPlaceholderText('What is it called?')).toBeTruthy();
  });

  // M15: the popup was a plain div — nothing announced a menu, focus stayed on
  // the trigger, arrow keys did nothing, and Escape did not close it.
  describe('keyboard', () => {
    it('announces a menu, focuses the first entry, and closes on Escape', async () => {
      const user = userEvent.setup();
      render(<CreateMenu />);
      const trigger = screen.getByRole('button', { name: 'New' });
      expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      await user.click(trigger);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(screen.getByRole('menu')).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'New record' }));
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).toBeNull();
      // Focus goes back to the trigger, not to <body>.
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New' }));
    });

    it('walks the entries with the arrow keys and wraps', async () => {
      const user = userEvent.setup();
      render(<CreateMenu />);
      await user.click(screen.getByRole('button', { name: 'New' }));
      await user.keyboard('{ArrowDown}');
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'New doc' }));
      await user.keyboard('{ArrowUp}{ArrowUp}');
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'New collection' }));
    });
  });

  // Fix (fix round M1): double-clicking Create while the write was pending
  // created twice.
  it('a second click while the record create is pending does not create twice', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn(() => new Promise<string>(() => {}));
    useVaultStore.setState({ createItem });
    render(<CreateMenu />);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('menuitem', { name: 'New record' }));
    await user.type(screen.getByPlaceholderText('What is it called?'), 'Once only');
    const create = screen.getByRole('button', { name: 'Create record' });
    await user.click(create);
    await user.click(create);
    expect(createItem).toHaveBeenCalledTimes(1);
  });
});
