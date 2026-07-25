import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateMenu, NewProjectDialog } from '@/app/CreateMenu';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault, makeEntry } from '@/test/factories';

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
      // The typed title becomes the H1 verbatim (M1.x capitalization fix).
      body: '# Ship the fix\n',
    });
  });

  it('falls back to the item key as slug when the title slugifies to nothing', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('items/fld-3.md');
    useVaultStore.setState({ createItem });
    render(<CreateMenu />);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('button', { name: 'New item' }));
    await user.type(screen.getByPlaceholderText('What needs doing?'), '???');
    await user.click(screen.getByRole('button', { name: 'Create item' }));
    expect(createItem).toHaveBeenCalledWith({
      folder: 'items',
      slug: 'fld-3', // slugify('???') === '' would be rejected by create_note
      frontmatter: { type: 'Work item', key: 'FLD-3', project: '[[onboarding]]' },
      body: '# ???\n',
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
      body: '# Atlas\n',
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

// Fix tests (fix round D8): the Sidebar's per-space "New project" rows open
// this dialog prefilled with the clicked space (plan line 7618's stated
// intent), so it is exported with an optional initialSpacePath.
describe('NewProjectDialog', () => {
  beforeEach(() => {
    useVaultStore.setState({
      entries: [
        // A space that lists first in the dialog's default, so preselection
        // is distinguishable from spaces[0].
        makeEntry({ path: 'spaces/aaa-ops.md', title: 'AAA ops', type: 'Space' }),
        ...fixtureVault(),
        makeEntry({ path: 'spaces/growth.md', title: 'Growth', type: 'Space' }),
      ],
    });
    useUiStore.setState({ toasts: [] });
  });

  it('preselects the initialSpacePath space and writes its wikilink', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('projects/atlas.md');
    useVaultStore.setState({ createItem });
    render(<NewProjectDialog initialSpacePath="spaces/growth.md" onClose={vi.fn()} />);
    expect((screen.getByLabelText('Space') as HTMLSelectElement).value).toBe('spaces/growth.md');
    await user.type(screen.getByPlaceholderText('Project name'), 'Atlas');
    await user.type(screen.getByPlaceholderText('e.g. FLD'), 'ATL');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(createItem).toHaveBeenCalledWith({
      folder: 'projects',
      slug: 'atlas',
      frontmatter: { type: 'Project', key: 'ATL', space: '[[growth]]' },
      body: '# Atlas\n',
    });
  });

  it('falls back to the first space when initialSpacePath is unknown', () => {
    useVaultStore.setState({ createItem: vi.fn() });
    render(<NewProjectDialog initialSpacePath="spaces/deleted.md" onClose={vi.fn()} />);
    expect((screen.getByLabelText('Space') as HTMLSelectElement).value).toBe('spaces/aaa-ops.md');
  });

  // Coverage gap flagged in review: the project dialog's failure guard had no
  // direct test.
  it('surfaces a failed project create via toast, stays open, and re-enables retry', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockRejectedValue(new Error('disk full'));
    useVaultStore.setState({ createItem });
    const onClose = vi.fn();
    render(<NewProjectDialog onClose={onClose} />);
    await user.type(screen.getByPlaceholderText('Project name'), 'Doomed proj');
    await user.type(screen.getByPlaceholderText('e.g. FLD'), 'DPX');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    await vi.waitFor(() => {
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
        'Couldn\'t create "Doomed proj"',
      );
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: 'Create project' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

// Fix tests (fix round M1, probe-proven): double-clicking Create while the
// write was pending called createItem twice with identical keys — two files
// with duplicate `key:` frontmatter. Each dialog holds an isSubmitting flag
// that disables the primary action while the write is in flight.
describe('CreateMenu busy guard', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
    useUiStore.setState({ toasts: [] });
  });

  const pendingForever = () => new Promise<string>(() => {});

  it('a second click while the item create is pending does not create twice', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn(pendingForever);
    useVaultStore.setState({ createItem });
    render(<CreateMenu />);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('button', { name: 'New item' }));
    await user.type(screen.getByPlaceholderText('What needs doing?'), 'Once only');
    const create = screen.getByRole('button', { name: 'Create item' });
    await user.click(create);
    await user.click(create);
    expect(createItem).toHaveBeenCalledTimes(1);
  });

  it('a second click while the project create is pending does not create twice', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn(pendingForever);
    useVaultStore.setState({ createItem });
    render(<CreateMenu />);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.type(screen.getByPlaceholderText('Project name'), 'Once only');
    await user.type(screen.getByPlaceholderText('e.g. FLD'), 'ONC');
    const create = screen.getByRole('button', { name: 'Create project' });
    await user.click(create);
    await user.click(create);
    expect(createItem).toHaveBeenCalledTimes(1);
  });

  it('a second click while the space create is pending does not create twice', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn(pendingForever);
    useVaultStore.setState({ createItem });
    render(<CreateMenu />);
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('button', { name: 'New space' }));
    await user.type(screen.getByPlaceholderText('Space name'), 'Once only');
    const create = screen.getByRole('button', { name: 'Create space' });
    await user.click(create);
    await user.click(create);
    expect(createItem).toHaveBeenCalledTimes(1);
  });
});
