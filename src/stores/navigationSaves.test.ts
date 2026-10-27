import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetOpenPages, registerSaveParticipant } from '@/editor/openPages';
import { DocumentOwner } from '@/editor/documentOwner';
import { useNavStore } from './navStore';
import { useUiStore } from './uiStore';
import { useVaultStore } from './vaultStore';
import { invalidatePendingLeaves } from '@/app/leaveGuard';

beforeEach(() => {
  __resetOpenPages();
  invalidatePendingLeaves();
  useNavStore.getState().reset();
  useUiStore.setState({ toasts: [], detailPath: null });
  useVaultStore.setState({ vaultPath: '/save-test', entriesVault: '/save-test' });
  useNavStore.getState().navigate({ kind: 'doc', path: 'a.md' });
});
afterEach(() => {
  __resetOpenPages();
  invalidatePendingLeaves();
});
function failedOwner() {
  const key = { vaultId: '/save-test', path: 'a.md', ownerId: useNavStore.getState().active };
  const owner = new DocumentOwner(key, 'saved', async () => {
    throw new Error('full');
  });
  owner.edit('retained exact');
  registerSaveParticipant({
    key,
    prepare: () => undefined,
    snapshot: () => owner.snapshot(),
    flush: () => owner.flush(),
  });
  return owner;
}

describe('navigation checks mounted saves', () => {
  it('opens beside the originally requested pane when focus changes during its save', async () => {
    const first = useNavStore.getState().active;
    useNavStore.getState().setPaneCapacity(4);
    useNavStore.getState().openPane({ kind: 'doc', path: 'second.md' });
    const second = useNavStore.getState().active;
    useNavStore.getState().focusPane(first);
    let resolve!: (ack: { kind: 'file'; contentHash: string }) => void;
    const owner = new DocumentOwner(
      { vaultId: '/save-test', path: 'a.md', ownerId: first },
      'saved',
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    owner.edit('pending');
    registerSaveParticipant({
      key: owner.key,
      prepare: () => undefined,
      snapshot: () => owner.snapshot(),
      flush: () => owner.flush(),
    });
    useNavStore.getState().openPane({ kind: 'doc', path: 'new.md' });
    useNavStore.getState().focusPane(second);
    resolve({ kind: 'file', contentHash: 'accepted' });
    await vi.waitFor(() => expect(useNavStore.getState().paneIds).toHaveLength(3));
    const state = useNavStore.getState();
    expect(state.paneIds).toEqual([first, state.active, second]);
    expect(state.selection).toEqual({ kind: 'doc', path: 'new.md' });
  });
  it('keeps failed editor mounted when navigating to another page', async () => {
    failedOwner();
    useNavStore.getState().navigate({ kind: 'doc', path: 'b.md' });
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'a.md' });
    await vi.waitFor(() => expect(useUiStore.getState().toasts.length).toBeGreaterThan(0));
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'a.md' });
  });
  it('keeps failed text through Back, pane close and peek close', async () => {
    useNavStore.getState().setPaneCapacity(2);
    useNavStore.getState().openPane({ kind: 'doc', path: 'b.md' });
    const active = useNavStore.getState().active;
    useUiStore.getState().openDetail('c.md', active);
    failedOwner();
    useNavStore.getState().back();
    useNavStore.getState().closePane();
    useUiStore.getState().closeDetail();
    expect(useNavStore.getState().paneIds).toContain(active);
    expect(useUiStore.getState().detailPath).toBe('c.md');
    await vi.waitFor(() => expect(useUiStore.getState().toasts.length).toBeGreaterThan(0));
    expect(useNavStore.getState().paneIds).toContain(active);
    expect(useUiStore.getState().detailPath).toBe('c.md');
  });
  it('does not switch vault or discard old entries after a failed save', async () => {
    const owner = failedOwner();
    await useVaultStore.getState().openVault('/another-vault');
    expect(useVaultStore.getState().vaultPath).toBe('/save-test');
    expect(useVaultStore.getState().entriesVault).toBe('/save-test');
    expect(owner.snapshot().latestDraft).toBe('retained exact');
  });
});
