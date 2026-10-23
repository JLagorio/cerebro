// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateMenu } from '@/app/CreateMenu';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { chooseOption } from '@/test/chooseOption';
import { fixtureVault } from '@/test/factories';
import { CreateLauncher } from './CreateLauncher';
import { useLauncherStore } from '@/stores/launcherStore';

afterEach(cleanup);

describe('CreateMenu', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entriesVault: '/demo-vault',
      status: 'ready',
      entries: fixtureVault(),
    });
    useLauncherStore.setState({ open: false, flow: null, recents: {} });
    useUiStore.setState({ toasts: [] });
  });

  it('creates a record of the picked type in its records folder', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('records/work-items/ship-the-fix.md');
    useVaultStore.setState({ createItem });
    render(
      <>
        <CreateMenu />
        <CreateLauncher />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('option', { name: 'Record' }));
    await user.type(screen.getByPlaceholderText('What is it called?'), 'Ship the fix');
    chooseOption(screen.getByRole('button', { name: 'Database' }), 'Work item');
    await user.click(screen.getByRole('button', { name: 'Create record' }));
    // No project context → the type's records folder; no key without a
    // container prefix (M12.2).
    expect(createItem).toHaveBeenCalledWith({
      folder: 'records/work-items',
      slug: 'ship-the-fix',
      frontmatter: { type: 'Work item', status: 'todo' },
      body: '# Ship the fix\n',
    });
  });

  it('creates an untyped doc at the vault root', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('meeting-notes.md');
    useVaultStore.setState({ createItem });
    render(
      <>
        <CreateMenu />
        <CreateLauncher />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('option', { name: 'Page' }));
    await user.type(screen.getByPlaceholderText('Page title'), 'Meeting notes');
    await user.click(screen.getByRole('button', { name: 'Create page' }));
    expect(createItem).toHaveBeenCalledWith({
      folder: '',
      slug: 'meeting-notes',
      frontmatter: {},
      body: '# Meeting notes\n',
    });
  });

  it('creates a named sheet page at the vault root', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('plan-numbers.md');
    useVaultStore.setState({ createItem });
    render(
      <>
        <CreateMenu />
        <CreateLauncher />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('option', { name: 'Sheet' }));
    expect(screen.getByRole('dialog', { name: 'New sheet' })).toBeTruthy();
    await user.type(screen.getByPlaceholderText('Name the page'), 'Plan numbers');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(createItem).toHaveBeenCalledWith({
      folder: '',
      slug: 'plan-numbers',
      frontmatter: {},
      body: '# Plan numbers\n\n```cerebro-sheet\n---\nformat: 1\nname: "Sheet1"\n---\n```\n',
    });
  });
  it('offers New collection', async () => {
    const user = userEvent.setup();
    render(
      <>
        <CreateMenu />
        <CreateLauncher />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('option', { name: 'Collection' }));
    // The shared CollectionDialog opens; its behavior is covered by its own
    // tests — here it only matters that the menu reaches it.
    expect(screen.getByRole('dialog', { name: 'New collection' })).toBeTruthy();
  });

  // Deviation guards (16a/17b): createItem throws to callers by design — the
  // dialog surfaces the failure and stays open for retry.
  it('surfaces a failed record create via toast and keeps the dialog open', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockRejectedValue(new Error('disk full'));
    useVaultStore.setState({ createItem });
    render(
      <>
        <CreateMenu />
        <CreateLauncher />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('option', { name: 'Record' }));
    await user.type(screen.getByPlaceholderText('What is it called?'), 'Doomed');
    await user.click(screen.getByRole('button', { name: 'Create record' }));
    await vi.waitFor(() => {
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
        "Couldn't create “Doomed”",
      );
    });
    expect(screen.getByPlaceholderText('What is it called?')).toBeTruthy();
  });

  describe('keyboard', () => {
    it('announces a dialog, focuses its filter, and restores focus on Escape', async () => {
      const user = userEvent.setup();
      render(
        <>
          <CreateMenu />
          <CreateLauncher />
        </>,
      );
      const trigger = screen.getByRole('button', { name: 'New' });
      expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
      await user.click(trigger);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(
        screen.getByRole('combobox', { name: 'What would you like to create?' }),
      );
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
    it('walks the choices with arrow keys and wraps', async () => {
      const user = userEvent.setup();
      render(
        <>
          <CreateMenu />
          <CreateLauncher />
        </>,
      );
      await user.click(screen.getByRole('button', { name: 'New' }));
      const choices = screen.getAllByRole('option');
      await user.keyboard('{ArrowUp}');
      expect(choices.at(-1)?.getAttribute('aria-selected')).toBe('true');
      await user.keyboard('{ArrowDown}');
      expect(choices[0]?.getAttribute('aria-selected')).toBe('true');
    });
  });

  // Fix (fix round M1): double-clicking Create while the write was pending
  // created twice.
  it('a second click while the record create is pending does not create twice', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn(() => new Promise<string>(() => {}));
    useVaultStore.setState({ createItem });
    render(
      <>
        <CreateMenu />
        <CreateLauncher />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('option', { name: 'Record' }));
    await user.type(screen.getByPlaceholderText('What is it called?'), 'Once only');
    const create = screen.getByRole('button', { name: 'Create record' });
    await user.click(create);
    await user.click(create);
    expect(createItem).toHaveBeenCalledTimes(1);
  });
});
