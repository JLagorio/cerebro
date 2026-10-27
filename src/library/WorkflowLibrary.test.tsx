import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkflowLibrary, type WorkflowLibraryService } from './WorkflowLibrary';
import * as ipc from '@/lib/ipc';
import type { WorkflowDraft, WorkflowDocument } from '@/lib/generated/workflows';
vi.mock('@/lib/ipc', () => ({ workflowContext: vi.fn(), workflowCatalog: vi.fn(), workflowDocument: vi.fn(), workflowVersion: vi.fn(), workflowSave: vi.fn(), workflowPublish: vi.fn(), workflowUnpublish: vi.fn(), workflowValidate: vi.fn(), workflowActions: vi.fn(), managedConnections: vi.fn(), managedConnectionStatus: vi.fn(), workflowStart: vi.fn(), workflowContinue: vi.fn(), workflowReauthorize: vi.fn(), workflowCancel: vi.fn(), workflowRuns: vi.fn(), workflowRun: vi.fn(), workflowValue: vi.fn(), workflowActionDetails: vi.fn(), workflowAnswerAction: vi.fn(), workflowAnswerWait: vi.fn(), workflowSchedule: vi.fn(), workflowScheduleEnable: vi.fn(), workflowSchedulePause: vi.fn(), workflowScheduleRemove: vi.fn(), workflowSchedulePreview: vi.fn(), workflowScheduleWake: vi.fn() }));
let serial = 0;
const context = () => ({ vaultId: serial.toString(16).padStart(32, '0'), storeUuid: 'original-store' });
const draft = (): WorkflowDraft => ({ workflowId: 'example', entryStepId: 'done', inputSchemaJson: '{"type":"object"}', triggerJson: '{"kind":"manual"}', steps: [{ stepId: 'done', label: 'Result', operation: { kind: 'result', outputJson: '{"kind":"literal","value":9007199254740993.0000000000000001}' } }] });
const version = { workflowId: 'example', definitionHash: 'c'.repeat(64) };
const document = (): WorkflowDocument => ({ context: context(), workflowId: 'example', publicationRevision: 1, draft: { etag: 'b'.repeat(64), draft: draft() }, publication: { version, revision: 1 }, versions: [version], versionsTruncated: false, activation: { state: 'unavailable' } });
beforeEach(() => {
 serial++; vi.clearAllMocks(); vi.mocked(ipc.managedConnections).mockRejectedValue({ code: 'unavailable' }); vi.mocked(ipc.managedConnectionStatus).mockRejectedValue({ code: 'unavailable' }); vi.mocked(ipc.workflowContext).mockResolvedValue(context()); vi.mocked(ipc.workflowCatalog).mockResolvedValue({ context: context(), items: [{ workflowId: 'example', readable: true, publication: { version, revision: 1 } }], nextCursor: null, truncated: false }); vi.mocked(ipc.workflowDocument).mockResolvedValue(document()); vi.mocked(ipc.workflowActions).mockResolvedValue([]); vi.mocked(ipc.workflowVersion).mockResolvedValue(draft()); vi.mocked(ipc.workflowValidate).mockResolvedValue({ valid: true, diagnostics: [] }); vi.mocked(ipc.workflowSave).mockImplementation(async (request) => ({ etag: 'd'.repeat(64), draft: request.draft })); vi.mocked(ipc.workflowPublish).mockResolvedValue({ version, revision: 2 });
});
describe('workflow Library file surface', () => {
 it('opens an actual document and keeps exact mapping text editable until explicit Save', async () => {
  render(<WorkflowLibrary vaultKey="one" onTab={vi.fn()} />); fireEvent.click(await screen.findByRole('button', { name: 'Open workflow example' })); const mapping = await screen.findByLabelText('Step 1 output mapping JSON'); expect((mapping as HTMLTextAreaElement).value).toBe('{"kind":"literal","value":9007199254740993.0000000000000001}'); fireEvent.change(screen.getByLabelText('Step 1 label'), { target: { value: 'Renamed result' } }); expect(ipc.workflowSave).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Save draft' })); await waitFor(() => expect(ipc.workflowSave).toHaveBeenCalledTimes(1)); expect(vi.mocked(ipc.workflowSave).mock.calls[0]![0]).toMatchObject({ context: context(), expectedEtag: 'b'.repeat(64), draft: { steps: [{ label: 'Renamed result', operation: { outputJson: '{"kind":"literal","value":9007199254740993.0000000000000001}' } }] } }); expect(ipc.workflowActions).toHaveBeenCalledWith(context());
 });
 it('shows a failed catalog as unavailable and preserves a visible retry instead of an empty shelf', async () => {
  vi.mocked(ipc.workflowCatalog).mockRejectedValue({ code: 'unavailable', diagnostics: [] }); render(<WorkflowLibrary vaultKey="two" onTab={vi.fn()} />); expect(await screen.findByText('Workflows could not be read.')).not.toBeNull(); expect(screen.queryByText('No workflows yet')).toBeNull(); expect(screen.getByRole('button', { name: 'Retry workflows' }).hasAttribute('disabled')).toBe(false);
 });
 it('validates and inspects pinned versions separately from explicit publication', async () => {
  render(<WorkflowLibrary vaultKey="three" onTab={vi.fn()} />); fireEvent.click(await screen.findByRole('button', { name: 'Open workflow example' })); await screen.findByLabelText('Step 1 label'); fireEvent.click(screen.getByRole('button', { name: 'Validate draft' })); await waitFor(() => expect(ipc.workflowValidate).toHaveBeenCalledWith(context(), draft())); expect(ipc.workflowPublish).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'View published version' })); await waitFor(() => expect(ipc.workflowVersion).toHaveBeenCalledWith(context(), version)); fireEvent.click(screen.getByRole('button', { name: 'Publish saved draft' })); await waitFor(() => expect(ipc.workflowPublish).toHaveBeenCalledExactlyOnceWith({ context: context(), workflowId: 'example', expectedDraftEtag: 'b'.repeat(64), expectedPublicationRevision: 1 }));
 });
});

