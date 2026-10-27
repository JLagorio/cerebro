// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, StrictMode, type ComponentProps } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EditorReadyInfo } from './MarkdownEditor';
const last = vi.hoisted(() => ({ info: null as EditorReadyInfo | null, debounceMs: 60_000 }));
vi.mock('@/editor/NoteBodyEditor', async (original) => {
  const mod = await original<typeof import('@/editor/NoteBodyEditor')>();
  return {
    ...mod,
    NoteBodyEditor: (props: ComponentProps<typeof mod.NoteBodyEditor>) =>
      createElement(mod.NoteBodyEditor, {
        ...props,
        debounceMs: last.debounceMs,
        onReady: (info) => {
          last.info = info;
          props.onReady?.(info);
        },
      }),
  };
});
import * as ipc from '@/lib/ipc';
import { DocPage } from '@/pages/DocPage';
import { DetailPanel } from '@/detail/DetailPanel';
import { resetMockFs } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { __resetOpenPages, retainedDocumentOwner, retainDocumentOwner } from './openPages';
import { recoveryDrafts, discardRecovery } from './deletedDraftRecovery';
const path = 'notes/deleted-recovery.md',
  vault = '/demo-vault';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
beforeEach(async () => {
  __resetOpenPages();
  resetMockFs();
  last.info = null;
  last.debounceMs = 60_000;
  useUiStore.setState({ detailPath: null });
  await useVaultStore.getState().openVault(vault);
  fs().set(path, '# Review\n\nInitial body.\n');
  await useVaultStore.getState().rescan();
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  vi.restoreAllMocks();
});
async function open(host: 'page' | 'peek' = 'page', strict = false) {
  if (host === 'peek') useUiStore.setState({ detailPath: path });
  const content = host === 'page' ? <DocPage selection={{ kind: 'doc', path }} /> : <DetailPanel />;
  render(strict ? <StrictMode>{content}</StrictMode> : content);
  await waitFor(() => expect(last.info).not.toBeNull(), { timeout: 20_000 });
  return last.info!;
}
function edit(info: EditorReadyInfo, text: string) {
  act(() =>
    info.editor.insertBlocks(
      [{ type: 'paragraph', content: text }],
      info.editor.document.at(-1)!,
      'after',
    ),
  );
}
it('blocks retirement during actual rich serialization and retains the same original owner', async () => {
  const info = await open();
  edit(info, 'Retired OLD body');
  await waitFor(() =>
    expect(recoveryDrafts({ vaultId: vault, path })[0]?.payload.body?.text).toContain(
      'Retired OLD body',
    ),
  );
  const draft = recoveryDrafts({ vaultId: vault, path })[0],
    original = retainedDocumentOwner(draft.ref.key)!;
  const replacementWrite = vi.fn(async () => ({
    kind: 'file' as const,
    contentHash: 'replacement',
  }));
  let flushing!: Promise<void>, result!: ReturnType<typeof discardRecovery>;
  act(() => {
    flushing = info.flushPendingSave();
    result = discardRecovery(draft.ref);
    if (result.kind === 'discarded')
      retainDocumentOwner(draft.ref.key, 'Replacement body', replacementWrite);
  });
  await act(async () => {
    await flushing;
  });
  expect(result).toEqual({ kind: 'blocked', reason: 'in_flight' });
  expect(retainedDocumentOwner(draft.ref.key)).toBe(original);
  expect(original.snapshot().latestDraft).toContain('Retired OLD body');
  expect(replacementWrite).not.toHaveBeenCalled();
  expect(fs().get(path)).toContain('Retired OLD body'); // the original authorized flush may finish
});
it('old real rich draft/flush callbacks remain inert after quiescent retirement and same-key replacement', async () => {
  const write = vi.spyOn(ipc, 'saveNoteBody');
  const info = await open();
  edit(info, 'Unsaved OLD body');
  info.cancelPendingSave();
  const draft = recoveryDrafts({ vaultId: vault, path })[0];
  act(() => {
    expect(discardRecovery(draft.ref)).toEqual({ kind: 'discarded' });
  });
  const replacementWrite = vi.fn(async () => ({
    kind: 'file' as const,
    contentHash: 'replacement',
  }));
  const replacement = retainDocumentOwner(draft.ref.key, 'Replacement body', replacementWrite);
  edit(info, 'Late OLD callback');
  await act(async () => {
    await info.flushPendingSave();
  });
  expect(replacement.snapshot().latestDraft).toBe('Replacement body');
  expect(replacementWrite).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(fs().get(path)).toBe('# Review\n\nInitial body.\n');
});
it.each(['page', 'peek'] as const)(
  'restored %s keeps exact held recovery reachable until explicit fresh reload',
  async (host) => {
    await open(host);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    const source = await screen.findByRole('textbox', { name: 'Page source' });
    fireEvent.change(source, { target: { value: '# Review\n\nRetained edit.\n' } });
    await act(async () => {
      fs().delete(path);
      await useVaultStore.getState().rescan();
    });
    await screen.findByText(/original file is missing/i);
    const before = recoveryDrafts({ vaultId: vault, path })[0];
    await act(async () => {
      fs().set(path, '# Review\n\nOutside restored body.\n');
      await useVaultStore.getState().rescan();
    });
    expect(screen.getByTestId('deleted-draft-recovery')).toBeTruthy();
    expect(recoveryDrafts({ vaultId: vault, path })[0].ref.instanceId).toBe(before.ref.instanceId);
    expect(recoveryDrafts({ vaultId: vault, path })[0].requiresRecovery).toBe(true);
    const read = vi.spyOn(ipc, 'readNoteSource');
    fireEvent.click(await screen.findByRole('button', { name: 'Reload restored page' }));
    await screen.findByRole('textbox', { name: 'Page source' }, { timeout: 20_000 });
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(screen.queryByTestId('deleted-draft-recovery')).toBeNull();
    expect(fs().get(path)).toBe('# Review\n\nOutside restored body.\n');
  },
);

