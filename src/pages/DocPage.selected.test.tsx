import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DocPage } from './DocPage';
import { useVaultStore } from '@/stores/vaultStore';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { resetMockFs } from '@/lib/mockIpc';
import {
  resetSelectedWorkspacesForTest,
  seedSelectedWorkspaceForTest,
  selectedFixtureForTest,
} from '@/lib/selectedMock';
import * as ipc from '@/lib/ipc';

const VAULT = '/fixture-selected-workspace';
const PATH = 'page.md';
const BODY =
  '\uFEFF---\r\ntype: Agent\r\ntools: [write_note]\r\n---\r\n# Canonical body\r\n\r\nExact visible Markdown.\r\n';

async function openSelected() {
  seedSelectedWorkspaceForTest({
    vault: VAULT,
    workspaceId: '3ee5b6eb-9f80-4bac-9538-f2a0c5938a62',
    records: [
      {
        id: '4a22406a-07d5-44d8-bc24-b67e61070bea',
        path: PATH,
        body: BODY,
        metadata: {
          kind: 'object',
          value: {
            type: { kind: 'string', value: 'Note' },
            grant: { kind: 'string', value: 'read_only' },
            empty: { kind: 'null' },
          },
        },
      },
    ],
  });
  await act(async () => {
    await useVaultStore.getState().openVault(VAULT);
    useNavStore.setState({ selection: { kind: 'doc', path: PATH } });
    render(<DocPage selection={{ kind: 'doc', path: PATH }} />);
  });
}

describe('mounted selected DocPage authority slice', () => {
  beforeEach(() => {
    resetMockFs();
    resetSelectedWorkspacesForTest();
    useVaultStore.setState({ vaultPath: null, entriesVault: null, entries: [], status: 'idle' });
    useUiStore.setState({ docPanelOpen: false, toasts: [] });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    resetSelectedWorkspacesForTest();
  });

  it('opens through the actual store and renders exact read-only body without a source/editor writer', async () => {
    const source = vi.spyOn(ipc, 'readNoteSource');
    const save = vi.spyOn(ipc, 'saveNoteBody');
    const yamlPatch = vi.spyOn(ipc, 'updateFrontmatter');
    await openSelected();
    expect((await screen.findByTestId('selected-body')).textContent).toBe(BODY);
    expect(screen.getByText('Read only')).toBeTruthy();
    expect(useVaultStore.getState().status).toBe('ready');
    expect(useVaultStore.getState().entries[0].type).toBe('Note');
    expect(useVaultStore.getState().entries[0].properties.grant).toBe('read_only');
    expect(screen.queryByRole('textbox', { name: 'Page source' })).toBeNull();
    expect(screen.queryByTestId('markdown-editor')).toBeNull();
    expect(source).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(yamlPatch).not.toHaveBeenCalled();
  });

  it('uses the real existing Full width action on the mounted page and survives reopen', async () => {
    const yamlPatch = vi.spyOn(ipc, 'updateFrontmatter');
    await openSelected();
    await screen.findByTestId('selected-body');
    fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Full width' }));
    });
    await waitFor(() =>
      expect(useVaultStore.getState().entries[0].properties.full_width).toBe(true),
    );
    expect(useVaultStore.getState().entries[0].authority?.metadataRevision).toBe('2');
    expect(selectedFixtureForTest(VAULT)?.receipts).toEqual([
      {
        actor: 'human:me',
        operation: 'page.full_width',
        recordId: '4a22406a-07d5-44d8-bc24-b67e61070bea',
        revision: '2',
      },
    ]);
    expect(screen.getByTestId('doc-content').classList.contains('cb-document-content-wide')).toBe(
      true,
    );
    expect(screen.getByTestId('selected-body').textContent).toBe(BODY);
    await act(async () => {
      await useVaultStore.getState().openVault(VAULT);
    });
    expect(useVaultStore.getState().entries[0].properties.full_width).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Center content' }));
    });
    await waitFor(() =>
      expect(useVaultStore.getState().entries[0].properties.full_width).toBeUndefined(),
    );
    expect(screen.getByTestId('selected-body').textContent).toBe(BODY);
    expect(useVaultStore.getState().entries[0].authority?.metadataRevision).toBe('3');
    expect(selectedFixtureForTest(VAULT)?.records[0].metadata).toEqual({
      kind: 'object',
      value: {
        type: { kind: 'string', value: 'Note' },
        grant: { kind: 'string', value: 'read_only' },
        empty: { kind: 'null' },
      },
    });
    expect(yamlPatch).not.toHaveBeenCalled();
  });

  it('retains an applied receipt and authoritative revision when the postcommit refresh fails', async () => {
    await openSelected();
    await screen.findByTestId('selected-body');
    vi.spyOn(ipc, 'scanVault').mockRejectedValue(new Error('Refresh unavailable'));
    await act(async () => {
      expect(await useVaultStore.getState().patchFrontmatter(PATH, { full_width: true })).toBe(
        true,
      );
    });
    expect(useVaultStore.getState().entries[0].authority?.metadataRevision).toBe('2');
    expect(useVaultStore.getState().entries[0].properties.full_width).toBe(true);
    expect(selectedFixtureForTest(VAULT)?.receipts).toHaveLength(1);
    expect(selectedFixtureForTest(VAULT)?.records[0].body).toBe(BODY);
  });

  it('renders a failed canonical scan as unavailable instead of a deleted page', async () => {
    vi.spyOn(ipc, 'scanVault').mockRejectedValue({ message: 'Canonical pairing unavailable' });
    await openSelected();
    expect((await screen.findByRole('alert')).textContent).toContain('Workspace unavailable');
    expect(screen.getByRole('alert').textContent).toContain('Canonical pairing unavailable');
    expect(screen.queryByText('This page no longer exists')).toBeNull();
  });
});