function deferredDocument() { let resolve!: (value: WorkflowDocument) => void; const promise = new Promise<WorkflowDocument>((yes) => { resolve = yes; }); return { promise, resolve }; }
function namedDocument(id: string): WorkflowDocument { const value = document(); value.workflowId = id; value.draft!.draft.workflowId = id; value.publication = null; value.publicationRevision = 0; value.versions = []; return value; }
it('keeps the newer workflow visit when an earlier document read resolves last', async () => {
 const first = deferredDocument(); const second = deferredDocument(); vi.mocked(ipc.workflowDocument).mockImplementation((_context, id) => id === 'alpha' ? first.promise : second.promise); const select = vi.fn(); const view = render(<WorkflowLibrary vaultKey="visit-race" workflowId="alpha" onSelect={select} onTab={vi.fn()} />); await waitFor(() => expect(ipc.workflowDocument).toHaveBeenCalledWith(context(), 'alpha')); view.rerender(<WorkflowLibrary vaultKey="visit-race" workflowId="beta" onSelect={select} onTab={vi.fn()} />); await waitFor(() => expect(ipc.workflowDocument).toHaveBeenCalledWith(context(), 'beta')); second.resolve(namedDocument('beta')); await screen.findByRole('heading', { name: 'beta' }); first.resolve(namedDocument('alpha')); await waitFor(() => expect(select).toHaveBeenCalledWith('beta')); await Promise.resolve(); expect(screen.queryByRole('heading', { name: 'alpha' })).toBeNull(); expect(screen.queryByRole('heading', { name: 'beta' })).not.toBeNull(); expect(select.mock.calls.some(([id]) => id === 'alpha')).toBe(false);
});
it('creating a new draft invalidates an earlier pending document read', async () => {
 const pending = deferredDocument(); vi.mocked(ipc.workflowDocument).mockReturnValue(pending.promise); const select = vi.fn(); render(<WorkflowLibrary vaultKey="create-race" onSelect={select} onTab={vi.fn()} />); fireEvent.click(await screen.findByRole('button', { name: 'Open workflow example' })); await waitFor(() => expect(ipc.workflowDocument).toHaveBeenCalledTimes(1)); fireEvent.click(screen.getByRole('button', { name: 'New workflow' })); await screen.findByLabelText('New workflow ID'); pending.resolve(document()); await Promise.resolve(); await Promise.resolve(); expect(screen.queryByLabelText('New workflow ID')).not.toBeNull(); expect(screen.queryByLabelText('Step 1 label')).toBeNull(); expect(select.mock.calls.some(([id]) => id === 'example')).toBe(false);
});

