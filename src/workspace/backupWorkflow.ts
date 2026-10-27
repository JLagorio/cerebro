import type {
  WorkspaceBackupAvailability,
  WorkspaceBackupChoiceResult,
  WorkspaceBackupCommitResult,
  WorkspaceBackupCancelResult,
  WorkspaceBackupOperation,
  WorkspaceBackupRefusal,
} from '@/lib/generated/workspace';
import type { FlushReport, DocumentKey } from '@/editor/documentOwner';
import type { OpenPageSnapshot } from '@/editor/saveParticipants';

/** Presentation scope only; the native selected opening remains authoritative. */
export interface BackupPresentation {
  vaultPath: string | null;
  opening: number;
}
export interface BackupWorkflowDeps {
  api: {
    availability(vault: string | null): Promise<WorkspaceBackupAvailability>;
    choose(vault: string): Promise<WorkspaceBackupChoiceResult>;
    check(): Promise<WorkspaceBackupChoiceResult>;
    restore(token: string): Promise<WorkspaceBackupChoiceResult>;
    commit(token: string): Promise<WorkspaceBackupCommitResult>;
    commitRestore(token: string): Promise<WorkspaceBackupCommitResult>;
    cancel(token: string): Promise<WorkspaceBackupCancelResult>;
    operation(): Promise<WorkspaceBackupOperation>;
  };
  presentation(): BackupPresentation;
  flush(): Promise<FlushReport>;
  unresolved(): OpenPageSnapshot[];
  toast(message: string): void;
}
export interface BackupWorkflowState {
  availability: WorkspaceBackupAvailability | null;
  operation: WorkspaceBackupOperation | null;
  busy: 'choosing' | 'saving' | 'committing' | 'cancelling' | null;
  message: string | null;
  refusal: WorkspaceBackupRefusal | null;
  blocked: { key: DocumentKey; participantId: string }[];
  uncertain: boolean;
}
export function createBackupWorkflow(deps: BackupWorkflowDeps) {
  let state: BackupWorkflowState = {
    availability: null,
    operation: null,
    busy: null,
    message: null,
    refusal: null,
    blocked: [],
    uncertain: false,
  };
  const listeners = new Set<() => void>();
  let version = 0;
  let read = 0;
  let availabilityRead = 0;
  let turn = 0;
  let createOpening: (BackupPresentation & { operationId: string; token: string }) | null = null;
  let observedPresentation = deps.presentation();
  const set = (patch: Partial<BackupWorkflowState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const samePresentation = (before: BackupPresentation, after = deps.presentation()) =>
    before.vaultPath === after.vaultPath && before.opening === after.opening;
  function fail(message: string, uncertain = false, notify = true) {
    set({ message, uncertain });
    if (notify) deps.toast(message);
    return false;
  }
  function adopt(operation: WorkspaceBackupOperation) {
    version++;
    if (
      operation.kind !== 'pending' ||
      operation.review.mode !== 'create' ||
      createOpening === null ||
      operation.review.operationId !== createOpening?.operationId ||
      operation.review.token !== createOpening.token
    )
      createOpening = null;
    set({ operation, uncertain: operation.kind === 'unavailable' });
  }
  function begin(busy: BackupWorkflowState['busy']) {
    const ticket = ++turn;
    version++;
    set({ busy, message: null, refusal: null, blocked: [] });
    return ticket;
  }
  function finish(ticket: number) {
    if (ticket === turn) set({ busy: null });
  }
  function newChoiceAllowed() {
    return (
      !state.busy &&
      !state.uncertain &&
      !['choosing', 'pending', 'running'].includes(state.operation?.kind ?? 'none')
    );
  }
  function pending() {
    return state.operation?.kind === 'pending' ? state.operation.review : null;
  }
  function sourceCurrent(review: NonNullable<ReturnType<typeof pending>>) {
    const current = pending();
    return (
      createOpening !== null &&
      current?.token === review.token &&
      current.operationId === review.operationId &&
      createOpening.operationId === review.operationId &&
      createOpening.token === review.token &&
      samePresentation(createOpening)
    );
  }
  function refused(refusal: WorkspaceBackupRefusal) {
    set({ refusal, message: refusal.message });
    deps.toast(refusal.message);
    return false;
  }
  async function refresh(notify = false) {
    const ticket = ++read;
    const originalVersion = version;
    const unknownBeforeRead = state.uncertain;
    try {
      const operation = await deps.api.operation();
      if (ticket !== read || originalVersion !== version || state.busy) return false;
      adopt(operation);
      if (operation.kind === 'unavailable')
        set({ refusal: operation.refusal, message: operation.refusal.message });
      else
        set({
          message:
            operation.kind === 'none' && unknownBeforeRead
              ? 'The previous backup outcome is unavailable. Check the saved location.'
              : null,
          refusal: null,
        });
      return operation.kind !== 'unavailable';
    } catch {
      if (ticket !== read || originalVersion !== version || state.busy) return false;
      return fail(
        'Backup status is unavailable. Check its status before another attempt.',
        true,
        notify,
      );
    }
  }
  async function refreshAvailability() {
    const ticket = ++availabilityRead;
    const original = deps.presentation();
    try {
      const availability = await deps.api.availability(original.vaultPath);
      if (ticket !== availabilityRead || !samePresentation(original)) return false;
      set({ availability });
      return true;
    } catch {
      if (ticket !== availabilityRead || !samePresentation(original)) return false;
      set({ availability: null });
      return fail('Backup availability could not be read.', state.uncertain, false);
    }
  }
  async function releaseChangedChoice(review: NonNullable<ReturnType<typeof pending>>) {
    createOpening = null;
    const ticket = begin('cancelling');
    try {
      const result = await deps.api.cancel(review.token);
      if (ticket !== turn) return false;
      if (result.kind === 'already_started') {
        adopt(result.operation);
        return false;
      }
      if (result.kind === 'cancelled') adopt({ kind: 'none' });
      else if (result.kind === 'refused') return refused(result.refusal);
      else adopt({ kind: 'preview', message: result.message });
      return fail('The vault opening changed. Choose the backup destination again.');
    } catch {
      return fail(
        'The backup choice could not be released. Check its status before another attempt.',
        true,
      );
    } finally {
      finish(ticket);
    }
  }
  function applyChoice(result: WorkspaceBackupChoiceResult, original?: BackupPresentation) {
    version++;
    if (result.kind === 'review') {
      createOpening =
        result.review.mode === 'create' && original
          ? { ...original, operationId: result.review.operationId, token: result.review.token }
          : null;
      adopt({ kind: 'pending', review: result.review });
      return true;
    }
    createOpening = null;
    adopt(
      result.kind === 'preview' ? { kind: 'preview', message: result.message } : { kind: 'none' },
    );
    if (result.kind === 'refused') return refused(result.refusal);
    return false;
  }
  async function chooseCreate() {
    if (!newChoiceAllowed()) return false;
    const original = deps.presentation();
    if (original.vaultPath === null) return fail('Open a workspace before creating a backup.');
    const ticket = begin('choosing');
    try {
      const result = await deps.api.choose(original.vaultPath);
      if (ticket !== turn) return false;
      if (result.kind === 'review' && !samePresentation(original))
        return await releaseChangedChoice(result.review);
      return applyChoice(result, original);
    } catch {
      return fail(
        'The backup choice is unavailable. Check its status before another attempt.',
        true,
      );
    } finally {
      finish(ticket);
    }
  }
  async function check() {
    if (!newChoiceAllowed()) return false;
    const ticket = begin('choosing');
    try {
      const result = await deps.api.check();
      return ticket === turn ? applyChoice(result) : false;
    } catch {
      return fail(
        'The backup check could not be confirmed. Check its status before another attempt.',
        true,
      );
    } finally {
      finish(ticket);
    }
  }
  async function chooseRestore() {
    const review = pending();
    if (!review || review.mode !== 'check' || state.busy || state.uncertain) return false;
    const ticket = begin('choosing');
    // Native consumes this checked-input choice while its chooser is open.
    set({ operation: null });
    try {
      const result = await deps.api.restore(review.token);
      return ticket === turn ? applyChoice(result) : false;
    } catch {
      return fail(
        'The restore choice could not be confirmed. Check its status before another attempt.',
        true,
      );
    } finally {
      finish(ticket);
    }
  }
  function blockedBySaves(rows: OpenPageSnapshot[]) {
    set({ blocked: rows.map(({ key, participantId }) => ({ key, participantId })) });
    return fail('Some drafts need attention. Finish saving them before creating a backup.');
  }
  async function commit() {
    const review = pending();
    if (!review || review.mode === 'check' || state.busy || state.uncertain) return false;
    if (review.mode === 'create' && !sourceCurrent(review)) return releaseChangedChoice(review);
    const ticket = begin(review.mode === 'create' ? 'saving' : 'committing');
    let invoked = false;
    try {
      if (review.mode === 'create') {
        const report = await deps.flush();
        if (ticket !== turn) return false;
        if (!sourceCurrent(review)) return await releaseChangedChoice(review);
        set({ busy: 'committing' });
        // Final synchronous observation: no await between this check and native
        // invocation. Existing owners retain drafts; this is never a writer.
        const unresolved = deps.unresolved();
        if (
          report.outcomes.some((outcome) =>
            ['failed', 'blocked', 'pending'].includes(outcome.kind),
          ) ||
          report.unresolvedOwnerIds.length > 0 ||
          unresolved.length > 0
        )
          return blockedBySaves(unresolved);
        if (!sourceCurrent(review)) return await releaseChangedChoice(review);
      }
      invoked = true;
      const request =
        review.mode === 'create'
          ? deps.api.commit(review.token)
          : deps.api.commitRestore(review.token);
      createOpening = null;
      // A consumed token cannot become an automatic retry after a lost reply.
      set({ operation: null });
      const result = await request;
      if (ticket !== turn) return false;
      version++;
      if (result.kind === 'started') {
        adopt({
          kind: 'running',
          operationId: result.operationId,
          mode: result.mode,
          labels: result.labels,
        });
        return true;
      }
      if (result.kind === 'already_started') {
        adopt(result.operation);
        return true;
      }
      if (result.kind === 'preview') {
        adopt({ kind: 'preview', message: result.message });
        return false;
      }
      return refused(result.refusal);
    } catch {
      if (ticket !== turn) return false;
      return invoked
        ? fail(
            'The backup result could not be confirmed. Check its status before another attempt.',
            true,
          )
        : fail('Pages could not finish saving. Resolve the drafts before creating a backup.');
    } finally {
      finish(ticket);
    }
  }
  async function cancel() {
    const review = pending();
    if (!review || state.busy) return false;
    const ticket = begin('cancelling');
    createOpening = null;
    try {
      const result = await deps.api.cancel(review.token);
      if (ticket !== turn) return false;
      if (result.kind === 'cancelled') {
        adopt({ kind: 'none' });
        return true;
      }
      if (result.kind === 'already_started') {
        adopt(result.operation);
        return false;
      }
      if (result.kind === 'preview') {
        adopt({ kind: 'preview', message: result.message });
        return false;
      }
      return refused(result.refusal);
    } catch {
      return fail(
        'The backup choice could not be released. Check its status before another attempt.',
        true,
      );
    } finally {
      finish(ticket);
    }
  }
  async function presentationChanged() {
    const current = deps.presentation();
    if (samePresentation(observedPresentation, current)) return;
    observedPresentation = current;
    set({ availability: null });
    const review = pending();
    if (review?.mode === 'create' && createOpening !== null && !sourceCurrent(review))
      await releaseChangedChoice(review);
    await refreshAvailability();
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    chooseCreate,
    check,
    chooseRestore,
    refresh,
    refreshAvailability,
    commit,
    cancel,
    presentationChanged,
  };
}
export type BackupWorkflow = ReturnType<typeof createBackupWorkflow>;
