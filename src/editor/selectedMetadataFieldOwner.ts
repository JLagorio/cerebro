import { isDateText } from '@/engine/dateGrammar';
import VALUE_RULES from '../../shared/workspace/values.v1.json';
import type {
  MetadataPatchOperation,
  MetadataPatchRequest,
  MetadataPatchResult,
  PropertyChange,
  SelectedEditorTarget,
  SelectedPropertySnapshot,
  SelectedRecordVersion,
} from '@/lib/generated/workspace';
import type { DocumentKey, OwnerSnapshot, SaveOutcome } from './documentOwner';
import type { RecoveryAdapter } from './deletedDraftRecovery';
import { recoveryKeys } from './deletedDraftRecovery';
import { documentAdmission, type DocumentAdmission } from './documentAdmission';
import { registerSaveParticipant, retainedSaveParticipant } from './openPages';
export interface MetadataFieldScope {
  vault: string;
  path: string;
  target: SelectedEditorTarget;
  field: string;
}
export interface MetadataFieldApi {
  read: (scope: MetadataFieldScope) => Promise<SelectedPropertySnapshot>;
  patch: (scope: MetadataFieldScope, request: MetadataPatchRequest) => Promise<MetadataPatchResult>;
  mintKey: () => string;
  accepted?: (
    scope: MetadataFieldScope,
    request: MetadataPatchRequest,
    result: Exclude<MetadataPatchResult, { kind: 'outcome_unknown' }>,
  ) => void;
}
export interface MetadataFieldState {
  phase: 'idle' | 'sending' | 'unknown' | 'reconcile' | 'failed';
  latestDraft: string;
  generation: number;
  acknowledgedGeneration: number;
  busy: boolean;
  request: MetadataPatchRequest | null;
  comparison: SelectedPropertySnapshot | null;
  confirmed: MetadataPatchResult | null;
  message: string | null;
}
const identity = (scope: MetadataFieldScope): DocumentKey => ({
  vaultId: scope.vault,
  path: scope.path,
  ownerId:
    'selected-property:' +
    scope.target.workspaceId +
    ':' +
    scope.target.recordId +
    ':' +
    scope.field,
});
const sameTarget = (a: SelectedEditorTarget, b: SelectedEditorTarget) =>
  a.workspaceId === b.workspaceId && a.recordId === b.recordId;
export const sameMetadataVersion = (a: SelectedRecordVersion, b: SelectedRecordVersion): boolean =>
  a.kind === b.kind &&
  sameTarget(a, b) &&
  a.metadataRevision === b.metadataRevision &&
  a.metadataHash === b.metadataHash &&
  a.bodyHash === b.bodyHash;
const textOf = (frame: SelectedPropertySnapshot) =>
  frame.value.kind === 'present' &&
  (frame.value.value.kind === 'string' ||
    frame.value.value.kind === 'decimal' ||
    frame.value.value.kind === 'date')
    ? frame.value.value.value
    : frame.value.kind === 'present' && frame.value.value.kind === 'boolean'
      ? String(frame.value.value.value)
      : '';
const decimalPattern = new RegExp(VALUE_RULES.decimal.pattern);
// Valid lexemes are ASCII; exact full matching makes this also the byte bound.
const validDecimalDraft = (text: string): boolean =>
  text.length <= VALUE_RULES.decimal.maxLexemeBytes && decimalPattern.exec(text)?.[0] === text;
const invalidDecimalMessage = (text: string): string =>
  'Invalid number draft: ' +
  JSON.stringify(text.slice(0, VALUE_RULES.decimal.maxLexemeBytes)) +
  (text.length > VALUE_RULES.decimal.maxLexemeBytes ? '…' : '') +
  '. Enter an exact decimal number within the supported size, without spaces. Your full draft is kept.';
// The strict shared grammar plus day-only form, with no Date/epoch conversion.
const validCalendarDay = (text: string): boolean => text.length === 10 && isDateText(text);
const invalidDateMessage = (text: string): string =>
  'Invalid date draft: ' +
  JSON.stringify(text.slice(0, 32)) +
  (text.length > 32 ? '…' : '') +
  '. Enter a calendar day as YYYY-MM-DD. Your full draft is kept.';