it('uses an explicit display service without calling native workflow IPC', async () => {
 const display: WorkflowLibraryService = { context: vi.fn(async () => context()), catalog: vi.fn(async () => ({ context: context(), items: [{ workflowId: 'example', readable: true, publication: null }], nextCursor: null, truncated: false })), document: vi.fn(async () => document()), version: vi.fn(async () => draft()), save: vi.fn(async () => document().draft!), publish: vi.fn(async () => document().publication!), validate: vi.fn(async () => ({ valid: true, diagnostics: [] })), actions: vi.fn(async () => []), accounts: vi.fn(async () => ({ items: [], nextCursor: null })), account: vi.fn(async () => { throw new Error('display-only'); }) };
 render(<WorkflowLibrary vaultKey="display-only" service={display} onTab={vi.fn()} />); expect(await screen.findByText('Display preview. No native workflow is running.')).not.toBeNull(); fireEvent.click(await screen.findByRole('button', { name: 'Open workflow example' })); await screen.findByLabelText('Step 1 label'); fireEvent.click(screen.getByRole('button', { name: 'Validate draft' })); await waitFor(() => expect(display.validate).toHaveBeenCalledWith(context(), draft())); expect(ipc.workflowContext).not.toHaveBeenCalled(); expect(ipc.workflowCatalog).not.toHaveBeenCalled(); expect(ipc.workflowDocument).not.toHaveBeenCalled(); expect(ipc.workflowActions).not.toHaveBeenCalled(); expect(ipc.workflowValidate).not.toHaveBeenCalled();
});

it('resumes a newly created unsaved local draft after remount without requiring a native file', async () => {
 vi.mocked(ipc.workflowCatalog).mockResolvedValue({ context: context(), items: [], nextCursor: null, truncated: false }); vi.mocked(ipc.workflowDocument).mockRejectedValue({ code: 'unavailable', diagnostics: [] }); const first = render(<WorkflowLibrary vaultKey="unsaved-remount" onTab={vi.fn()} />); await screen.findByText('No workflows yet'); fireEvent.click(screen.getByRole('button', { name: 'New workflow' })); fireEvent.change(screen.getByLabelText('New workflow ID'), { target: { value: 'local-only' } }); fireEvent.click(screen.getByRole('button', { name: 'Create draft' })); fireEvent.change(await screen.findByLabelText('Step 1 label'), { target: { value: 'Retained local title' } }); first.unmount(); render(<WorkflowLibrary vaultKey="unsaved-remount" onTab={vi.fn()} />); fireEvent.click(await screen.findByRole('button', { name: 'Resume draft local-only' })); expect((await screen.findByLabelText('Step 1 label') as HTMLInputElement).value).toBe('Retained local title'); expect(ipc.workflowDocument).not.toHaveBeenCalled(); expect(ipc.workflowSave).not.toHaveBeenCalled();
});

