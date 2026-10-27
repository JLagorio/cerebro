import type {
  GrantInputSelection,
  GrantInputView,
  RunActionAccessView,
  SetRunActionAccess,
  SetRunActionAccessResult,
} from '@/lib/generated/actions';

export interface RunActionAccessApi {
  read: (run: number) => Promise<RunActionAccessView>;
  set: (run: number, request: SetRunActionAccess) => Promise<SetRunActionAccessResult>;
}
export type AccessSelection = SetRunActionAccess['selections'][number];
export interface RunActionAccessState {
  retired: boolean;
  phase: 'idle' | 'loading' | 'ready' | 'saving' | 'saved' | 'unknown' | 'unavailable' | 'closed';
  view: RunActionAccessView | null;
  selections: AccessSelection[];
  failure: string | null;
  notice: string | null;
  sourceCurrent: boolean | null;
  requestClosed: boolean | null;
}

/** An app-session sheet for one original run/request, never persisted. */
export function createRunActionAccessSession(
  run: number,
  requestId: string | null,
  api: RunActionAccessApi,
) {
  let originalRunId: string | null = null;
  let state: RunActionAccessState = {
    retired: false,
    phase: 'idle',
    view: null,
    selections: [],
    failure: null,
    notice: null,
    sourceCurrent: null,
    requestClosed: null,
  };
  const listeners = new Set<() => void>();
  const publish = (next: Partial<RunActionAccessState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const busy = () => state.phase === 'loading' || state.phase === 'saving';
  const unknown = () =>
    publish({
      phase: 'unknown',
      selections: [],
      sourceCurrent: null,
      requestClosed: null,
      failure:
        'Could not confirm whether access changed. Reload current access and review it before making another change.',
      notice: null,
    });
  const invalidChoice = () =>
    publish({
      phase: 'unavailable',
      failure: 'An action choice could not be read. Reload current access before editing.',
    });
  return {
    retire: (): void => {
      if (state.retired) return;
      publish({
        retired: true,
        phase: busy() ? state.phase : 'closed',
        notice:
          'This access request has ended. A save already sent still belongs to the original run.',
      });
    },
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: async (): Promise<void> => {
      if (state.retired || busy() || state.phase === 'closed') return;
      const reviewing = state.phase !== 'idle';
      publish({ phase: 'loading', failure: null });
      try {
        const view = copyView(await api.read(run));
        if (state.retired) {
          publish({ phase: 'closed', selections: [] });
          return;
        }
        if (
          (originalRunId !== null && originalRunId !== view.runId) ||
          (requestId !== null && requestId !== view.accessRequestId)
        ) {
          publish({
            phase: 'closed',
            selections: [],
            failure: 'This access request is no longer waiting on the original run.',
          });
          return;
        }
        originalRunId = view.runId;
        publish({
          phase: 'ready',
          view,
          selections: preserve(view),
          failure: null,
          sourceCurrent: null,
          requestClosed: null,
          notice: reviewing
            ? 'Current access reloaded. Review these choices before selecting Done.'
            : null,
        });
      } catch {
        if (state.retired) {
          publish({ phase: 'closed', selections: [] });
          return;
        }
        publish({
          phase: 'unavailable',
          failure: 'Access is unavailable. Reload current access to try again.',
        });
      }
    },
    select: (selections: AccessSelection[]): void => {
      if (state.retired || state.phase !== 'ready') return;
      try {
        publish({ selections: selections.map(copySelection), failure: null });
      } catch {
        invalidChoice();
      }
    },
    save: async (): Promise<void> => {
      const { view } = state;
      if (state.retired || state.phase !== 'ready' || view === null) return;
      let request: SetRunActionAccess;
      try {
        request = {
          expectedAccessRevision: view.accessRevision,
          selections: state.selections.map(copySelection),
          completeRequestId: requestId,
        };
      } catch {
        invalidChoice();
        return;
      }
      publish({ phase: 'saving', failure: null, notice: null });
      try {
        const result = await api.set(run, request);
        if (result.state === 'changed') {
          const next = copyView(result.view);
          if (
            next.runId !== originalRunId ||
            typeof result.sourceCurrent !== 'boolean' ||
            typeof result.requestClosed !== 'boolean'
          ) {
            unknown();
            return;
          }
          publish({
            phase: 'saved',
            view: next,
            selections: [],
            failure: null,
            sourceCurrent: result.sourceCurrent,
            requestClosed: result.requestClosed,
            notice: !result.sourceCurrent
              ? 'Access was saved for the original run. That run is no longer current.'
              : !result.requestClosed && requestId !== null
                ? 'Access was saved. Reload to check whether the original request is still waiting.'
                : 'Access saved for this run.',
          });
        } else if (result.state === 'refused') {
          const editable = ['invalid_input', 'unsupported_schema', 'limit_exceeded'].includes(
            result.error.code,
          );
          publish({
            phase: editable ? 'ready' : 'unavailable',
            failure: editable
              ? 'These choices could not be saved. Check the selected action and input.'
              : 'Access or account details changed, or this run is unavailable. Refresh access before changing it.',
          });
        } else {
          unknown();
        }
      } catch {
        unknown();
      }
    },
  };
}

function preserve(view: RunActionAccessView): AccessSelection[] {
  // Native returns unrevoked rows. A temporarily unavailable account or
  // definition cannot silently remove a person's existing exact-input grant.
  return view.grants.map((grant) => ({
    kind: 'preserve',
    grantId: grant.grantId,
    expectedRevision: grant.revision,
  }));
}

function copySelection(choice: AccessSelection): AccessSelection {
  if (choice.kind === 'preserve')
    return {
      kind: 'preserve',
      grantId: choice.grantId,
      expectedRevision: choice.expectedRevision,
    };
  if (choice.kind !== 'new') throw new Error('Invalid action choice.');
  const selected = choice.selection;
  return {
    kind: 'new',
    selection: {
      connectionId: selected.connectionId,
      accountId: selected.accountId,
      accountRevision: selected.accountRevision,
      revocationGeneration: selected.revocationGeneration,
      actionId: selected.actionId,
      definitionDigest: selected.definitionDigest,
      inputScope: copyInputSelection(selected.inputScope),
    },
  };
}

function copyInputSelection(scope: GrantInputSelection): GrantInputSelection {
  if (scope.kind === 'all_valid_inputs') return { kind: 'all_valid_inputs' };
  if (scope.kind === 'exact_canonical_input' && typeof scope.input === 'string') {
    return { kind: 'exact_canonical_input', input: scope.input };
  }
  throw new Error('Invalid action input scope.');
}

function copyInputView(scope: GrantInputView): GrantInputView {
  if (scope.kind === 'all_valid_inputs') return { kind: 'all_valid_inputs' };
  if (scope.kind === 'exact_canonical_input' && typeof scope.inputDigest === 'string') {
    return { kind: 'exact_canonical_input', inputDigest: scope.inputDigest };
  }
  throw new Error('Invalid recorded action input scope.');
}

/** Keep the finite metadata DTO, never unknown transport fields or raw errors. */
function copyView(value: RunActionAccessView): RunActionAccessView {
  if (
    !value ||
    typeof value.runId !== 'string' ||
    value.runId.length === 0 ||
    typeof value.accessRevision !== 'string' ||
    value.accessRevision.length === 0 ||
    (value.accessRequestId !== null && typeof value.accessRequestId !== 'string')
  ) {
    throw new Error('Invalid access metadata.');
  }
  return {
    runId: value.runId,
    accessRevision: value.accessRevision,
    accessRequestId: value.accessRequestId,
    accounts: value.accounts.map((account) => ({
      connectionId: account.connectionId,
      accountId: account.accountId,
      label: account.label,
      accountRevision: account.accountRevision,
      revocationGeneration: account.revocationGeneration,
    })),
    definitions: value.definitions.map((definition) => ({
      actionId: definition.actionId,
      definitionDigest: definition.definitionDigest,
      inputSchemaDigest: definition.inputSchemaDigest,
      outputSchemaDigest: definition.outputSchemaDigest,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      adapterRevision: definition.adapterRevision,
      effectClass: definition.effectClass,
      requiredCapabilities: [...definition.requiredCapabilities],
      retry: definition.retry,
      cancel: definition.cancel,
      reconcile: definition.reconcile,
    })),
    grants: value.grants.map((grant) => ({
      grantId: grant.grantId,
      revision: grant.revision,
      connectionId: grant.connectionId,
      accountId: grant.accountId,
      actionId: grant.actionId,
      definitionDigest: grant.definitionDigest,
      available: grant.available,
      inputScope: copyInputView(grant.inputScope),
    })),
  };
}
