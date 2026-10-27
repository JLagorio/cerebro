import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { retainWorkflowRun } from './workflowRunOwner';
import { WorkflowRunPanel, type WorkflowRuntimeService } from './WorkflowRunPanel';
import type {
  WorkflowDraft,
  WorkflowRunView,
  WorkflowStartAck,
  WorkflowAccessView,
} from '@/lib/generated/workflows';
import type { ActionEffectDetails, ActionDefinition } from '@/lib/generated/actions';
afterEach(cleanup);
const context = { vaultId: 'a'.repeat(32), storeUuid: 'original' };
const version = { workflowId: 'example', definitionHash: 'b'.repeat(64) };
const id = 'c'.repeat(32);
const invocation = 'd'.repeat(32);
const digest = 'e'.repeat(64);
const definition = (): WorkflowDraft => ({
  workflowId: 'example',
  entryStepId: 'done',
  inputSchemaJson: '{"type":"object"}',
  triggerJson: '{"kind":"manual"}',
  steps: [
    {
      stepId: 'done',
      label: 'Return result',
      operation: { kind: 'result', outputJson: '{"kind":"literal","value":null}' },
    },
  ],
});
const run = (): WorkflowRunView => ({
  context,
  version,
  runId: id,
  nativeRunId: 'f'.repeat(32),
  admissionEpoch: 3,
  revision: 7,
  state: 'queued',
  cancelRequested: false,
  configurationDigest: digest,
  inputDigest: digest,
  reason: null,
  steps: [
    {
      stepId: 'done',
      label: 'Return result',
      kind: 'result',
      state: 'pending',
      ordinal: 0,
      invocationId: null,
      reason: null,
      wait: null,
      input: { state: 'not_recorded' },
      output: { state: 'not_recorded' },
    },
  ],
});
const ack = (): WorkflowStartAck => ({
  context,
  version,
  runId: id,
  admissionEpoch: 3,
  revision: 7,
  created: true,
  admission: 'busy',
});
function service(): WorkflowRuntimeService {
  return {
    start: vi.fn(async () => ack()),
    run: vi.fn(async () => run()),
    continue: vi.fn(async () => ({ ...ack(), created: false })),
    cancel: vi.fn(async (): Promise<WorkflowRunView> => ({ ...run(), state: 'cancelled' })),
    reauthorize: vi.fn(async () => ({ ...ack(), created: false })),
    action: vi.fn(async () => {
      throw new Error('no action');
    }),
    answerAction: vi.fn(async () => run()),
    answerWait: vi.fn(async () => run()),
    value: vi.fn(async () => ({ digest, json: 'null' })),
    access: vi.fn(async () => ({
      context,
      runId: id,
      admissionEpoch: 3,
      original: { queryRecords: false, readPrefixes: [], accounts: [] },
      current: { queryRecords: false, readPrefixes: [], accounts: [] },
    })),
    runs: vi.fn(async () => ({ context, items: [], nextCursor: null, truncated: false })),
    definition: vi.fn(async () => definition()),
    actions: vi.fn(async () => []),
  };
}
function catalog(api: WorkflowRuntimeService) {
  vi.mocked(api.runs).mockResolvedValue({
    context,
    items: [
      {
        version,
        runId: id,
        revision: 7,
        admissionEpoch: 3,
        state: 'queued',
        reason: null,
        startedAt: '2026-10-26T00:00:00Z',
        updatedAt: '2026-10-26T00:00:00Z',
      },
    ],
    nextCursor: null,
    truncated: false,
  });
}
const props = (api: WorkflowRuntimeService, test: string) => ({
  vaultKey: '/vault/' + test,
  context,
  workflowId: 'example',
  version,
  service: api,
});
it('starts only by explicit click with the published version, exact JSON and permissions off', async () => {
  const api = service();
  render(<WorkflowRunPanel {...props(api, 'start')} />);
  const input = await screen.findByLabelText('Run input JSON');
  const exact = '{"n":9007199254740993.0000000000000001}';
  fireEvent.change(input, { target: { value: exact } });
  expect(api.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
  await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
  const request = vi.mocked(api.start).mock.calls[0]![0];
  expect(request.context).toEqual(context);
  expect(request.version).toEqual(version);
  expect(request.inputJson).toBe(exact);
  expect(request.startKey).toMatch(/^[a-f0-9]{32}$/);
  expect(request.permissions).toEqual({ queryRecords: false, readPrefixes: [], accounts: [] });
});
it('keeps a known-created Busy run and offers explicit Continue without another Start', async () => {
  const api = service();
  render(<WorkflowRunPanel {...props(api, 'busy')} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Start run' }));
  await screen.findByText('Run created. Execution is busy; continue this same run when ready.');
  fireEvent.click(await screen.findByRole('button', { name: 'Continue run' }));
  await waitFor(() =>
    expect(api.continue).toHaveBeenCalledExactlyOnceWith({
      context,
      runId: id,
      expectedEpoch: 3,
      expectedRevision: 7,
    }),
  );
  expect(api.start).toHaveBeenCalledTimes(1);
});
it('recovers the same unknown Start after remount without replacing its request', async () => {
  const api = service();
  vi.mocked(api.start).mockRejectedValueOnce(new Error('lost'));
  const originalProps = props(api, 'unknown');
  const first = render(<WorkflowRunPanel {...originalProps} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Start run' }));
  await screen.findByRole('button', { name: 'Check original start' });
  first.unmount();
  render(<WorkflowRunPanel {...originalProps} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Check original start' }));
  await waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.start).mock.calls[1]![0]).toEqual(vi.mocked(api.start).mock.calls[0]![0]);
});
it('shows native person approval separately and answers only its exact observed revisions', async () => {
  const api = service();
  catalog(api);
  const current = run();
  current.state = 'waiting';
  current.steps[0] = {
    ...current.steps[0]!,
    stepId: 'action',
    label: 'Create issue',
    kind: 'action',
    state: 'waiting',
    invocationId: invocation,
    ordinal: 1,
  };
  vi.mocked(api.run).mockResolvedValue(current);
  const detail: ActionEffectDetails = {
    revision: 9,
    definitionDigest: digest,
    inputDigest: digest,
    effect: {
      invocationId: invocation,
      approvalId: 'approval',
      state: 'awaiting_approval',
      canRetry: false,
      canReconcile: false,
      accountLabel: 'Account',
    },
    preview: { summary: 'Create issue', fields: [], redactedFields: [] },
    account: null,
    target: null,
    attempts: [],
    approval: {
      approvalId: 'approval',
      revision: 4,
      expiresAt: '2026-10-27T00:00:00Z',
      askedInputDigest: digest,
      approvedInputDigest: null,
      approvedPreview: null,
    },
  };
  vi.mocked(api.action).mockResolvedValue(detail);
  render(<WorkflowRunPanel {...props(api, 'approval')} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open run ' + id }));
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect action Create issue' }));
  expect(api.answerAction).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole('button', { name: 'Allow this action' }));
  await waitFor(() =>
    expect(api.answerAction).toHaveBeenCalledExactlyOnceWith({
      context,
      runId: id,
      invocationId: invocation,
      approvalId: 'approval',
      expectedInvocationRevision: 9,
      expectedApprovalRevision: 4,
      allow: true,
      editedInputJson: null,
    }),
  );
});
it('retains an unknown external input across remount and retries the same original signal', async () => {
  const api = service();
  catalog(api);
  const current = run();
  current.state = 'waiting';
  current.steps[0] = {
    ...current.steps[0]!,
    stepId: 'ask',
    label: 'Question',
    kind: 'external_input',
    state: 'waiting',
    ordinal: 1,
    wait: {
      continuationId: '1'.repeat(32),
      revision: 2,
      state: 'pending',
      kind: 'external_input',
      schemaJson: '{}',
      dueAt: null,
      expiresAt: null,
    },
  };
  vi.mocked(api.run).mockResolvedValue(current);
  vi.mocked(api.answerWait).mockRejectedValueOnce(new Error('lost'));
  const originalProps = props(api, 'signal');
  const first = render(<WorkflowRunPanel {...originalProps} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open run ' + id }));
  fireEvent.change(await screen.findByLabelText('Input for Question'), {
    target: { value: '9007199254740993.0000000000000001' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Submit input for Question' }));
  await screen.findByRole('button', { name: 'Check original input' });
  first.unmount();
  render(<WorkflowRunPanel {...originalProps} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Check original input' }));
  await waitFor(() => expect(api.answerWait).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.answerWait).mock.calls[1]![0]).toEqual(
    vi.mocked(api.answerWait).mock.calls[0]![0],
  );
});
it('shows failed native run reads as unavailable without claiming an empty run list', async () => {
  const api = service();
  vi.mocked(api.runs).mockRejectedValue(new Error('unavailable'));
  render(<WorkflowRunPanel {...props(api, 'read-failure')} />);
  await screen.findByText('Workflow runs could not be read.');
  expect(screen.queryByText('No runs recorded for this workflow.')).toBeNull();
  expect(api.start).not.toHaveBeenCalled();
});

function accessFixture(): WorkflowAccessView {
  const account = {
    connection: 'github',
    account: 'selected',
    action: 'github.issue.create',
    definition: digest,
    capabilities: ['issues:write'],
    inputScope: 'exact_canonical_input' as const,
    inputDigest: '7'.repeat(64),
  };
  return {
    context,
    runId: id,
    admissionEpoch: 3,
    original: { queryRecords: true, readPrefixes: ['Notes'], accounts: [account] },
    current: {
      queryRecords: true,
      readPrefixes: ['Notes/Research'],
      accounts: [{ ...account, capabilities: [...account.capabilities] }],
    },
  };
}
function actionDefinitionFixture(): ActionDefinition {
  return {
    actionId: 'github.issue.create',
    definitionDigest: digest,
    adapterRevision: '1',
    inputSchema: '{}',
    inputSchemaDigest: digest,
    outputSchema: '{}',
    outputSchemaDigest: digest,
    requiredCapabilities: ['issues:write'],
    effectClass: 'external_mutation',
    retry: 'never',
    cancel: false,
    reconcile: false,
  };
}
function declaredAction(api: WorkflowRuntimeService) {
  const draft = definition();
  draft.entryStepId = 'action';
  draft.steps.unshift({
    stepId: 'action',
    label: 'Send issue',
    operation: {
      kind: 'action',
      actionId: 'github.issue.create',
      definitionDigest: digest,
      connectionId: 'github',
      accountId: 'selected',
      inputJson: '{"kind":"input","path":[]}',
      nextStepId: 'done',
    },
  });
  vi.mocked(api.definition).mockResolvedValue(draft);
  vi.mocked(api.actions).mockResolvedValue([actionDefinitionFixture()]);
}
async function openAccess() {
  fireEvent.click(await screen.findByRole('button', { name: 'Open run ' + id }));
  fireEvent.click(await screen.findByRole('button', { name: 'Review access' }));
  return (await screen.findByText('Review access for this original run')).closest('section')!;
}
it('reads the actual original ceiling and does not offer an ungranted declared account', async () => {
  const empty = { queryRecords: false, readPrefixes: [], accounts: [] };
  const api = Object.assign(service(), {
    access: vi.fn(async (): Promise<WorkflowAccessView> => ({
      context,
      runId: id,
      admissionEpoch: 3,
      original: empty,
      current: empty,
    })),
  });
  catalog(api);
  declaredAction(api);
  render(<WorkflowRunPanel {...props(api, 'empty-ceiling')} />);
  const region = await openAccess();
  await waitFor(() => expect(api.access).toHaveBeenCalledExactlyOnceWith(context, id));
  await within(region).findByText('No account actions were originally permitted.');
  expect(within(region).queryByText(/Allow Send issue/)).toBeNull();
});
it('preserves current exact-input and narrowed read permissions when applying reviewed access', async () => {
  const native = accessFixture();
  const api = Object.assign(service(), { access: vi.fn(async () => native) });
  catalog(api);
  declaredAction(api);
  render(<WorkflowRunPanel {...props(api, 'exact-ceiling')} />);
  const region = await openAccess();
  const apply = await within(region).findByRole('button', {
    name: 'Apply reviewed access and continue',
  });
  await waitFor(() => expect(apply.hasAttribute('disabled')).toBe(false));
  fireEvent.click(apply);
  await waitFor(() =>
    expect(api.reauthorize).toHaveBeenCalledExactlyOnceWith({
      context,
      runId: id,
      expectedEpoch: 3,
      permissions: native.current,
    }),
  );
  expect(vi.mocked(api.reauthorize).mock.calls[0]![0].permissions.accounts[0]!.inputScope).toBe(
    'exact_canonical_input',
  );
});
it('refuses a foreign access-view response instead of enabling guessed reauthorization', async () => {
  const native = accessFixture();
  const api = Object.assign(service(), {
    access: vi.fn(async () => ({ ...native, context: { ...context, storeUuid: 'foreign' } })),
  });
  catalog(api);
  declaredAction(api);
  render(<WorkflowRunPanel {...props(api, 'foreign-ceiling')} />);
  const region = await openAccess();
  await within(region).findByText('Original access could not be read.');
  expect(
    within(region)
      .getByRole('button', { name: 'Apply reviewed access and continue' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(api.reauthorize).not.toHaveBeenCalled();
});

it('preserves the native explicit whole-vault prefix instead of treating it as an empty selection', async () => {
  const native = accessFixture();
  native.original.readPrefixes = [''];
  native.current.readPrefixes = [''];
  const api = Object.assign(service(), { access: vi.fn(async () => native) });
  catalog(api);
  declaredAction(api);
  render(<WorkflowRunPanel {...props(api, 'whole-vault-ceiling')} />);
  const region = await openAccess();
  const apply = await within(region).findByRole('button', {
    name: 'Apply reviewed access and continue',
  });
  await waitFor(() => expect(apply.hasAttribute('disabled')).toBe(false));
  fireEvent.click(apply);
  await waitFor(() =>
    expect(api.reauthorize).toHaveBeenCalledExactlyOnceWith({
      context,
      runId: id,
      expectedEpoch: 3,
      permissions: native.current,
    }),
  );
  expect(vi.mocked(api.reauthorize).mock.calls[0]![0].permissions.readPrefixes).toEqual(['']);
});

it('refuses a reviewed access click when the original session advances before React redraws', async () => {
  const native = accessFixture();
  const api = service();
  catalog(api);
  vi.mocked(api.access).mockResolvedValue(native);
  const originalProps = props(api, 'access-epoch-race');
  render(<WorkflowRunPanel {...originalProps} />);
  const region = await openAccess();
  const apply = within(region).getByRole('button', { name: 'Apply reviewed access and continue' });
  await waitFor(() => expect(apply.hasAttribute('disabled')).toBe(false));
  const owner = retainWorkflowRun(originalProps.vaultKey, context, 'example', api, () =>
    '2'.repeat(32),
  );
  expect(owner).not.toBeNull();
  vi.mocked(api.run).mockResolvedValue({ ...run(), admissionEpoch: 4, revision: 8 });
  // The actual controller read publishes epoch4 synchronously to its store.
  // React's async act batch has not committed those props to the epoch3 review.
  await act(async () => {
    await owner!.run.refresh();
    expect(owner!.run.getSnapshot().run?.admissionEpoch).toBe(4);
    expect(apply.isConnected).toBe(true);
    fireEvent.click(apply);
  });
  expect(api.reauthorize).not.toHaveBeenCalled();
});

it('does not offer a removed original account as current reauthorization access', async () => {
  const native = accessFixture();
  native.current.accounts = [];
  const api = service();
  catalog(api);
  vi.mocked(api.access).mockResolvedValue(native);
  render(<WorkflowRunPanel {...props(api, 'removed-account')} />);
  const region = await openAccess();
  await waitFor(() =>
    expect(
      within(region)
        .getByRole('button', { name: 'Apply reviewed access and continue' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(within(region).queryByRole('checkbox', { name: /Keep github.issue.create/ })).toBeNull();
  expect(api.reauthorize).not.toHaveBeenCalled();
});
it('does not offer the whole-vault permission removed by current native narrowing', async () => {
  const native = accessFixture();
  native.original.readPrefixes = [''];
  const api = service();
  catalog(api);
  vi.mocked(api.access).mockResolvedValue(native);
  render(<WorkflowRunPanel {...props(api, 'removed-whole-vault')} />);
  const region = await openAccess();
  await waitFor(() =>
    expect(
      within(region)
        .getByRole('button', { name: 'Apply reviewed access and continue' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(
    within(region).queryByRole('checkbox', {
      name: 'Keep the original whole-vault read selection',
    }),
  ).toBeNull();
  expect(
    (
      within(region).getByLabelText(
        'Requested readable prefixes, one per line',
      ) as HTMLTextAreaElement
    ).value,
  ).toBe('Notes/Research');
});
it('does not offer record-query permission that the current native ceiling removed', async () => {
  const native = accessFixture();
  native.current.queryRecords = false;
  native.current.readPrefixes = [];
  const api = service();
  catalog(api);
  vi.mocked(api.access).mockResolvedValue(native);
  render(<WorkflowRunPanel {...props(api, 'removed-record-query')} />);
  const region = await openAccess();
  await waitFor(() =>
    expect(
      within(region)
        .getByRole('button', { name: 'Apply reviewed access and continue' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(
    within(region).queryByRole('checkbox', { name: 'Keep record queries permitted' }),
  ).toBeNull();
  expect(
    within(region)
      .getByLabelText('Requested readable prefixes, one per line')
      .hasAttribute('disabled'),
  ).toBe(true);
});
