import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetOpenPages, registerSaveParticipant } from '@/editor/openPages';
import { DocumentOwner } from '@/editor/documentOwner';
import {
  requestLeave,
  invalidatePendingLeaves,
  reserveLeaveIntent,
  acceptLeaveIntent,
  hasPendingLeaveIntent,
  finishLeaveIntent,
  saveBeforeAction,
  LEAVE_BLOCKED,
} from './leaveGuard';
import { useUiStore } from '@/stores/uiStore';
const key = { vaultId: '/vault', path: 'a.md', ownerId: 'p1' };
beforeEach(() => {
  __resetOpenPages();
  invalidatePendingLeaves();
  useUiStore.setState({ toasts: [] });
});
afterEach(() => {
  __resetOpenPages();
  invalidatePendingLeaves();
});
function mount(write: ConstructorParameters<typeof DocumentOwner>[2]) {
  const owner = new DocumentOwner(key, 'before', write);
  registerSaveParticipant({
    key,
    prepare: () => undefined,
    snapshot: () => owner.snapshot(),
    flush: () => owner.flush(),
  });
  return owner;
}
describe('dependent action origins', () => {
  it.each([
    { failed: false, current: false, allowed: false, messages: [] },
    { failed: false, current: true, allowed: true, messages: [] },
    { failed: true, current: false, allowed: false, messages: [] },
    { failed: true, current: true, allowed: false, messages: [LEAVE_BLOCKED] },
  ])(
    'checks the origin after flushing (failed=$failed, current=$current)',
    async ({ failed, current, allowed, messages }) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const owner = mount(async () => {
        await gate;
        if (failed) throw new Error('disk refused');
        return { kind: 'file', contentHash: 'confirmed' };
      });
      owner.edit('exact draft');
      let active = true;
      const pending = saveBeforeAction('all', 'block', () => active);
      await vi.waitFor(() => expect(owner.snapshot().inFlightGeneration).toBe(1));
      active = current;
      release();
      expect(await pending).toBe(allowed);
      expect(useUiStore.getState().toasts.map((toast) => toast.message)).toEqual(messages);
      expect(owner.snapshot().latestDraft).toBe('exact draft');
      expect(owner.snapshot().acknowledgedGeneration).toBe(failed ? 0 : 1);
    },
  );
});
describe('dependent leave requests', () => {
  it('reserves intent before asynchronous work and never renews an obsolete request', () => {
    const intent = reserveLeaveIntent('p1');
    const old = vi.fn();
    const newer = vi.fn();
    requestLeave('p1', newer);
    expect(intent.isCurrent()).toBe(false);
    expect(requestLeave(intent, old)).toBe(false);
    expect(old).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledOnce();
  });
  it('preserves only its own current intent across synchronous accepted-switch resets', () => {
    const intent = reserveLeaveIntent('p1');
    const unrelated = reserveLeaveIntent('p2');
    acceptLeaveIntent(intent, () => {
      invalidatePendingLeaves();
      invalidatePendingLeaves();
    });
    expect(intent.isCurrent()).toBe(true);
    expect(unrelated.isCurrent()).toBe(false);
    const destination = vi.fn();
    expect(requestLeave(intent, destination)).toBe(true);
    expect(destination).toHaveBeenCalledOnce();
    invalidatePendingLeaves();
    expect(intent.isCurrent()).toBe(false);
  });
  it('moves an accepted reservation to the reset pane and lets its newer request win', () => {
    const intent = reserveLeaveIntent('old-pane');
    acceptLeaveIntent(intent, () => invalidatePendingLeaves('new-pane'));
    expect(intent.surface).toBe('new-pane');
    expect(hasPendingLeaveIntent('old-pane')).toBe(false);
    expect(hasPendingLeaveIntent('new-pane')).toBe(true);
    requestLeave('new-pane', () => {});
    expect(intent.isCurrent()).toBe(false);
    expect(hasPendingLeaveIntent('new-pane')).toBe(false);
  });
  it('retires completed and canceled reservations without retiring a replacement', () => {
    const canceled = reserveLeaveIntent('p1');
    finishLeaveIntent(canceled);
    expect(hasPendingLeaveIntent('p1')).toBe(false);
    const completed = reserveLeaveIntent('p1');
    requestLeave(completed, () => {});
    expect(hasPendingLeaveIntent('p1')).toBe(false);
    const old = reserveLeaveIntent('p1');
    const next = reserveLeaveIntent('p1');
    finishLeaveIntent(old);
    expect(next.isCurrent()).toBe(true);
    expect(hasPendingLeaveIntent('p1')).toBe(true);
  });
  it('does not resurrect an intent superseded before or during switch acceptance', () => {
    const intent = reserveLeaveIntent('p1');
    const latest = reserveLeaveIntent('p1');
    const canceled = vi.fn();
    expect(acceptLeaveIntent(intent, canceled)).toBeUndefined();
    expect(canceled).not.toHaveBeenCalled();
    expect(latest.isCurrent()).toBe(true);
    acceptLeaveIntent(latest, () => {
      reserveLeaveIntent('p1');
      invalidatePendingLeaves();
    });
    expect(latest.isCurrent()).toBe(false);
  });
  it('keeps clean navigation synchronous', () => {
    mount(async () => ({ kind: 'file', contentHash: 'unused' }));
    const leave = vi.fn();
    expect(requestLeave('p1', leave)).toBe(true);
    expect(leave).toHaveBeenCalledOnce();
  });
  it('never retires a view with a failed latest draft', async () => {
    const owner = mount(async () => {
      throw new Error('full');
    });
    owner.edit('exact draft');
    const leave = vi.fn();
    expect(requestLeave('p1', leave)).toBe(false);
    await vi.waitFor(() => expect(useUiStore.getState().toasts).toHaveLength(1));
    expect(leave).not.toHaveBeenCalled();
    expect(owner.snapshot().latestDraft).toBe('exact draft');
  });
  it('only the latest still-current destination proceeds after acknowledgement', async () => {
    let resolve!: (value: { kind: 'file'; contentHash: string }) => void;
    const owner = mount(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    owner.edit('pending');
    const old = vi.fn();
    const latest = vi.fn();
    requestLeave('p1', old);
    requestLeave('p1', latest);
    resolve({ kind: 'file', contentHash: 'confirmed' });
    await vi.waitFor(() => expect(latest).toHaveBeenCalledOnce());
    expect(old).not.toHaveBeenCalled();
  });
  it('invalidates a pending leave when the vault changes independently', async () => {
    let resolve!: (value: { kind: 'file'; contentHash: string }) => void;
    const owner = mount(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    owner.edit('pending');
    const leave = vi.fn();
    requestLeave('p1', leave);
    invalidatePendingLeaves();
    resolve({ kind: 'file', contentHash: 'confirmed' });
    await owner.flush();
    await new Promise((done) => setTimeout(done, 0));
    expect(leave).not.toHaveBeenCalled();
  });
});
