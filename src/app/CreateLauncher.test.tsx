import { navSeed } from '@/test/navSeed';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeEntry } from '@/test/factories';
import { useLauncherStore } from '@/stores/launcherStore';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { CreateLauncher } from './CreateLauncher';
import { createLibraryItem } from '@/library/libraryActions';
import { addSubPage } from './pageActions';
import { captureNote } from '@/lib/capture';
vi.mock('./CreateMenu', () => ({
  NewDocDialog: () => <div role="dialog" aria-label="New page" />,
  NewRecordDialog: () => <div role="dialog" aria-label="New record" />,
}));
vi.mock('./TypeDialogs', () => ({
  NewTypeDialog: () => <div role="dialog" aria-label="New database" />,
}));
vi.mock('./CsvImportDialog', () => ({
  CsvImportDialog: () => <div role="dialog" aria-label="Import CSV" />,
}));
vi.mock('./CollectionDialog', () => ({
  CollectionDialog: () => <div role="dialog" aria-label="New collection" />,
}));
vi.mock('@/pages/StudioPage', () => ({
  NewPrototypeDialog: () => <div role="dialog" aria-label="New prototype" />,
}));
vi.mock('@/library/libraryActions', async (original) => ({
  ...(await original<typeof import('@/library/libraryActions')>()),
  createLibraryItem: vi.fn(),
}));
vi.mock('./pageActions', () => ({ addSubPage: vi.fn() }));
vi.mock('@/lib/capture', () => ({ captureNote: vi.fn() }));
beforeEach(() => {
  useVaultStore.setState({
    vaultPath: '/v',
    entriesVault: '/v',
    status: 'ready',
    entries: [makeEntry({ path: 'plan.md', title: 'Plan' })],
  });
  useNavStore.setState({
    selection: { kind: 'home' },
    history: [navSeed({ kind: 'home' })],
    historyIndex: 0,
  });
  useUiStore.setState({ inboxEnabled: true });
  useLauncherStore.setState({ open: true, flow: null, recents: {} });
  vi.mocked(createLibraryItem).mockReset().mockResolvedValue('new.md');
  vi.mocked(addSubPage).mockReset().mockResolvedValue('plan/untitled.md');
  vi.mocked(captureNote).mockReset().mockResolvedValue('inbox/new.md');
});
afterEach(cleanup);
it('shows the ordered groups, follows hover, and filters both recents and the catalog', async () => {
  const user = userEvent.setup();
  render(<CreateLauncher />);
  expect(screen.getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual([
    'Write',
    'Organize',
    'Data',
    'Diagram',
    'Build',
    'AI',
    'Capture',
  ]);
  expect(screen.queryByRole('group', { name: 'Recent' })).toBeNull();
  expect(screen.getByTestId('create-lands').textContent).toBe('At the top of the vault.');
  await user.hover(screen.getByRole('option', { name: 'Agent' }));
  expect(screen.getByTestId('create-lands').textContent).toBe('In records/agents/, born paused.');
  act(() => useLauncherStore.setState({ recents: { '/v': ['database', 'agent', 'page'] } }));
  await user.type(screen.getByRole('combobox'), 'database');
  expect(
    within(screen.getByRole('group', { name: 'Recent' }))
      .getAllByRole('option')
      .map((row) => row.textContent),
  ).toEqual(['Database']);
  expect(screen.getAllByRole('option')).toHaveLength(4); // record's tagline names its database too
});
it.each([
  ['Page', 'New page'],
  ['Record', 'New record'],
  ['Database', 'New database'],
  ['Database from CSV', 'Import CSV'],
  ['Collection', 'New collection'],
  ['Prototype', 'New prototype'],
  ['Whiteboard', 'New whiteboard'],
])('%s reaches its existing dialog', async (label, dialog) => {
  const user = userEvent.setup();
  render(<CreateLauncher />);
  await user.click(screen.getByRole('option', { name: label }));
  expect(screen.getByRole('dialog', { name: dialog })).toBeTruthy();
  expect(useLauncherStore.getState().open).toBe(false);
});
it.each(['agent', 'skill', 'template'] as const)(
  'creates a %s once and opens its existing destination',
  async (kind) => {
    const user = userEvent.setup();
    render(<CreateLauncher />);
    await user.click(screen.getByRole('option', { name: new RegExp(`^${kind}$`, 'i') }));
    expect(createLibraryItem).toHaveBeenCalledExactlyOnceWith(kind);
    expect(useNavStore.getState().selection).toEqual(
      kind === 'agent'
        ? { kind: 'doc', path: 'new.md' }
        : { kind: 'library', tab: kind, path: 'new.md' },
    );
  },
);
it('a failed creator leaves the place alone', async () => {
  vi.mocked(createLibraryItem).mockResolvedValue(null);
  const user = userEvent.setup();
  render(<CreateLauncher />);
  await user.click(screen.getByRole('option', { name: 'Skill' }));
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
});
it('creates a sub-page on the current page and a capture on the Inbox', async () => {
  useNavStore.setState({ selection: { kind: 'doc', path: 'plan.md' } });
  const user = userEvent.setup();
  render(<CreateLauncher />);
  await user.click(screen.getByRole('option', { name: 'Sub-page' }));
  expect(addSubPage).toHaveBeenCalledExactlyOnceWith('plan.md', 'Untitled');
  act(() => useLauncherStore.getState().openLauncher());
  await user.click(screen.getByRole('option', { name: 'Capture' }));
  expect(captureNote).toHaveBeenCalledTimes(1);
  expect(useNavStore.getState().selection).toEqual({ kind: 'inbox' });
  expect(useUiStore.getState().inboxSelectedPath).toBe('inbox/new.md');
});
it('closes a creation flow when switching vaults', () => {
  useLauncherStore.setState({
    open: false,
    flow: {
      id: 'page',
      vault: '/other',
      page: null,
      context: {
        vault: '/other',
        pane: 'p1',
        destination: { kind: 'page', folder: '', recipe: { kind: 'blank' } },
      },
    },
  });
  render(<CreateLauncher />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(useLauncherStore.getState().flow).toBeNull();
});