it('opens the production native run panel without starting anything until explicit Run', async () => {
 const runId = '8'.repeat(32); const current = context(); vi.mocked(ipc.workflowRuns).mockResolvedValue({ context: current, items: [], nextCursor: null, truncated: false }); vi.mocked(ipc.workflowStart).mockResolvedValue({ context: current, version, runId, created: true, admission: 'busy', revision: 1, admissionEpoch: 1 }); vi.mocked(ipc.workflowRun).mockResolvedValue({ context: current, version, runId, nativeRunId: '9'.repeat(32), state: 'queued', revision: 1, admissionEpoch: 1, configurationDigest: 'a'.repeat(64), inputDigest: 'b'.repeat(64), cancelRequested: false, reason: null, steps: [] });
 render(<WorkflowLibrary vaultKey="native-runtime" onTab={vi.fn()} />); fireEvent.click(await screen.findByRole('button', { name: 'Open workflow example' })); fireEvent.click(await screen.findByRole('button', { name: 'Run and inspect' })); const input = await screen.findByLabelText('Run input JSON'); expect(ipc.workflowStart).not.toHaveBeenCalled(); const exact = '{"n":9007199254740993.0000000000000001}'; fireEvent.change(input, { target: { value: exact } }); fireEvent.click(screen.getByRole('button', { name: 'Start run' })); await waitFor(() => expect(ipc.workflowStart).toHaveBeenCalledTimes(1)); expect(vi.mocked(ipc.workflowStart).mock.calls[0]![0]).toMatchObject({ context: current, version, inputJson: exact, permissions: { queryRecords: false, readPrefixes: [], accounts: [] } }); expect(ipc.workflowRuns).toHaveBeenCalledWith(current, null);
});
it('never adds native execution controls to an injected display-only Library service', async () => {
 const preview: WorkflowLibraryService = { context: async () => context(), catalog: async () => ({ context: context(), items: [{ workflowId: 'example', readable: true, publication: { version, revision: 1 } }], nextCursor: null, truncated: false }), document: async () => document(), version: async () => draft(), save: async (request) => ({ draft: request.draft, etag: 'd'.repeat(64) }), publish: async () => ({ version, revision: 1 }), validate: async () => ({ valid: true, diagnostics: [] }), actions: async () => [], accounts: async () => ({ items: [], nextCursor: null }), account: async () => { throw new Error('unavailable'); } };
 render(<WorkflowLibrary service={preview} vaultKey="display-no-runtime" onTab={vi.fn()} />); fireEvent.click(await screen.findByRole('button', { name: 'Open workflow example' })); await screen.findByLabelText('Step 1 label'); expect(screen.queryByRole('button', { name: 'Run and inspect' })).toBeNull(); expect(ipc.workflowStart).not.toHaveBeenCalled(); expect(ipc.workflowRuns).not.toHaveBeenCalled();
});

it('opens actual automatic configuration controls through the native Library without enabling on view', async () => {
 vi.mocked(ipc.workflowSchedule).mockResolvedValue({ context: context(), workflowId: 'example', configuration: null, readiness: 'unconfigured', monitoring: 'stopped' });
 vi.mocked(ipc.workflowVersion).mockResolvedValue({ ...draft(), triggerJson: '{"kind":"schedule","intervalSeconds":60,"catchUp":"skip_missed"}' });
 render(<WorkflowLibrary vaultKey="native-schedule" onTab={vi.fn()} />); fireEvent.click(await screen.findByRole('button', { name: 'Open workflow example' })); fireEvent.click(await screen.findByRole('button', { name: 'Automatic runs' })); await screen.findByLabelText('Automatic run input JSON'); expect(ipc.workflowSchedule).toHaveBeenCalledWith(context(), 'example'); expect(ipc.workflowScheduleEnable).not.toHaveBeenCalled(); expect(ipc.workflowScheduleWake).not.toHaveBeenCalled();
});
it('does not expose native automatic controls through display-only Library injection', async () => {
 const preview: WorkflowLibraryService = { context: async () => context(), catalog: async () => ({ context: context(), items: [{ workflowId: 'example', readable: true, publication: { version, revision: 1 } }], nextCursor: null, truncated: false }), document: async () => document(), version: async () => draft(), save: async (request) => ({ draft: request.draft, etag: 'd'.repeat(64) }), publish: async () => ({ version, revision: 1 }), validate: async () => ({ valid: true, diagnostics: [] }), actions: async () => [], accounts: async () => ({ items: [], nextCursor: null }), account: async () => { throw new Error('unavailable'); } };
 render(<WorkflowLibrary service={preview} vaultKey="display-no-schedule" onTab={vi.fn()} />); fireEvent.click(await screen.findByRole('button', { name: 'Open workflow example' })); await screen.findByLabelText('Step 1 label'); expect(screen.queryByRole('button', { name: 'Automatic runs' })).toBeNull(); expect(ipc.workflowSchedule).not.toHaveBeenCalled(); expect(ipc.workflowScheduleEnable).not.toHaveBeenCalled();
});


