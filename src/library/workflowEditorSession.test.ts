import { describe, expect, it, vi } from 'vitest';
import { createWorkflowEditorSession, type WorkflowEditorApi } from './workflowEditorSession';
import type {
  WorkflowDraft,
  WorkflowDocument,
  WorkflowDraftSnapshot,
  WorkflowPublication,
} from '@/lib/generated/workflows';
const context = { vaultId: 'a'.repeat(32), storeUuid: 'original-store' };
const draft = (): WorkflowDraft => ({
  workflowId: 'example',
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
const saved = (value = draft(), etag = 'b'.repeat(64)): WorkflowDraftSnapshot => ({
  draft: value,
  etag,
});
const publication = (): WorkflowPublication => ({
  version: { workflowId: 'example', definitionHash: 'c'.repeat(64) },
  revision: 1,
});
const document = (value = saved()): WorkflowDocument => ({
  context,
  workflowId: 'example',
  publicationRevision: 0,
  draft: value,
  publication: null,
  versions: [],
  versionsTruncated: false,
  activation: { state: 'unavailable' },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function api(): WorkflowEditorApi {
  return {
    save: vi.fn(async (request) => saved(request.draft)),
    publish: vi.fn(async () => publication()),
    document: vi.fn(async () => document()),
    validate: vi.fn(async () => ({ valid: true, diagnostics: [] })),
  };
}
describe('workflow editor original draft ownership', () => {
  it('saves incomplete native-validatable JSON text without rounding or treating validation as a save gate', async () => {
    const service = api();
    const incomplete = draft();
    incomplete.inputSchemaJson = '{"$ref":"https://example.invalid/incomplete"}';
    incomplete.entryStepId = 'missing';
    incomplete.steps[0]!.label = 'Unfinished';
    const session = createWorkflowEditorSession(service, context, incomplete);
    await session.save();
    expect(service.save).toHaveBeenCalledExactlyOnceWith({
      context,
      draft: incomplete,
      expectedEtag: null,
    });
    expect(service.validate).not.toHaveBeenCalled();
    expect(session.getSnapshot().saved?.draft).toEqual(incomplete);
    expect(session.getSnapshot().dirty).toBe(false);
  });
  it('keeps newer local edits while an earlier save acknowledgement updates only its saved base', async () => {
    const service = api();
    const pending = deferred<WorkflowDraftSnapshot>();
    service.save = vi.fn(() => pending.promise);
    const session = createWorkflowEditorSession(service, context, draft());
    const work = session.save();
    const changed = draft();
    changed.steps[0]!.label = 'Edited while saving';
    session.edit(changed);
    pending.resolve(saved());
    await work;
    expect(session.getSnapshot().draft).toEqual(changed);
    expect(session.getSnapshot().saved).toEqual(saved());
    expect(session.getSnapshot().dirty).toBe(true);
  });
  it('does not overwrite on conflict and requires explicit adoption of the refreshed revision before another save', async () => {
    const service = api();
    service.save = vi.fn(async () => {
      throw { code: 'conflict', diagnostics: [] };
    });
    const session = createWorkflowEditorSession(service, context, draft());
    await session.save();
    expect(session.getSnapshot().phase).toBe('conflict');
    await session.save();
    expect(service.save).toHaveBeenCalledTimes(1);
    const remote = draft();
    remote.steps[0]!.label = 'Remote edit';
    service.document = vi.fn(async () => document(saved(remote, 'd'.repeat(64))));
    await session.refresh(context);
    expect(session.getSnapshot().draft).toEqual(draft());
    expect(session.getSnapshot().phase).toBe('conflict');
    session.acceptRemoteRevision();
    expect(session.getSnapshot().phase).toBe('idle');
    expect(session.getSnapshot().saved?.etag).toBe('d'.repeat(64));
    expect(session.getSnapshot().draft).toEqual(draft());
    expect(service.save).toHaveBeenCalledTimes(1);
  });
  it('retains ambiguous mutation state across remount and refuses recovery against another original store', async () => {
    const service = api();
    service.save = vi.fn(async () => {
      throw new Error('SECRET-ERROR');
    });
    const session = createWorkflowEditorSession(service, context, draft());
    const remove = session.subscribe(vi.fn());
    await session.save();
    remove();
    const state = session.getSnapshot();
    expect(state.phase).toBe('unknown');
    expect(state.draft).toEqual(draft());
    expect(JSON.stringify(state)).not.toContain('SECRET-ERROR');
    await session.save();
    await session.publish();
    await session.refresh({ ...context, storeUuid: 'replacement' });
    expect(service.save).toHaveBeenCalledTimes(1);
    expect(service.publish).not.toHaveBeenCalled();
    expect(service.document).not.toHaveBeenCalled();
    expect(session.getSnapshot().phase).toBe('unknown');
  });
  it('publishes only a known saved draft with the exact prior publication revision', async () => {
    const service = api();
    const session = createWorkflowEditorSession(service, context, draft());
    await session.publish();
    expect(service.publish).not.toHaveBeenCalled();
    await session.save();
    await session.publish();
    expect(service.publish).toHaveBeenCalledExactlyOnceWith({
      context,
      workflowId: 'example',
      expectedDraftEtag: 'b'.repeat(64),
      expectedPublicationRevision: null,
    });
    expect(session.getSnapshot().publication).toEqual(publication());
    const edited = draft();
    edited.steps[0]!.label = 'Changed';
    session.edit(edited);
    await session.publish();
    expect(service.publish).toHaveBeenCalledTimes(1);
  });
  it('does not attach stale validation to a newer local edit', async () => {
    const service = api();
    const pending = deferred<{ valid: boolean; diagnostics: [] }>();
    service.validate = vi.fn(() => pending.promise);
    const session = createWorkflowEditorSession(service, context, draft());
    const work = session.validate();
    expect(service.validate).toHaveBeenCalledExactlyOnceWith(context, draft());
    const changed = draft();
    changed.steps[0]!.label = 'Newer';
    session.edit(changed);
    pending.resolve({ valid: true, diagnostics: [] });
    await work;
    expect(session.getSnapshot().validation).toBeNull();
    expect(session.getSnapshot().draft).toEqual(changed);
  });
  it('copies finite draft and acknowledgement keys instead of retaining foreign payload fields', async () => {
    const service = api();
    const incoming = Object.assign(draft(), { hiddenPayload: 'CANARY-INPUT' });
    const original = draft();
    service.save = vi.fn(async () => Object.assign(saved(), { hiddenPayload: 'CANARY-ACK' }));
    const session = createWorkflowEditorSession(service, context, incoming);
    incoming.steps[0]!.label = 'mutated outside';
    await session.save();
    expect(service.save).toHaveBeenCalledExactlyOnceWith({
      context,
      draft: original,
      expectedEtag: null,
    });
    expect(JSON.stringify(session.getSnapshot())).not.toContain('CANARY');
  });
});

it('accepts only outer JSON whitespace normalization while retaining local text and exact numeric lexemes', async () => {
  const service = api();
  const original = draft();
  original.inputSchemaJson = ' \n{"type":"object"} \t';
  original.triggerJson = '\r {"kind":"manual"} \n';
  const exact = '{ "kind": "literal", "value": 9007199254740993.0000000000000001 }';
  original.steps[0]!.operation = { kind: 'result', outputJson: ' \n' + exact + '\t ' };
  const acknowledged = draft();
  acknowledged.steps[0]!.operation = { kind: 'result', outputJson: exact };
  service.save = vi.fn(async () => saved(acknowledged));
  const session = createWorkflowEditorSession(service, context, original);
  await session.save();
  expect(session.getSnapshot().phase).toBe('idle');
  expect(session.getSnapshot().draft).toEqual(original);
  expect(session.getSnapshot().saved?.draft).toEqual(acknowledged);
  expect(session.getSnapshot().dirty).toBe(false);
  const changed = draft();
  changed.steps[0]!.operation = {
    kind: 'result',
    outputJson: exact.replace('0000000000000001', '0000000000000002'),
  };
  session.edit(changed);
  expect(session.getSnapshot().dirty).toBe(true);
});
