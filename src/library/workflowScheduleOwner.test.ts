import { expect, it, vi } from 'vitest';
import { retainWorkflowSchedule } from './workflowScheduleOwner';
import type { WorkflowScheduleApi } from './workflowScheduleSession';
import type { WorkflowScheduleAck } from '@/lib/generated/workflows';
import policy from '../../shared/workflows/editor.v1.json';
const context = { vaultId: 'a'.repeat(32), storeUuid: 'original' };
const version = { workflowId: 'schedule', definitionHash: 'b'.repeat(64) };
const digest = 'c'.repeat(64);
function ack(): WorkflowScheduleAck {
  return {
    context,
    workflowId: version.workflowId,
    current: {
      activationId: 'd'.repeat(32),
      version,
      state: 'enabled',
      revision: 1,
      epoch: 'e'.repeat(32),
      configurationDigest: digest,
      inputDigest: digest,
      permissionDigest: digest,
      triggerDigest: digest,
      anchorMs: 1792980000000,
      cursorMs: 1792980000000,
      recoveryHeld: false,
      coverageKnown: false,
      skippedCount: 0,
      coalescedCount: 0,
      observedAtMs: null,
      firstSkippedMs: null,
      lastSkippedMs: null,
      inputJson: '{}',
      permissions: { queryRecords: false, readPrefixes: [], accounts: [] },
    },
    receipt: { operation: 'enable', revision: 1, epoch: 'e'.repeat(32), state: 'enabled', version },
    replayed: true,
    monitoring: null,
  };
}
function api(): WorkflowScheduleApi {
  return {
    read: vi.fn(async (): ReturnType<WorkflowScheduleApi['read']> => ({
      context,
      workflowId: version.workflowId,
      configuration: null,
      readiness: 'unconfigured',
      monitoring: 'stopped',
    })),
    enable: vi.fn(async () => {
      throw new Error('lost');
    }),
    pause: vi.fn(async () => {
      throw new Error('unused');
    }),
    remove: vi.fn(async () => {
      throw new Error('unused');
    }),
    wake: vi.fn(async (): ReturnType<WorkflowScheduleApi['wake']> => ({
      context,
      monitoring: 'queued',
    })),
    preview: vi.fn(async () => {
      throw new Error('unused');
    }),
  };
}
const input = () => ({
  version,
  expectedRevision: 0,
  inputJson: '{}',
  permissions: { queryRecords: false, readPrefixes: [], accounts: [] },
});
const key = () => 'f'.repeat(32);
it('retains unknown configuration request across unmount and failed refresh only for the exact source', async () => {
  const service = api();
  const owner = retainWorkflowSchedule('/vault/unknown', context, version.workflowId, service, key);
  expect(owner).not.toBeNull();
  if (owner === null) return;
  const unmount = owner.mount();
  await owner.session.refresh();
  await owner.session.enable(input());
  vi.mocked(service.read).mockRejectedValueOnce(new Error('failed read'));
  await owner.session.refresh();
  unmount();
  await Promise.resolve();
  expect(retainWorkflowSchedule('/vault/unknown', context, version.workflowId, service, key)).toBe(
    owner,
  );
  expect(
    retainWorkflowSchedule('/vault/unknown', context, version.workflowId, api(), key),
  ).toBeNull();
  const foreign = retainWorkflowSchedule('/vault/other', context, version.workflowId, service, key);
  expect(foreign).not.toBe(owner);
  const foreignUnmount = foreign?.mount();
  foreignUnmount?.();
  vi.mocked(service.enable).mockResolvedValue(ack());
  await owner.session.retry(context);
  await Promise.resolve();
});
it('releases clean unmounted owners with exact-owner microtask cancellation on immediate remount', async () => {
  const service = api();
  const owner = retainWorkflowSchedule('/vault/clean', context, version.workflowId, service, key);
  expect(owner).not.toBeNull();
  if (owner === null) return;
  const first = owner.mount();
  first();
  const remount = owner.mount();
  await Promise.resolve();
  expect(retainWorkflowSchedule('/vault/clean', context, version.workflowId, service, key)).toBe(
    owner,
  );
  remount();
  await Promise.resolve();
  const successor = retainWorkflowSchedule(
    '/vault/clean',
    context,
    version.workflowId,
    service,
    key,
  );
  expect(successor).not.toBe(owner);
  const close = successor?.mount();
  close?.();
  await Promise.resolve();
});
it('refuses capacity without evicting unresolved original requests and releases after their acknowledgement', async () => {
  const service = api();
  const held: NonNullable<ReturnType<typeof retainWorkflowSchedule>>[] = [];
  try {
    for (let i = 0; i < policy.maxRetainedScheduleSessions; i++) {
      const owner = retainWorkflowSchedule(
        '/vault/cap-' + i,
        context,
        version.workflowId,
        service,
        key,
      );
      expect(owner).not.toBeNull();
      if (owner === null) return;
      const unmount = owner.mount();
      await owner.session.refresh();
      await owner.session.enable(input());
      unmount();
      held.push(owner);
    }
    await Promise.resolve();
    expect(
      retainWorkflowSchedule('/vault/overflow', context, version.workflowId, service, key),
    ).toBeNull();
    expect(retainWorkflowSchedule('/vault/cap-0', context, version.workflowId, service, key)).toBe(
      held[0],
    );
  } finally {
    vi.mocked(service.enable).mockResolvedValue(ack());
    for (const owner of held) await owner.session.retry(context);
    await Promise.resolve();
  }
  const fresh = retainWorkflowSchedule(
    '/vault/after-cap',
    context,
    version.workflowId,
    service,
    key,
  );
  expect(fresh).not.toBeNull();
  const close = fresh?.mount();
  close?.();
  await Promise.resolve();
});