it('explicit native Unpublish keeps the edited draft and refreshes the actual automatic configuration', async () => {
 vi.mocked(ipc.workflowSchedule).mockResolvedValue({ context: context(), workflowId: 'example', configuration: null, readiness: 'unconfigured', monitoring: 'stopped' });
 vi.mocked(ipc.workflowUnpublish).mockImplementation(async (request) => ({ context: request.context, requestKey: request.requestKey, original: request.publication, publicationRevision: 2, replayed: false }));
 render(<WorkflowLibrary vaultKey="unpublish-native" onTab={vi.fn()} />);
 fireEvent.click(await screen.findByRole('button', { name: 'Open workflow example' }));
 await screen.findByLabelText('Step 1 label'); expect(ipc.workflowUnpublish).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText('Step 1 label'), { target: { value: 'Still unsaved' } });
 fireEvent.click(screen.getByRole('button', { name: 'Automatic runs' }));
 await waitFor(() => expect(ipc.workflowSchedule).toHaveBeenCalledTimes(1));
 fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }));
 await waitFor(() => expect(ipc.workflowUnpublish).toHaveBeenCalledTimes(1));
 const request = vi.mocked(ipc.workflowUnpublish).mock.calls[0]![0];
 expect(request).toEqual({ context: context(), requestKey: expect.stringMatching(/^[0-9a-f]{32}$/), publication: { version, revision: 1 } });
 await screen.findByText('Unpublished'); expect((screen.getByLabelText('Step 1 label') as HTMLInputElement).value).toBe('Still unsaved');
 expect((screen.getByLabelText('Step 1 output mapping JSON') as HTMLTextAreaElement).value).toContain('9007199254740993.0000000000000001');
 expect(ipc.workflowSave).not.toHaveBeenCalled(); expect(ipc.workflowCancel).not.toHaveBeenCalled();
 await waitFor(() => expect(ipc.workflowSchedule).toHaveBeenCalledTimes(2));
});
it('uncertain Unpublish remount offers only the original request retry and preserves newer draft text', async () => {
 vi.mocked(ipc.workflowUnpublish).mockRejectedValueOnce({ code: 'unavailable' }).mockImplementationOnce(async (request) => ({ context: request.context, requestKey: request.requestKey, original: request.publication, publicationRevision: 2, replayed: true }));
 const view = render(<WorkflowLibrary vaultKey="unpublish-remount" workflowId="example" onTab={vi.fn()} />);
 await screen.findByLabelText('Step 1 label'); fireEvent.change(screen.getByLabelText('Step 1 label'), { target: { value: 'My kept draft' } });
 fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }));
 await screen.findByRole('button', { name: 'Check original Unpublish request' });
 const original = vi.mocked(ipc.workflowUnpublish).mock.calls[0]![0]; view.unmount();
 render(<WorkflowLibrary vaultKey="unpublish-remount" workflowId="example" onTab={vi.fn()} />);
 fireEvent.click(await screen.findByRole('button', { name: 'Check original Unpublish request' }));
 await waitFor(() => expect(ipc.workflowUnpublish).toHaveBeenNthCalledWith(2, original));
 await screen.findByText('Unpublished'); expect((screen.getByLabelText('Step 1 label') as HTMLInputElement).value).toBe('My kept draft');
 expect(ipc.workflowSave).not.toHaveBeenCalled(); expect(ipc.workflowPublish).not.toHaveBeenCalled();
});

