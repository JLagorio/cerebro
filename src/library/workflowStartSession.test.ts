import { describe, expect, it, vi } from 'vitest';
import { createWorkflowStartSession, type WorkflowStartInput } from './workflowStartSession';
import type { WorkflowStartAck, WorkflowStartRequest } from '@/lib/generated/workflows';
const original = { vaultId: 'a'.repeat(32), storeUuid: 'original-store' };
const version = { workflowId: 'example', definitionHash: 'b'.repeat(64) };
const input = (): WorkflowStartInput => ({ context: { ...original }, version: { ...version }, inputJson: '{"n":9007199254740993.0000000000000001}', permissions: { readPrefixes: ['Notes'], queryRecords: true, accounts: [{ connection: 'github', account: 'selected', action: 'github.issue.create', definition: 'c'.repeat(64), capabilities: ['issues:write'], inputScope: 'all_valid_inputs', inputDigest: null }] } });
const ack = (extra: Partial<WorkflowStartAck> = {}): WorkflowStartAck => ({ context: { ...original }, version: { ...version }, runId: 'd'.repeat(32), revision: 1, admissionEpoch: 1, created: true, admission: 'ready', ...extra });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
describe('workflow Start original request ownership', () => {
  it('copies only finite original selectors and exact JSON before an asynchronous start', async () => {
    const pending = deferred<WorkflowStartAck>(); const start = vi.fn(() => pending.promise); const key = vi.fn(() => '1'.repeat(32)); const session = createWorkflowStartSession({ start }, key);
    const selected = Object.assign(input(), { extraPayload: 'DO-NOT-KEEP' }); const expected = input(); const work = session.begin(selected);
    selected.context.storeUuid = 'different-store'; selected.version.definitionHash = 'f'.repeat(64); selected.permissions.accounts[0]!.capabilities.push('unrequested'); selected.inputJson = 'changed';
    expect(start).toHaveBeenCalledExactlyOnceWith({ ...expected, startKey: '1'.repeat(32) }); expect(session.getSnapshot().phase).toBe('starting'); await session.begin(input()); expect(start).toHaveBeenCalledTimes(1);
    pending.resolve(ack()); await work; expect(session.getSnapshot().phase).toBe('known'); expect(JSON.stringify(session.getSnapshot())).not.toContain('DO-NOT-KEEP'); expect(JSON.stringify(session.getSnapshot())).not.toContain('9007199254740993');
  });
  it('retries an unknown acknowledgement with the exact same original payload and one key', async () => {
    const requests: WorkflowStartRequest[] = []; const start = vi.fn(async (request: WorkflowStartRequest) => { requests.push(structuredClone(request)); if (requests.length === 1) throw new Error('ack lost'); return ack({ created: false, admission: 'busy' }); }); const key = vi.fn(() => '2'.repeat(32)); const session = createWorkflowStartSession({ start }, key);
    await session.begin(input()); expect(session.getSnapshot().phase).toBe('unknown'); await session.begin({ ...input(), inputJson: 'other' }); expect(start).toHaveBeenCalledTimes(1);
    await session.retry(original); expect(requests[1]).toEqual(requests[0]); expect(key).toHaveBeenCalledTimes(1); expect(session.getSnapshot().ack?.created).toBe(false); expect(session.getSnapshot().phase).toBe('known');
  });
  it('refuses unknown retry after vault/store replacement and retains the recoverable original request', async () => {
    const start = vi.fn(async () => { throw new Error('lost'); }); const session = createWorkflowStartSession({ start }, () => '3'.repeat(32)); await session.begin(input());
    await session.retry({ ...original, storeUuid: 'replacement' }); expect(start).toHaveBeenCalledTimes(1); expect(session.getSnapshot().phase).toBe('unknown'); expect(session.getSnapshot().original).toEqual({ context: original, version });
    await session.retry(original); expect(start).toHaveBeenCalledTimes(2);
  });
  it('treats a mismatched native acknowledgement as unknown and never adopts another run scope', async () => {
    const start = vi.fn(async () => ack({ context: { ...original, vaultId: 'f'.repeat(32) } })); const session = createWorkflowStartSession({ start }, () => '4'.repeat(32)); await session.begin(input());
    expect(session.getSnapshot().phase).toBe('unknown'); expect(session.getSnapshot().ack).toBeNull(); expect(session.getSnapshot().original?.context).toEqual(original);
  });
  it('keeps known-created Busy acknowledgement without retrying Start or inventing fresh admission', async () => {
    const start = vi.fn(async () => ack({ admission: 'busy' })); const key = vi.fn(() => '5'.repeat(32)); const session = createWorkflowStartSession({ start }, key); await session.begin(input());
    expect(session.getSnapshot().ack).toEqual(ack({ admission: 'busy' })); await session.retry(original); await session.begin(input()); expect(start).toHaveBeenCalledTimes(1);
    session.clearKnown(); expect(session.getSnapshot().phase).toBe('idle'); await session.begin(input()); expect(key).toHaveBeenCalledTimes(2);
  });
  it('survives view subscription remount without dropping ambiguous work or retaining arbitrary errors', async () => {
    const start = vi.fn(async () => { throw new Error('SECRET-PAYLOAD'); }); const session = createWorkflowStartSession({ start }, () => '6'.repeat(32)); const first = vi.fn(); const remove = session.subscribe(first); await session.begin(input()); remove(); const snapshot = session.getSnapshot(); const second = vi.fn(); const removeSecond = session.subscribe(second);
    expect(first).toHaveBeenCalled(); expect(snapshot.phase).toBe('unknown'); expect(JSON.stringify(snapshot)).not.toContain('SECRET-PAYLOAD'); session.clearKnown(); expect(session.getSnapshot().phase).toBe('unknown'); await session.retry(original); expect(second).toHaveBeenCalled(); removeSecond();
  });
  it('copies only the finite acknowledged fields and drops pending input after known creation', async () => {
    const response = Object.assign(ack(), { secret: 'CANARY-EXTRA', inputJson: 'CANARY-INPUT' }); const session = createWorkflowStartSession({ start: async () => response }, () => '7'.repeat(32)); await session.begin(input());
    expect(session.getSnapshot().ack).toEqual(ack()); expect(JSON.stringify(session.getSnapshot())).not.toContain('CANARY'); response.context.storeUuid = 'mutated-later'; expect(session.getSnapshot().ack?.context).toEqual(original);
  });
});

it('allows corrected Start input only after a definite native invalid_input refusal', async () => {
 const start = vi.fn(async (_request: WorkflowStartRequest) => ack()); start.mockRejectedValueOnce({ code: 'invalid_input', diagnostics: [], privatePayload: 'CANARY' }); const key = vi.fn().mockReturnValueOnce('8'.repeat(32)).mockReturnValueOnce('9'.repeat(32)); const session = createWorkflowStartSession({ start }, key);
 await session.begin({ ...input(), inputJson: '{invalid' }); expect(session.getSnapshot().phase).toBe('idle'); expect(session.getSnapshot().ack).toBeNull(); expect(session.getSnapshot().failure).toContain('input'); expect(JSON.stringify(session.getSnapshot())).not.toContain('CANARY'); await session.begin(input()); expect(start).toHaveBeenCalledTimes(2); expect(vi.mocked(start).mock.calls[0]).not.toEqual(vi.mocked(start).mock.calls[1]); expect(session.getSnapshot().phase).toBe('known');
});
