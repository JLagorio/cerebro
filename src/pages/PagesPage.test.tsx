// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { useLauncherStore } from '@/stores/launcherStore';
import { useNavStore } from '@/stores/navStore';
import { useOpenLogStore } from '@/stores/openLogStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { chooseOption, optionLabels } from '@/test/chooseOption';
import { PagesPage } from './PagesPage';

const note = makeEntry({ path: 'docs/brief.md', title: 'Design brief', folder: 'docs' });
const record = makeEntry({ path: 'projects/release.md', title: 'Release plan', type: 'Project' });

beforeEach(() => {
  useNavStore.getState().reset();
  useNavStore.getState().navigate({ kind: 'pages' });
  useUiStore.setState({ favorites: {}, detailPath: null });
  useOpenLogStore.setState({ logs: {} });
  useLauncherStore.setState({ flow: null });
  useVaultStore.setState({
    vaultPath: '/demo-vault',
    entriesVault: '/demo-vault',
    status: 'ready',
    error: null,
    entries: [
      note,
      record,
      makeEntry({ path: 'types/project.md', type: 'Type', title: 'Project schema' }),
      makeEntry({ path: 'knowledge/concept.md', title: 'Guarded concept' }),
      makeEntry({ path: 'templates/blank.md', folder: 'templates', title: '{{title}}' }),
    ],
  });
});
afterEach(cleanup);

describe('Pages browser', () => {
  it('opens documents and records as pages, keeping schemas and knowledge in their destinations', () => {
    render(<PagesPage />);
    expect(screen.getAllByTestId('page-browser-item')).toHaveLength(2);
    expect(screen.queryByText('Project schema')).toBeNull();
    expect(screen.queryByText('Guarded concept')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Release plan' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: record.path });
    expect(useUiStore.getState().detailPath).toBeNull();
  });

  it('uses real favorites and the current vault’s personal open history', () => {
    useOpenLogStore.getState().record('/demo-vault', note.path);
    useOpenLogStore.getState().record('/other-vault', record.path);
    render(<PagesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Recently opened' }));
    expect(screen.getAllByTestId('page-browser-item')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Open Design brief' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Design brief to favorites' }));
    fireEvent.click(screen.getByRole('button', { name: 'Favorites' }));
    expect(useUiStore.getState().favorites['/demo-vault']).toEqual([note.path]);
    const row = screen.getByTestId('page-browser-item');
    expect(within(row).getByRole('button', { name: 'Open Design brief' })).toBeTruthy();
  });

  it('retains the browser view and query when Back returns to this visit', () => {
    render(<PagesPage />);
    fireEvent.change(screen.getByLabelText('Search pages'), { target: { value: 'Release' } });
    fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Release plan' }));
    act(() => useNavStore.getState().back());
    expect(useNavStore.getState().readEntryState('view.search')).toBe('Release');
    expect(useNavStore.getState().readEntryState('pages.browser')).toMatchObject({
      display: 'grid',
    });
  });

  it('sorts by last edit or by name, and Recently opened keeps its own order', () => {
    useVaultStore.setState({
      entries: [note, { ...record, modifiedAt: '2026-07-30T00:00:00.000Z' }],
    });
    render(<PagesPage />);
    const order = () =>
      screen
        .getAllByRole('button', { name: /^Open / })
        .map((button) => button.getAttribute('aria-label'));
    const sort = screen.getByRole('button', { name: 'Sort pages' });
    expect(sort.getAttribute('data-value')).toBe('modified');
    expect(optionLabels(sort)).toEqual(['Last edited', 'Name']);
    expect(order()).toEqual(['Open Release plan', 'Open Design brief']);
    chooseOption(sort, 'Name');
    expect(sort.getAttribute('data-value')).toBe('title');
    expect(order()).toEqual(['Open Design brief', 'Open Release plan']);
    expect(useNavStore.getState().readEntryState('pages.browser')).toMatchObject({
      sort: 'title',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recently opened' }));
    expect(screen.queryByRole('button', { name: 'Sort pages' })).toBeNull();
  });

  it('routes New through the existing create flow', () => {
    render(<PagesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Page' }));
    expect(useLauncherStore.getState().flow).toMatchObject({ id: 'page', vault: '/demo-vault' });
  });

  it('reports a failed scan instead of an empty browser', () => {
    useVaultStore.setState({ status: 'error', error: 'Disk unavailable', entries: [] });
    render(<PagesPage />);
    expect(screen.getByTestId('section-unavailable').textContent).toContain('Disk unavailable');
    expect(screen.queryByText('A place for your ideas')).toBeNull();
    expect((screen.getByRole('button', { name: 'New' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not display the prior vault while a different vault is opening', () => {
    useVaultStore.setState({ vaultPath: '/other-vault' });
    render(<PagesPage />);
    expect(screen.getByRole('status').textContent).toContain('Loading pages');
    expect(screen.queryByTestId('page-browser-item')).toBeNull();
  });

  it('says Not recorded for an absent edit date', () => {
    useVaultStore.setState({ entries: [{ ...note, modifiedAt: '' }] });
    render(<PagesPage />);
    expect(screen.getByText('Not recorded')).toBeTruthy();
  });

  it('never presents an unreadable grid preview as a blank writable page', () => {
    useVaultStore.setState({ entries: [{ ...note, parseError: 'Malformed frontmatter' }] });
    render(<PagesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));
    expect(screen.getByText('Page has a reading error. Open for details.')).toBeTruthy();
    expect(screen.queryByText('No preview text.')).toBeNull();
  });
});