describe('stable workflow authoring and explicit historical manual selection', () => {
 it('reorders stable step identities without rewriting graph references or writing before Save', async () => {
  const original = draft();
  original.entryStepId = 'first';
  original.steps.unshift({ stepId: 'first', label: 'Exact transform', operation: {
   kind: 'transform', mappingJson: '{"kind":"literal","value":9007199254740993.0000000000000001}',
   outputSchemaJson: '{"type":"number"}', nextStepId: 'done',
  } });
  vi.mocked(ipc.workflowDocument).mockResolvedValue({ ...document(), draft: { etag: 'b'.repeat(64), draft: original } });
  render(<WorkflowLibrary vaultKey="reorder-original" onTab={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open workflow example' }));
  await screen.findByLabelText('Step 1 ID');
  expect(screen.getByRole('button', { name: 'Move step 1 up' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Move step 2 down' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Move step 1 down' }));
  expect((screen.getByLabelText('Step 1 ID') as HTMLInputElement).value).toBe('done');
  expect((screen.getByLabelText('Step 2 ID') as HTMLInputElement).value).toBe('first');
  expect((screen.getByLabelText('Entry step ID') as HTMLInputElement).value).toBe('first');
  expect((screen.getByLabelText('Step 2 next step ID') as HTMLInputElement).value).toBe('done');
  expect((screen.getByLabelText('Step 2 mapping JSON') as HTMLTextAreaElement).value).toBe('{"kind":"literal","value":9007199254740993.0000000000000001}');
  expect(ipc.workflowSave).not.toHaveBeenCalled(); expect(ipc.workflowPublish).not.toHaveBeenCalled();
  expect(ipc.workflowStart).not.toHaveBeenCalled(); expect(ipc.workflowScheduleEnable).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(ipc.workflowSave).toHaveBeenCalledTimes(1));
  expect(vi.mocked(ipc.workflowSave).mock.calls[0]![0]).toMatchObject({ context: context(), expectedEtag: 'b'.repeat(64), draft: { ...original, steps: [original.steps[1], original.steps[0]] } });
  await screen.findByText('Draft saved.');
  fireEvent.click(screen.getByRole('button', { name: 'Move step 2 up' }));
  expect((screen.getByLabelText('Step 1 ID') as HTMLInputElement).value).toBe('first');
  expect((screen.getByLabelText('Step 2 ID') as HTMLInputElement).value).toBe('done');
  expect(ipc.workflowSave).toHaveBeenCalledTimes(1);
 });
 it('starts only the explicitly inspected historical version and retains it through unknown retry after another selection', async () => {
  const historical = { workflowId: 'example', definitionHash: '7'.repeat(64) };
  vi.mocked(ipc.workflowRuns).mockResolvedValue({ context: context(), items: [], nextCursor: null, truncated: false });
  vi.mocked(ipc.workflowStart).mockRejectedValue({ code: 'unavailable', diagnostics: [] });
  render(<WorkflowLibrary vaultKey="historical-manual-original" onTab={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open workflow example' }));
  fireEvent.change(await screen.findByLabelText('Version hash'), { target: { value: historical.definitionHash } });
  fireEvent.click(screen.getByRole('button', { name: 'Open exact version' }));
  await waitFor(() => expect(ipc.workflowVersion).toHaveBeenCalledWith(context(), historical));
  fireEvent.click(await screen.findByRole('button', { name: 'Use viewed version for manual run' }));
  const start = await screen.findByRole('button', { name: 'Start run' });
  expect(ipc.workflowStart).not.toHaveBeenCalled(); expect(ipc.workflowScheduleEnable).not.toHaveBeenCalled();
  expect(ipc.workflowPublish).not.toHaveBeenCalled(); expect(ipc.workflowSave).not.toHaveBeenCalled();
  expect(screen.getByText('Published version 1')).not.toBeNull();
  fireEvent.click(start);
  await screen.findByRole('button', { name: 'Check original start' });
  expect(vi.mocked(ipc.workflowStart).mock.calls[0]![0]).toMatchObject({ context: context(), version: historical });
  fireEvent.click(screen.getByRole('button', { name: 'Use current publication for manual run' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check original start' }));
  await waitFor(() => expect(ipc.workflowStart).toHaveBeenCalledTimes(2));
  expect(vi.mocked(ipc.workflowStart).mock.calls[1]![0]).toEqual(vi.mocked(ipc.workflowStart).mock.calls[0]![0]);
  expect(ipc.workflowCancel).not.toHaveBeenCalled(); expect(ipc.workflowScheduleEnable).not.toHaveBeenCalled();
 });
});
