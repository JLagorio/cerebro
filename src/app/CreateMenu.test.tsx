import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateMenu, NewProjectDialog } from '@/app/CreateMenu';
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
    // v2: the item lands inside the project folder (containment membership,
    // no `project:` wikilink); the typed title becomes the H1 verbatim.
    expect(createItem).toHaveBeenCalledWith({
      folder: 'projects/onboarding/items',
      slug: 'ship-the-fix',
      frontmatter: { type: 'Work item', key: 'FLD-3' },
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
      folder: 'projects/onboarding/items',
      slug: 'fld-3', // slugify('???') === '' would be rejected by create_note
      frontmatter: { type: 'Work item', key: 'FLD-3' },
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
    // v2: a project is projects/<slug>/project.md.
    expect(createItem).toHaveBeenCalledWith({
      folder: 'projects/atlas',
      slug: 'project',
      frontmatter: { type: 'Project', key: 'ATL' },
      body: '# Atlas\n',
    });
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

});

describe('NewProjectDialog', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
    useUiStore.setState({ toasts: [] });
  });

  // v2: create_note dedupes the file slug only, so the dialog must dedupe the
  // project FOLDER against existing projects.
  it('dedupes the project folder against existing projects', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('projects/guided-onboarding-2/project.md');
    useVaultStore.setState({ createItem });
    render(<NewProjectDialog onClose={vi.fn()} />);
    // The fixture already has projects/onboarding/ — same slug collides.
    await user.type(screen.getByPlaceholderText('Project name'), 'Onboarding');
    await user.type(screen.getByPlaceholderText('e.g. FLD'), 'ONB');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(createItem).toHaveBeenCalledWith({
      folder: 'projects/onboarding-2',
      slug: 'project',
      frontmatter: { type: 'Project', key: 'ONB' },
      body: '# Onboarding\n',
    });
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

});