it('releases the real rich serialization lease after native refusal', async () => {
  vi.spyOn(ipc, 'saveNoteBody').mockRejectedValueOnce(Error('disk full'));
  const info = await open();
  edit(info, 'Keep on failure');
  const draft = recoveryDrafts({ vaultId: vault, path })[0];
  const owner = retainedDocumentOwner(draft.ref.key)!;
  await act(() => info.flushPendingSave());
  expect(owner.recoveryBusy()).toBe(false);
  expect(owner.snapshot().failure).not.toBeNull();
  act(() => {
    expect(discardRecovery(recoveryDrafts({ vaultId: vault, path })[0].ref)).toEqual({
      kind: 'discarded',
    });
  });
});
it('autosave starts its owner lease before serialization/native dispatch and releases it after acknowledgement', async () => {
  last.debounceMs = 10;
  const info = await open();
  const owner = retainedDocumentOwner({ vaultId: vault, path, ownerId: 'p1' })!;
  const phases: { busy: boolean; writing: number | null }[] = [];
  const stop = owner.subscribe(() =>
    phases.push({ busy: owner.recoveryBusy(), writing: owner.snapshot().inFlightGeneration }),
  );
  edit(info, 'Autosave lease');
  await waitFor(() => expect(fs().get(path)).toContain('Autosave lease'));
  await waitFor(() => expect(owner.recoveryBusy()).toBe(false));
  stop();
  expect(phases.some((phase) => phase.busy && phase.writing === null)).toBe(true);
  expect(owner.snapshot().failure).toBeNull();
});

it('StrictMode keeps the actually rendered source presentation bound to its retained owner', async () => {
  await open('page', true);
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  const input = await screen.findByRole('textbox', { name: 'Page source' });
  fireEvent.change(input, { target: { value: '# Review\n\nStrict exact draft.\n' } });
  expect(recoveryDrafts({ vaultId: vault, path })[0]?.payload.body?.text).toContain(
    'Strict exact draft.',
  );
  await act(async () => {
    fs().delete(path);
    await useVaultStore.getState().rescan();
  });
  await screen.findByTestId('deleted-draft-recovery');
  expect(recoveryDrafts({ vaultId: vault, path })[0].payload.body!.text).toContain(
    'Strict exact draft.',
  );
});