function frameMatches(scope: MetadataFieldScope, frame: SelectedPropertySnapshot): boolean {
  return (
    frame.path === scope.path &&
    frame.field === scope.field &&
    sameTarget(scope.target, frame.target) &&
    sameTarget(scope.target, frame.version)
  );
}
function writable(scope: MetadataFieldScope, frame: SelectedPropertySnapshot): boolean {
  return (
    frameMatches(scope, frame) &&
    frame.editable &&
    frame.coherence === 'paired' &&
    frame.observedBodyHash === frame.version.bodyHash &&
    (frame.value.kind === 'absent' ||
      frame.value.value.kind === 'string' ||
      frame.value.value.kind === 'boolean' ||
      frame.value.value.kind === 'decimal' ||
      frame.value.value.kind === 'date' ||
      frame.value.value.kind === 'null')
  );
}
const sameFrame = (a: SelectedPropertySnapshot, b: SelectedPropertySnapshot) =>
  sameMetadataVersion(a.version, b.version) &&
  a.path === b.path &&
  a.field === b.field &&
  sameTarget(a.target, b.target) &&
  a.observedBodyHash === b.observedBodyHash &&
  a.coherence === b.coherence &&
  a.editable === b.editable &&
  JSON.stringify(a.value) === JSON.stringify(b.value);
function freshRefusal(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'kind' in error &&
    error.kind === 'metadata_refused' &&
    'error' in error &&
    typeof error.error === 'object' &&
    error.error !== null &&
    'message' in error.error &&
    typeof error.error.message === 'string'
  )
    return error.error.message;
  return null;
}
function matchingOperation(
  op: MetadataPatchOperation,
  q: MetadataPatchRequest,
  path: string,
): boolean {
  const r = op.receipt;
  const v = op.version;
  const before = q.expectedVersion;
  return (
    op.path === path &&
    op.requestKey === q.requestKey &&
    sameTarget(op.target, q.target) &&
    sameTarget(v, q.target) &&
    v.kind === 'sqlite_metadata' &&
    v.bodyHash === before.bodyHash &&
    r.workspaceId === q.target.workspaceId &&
    r.recordId === q.target.recordId &&
    r.operation === 'metadata.patch' &&
    r.previousRevision === before.metadataRevision &&
    r.revision === v.metadataRevision &&
    r.metadataBeforeHash === before.metadataHash &&
    r.metadataAfterHash === v.metadataHash &&
    r.bodyBeforeHash === before.bodyHash &&
    r.bodyAfterHash === v.bodyHash &&
    /^[1-9][0-9]{0,18}$/.test(v.metadataRevision) &&
    BigInt(v.metadataRevision) === BigInt(before.metadataRevision) + 1n &&
    (q.original == null ||
      (q.original.path === op.path &&
        q.original.requestKey === op.requestKey &&
        q.original.operationId === op.operationId &&
        sameTarget(q.original.target, op.target) &&
        sameMetadataVersion(q.original.version, op.version) &&
        Object.keys({ ...q.original.receipt, ...r }).every(
          (key) =>
            (q.original!.receipt[key as keyof typeof r] ?? null) ===
            (r[key as keyof typeof r] ?? null),
        )))
  );
}
/** One original metadata request is retained independently of its cell. The
 * generated native result, not a truthy transport or refresh, settles it. */
