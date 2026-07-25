import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateMenu } from '@/app/CreateMenu';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault } from '@/test/factories';

afterEach(cleanup);

describe('CreateMenu', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
  });

  it('creates an item from the new item dialog', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('items/ship-the-fix.md');
    useVaultStore.setState({ createItem });
    render(<CreateMenu />);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('button', { name: 'New item' }));
    await user.type(screen.getByPlaceholderText('What needs doing?'), 'Ship the fix');
    await user.click(screen.getByRole('button', { name: 'Create item' }));
    expect(createItem).toHaveBeenCalledWith({
      folder: 'items',
      slug: 'ship-the-fix',
      frontmatter: { type: 'Work item', key: 'FLD-3', project: '[[onboarding]]' },
    });
  });

  it('disables project creation until the key prefix is 2-4 uppercase letters', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('projects/atlas.md');
    useVaultStore.setState({ createItem });
    render(<CreateMenu />);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.type(screen.getByPlaceholderText('Project name'), 'Atlas');
    await user.type(screen.getByPlaceholderText('e.g. FLD'), 'A');
    expect(
      (screen.getByRole('button', { name: 'Create project' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.type(screen.getByPlaceholderText('e.g. FLD'), 'TL');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(createItem).toHaveBeenCalledWith({
      folder: 'projects',
      slug: 'atlas',
      frontmatter: { type: 'Project', key: 'ATL', space: '[[field-platform]]' },
    });
  });

  it('creates a space seeded with the selected status template', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('spaces/growth.md');
    useVaultStore.setState({ createItem });
    render(<CreateMenu />);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('button', { name: 'New space' }));
    await user.type(screen.getByPlaceholderText('Space name'), 'Growth');
    await user.selectOptions(screen.getByLabelText('Status template'), 'simple');
    await user.click(screen.getByRole('button', { name: 'Create space' }));
    const args = createItem.mock.calls[0][0];
    expect(args.folder).toBe('spaces');
    expect(args.slug).toBe('growth');
    expect(args.frontmatter.type).toBe('Space');
    expect(args.frontmatter.statuses).toEqual([
      { id: 'todo', label: 'Todo', group: 'active', color: 'var(--n-500)', hollow: true },
      { id: 'doing', label: 'Doing', group: 'active', color: 'var(--warn-500)' },
      { id: 'done', label: 'Done', group: 'done', color: 'var(--success-500)' },
      { id: 'dropped', label: 'Dropped', group: 'closed', color: 'var(--n-400)' },
    ]);
  });
});

// Deviation tests (execution-log notes 16a/17b, reported): no fire-and-forget
// writes in CreateMenu — createItem throws to callers by design, so each
// dialog must surface a failure via toast and keep the dialog open instead of
// leaving an unhandled rejection.
describe('CreateMenu write guards', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
    useUiStore.setState({ toasts: [] });
  });

  it('surfaces a failed item create via toast and keeps the dialog open', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockRejectedValue(new Error('disk full'));
    useVaultStore.setState({ createItem });
    render(<CreateMenu />);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('button', { name: 'New item' }));
    await user.type(screen.getByPlaceholderText('What needs doing?'), 'Doomed');
    await user.click(screen.getByRole('button', { name: 'Create item' }));
    await vi.waitFor(() => {
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
        'Couldn\'t create "Doomed"',
      );
    });
    expect(screen.getByPlaceholderText('What needs doing?')).toBeTruthy();
  });

  it('surfaces a failed space create via toast without navigating', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockRejectedValue(new Error('disk full'));
    useVaultStore.setState({ createItem });
    const before = useNavStore.getState().selection;
    render(<CreateMenu />);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('button', { name: 'New space' }));
    await user.type(screen.getByPlaceholderText('Space name'), 'Doomed space');
    await user.click(screen.getByRole('button', { name: 'Create space' }));
    await vi.waitFor(() => {
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
        'Couldn\'t create "Doomed space"',
      );
    });
    expect(useNavStore.getState().selection).toEqual(before);
    expect(screen.getByPlaceholderText('Space name')).toBeTruthy();
  });
});
