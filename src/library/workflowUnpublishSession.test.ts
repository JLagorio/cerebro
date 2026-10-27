import { expect, it, vi } from 'vitest';
import { createWorkflowEditorSession, type WorkflowEditorApi } from './workflowEditorSession';
import { retainWorkflowDraft } from './workflowDraftOwner';
import type {
  WorkflowDocument,
  WorkflowDraft,
  WorkflowPublication,
  WorkflowUnpublishAck,
  WorkflowUnpublishRequest,
} from '@/lib/generated/workflows';
const context = { vaultId: 'a'.repeat(32), storeUuid: 'original-unpublish-store' };
const key = 'd'.repeat(32);
const draft = (): WorkflowDraft => ({
  workflowId: 'unpublish',
  entryStepId: 'done',
  inputSchemaJson: '{"type":"object"}',
  triggerJson: '{"kind":"manual"}',
  steps: [
    {
      stepId: 'done',
      label: 'Result',
      operation: {
        kind: 'result',
        outputJson: '{"kind":"literal","value":9007199254740993.0000000000000001}',
      },
    },
  ],
});
const saved = () => ({ draft: draft(), etag: 'b'.repeat(64) });
const publication = (): WorkflowPublication => ({
  version: { workflowId: 'unpublish', definitionHash: 'c'.repeat(64) },
  revision: 1,
});
const document = (
  published: WorkflowPublication | null = null,
  revision = 2,
): WorkflowDocument => ({
  context,
  workflowId: 'unpublish',
  draft: saved(),
  publication: published,
  publicationRevision: revision,
  versions: [publication().version],
  versionsTruncated: false,
  activation: { state: 'unavailable' },
});
const acknowledgement = (request: WorkflowUnpublishRequest): WorkflowUnpublishAck => ({
  context: request.context,
  requestKey: request.requestKey,
  original: request.publication,
  publicationRevision: request.publication.revision + 1,
  replayed: false,
});
function api(): WorkflowEditorApi & {
  unpublish: (request: WorkflowUnpublishRequest) => Promise<WorkflowUnpublishAck>;
} {
  return {
    save: vi.fn(async (request) => ({ draft: request.draft, etag: 'e'.repeat(64) })),
    publish: vi.fn(async () => ({ ...publication(), revision: 3 })),
    unpublish: vi.fn(async (request: WorkflowUnpublishRequest) => acknowledgement(request)),
    document: vi.fn(async () => document()),
    validate: vi.fn(async () => ({ valid: true, diagnostics: [] })),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function session(service = api()) {
  return createWorkflowEditorSession(service, context, draft(), saved(), publication(), {
    publicationRevision: 1,
    newRequestKey: () => key,
  });
}
it('viewing a published editor does not unpublish or mint a request', () => {
  const service = api();
  const held = session(service);
  expect(held.getSnapshot().publication).toEqual(publication());
  expect(held.getSnapshot().unpublishRequest).toBeNull();
  expect(service.unpublish).not.toHaveBeenCalled();
});
it('explicit Unpublish preserves unsaved exact draft text and its saved base without saving first', async () => {
  const service = api();
  const held = session(service);
  const edited = draft();
  edited.steps[0]!.label = 'Still unsaved';
  held.edit(edited);
  await held.unpublish();
  expect(service.unpublish).toHaveBeenCalledExactlyOnceWith({
    context,
    requestKey: key,
    publication: publication(),
  });
  expect(service.save).not.toHaveBeenCalled();
  expect(service.publish).not.toHaveBeenCalled();
  expect(held.getSnapshot()).toMatchObject({
    draft: edited,
    saved: saved(),
    publication: null,
    publicationRevision: 2,
    phase: 'idle',
    dirty: true,
    unpublishRequest: null,
  });
});
it('unknown Unpublish retries only the original key and captured publication', async () => {
  const service = api();
  vi.mocked(service.unpublish).mockRejectedValueOnce(new Error('PRIVATE-TRANSPORT'));
  const mint = vi.fn(() => key);
  const held = createWorkflowEditorSession(service, context, draft(), saved(), publication(), {
    newRequestKey: mint,
  });
  await held.unpublish();
  expect(held.getSnapshot().phase).toBe('unknown');
  const original = { context, requestKey: key, publication: publication() };
  expect(held.getSnapshot().unpublishRequest).toEqual(original);
  await held.unpublish();
  expect(service.unpublish).toHaveBeenNthCalledWith(1, original);
  expect(service.unpublish).toHaveBeenNthCalledWith(2, original);
  expect(mint).toHaveBeenCalledTimes(1);
  expect(held.getSnapshot().publication).toBeNull();
  expect(JSON.stringify(held.getSnapshot())).not.toContain('PRIVATE-TRANSPORT');
});
it('a tombstone read and explicit revision acceptance cannot settle an unknown original request', async () => {
  const service = api();
  vi.mocked(service.unpublish).mockRejectedValueOnce({ code: 'unavailable' });
  const held = session(service);
  await held.unpublish();
  await held.refresh(context);
  held.acceptRemoteRevision();
  expect(held.getSnapshot().publicationRevision).toBe(2);
  expect(held.getSnapshot().publication).toBeNull();
  expect(held.getSnapshot().phase).toBe('unknown');
  expect(held.getSnapshot().unpublishRequest?.requestKey).toBe(key);
  await held.publish();
  await held.save();
  expect(service.publish).not.toHaveBeenCalled();
  expect(service.save).not.toHaveBeenCalled();
});
it('Publish after a known tombstone uses its positive revision instead of never-published null', async () => {
  const service = api();
  const held = createWorkflowEditorSession(service, context, draft(), saved(), null, {
    publicationRevision: 2,
  });
  await held.publish();
  expect(service.publish).toHaveBeenCalledExactlyOnceWith({
    context,
    workflowId: 'unpublish',
    expectedDraftEtag: 'b'.repeat(64),
    expectedPublicationRevision: 2,
  });
  expect(held.getSnapshot().publicationRevision).toBe(3);
});
it('a historical ACK after observing a newer publication settles only the original request', async () => {
  const service = api();
  const response = deferred<WorkflowUnpublishAck>();
  vi.mocked(service.unpublish)
    .mockRejectedValueOnce({ code: 'unavailable' })
    .mockImplementationOnce(() => response.promise);
  const held = session(service);
  await held.unpublish();
  const newer = {
    version: { workflowId: 'unpublish', definitionHash: 'f'.repeat(64) },
    revision: 3,
  };
  vi.mocked(service.document).mockResolvedValueOnce(document(newer, 3));
  await held.refresh(context);
  held.acceptRemoteRevision();
  const retry = held.unpublish();
  response.resolve({
    context,
    requestKey: key,
    original: publication(),
    publicationRevision: 2,
    replayed: true,
  });
  await retry;
  expect(service.unpublish).toHaveBeenNthCalledWith(2, {
    context,
    requestKey: key,
    publication: publication(),
  });
  expect(held.getSnapshot()).toMatchObject({
    publication: newer,
    publicationRevision: 3,
    phase: 'idle',
    unpublishRequest: null,
  });
});
it('foreign or mismatched Unpublish acknowledgement keeps the exact original request unresolved', async () => {
  const service = api();
  vi.mocked(service.unpublish).mockImplementationOnce(async (request) => ({
    ...acknowledgement(request),
    context: { ...context, storeUuid: 'other-store' },
  }));
  const held = session(service);
  await held.unpublish();
  expect(held.getSnapshot()).toMatchObject({
    publication: publication(),
    publicationRevision: 1,
    phase: 'unknown',
    unpublishRequest: { context, requestKey: key, publication: publication() },
  });
});
it('unknown Unpublish survives failed original refresh and owner unmount/remount', async () => {
  const service = api();
  vi.mocked(service.unpublish).mockRejectedValue({ code: 'unavailable' });
  vi.mocked(service.document).mockRejectedValue({ code: 'unavailable' });
  const owner = retainWorkflowDraft(
    '/unpublish-unknown-owner',
    context,
    draft(),
    saved(),
    publication(),
    service,
  )!;
  const unmount = owner.mount();
  await owner.session.unpublish();
  await owner.session.refresh(context);
  unmount();
  await Promise.resolve();
  const restored = retainWorkflowDraft(
    '/unpublish-unknown-owner',
    context,
    draft(),
    saved(),
    publication(),
    service,
  )!;
  expect(restored).toBe(owner);
  expect(restored.session.getSnapshot().phase).toBe('unknown');
  expect(restored.participant.retention?.held()).toBe(true);
});
it('a retired clean original editor cannot dispatch an untracked Unpublish after a successor mounts', async () => {
  const service = api();
  const owner = retainWorkflowDraft(
    '/unpublish-retired-owner',
    context,
    draft(),
    saved(),
    publication(),
    service,
  )!;
  const unmount = owner.mount();
  unmount();
  await Promise.resolve();
  const successor = retainWorkflowDraft(
    '/unpublish-retired-owner',
    context,
    draft(),
    saved(),
    publication(),
    service,
  )!;
  expect(successor).not.toBe(owner);
  const remove = successor.mount();
  await owner.session.unpublish();
  expect(service.unpublish).not.toHaveBeenCalled();
  remove();
  await Promise.resolve();
});
