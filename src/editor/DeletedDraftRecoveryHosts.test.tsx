// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ComponentProps } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EditorReadyInfo } from './MarkdownEditor';
const last = vi.hoisted(() => ({ info: null as EditorReadyInfo | null }));
vi.mock('@/editor/NoteBodyEditor', async (original) => {
  const mod = await original<typeof import('@/editor/NoteBodyEditor')>();
  return {
    ...mod,
    NoteBodyEditor: (props: ComponentProps<typeof mod.NoteBodyEditor>) =>
      createElement(mod.NoteBodyEditor, {
        ...props,
        debounceMs: 60_000,
        onReady: (info) => {
          last.info = info;
          props.onReady?.(info);
        },
      }),
  };
});
vi.mock('@/lib/ipc', async (original) => ({
  ...(await original<typeof import('@/lib/ipc')>()),
  probeDraftTarget: vi.fn(async () => ({ kind: 'missing' })),
  writeClipboard: vi.fn(async () => undefined),
  chooseDraftExport: vi.fn(),
  commitDraftExport: vi.fn(),
  cancelDraftExport: vi.fn(),
  createRecoveredPage: vi.fn(),
}));
import * as ipc from '@/lib/ipc';
import { DocPage } from '@/pages/DocPage';
import { DetailPanel } from '@/detail/DetailPanel';
import { resetMockFs } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { __resetOpenPages, flushOpenPages, retainDocumentOwner } from './openPages';
const path = 'notes/deleted-recovery.md';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
beforeEach(async () => {
  __resetOpenPages();
  resetMockFs();
  last.info = null;
  useUiStore.setState({ detailPath: null });
  await useVaultStore.getState().openVault('/demo-vault');
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  vi.clearAllMocks();
});
it('a real source editor survives outside deletion through the missing full-page host', async () => {
  const raw = '\ufeff# Recovery\r\n\r\n<div>exact source</div>\r\n';
  fs().set(path, raw);
  await useVaultStore.getState().rescan();
  render(<DocPage selection={{ kind: 'doc', path }} />);
  await waitFor(() => expect(last.info).not.toBeNull(), { timeout: 20_000 });
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  const source = await screen.findByRole('textbox', { name: 'Page source' });
  fireEvent.change(source, { target: { value: '# Recovery\n\n<div>latest source</div>\n' } });
  await act(async () => {
    fs().delete(path);
    await useVaultStore.getState().rescan();
  });
  await screen.findByText(/original file is missing/i);
  fireEvent.click(screen.getByRole('button', { name: 'Copy body' }));
  await screen.findByText(/Copied. Your original draft is still kept/);
  expect(ipc.writeClipboard).toHaveBeenCalledWith('# Recovery\r\n\r\n<div>latest source</div>\r\n');
  expect(fs().has(path)).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Discard this draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard permanently' }));
  const report = await act(() => flushOpenPages());
  expect(report.unresolvedOwnerIds).toEqual([]);
  expect(fs().has(path)).toBe(false);
});
it('a missing record peek keeps its exact retained owner and accessible close chrome', async () => {
  const owner = retainDocumentOwner(
    { vaultId: '/demo-vault', path, ownerId: 'peek' },
    'before',
    vi.fn(),
  );
  owner.edit('exact preview draft');
  useUiStore.setState({ detailPath: path });
  render(<DetailPanel />);
  expect(await screen.findByTestId('deleted-draft-recovery')).toBeTruthy();
  expect(screen.getByTestId('detail-panel')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  expect(
    (screen.getByRole('textbox', { name: 'Preview draft retained text' }) as HTMLTextAreaElement)
      .value,
  ).toBe('exact preview draft');
});
it('captures exact title composition before deletion without depending on child cleanup ordering', async () => {
  fs().set(path, 'Body without a heading.\n');
  await useVaultStore.getState().rescan();
  render(<DocPage selection={{ kind: 'doc', path }} />);
  const title = await screen.findByRole('textbox', { name: 'Document title' }, { timeout: 20_000 });
  fireEvent.compositionStart(title);
  fireEvent.change(title, { target: { value: '  	  ' } });
  const { recoveryDrafts } = await import('./deletedDraftRecovery');
  expect(recoveryDrafts({ vaultId: '/demo-vault', path })[0].payload.children['page-title']).toBe(
    '  	  ',
  );
  await act(async () => {
    fs().delete(path);
    await useVaultStore.getState().rescan();
  });
  await screen.findByTestId('deleted-draft-recovery');
  expect(recoveryDrafts({ vaultId: '/demo-vault', path })[0].payload.children['page-title']).toBe(
    '  	  ',
  );
  expect(fs().has(path)).toBe(false);
});
