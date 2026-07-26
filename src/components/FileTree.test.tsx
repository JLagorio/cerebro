// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockFs } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { FileTree } from './FileTree';

const ROOT = 'projects/guided-onboarding-ga';
const PROJECT = `${ROOT}/project.md`;
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

const renderTree = (onOpen = vi.fn()) => {
  render(<FileTree root={ROOT} hide={(p) => p === PROJECT} onOpen={onOpen} />);
  return onOpen;
};

describe('FileTree', () => {
  beforeEach(async () => {
    resetMockFs();
    window.localStorage.clear();
    useUiStore.setState({ expandedFolders: {}, toasts: [], detailPath: null });
    await useVaultStore.getState().openVault('/demo-vault');
  });
  afterEach(cleanup);

  it('lists folders and files, hides the excluded project.md', () => {
    renderTree();
    const folders = screen.getAllByTestId('tree-folder').map((el) => el.textContent);
    expect(folders).toContain('meetings');
    expect(folders).toContain('items');
    // Root holds only folders (project.md is hidden), so no file rows yet.
    const files = screen.queryAllByTestId('tree-file').map((el) => el.textContent);
    expect(files).not.toContain('project');
  });

  it('expands a folder on click and persists the expand state', () => {
    renderTree();
    expect(screen.queryByText('kickoff')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^meetings/ }));
    expect(screen.getByText('kickoff')).toBeTruthy();
    expect(useUiStore.getState().expandedFolders[`${ROOT}/meetings`]).toBe(true);
    expect(window.localStorage.getItem('cerebro.expandedFolders')).toContain(`${ROOT}/meetings`);
  });

  it('opens a file through onOpen', () => {
    const onOpen = renderTree();
    fireEvent.click(screen.getByRole('button', { name: /^meetings/ }));
    fireEvent.click(screen.getByRole('button', { name: /^kickoff/ }));
    expect(onOpen).toHaveBeenCalledWith(`${ROOT}/meetings/kickoff.md`);
  });

  it('creates a page with the typed capitalization and opens it', async () => {
    const onOpen = renderTree();
    fireEvent.click(screen.getByRole('button', { name: 'New page' }));
    fireEvent.change(screen.getByPlaceholderText('Page name'), {
      target: { value: 'Design Notes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(`${ROOT}/design-notes.md`));
    expect(fs().get(`${ROOT}/design-notes.md`)).toBe('# Design Notes\n');
    expect(
      useVaultStore.getState().entries.some((e) => e.path === `${ROOT}/design-notes.md`),
    ).toBe(true);
  });

  it('creates a folder and shows it expanded even while empty', async () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    fireEvent.change(screen.getByPlaceholderText('Folder name'), {
      target: { value: 'Research' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(screen.getAllByTestId('tree-folder').map((el) => el.textContent)).toContain(
        'research',
      ),
    );
    expect(screen.getByText('Empty folder')).toBeTruthy();
  });

  it('renames a file on disk', async () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: /^meetings/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename kickoff' }));
    const input = screen.getByPlaceholderText('Page name');
    expect((input as HTMLInputElement).value).toBe('kickoff');
    fireEvent.change(input, { target: { value: 'kickoff-notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(fs().has(`${ROOT}/meetings/kickoff-notes.md`)).toBe(true));
    expect(fs().has(`${ROOT}/meetings/kickoff.md`)).toBe(false);
  });

  // Task 14: right-click context menus.
  it('right-clicking a file offers rename and trash', async () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: /^meetings/ }));
    fireEvent.contextMenu(screen.getByRole('button', { name: /^kickoff/ }));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByPlaceholderText('Page name') as HTMLInputElement;
    expect(input.value).toBe('kickoff');
    fireEvent.change(input, { target: { value: 'standup' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(fs().has(`${ROOT}/meetings/standup.md`)).toBe(true));
  });

  it('right-clicking a folder creates a page inside it', async () => {
    const onOpen = renderTree();
    fireEvent.contextMenu(screen.getByRole('button', { name: /^meetings/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New page' }));
    fireEvent.change(screen.getByPlaceholderText('Page name'), {
      target: { value: 'Retro' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(`${ROOT}/meetings/retro.md`));
  });

  it('right-clicking the background targets the tree root', async () => {
    const onOpen = renderTree();
    fireEvent.contextMenu(screen.getByTestId('file-tree'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New page' }));
    // No rename/trash on the background menu — there is no target node.
    fireEvent.change(screen.getByPlaceholderText('Page name'), {
      target: { value: 'Scratch' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(`${ROOT}/scratch.md`));
  });

  it('right-clicking a file and choosing Move to Trash deletes after confirm', async () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: /^meetings/ }));
    fireEvent.contextMenu(screen.getByRole('button', { name: /^kickoff/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Trash' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(fs().has(`${ROOT}/meetings/kickoff.md`)).toBe(false));
  });

  it('moves a file to the Trash after confirmation', async () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: /^meetings/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete kickoff' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(fs().has(`${ROOT}/meetings/kickoff.md`)).toBe(false));
  });
});