it('refuses a new Enable from a clean retired owner while the same key has a new owner', async () => {
  const service = api();
  const old = retainWorkflowSchedule(
    '/vault/retired-enable',
    context,
    version.workflowId,
    service,
    key,
  );
  expect(old).not.toBeNull();
  if (old === null) return;
  const unmount = old.mount();
  await old.session.refresh();
  unmount();
  await Promise.resolve();
  const successor = retainWorkflowSchedule(
    '/vault/retired-enable',
    context,
    version.workflowId,
    service,
    key,
  );
  expect(successor).not.toBeNull();
  expect(successor).not.toBe(old);
  const close = successor?.mount();
  try {
    await old.session.enable(input());
    expect(service.enable).not.toHaveBeenCalled();
    expect(old.session.getSnapshot().uncertain).toBe(false);
    expect(
      retainWorkflowSchedule('/vault/retired-enable', context, version.workflowId, service, key),
    ).toBe(successor);
  } finally {
    vi.mocked(service.enable).mockResolvedValue(ack());
    await old.session.retry(context);
    close?.();
    await Promise.resolve();
  }
});
it('refuses stale-owner monitoring and refresh even if an old view calls mount again', async () => {
  const service = api();
  vi.mocked(service.read).mockResolvedValue({
    context,
    workflowId: version.workflowId,
    configuration: ack().current,
    readiness: 'ready',
    monitoring: 'stopped',
  });
  const old = retainWorkflowSchedule(
    '/vault/retired-wake',
    context,
    version.workflowId,
    service,
    key,
  );
  expect(old).not.toBeNull();
  if (old === null) return;
  const unmount = old.mount();
  await old.session.refresh();
  unmount();
  await Promise.resolve();
  const successor = retainWorkflowSchedule(
    '/vault/retired-wake',
    context,
    version.workflowId,
    service,
    key,
  );
  const close = successor?.mount();
  const staleClose = old.mount();
  try {
    await old.session.wake();
    await old.session.refresh();
    expect(service.wake).not.toHaveBeenCalled();
    expect(service.read).toHaveBeenCalledTimes(1);
    expect(
      retainWorkflowSchedule('/vault/retired-wake', context, version.workflowId, service, key),
    ).toBe(successor);
  } finally {
    staleClose();
    close?.();
    await Promise.resolve();
  }
});
it('releases an abandoned never-mounted selection while an immediate mount cancels speculative cleanup', async () => {
  const service = api();
  const abandoned = retainWorkflowSchedule(
    '/vault/speculative',
    context,
    version.workflowId,
    service,
    key,
  );
  expect(abandoned).not.toBeNull();
  await Promise.resolve();
  const next = retainWorkflowSchedule(
    '/vault/speculative',
    context,
    version.workflowId,
    service,
    key,
  );
  expect(next).not.toBeNull();
  expect(next).not.toBe(abandoned);
  const close = next?.mount();
  await Promise.resolve();
  expect(
    retainWorkflowSchedule('/vault/speculative', context, version.workflowId, service, key),
  ).toBe(next);
  close?.();
  await Promise.resolve();
});