it.each(['page', 'peek'] as const)(
  'independent: %s preserves actionable hold when restored source read fails',
  async (host) => {
    await open(host);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    const source = await screen.findByRole('textbox', { name: 'Page source' });
    fireEvent.change(source, {
      target: { value: '# Review\n\nExact retained independent draft.\n' },
    });
    await act(async () => {
      fs().delete(path);
      await useVaultStore.getState().rescan();
    });
    await screen.findByText(/original file is missing/i);
    const before = recoveryDrafts({ vaultId: vault, path })[0];
    await act(async () => {
      fs().set(path, '# Outside\n\nRestored body.\n');
      await useVaultStore.getState().rescan();
    });
    const read = vi
      .spyOn(ipc, 'readNoteSource')
      .mockRejectedValue(Error('independent restored read unavailable'));
    fireEvent.click(await screen.findByRole('button', { name: 'Reload restored page' }));
    await waitFor(() => expect(read).toHaveBeenCalled());
    await screen.findByText(/This page couldn.t be loaded/i);
    const after = recoveryDrafts({ vaultId: vault, path })[0];
    expect(after.ref.instanceId).toBe(before.ref.instanceId);
    expect(after.payload.body?.text).toContain('Exact retained independent draft.');
    expect(after.state.reconcileRequired).toBe(true);
    expect(fs().get(path)).toBe('# Outside\n\nRestored body.\n');
    expect(screen.queryByTestId('deleted-draft-recovery')).not.toBeNull();
    expect(after.requiresRecovery).toBe(true);
  },
);

it.each(['page', 'peek'] as const)(
  '%s restores recovery actions when actual attachment fails after successful admission',
  async (host) => {
    await open(host);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Page source' }), {
      target: { value: '# Review\n\nExact second-read draft.\n' },
    });
    await act(async () => {
      fs().delete(path);
      await useVaultStore.getState().rescan();
    });
    await screen.findByText(/original file is missing/i);
    const before = recoveryDrafts({ vaultId: vault, path })[0];
    await act(async () => {
      fs().set(path, '# Outside\n\nRestored body.\n');
      await useVaultStore.getState().rescan();
    });
    const original = ipc.readNoteSource;
    const read = vi
      .spyOn(ipc, 'readNoteSource')
      .mockImplementationOnce(original)
      .mockRejectedValue(Error('actual attachment unavailable'));
    fireEvent.click(await screen.findByRole('button', { name: 'Reload restored page' }));
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() =>
      expect(recoveryDrafts({ vaultId: vault, path })[0].requiresRecovery).toBe(true),
    );
    expect(screen.getByTestId('deleted-draft-recovery')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy body' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save as…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard this draft' })).toBeTruthy();
    const after = recoveryDrafts({ vaultId: vault, path })[0];
    expect(after.ref.instanceId).toBe(before.ref.instanceId);
    expect(after.payload.body?.text).toContain('Exact second-read draft.');
    expect(fs().get(path)).toBe('# Outside\n\nRestored body.\n');
  },
);
it('a failed old attachment cannot install a ghost hold on a same-key replacement', async () => {
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Page source' }), {
    target: { value: '# Review\n\nOriginal retained.\n' },
  });
  await act(async () => {
    fs().delete(path);
    await useVaultStore.getState().rescan();
  });
  await screen.findByText(/original file is missing/i);
  await act(async () => {
    fs().set(path, '# Outside\n');
    await useVaultStore.getState().rescan();
  });
  let fail!: (reason: Error) => void;
  const original = ipc.readNoteSource;
  const read = vi
    .spyOn(ipc, 'readNoteSource')
    .mockImplementationOnce(original)
    .mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
  fireEvent.click(await screen.findByRole('button', { name: 'Reload restored page' }));
  await waitFor(() => expect(read.mock.calls.length).toBeGreaterThanOrEqual(2));
  const ref = recoveryDrafts({ vaultId: vault, path })[0].ref;
  await waitFor(() => expect(recoveryDrafts({ vaultId: vault, path })[0].busy).toBe(false));
  const old = retainedDocumentOwner(ref.key)!;
  act(() => expect(discardRecovery(ref).kind).toBe('discarded'));
  const write = vi.fn();
  const replacement = retainDocumentOwner(ref.key, 'replacement body', write);
  replacement.edit('replacement exact draft');
  await act(async () => {
    fail(Error('late old failure'));
  });
  expect(old.recoveryRetired()).toBe(true);
  expect(replacement.requiresRecovery()).toBe(false);
  expect(replacement.recoveryResumePending()).toBe(false);
  expect(replacement.snapshot().latestDraft).toBe('replacement exact draft');
  expect(write).not.toHaveBeenCalled();
});