export class SelectedMetadataFieldOwner {
  readonly phase = 'field' as const;
  readonly key: DocumentKey;
  readonly scope: MetadataFieldScope;
  readonly original: SelectedPropertySnapshot;
  private readonly api: MetadataFieldApi;
  private state: MetadataFieldState;
  private draftValue: SelectedPropertySnapshot['value'];
  private change: PropertyChange | null = null;
  private editable: boolean;
  private expected: SelectedRecordVersion;
  private attempt: MetadataPatchRequest | null = null;
  private attemptGeneration = 0;
  private removal = false;
  private invalidValue: 'decimal' | 'date' | null = null;
  private running: Promise<SaveOutcome> | null = null;
  private reading: Promise<boolean> | null = null;
  private failed: Extract<SaveOutcome, { kind: 'failed' }> | null = null;
  private held = false;
  private retired = false;
  private admission: DocumentAdmission = { kind: 'ready' };
  private leases = 0;
  private stop: (() => void) | null = null;
  private listeners = new Set<() => void>();
  constructor(
    scope: MetadataFieldScope,
    original: SelectedPropertySnapshot,
    api: MetadataFieldApi,
  ) {
    this.scope = structuredClone(scope);
    this.original = structuredClone(original);
    this.draftValue = structuredClone(original.value);
    this.editable = writable(scope, original);
    this.expected = structuredClone(original.version);
    this.key = identity(scope);
    this.api = { read: api.read, patch: api.patch, mintKey: api.mintKey, accepted: api.accepted };
    this.state = {
      phase: 'idle',
      latestDraft: textOf(original),
      generation: 0,
      acknowledgedGeneration: 0,
      busy: false,
      request: null,
      comparison: null,
      confirmed: null,
      message: null,
    };
  }
  getSnapshot = (): MetadataFieldState => this.state;
  /** Typed intent is never recovered by parsing the draft's display text. */
  editBoolean = (value: boolean): void => {
    if (this.retired || !this.editable || this.state.busy || this.attempt !== null) return;
    this.removal = false;
    this.invalidValue = null;
    this.change = { op: 'set', key: this.scope.field, value: { kind: 'boolean', value } };
    this.draftValue = { kind: 'present', value: { kind: 'boolean', value } };
    this.failed = null;
    this.state = {
      ...this.state,
      phase: 'idle',
      latestDraft: String(value),
      generation: this.state.generation + 1,
      message: null,
    };
    this.publish();
  };
  /** Author a canonical Decimal from the shared exact lexeme grammar only. */
  editDecimal = (lexeme: string): void => {
    if (this.retired || !this.editable || this.state.busy || this.attempt !== null) return;
    this.removal = false;
    this.invalidValue = validDecimalDraft(lexeme) ? null : 'decimal';
    this.failed = null;
    this.change =
      this.invalidValue === null
        ? { op: 'set', key: this.scope.field, value: { kind: 'decimal', value: lexeme } }
        : null;
    if (this.invalidValue === null)
      this.draftValue = { kind: 'present', value: { kind: 'decimal', value: lexeme } };
    this.state = {
      ...this.state,
      phase: 'idle',
      latestDraft: lexeme,
      generation: this.state.generation + 1,
      message: this.invalidValue === 'decimal' ? invalidDecimalMessage(lexeme) : null,
    };
    this.publish();
  };
  /** Author only an exact calendar Date; other temporal modes stay unavailable. */
  editDate = (day: string): void => {
    if (this.retired || !this.editable || this.state.busy || this.attempt !== null) return;
    this.removal = false;
    this.invalidValue = validCalendarDay(day) ? null : 'date';
    this.failed = null;
    this.change =
      this.invalidValue === null
        ? { op: 'set', key: this.scope.field, value: { kind: 'date', value: day } }
        : null;
    if (this.invalidValue === null)
      this.draftValue = { kind: 'present', value: { kind: 'date', value: day } };
    this.state = {
      ...this.state,
      phase: 'idle',
      latestDraft: day,
      generation: this.state.generation + 1,
      message: this.invalidValue === 'date' ? invalidDateMessage(day) : null,
    };
    this.publish();
  };
  getValue = (): SelectedPropertySnapshot['value'] => structuredClone(this.draftValue);
  isPresented = (): boolean => this.leases > 0;
  intentPreview = (): string => {
    if (this.invalidValue !== null)
      return (
        'Invalid ' +
        (this.invalidValue === 'date' ? 'date' : 'number') +
        ' draft: ' +
        JSON.stringify(this.state.latestDraft)
      );
    if (this.removal) return '(remove property)';
    const current = this.draftValue;
    if (current.kind === 'absent') return '(property absent)';
    return current.value.kind === 'string'
      ? JSON.stringify(current.value.value)
      : current.value.kind === 'boolean'
        ? String(current.value.value)
        : current.value.kind === 'decimal' || current.value.kind === 'date'
          ? current.value.value
          : current.value.kind === 'null'
            ? 'null'
            : JSON.stringify(current.value);
  };
  snapshot = (): OwnerSnapshot => ({
    latestDraft: this.state.latestDraft,
    generation: this.state.generation,
    acknowledgedGeneration: this.state.acknowledgedGeneration,
    inFlightGeneration: this.state.busy ? this.attemptGeneration : null,
    failure: this.failed,
    ...(this.state.phase === 'unknown'
      ? {
          selectedSave: {
            status: 'unknown' as const,
            generation: this.attemptGeneration,
            requestKey: this.attempt!.requestKey,
          },
        }
      : {}),
    reconcileRequired: this.state.phase === 'reconcile' || this.held,
  });
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish = () => {
    for (const listener of this.listeners) listener();
    if (this.leases === 0 && !this.unresolved()) this.stop?.();
  };
  private unresolved = () =>
    this.state.busy ||
    this.state.request !== null ||
    this.failed !== null ||
    this.held ||
    this.state.phase === 'reconcile' ||
    this.state.generation !== this.state.acknowledgedGeneration;
  prepare = (): void => undefined;
  blocked = (): 'choice' | 'reconcile' | null =>
    this.held || this.state.phase === 'reconcile' ? 'reconcile' : null;
  attach = (): (() => void) => {
    if (this.leases === 0) {
      const stop = registerSaveParticipant(this);
      this.stop = stop;
      this.admission = stop.admission;
    }
    this.leases += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases -= 1;
      if (this.leases === 0) this.stop?.();
      this.publish();
    };
  };
  edit = (text: string): void => {
    if (this.retired || !this.editable || this.state.busy || this.attempt !== null) return;
    this.removal = false;
    this.invalidValue = null;
    this.change = { op: 'set', key: this.scope.field, value: { kind: 'string', value: text } };
    this.draftValue = { kind: 'present', value: { kind: 'string', value: text } };
    this.failed = null;
    this.state = {
      ...this.state,
      phase: 'idle',
      latestDraft: text,
      generation: this.state.generation + 1,
      message: null,
    };
    this.publish();
  };
  remove = (): void => {
    if (this.retired || !this.editable || this.state.busy || this.attempt !== null) return;
    this.removal = true;
    this.invalidValue = null;
    this.change = { op: 'remove', key: this.scope.field };
    this.draftValue = { kind: 'absent' };
    this.failed = null;
    this.state = {
      ...this.state,
      phase: 'idle',
      generation: this.state.generation + 1,
      message: null,
    };
    this.publish();
  };
  private blockedOutcome = (): SaveOutcome => ({
    kind: 'blocked',
    ownerId: this.key.ownerId,
    generation: this.state.generation,
    reason: 'reconcile',
  });
  private clean = (): SaveOutcome => ({
    kind: 'clean',
    ownerId: this.key.ownerId,
    generation: this.state.generation,
  });
  flush = (): Promise<SaveOutcome> => {
    if (this.running) return this.running;
    if (this.retired) return Promise.resolve(this.clean());
    if (
      this.state.busy ||
      this.held ||
      this.admission.kind !== 'ready' ||
      documentAdmission(this.key, this).kind !== 'ready' ||
      this.state.phase === 'reconcile'
    )
      return Promise.resolve(this.blockedOutcome());
    if (this.attempt === null && this.invalidValue !== null) {
      this.failed = {
        kind: 'failed',
        ownerId: this.key.ownerId,
        generation: this.state.generation,
        code: 'metadata_value_invalid',
      };
      this.state = {
        ...this.state,
        phase: 'failed',
        message:
          this.invalidValue === 'date'
            ? invalidDateMessage(this.state.latestDraft)
            : invalidDecimalMessage(this.state.latestDraft),
      };
      this.publish();
      return Promise.resolve(this.failed);
    }
    if (this.attempt === null && this.state.generation === this.state.acknowledgedGeneration)
      return Promise.resolve(this.clean());
    if (this.attempt === null) {
      const changes: PropertyChange[] =
        this.change === null
          ? [
              {
                op: 'set',
                key: this.scope.field,
                value: { kind: 'string', value: this.state.latestDraft },
              },
            ]
          : [structuredClone(this.change)];
      let requestKey: string;
      try {
        requestKey = this.api.mintKey();
      } catch {
        this.failed = {
          kind: 'failed',
          ownerId: this.key.ownerId,
          generation: this.state.generation,
          code: 'metadata_request_unavailable',
        };
        this.state = {
          ...this.state,
          phase: 'failed',
          message: 'The field request could not be started. Your draft is kept.',
        };
        this.publish();
        return Promise.resolve(this.failed);
      }
      this.attempt = {
        target: structuredClone(this.scope.target),
        requestKey,
        expectedVersion: structuredClone(this.expected),
        changes,
        phase: 'start',
        original: null,
      };
      this.attemptGeneration = this.state.generation;
    }
    const q = structuredClone(this.attempt);
    q.phase = this.state.phase === 'unknown' ? 'resolve' : 'start';
    this.failed = null;
    this.state = {
      ...this.state,
      phase: 'sending',
      busy: true,
      request: structuredClone(this.attempt),
      comparison: null,
      message: 'Saving…',
    };
    this.publish();
    const task = this.dispatch(q);
    this.running = task;
    void task.finally(() => {
      if (this.running === task) this.running = null;
    });
    return task;
  };
  retry = (): Promise<SaveOutcome> => this.flush();
  private async dispatch(q: MetadataPatchRequest): Promise<SaveOutcome> {
    let outcome: SaveOutcome;
    try {
      const result = await this.api.patch(structuredClone(this.scope), structuredClone(q));
      if (result.kind === 'outcome_unknown') {
        if (result.requestKey !== q.requestKey) throw new Error('Foreign metadata response.');
        this.state = {
          ...this.state,
          phase: 'reconcile',
          busy: false,
          confirmed: null,
          message: result.error.message + ' Compare versions before choosing what to keep.',
        };
        outcome = this.blockedOutcome();
      } else {
        const version = result.kind === 'applied' ? result.operation.version : result.version;
        const valid =
          result.kind === 'applied'
            ? matchingOperation(result.operation, q, this.scope.path)
            : result.requestKey === q.requestKey &&
              result.path === this.scope.path &&
              sameTarget(result.target, q.target) &&
              sameMetadataVersion(result.version, q.expectedVersion);
        if (
          !valid ||
          !sameTarget(result.currentVersion, q.target) ||
          result.currentVersion.kind !== 'sqlite_metadata'
        )
          throw new Error('Metadata acknowledgement did not match the original request.');
        const reconcile =
          result.reconcileRequired || !sameMetadataVersion(version, result.currentVersion);
        this.state = {
          ...this.state,
          phase: reconcile ? 'reconcile' : 'idle',
          busy: false,
          confirmed: structuredClone(result),
          acknowledgedGeneration: this.attemptGeneration,
          message: reconcile
            ? 'The original field save is known. The page changed again; compare versions.'
            : null,
        };
        // Presentation failure cannot change a native acknowledged original.
        try {
          this.api.accepted?.(
            structuredClone(this.scope),
            structuredClone(q),
            structuredClone(result),
          );
        } catch {
          /* The known result remains retained below. */
        }
        if (reconcile) {
          outcome = this.blockedOutcome();
        } else {
          this.expected = structuredClone(version);
          this.attempt = null;
          this.state = { ...this.state, request: null };
          outcome = {
            kind: 'committed',
            ownerId: this.key.ownerId,
            generation: this.attemptGeneration,
            source: 'guarded_field',
          };
        }
      }
    } catch (error) {
      const refusal = q.phase === 'start' ? freshRefusal(error) : null;
      if (refusal !== null) {
        this.failed = {
          kind: 'failed',
          ownerId: this.key.ownerId,
          generation: this.attemptGeneration,
          code: 'metadata_refused',
        };
        this.state = {
          ...this.state,
          phase: 'failed',
          busy: false,
          message: refusal + ' Your draft is kept.',
        };
        outcome = this.failed;
      } else {
        this.state = {
          ...this.state,
          phase: 'unknown',
          busy: false,
          message:
            'The original field save could not be confirmed. Check save without starting another request.',
        };
        outcome = {
          kind: 'pending',
          ownerId: this.key.ownerId,
          generation: this.attemptGeneration,
          status: 'unknown',
          code: 'metadata_outcome_unknown',
        };
      }
    }
    this.publish();
    return outcome;
  }
  compare = (): Promise<boolean> => {
    if (this.reading) return this.reading;
    if (this.retired || this.state.busy || this.attempt === null) return Promise.resolve(false);
    this.state = { ...this.state, busy: true, message: 'Reading current field…' };
    this.publish();
    const task = this.readComparison();
    this.reading = task;
    void task.finally(() => {
      if (this.reading === task) this.reading = null;
    });
    return task;
  };
  private async readComparison(): Promise<boolean> {
    try {
      const current = await this.api.read(structuredClone(this.scope));
      if (!frameMatches(this.scope, current)) throw new Error('Foreign current field.');
      this.failed = null;
      this.state = {
        ...this.state,
        phase: 'reconcile',
        comparison: structuredClone(current),
        busy: false,
        message:
          current.coherence === 'paired'
            ? null
            : 'The current body is not paired with canonical metadata. Your draft is kept.',
      };
      this.publish();
      return true;
    } catch {
      this.state = {
        ...this.state,
        busy: false,
        message: 'Current field could not be verified. The original request and draft are kept.',
      };
      this.publish();
      return false;
    }
  }
  choose = async (which: 'mine' | 'current'): Promise<SaveOutcome> => {
    const compared = this.state.comparison;
    if (this.state.busy || compared === null || this.attempt === null || this.retired)
      return this.blockedOutcome();
    this.state = { ...this.state, busy: true, message: 'Checking the displayed comparison…' };
    this.publish();
    let current: SelectedPropertySnapshot;
    try {
      current = await this.api.read(structuredClone(this.scope));
      if (!frameMatches(this.scope, current)) throw new Error('Foreign current field.');
    } catch {
      this.state = {
        ...this.state,
        busy: false,
        message: 'The comparison could not be verified. Your draft is kept.',
      };
      this.publish();
      return this.blockedOutcome();
    }
    if (!sameFrame(compared, current)) {
      this.state = {
        ...this.state,
        busy: false,
        comparison: structuredClone(current),
        message: 'The current field changed. Review the updated comparison and choose again.',
      };
      this.publish();
      return this.blockedOutcome();
    }
    if (
      (which === 'mine' && !writable(this.scope, current)) ||
      (which === 'current' &&
        (current.coherence !== 'paired' || current.observedBodyHash !== current.version.bodyHash))
    ) {
      this.state = {
        ...this.state,
        busy: false,
        message:
          current.readOnlyReason ?? 'The current page is not paired. Your original draft is kept.',
      };
      this.publish();
      return this.blockedOutcome();
    }
    this.failed = null;
    this.attempt = null;
    this.held = false;
    this.expected = structuredClone(current.version);
    this.state = {
      ...this.state,
      phase: 'idle',
      busy: false,
      request: null,
      comparison: null,
      confirmed: null,
      message: null,
    };
    if (which === 'current') {
      this.removal = false;
      this.invalidValue = null;
      this.change = null;
      this.draftValue = structuredClone(current.value);
      this.editable = writable(this.scope, current);
      this.state = {
        ...this.state,
        latestDraft: textOf(current),
        acknowledgedGeneration: this.state.generation,
      };
      this.publish();
      return this.clean();
    }
    // Explicit stable choice, the only transition which replaces an unresolved
    // original with a new request and complete current expectation.
    this.editable = true;
    this.state = { ...this.state, generation: this.state.generation + 1 };
    this.publish();
    return this.flush();
  };
  get recovery(): RecoveryAdapter {
    return {
      key: this.key,
      identity: this,
      snapshot: this.snapshot,
      subscribe: this.subscribe,
      busy: () => this.state.busy,
      hold: () => {
        this.held = true;
        this.publish();
      },
      requiresRecovery: () => this.held,
      resume: async (current) => {
        if (!current() || this.state.busy) return false;
        const compared = await this.compare();
        return current() && compared;
      },
      retire: () => {
        if (this.state.busy || (this.attempt !== null && this.state.phase !== 'failed'))
          return false;
        this.retired = true;
        this.held = false;
        this.failed = null;
        this.attempt = null;
        this.state = {
          ...this.state,
          phase: 'idle',
          request: null,
          acknowledgedGeneration: this.state.generation,
        };
        this.publish();
        return true;
      },
      payload: (): ReturnType<RecoveryAdapter['payload']> => ({
        kind: 'field',
        body: null,
        field: { name: this.scope.field, text: this.state.latestDraft },
        children: this.unresolved()
          ? {
              selectedMetadataOriginal: JSON.stringify({
                scope: this.scope,
                original: this.original,
                request: this.attempt,
              }),
            }
          : {},
        metadata: { kind: 'unavailable' },
      }),
    };
  }
}
export function retainedSelectedMetadataField(
  scope: MetadataFieldScope,
): SelectedMetadataFieldOwner | undefined {
  const retained = retainedSaveParticipant(identity(scope));
  return retained instanceof SelectedMetadataFieldOwner ? retained : undefined;
}
export function selectedMetadataOwners(): SelectedMetadataFieldOwner[] {
  return recoveryKeys().flatMap((key) => {
    const owner = retainedSaveParticipant(key);
    if (!(owner instanceof SelectedMetadataFieldOwner)) return [];
    const state = owner.snapshot();
    return state.generation !== state.acknowledgedGeneration ||
      state.reconcileRequired ||
      owner.getSnapshot().request !== null
      ? [owner]
      : [];
  });
}
export function attachSelectedMetadataField(
  scope: MetadataFieldScope,
  observed: SelectedPropertySnapshot,
  api: MetadataFieldApi,
): { owner: SelectedMetadataFieldOwner; release: () => void } | null {
  const retained = retainedSelectedMetadataField(scope);
  if (retained) return { owner: retained, release: retained.attach() };
  if (!writable(scope, observed)) return null;
  const owner = new SelectedMetadataFieldOwner(scope, observed, api);
  return { owner, release: owner.attach() };
}
