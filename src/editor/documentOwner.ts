import type { RecoveryOutcome } from '@/engine/recovery';
import type {
  EditorOperation,
  EditorRecoveryView,
  EditorSaveRequest,
  EditorSaveResult,
  SelectedEditorTarget,
  SelectedEditorSnapshot,
  SelectedRecordVersion,
} from '@/lib/generated/workspace';
import { sha256Hex } from '@/lib/sha256';
export type BodyFormat = 'rich' | 'source';
/** Authoritative byte identity returned by the existing write door. */
export type NoteWriteAck =
  | { kind: 'file'; contentHash: string; recovery?: RecoveryOutcome }
  | { kind: 'governed'; projectionHash: string };
export type DocumentWriteResult = NoteWriteAck | EditorSaveResult;
export type DocumentWriter = (
  body: string,
  bodyFormat?: BodyFormat,
  recoveryBypass?: string,
  expectHash?: string,
  destination?: DocumentKey,
  editorRequest?: EditorSaveRequest,
) => Promise<DocumentWriteResult>;
export interface SelectedSaveState {
  status: 'pending' | 'unknown' | 'reconcile';
  generation: number;
  requestKey: string;
  reason?: 'refused';
}
export type SaveOutcome =
  | { kind: 'clean'; ownerId: string; generation: number }
  | {
      kind: 'acknowledged';
      ownerId: string;
      generation: number;
      write:
        | NoteWriteAck
        | Extract<EditorSaveResult, { kind: 'selected_applied' | 'selected_unchanged' }>;
    }
  /** A field's existing guarded mutation returned success. This confirms
   * that mutation, without inventing a document byte hash it did not return. */
  | { kind: 'committed'; ownerId: string; generation: number; source: 'guarded_field' }
  | {
      kind: 'pending';
      ownerId: string;
      generation: number;
      status: 'pending' | 'unknown';
      code: string;
    }
  | { kind: 'failed'; ownerId: string; generation: number; code: string }
  | {
      kind: 'blocked';
      ownerId: string;
      generation: number;
      reason: 'reconcile' | 'choice' | 'deadline';
    };
export type FlushReport = { outcomes: SaveOutcome[]; unresolvedOwnerIds: string[] };
export interface OwnerSnapshot {
  selectedSave?: SelectedSaveState;
  latestDraft: string;
  recoveryAck?: { generation: number; outcome: RecoveryOutcome | EditorRecoveryView };
  bodyFormat?: BodyFormat;
  generation: number;
  acknowledgedGeneration: number;
  inFlightGeneration: number | null;
  failure: Extract<SaveOutcome, { kind: 'failed' }> | null;
  mergeBase?: { raw: string; canon: string } | null;
  reconcileRequired?: boolean;
  /** Exact unresolved child payloads, owned by the document across reparses. */
  childDrafts?: Readonly<Record<string, string>>;
}
export interface DocumentKey {
  vaultId: string;
  path: string;
  ownerId: string;
}

interface SelectedAttempt {
  generation: number;
  body: string;
  bodyFormat: BodyFormat;
  destination: DocumentKey;
  request: EditorSaveRequest;
  status: 'dispatch' | SelectedSaveState['status'];
  /** An explicit clean save carries raw bytes without dirtying rich presentation. */
  presentationCanon?: string;
}
interface SelectedTextIntent {
  generation: number;
  body: string;
  bodyFormat: BodyFormat;
  canon: string;
}
function sameSelectedTarget(left?: SelectedEditorTarget, right?: SelectedEditorTarget): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined &&
        left.workspaceId === right.workspaceId &&
        left.recordId === right.recordId;
}
/** Only a definite pre-publication native refusal belongs in the failed lane.
 * Resolve errors cannot make that claim about the earlier original dispatch. */
function selectedRefusal(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'kind' in error &&
    error.kind === 'selected_refused' &&
    'error' in error &&
    typeof error.error === 'object' &&
    error.error !== null &&
    'message' in error.error &&
    typeof error.error.message === 'string'
  )
    return error.error.message;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  return message?.startsWith('recovery_required:') || message === 'recovery_bypass_invalid'
    ? message
    : null;
}
function sameOriginal(left: EditorOperation, right: EditorOperation): boolean {
  return (
    left.operationId === right.operationId &&
    left.path === right.path &&
    left.requestKey === right.requestKey &&
    sameSelectedTarget(left.target, right.target) &&
    Object.keys({ ...left.version, ...right.version }).every(
      (key) =>
        left.version[key as keyof typeof left.version] ===
        right.version[key as keyof typeof right.version],
    ) &&
    Object.keys({ ...left.receipt, ...right.receipt }).every(
      (key) =>
        (left.receipt[key as keyof typeof left.receipt] ?? null) ===
        (right.receipt[key as keyof typeof right.receipt] ?? null),
    )
  );
}
function matchingOperation(operation: EditorOperation, attempt: SelectedAttempt): boolean {
  const target = attempt.request.target;
  const hash = sha256Hex(attempt.body);
  return (
    sameSelectedTarget(operation.target, target) &&
    operation.path === attempt.destination.path &&
    operation.requestKey === attempt.request.requestKey &&
    sameSelectedTarget(operation.version, target) &&
    operation.version.bodyHash === hash &&
    operation.receipt.workspaceId === target.workspaceId &&
    operation.receipt.recordId === target.recordId &&
    operation.receipt.bodyAfterHash === hash &&
    operation.receipt.revision === operation.version.metadataRevision &&
    operation.receipt.metadataAfterHash === operation.version.metadataHash &&
    (attempt.request.original == null || sameOriginal(attempt.request.original, operation))
  );
}

/** A retained payload, independent of the presentation's lifetime. A failed
 * attempt stops draining: only an explicit flush/retry starts another attempt. */
export class DocumentOwner {
  private state: OwnerSnapshot;
  private selectedAttempt: SelectedAttempt | null = null;
  private selectedExpectedVersion: SelectedRecordVersion | undefined;
  private selectedRetry: SelectedAttempt | null = null;
  private selectedTextIntent: SelectedTextIntent | null = null;
  private running: Promise<SaveOutcome> | null = null;
  private retired = false;
  private recoveryHeld = false;
  private renameHeld = false;
  private recoveryReload = false;
  private preparations = new Set<Promise<void>>();
  private expectedHash: string | undefined;
  private listeners = new Set<() => void>();
  private failedAttempt: { body: string; format: BodyFormat; generation: number } | null = null;
  private recoveryBypass: { nonce: string; generation: number } | null = null;
  private writeGate: () => 'reconcile' | 'choice' | null = () => null;
  /** M93.1 (BL-03): rich typing is an O(1) generation bump. The presentation
   * that typed binds its materializer, which serializes the page only when a
   * reader needs exact text: `snapshot()`, an edit, a flush, a retry, a leave's
   * preparation, a debounce or the presentation's unmount. */
  private materializer: (() => string) | null = null;
  /** The generation before an edit no reader has materialized yet. */
  private touchedFrom: number | null = null;
  /** Up only while a dirty transition publishes: its listeners read the bump
   * without serializing, so a burst of typing costs one pass per save. */
  private quiet = false;
  private cleanQueued = false;
  constructor(
    readonly key: DocumentKey,
    initial: string,
    private write: DocumentWriter,
    readonly selectedTarget?: SelectedEditorTarget,
  ) {
    this.selectedTarget =
      selectedTarget === undefined ? undefined : Object.freeze({ ...selectedTarget });
    this.state = {
      latestDraft: initial,
      bodyFormat: 'rich',
      generation: 0,
      acknowledgedGeneration: 0,
      inFlightGeneration: null,
      failure: null,
      mergeBase: { raw: initial, canon: initial },
      reconcileRequired: false,
      childDrafts: {},
    };
  }
  /** Reattach presentation callbacks without replacing retained generations. */
  setWriter(write: DocumentWriter, selectedTarget?: SelectedEditorTarget): void {
    if (this.retired) return;
    if (!sameSelectedTarget(this.selectedTarget, selectedTarget)) {
      this.holdForReconcile();
      return;
    }
    this.write = write;
    this.renameHeld = false;
  }
  /** A move holds the drain without consuming or acknowledging later edits. */
  holdRename(): void {
    if (this.retired || this.renameHeld) return;
    this.renameHeld = true;
    this.publish();
  }
  releaseRename(): void {
    this.renameHeld = false;
    this.publish();
  }
  renamePending(): boolean {
    return this.renameHeld;
  }
  setWriteGate(gate: () => 'reconcile' | 'choice' | null): void {
    if (this.retired) return;
    this.writeGate = gate;
  }
  setChildDrafts(namespace: string, payload: string | null): void {
    if (this.retired) return;
    const children = { ...this.state.childDrafts };
    if ((children[namespace] ?? null) === payload) return;
    if (payload === null) delete children[namespace];
    else children[namespace] = payload;
    this.state.childDrafts = children;
    this.publish();
  }
  private blockedReason(): 'reconcile' | 'choice' | null {
    return (
      (this.renameHeld ? 'reconcile' : null) ??
      (this.recoveryHeld ? 'choice' : null) ??
      this.writeGate() ??
      (Object.keys(this.state.childDrafts ?? {}).length ? 'choice' : null) ??
      (this.state.reconcileRequired ? 'reconcile' : null)
    );
  }
  setMergeBase(base: { raw: string; canon: string }): void {
    if (this.retired) return;
    this.state.mergeBase = { ...base };
  }
  holdForReconcile(): void {
    if (this.retired) return;
    this.state.reconcileRequired = true;
    this.publish();
  }
  finishReconcile(): void {
    if (this.retired || this.selectedAttempt !== null) return;
    this.recoveryReload = false;
    this.state.reconcileRequired = false;
    this.publish();
  }
  /** Call only after holding the drain, then read disk again. Waiting for
   * the active attempt establishes which writes precede that fresh read. */
  async settleWrite(): Promise<void> {
    while (this.preparations.size || this.running)
      await Promise.all([...this.preparations, this.running]);
  }
  snapshot(): OwnerSnapshot {
    if (!this.quiet) this.materialize();
    return {
      ...this.state,
      ...(this.state.selectedSave === undefined
        ? {}
        : { selectedSave: { ...this.state.selectedSave } }),
      reconcileRequired: this.renameHeld || this.recoveryHeld || this.state.reconcileRequired,
      childDrafts: { ...this.state.childDrafts },
    };
  }
  recoveryBusy(): boolean {
    return (
      this.selectedAttempt !== null ||
      this.preparations.size > 0 ||
      this.running !== null ||
      this.state.inFlightGeneration !== null
    );
  }
  beginPreparation(): () => void {
    if (this.retired) return () => {};
    let done!: () => void;
    const pending = new Promise<void>((resolve) => {
      done = resolve;
    });
    this.preparations.add(pending);
    this.publish();
    let complete = false;
    return () => {
      if (complete) return;
      complete = true;
      this.preparations.delete(pending);
      done();
      this.publish();
    };
  }
  requiresRecovery(): boolean {
    return this.recoveryHeld;
  }
  recoveryResumePending(): boolean {
    return this.recoveryReload;
  }
  /** Optional dependent-transform CAS evidence; never a permission. */
  expectSelectedVersion(version: SelectedRecordVersion): boolean {
    this.materialize();
    if (
      this.retired ||
      this.selectedTarget === undefined ||
      !sameSelectedTarget(version, this.selectedTarget) ||
      version.kind !== 'sqlite_metadata' ||
      this.recoveryBusy() ||
      this.state.generation !== this.state.acknowledgedGeneration ||
      this.state.failure !== null
    )
      return false;
    this.selectedExpectedVersion = Object.freeze({ ...version });
    return true;
  }
  expectTargetHash(hash: string): void {
    if (!this.retired) this.expectedHash = hash;
  }
  recoveryRetired(): boolean {
    return this.retired;
  }
  holdRecovery(): void {
    if (this.retired || this.recoveryHeld) return;
    this.recoveryReload = false;
    this.recoveryHeld = true;
    this.publish();
  }
  resumeRecovery(reconcile: boolean): void {
    if (this.retired) return;
    this.recoveryHeld = false;
    this.recoveryReload = reconcile;
    if (reconcile) this.state.reconcileRequired = true;
    this.publish();
  }
  retireRecovery(): boolean {
    if (this.recoveryBusy()) return false;
    this.retired = true;
    // An explicit discard: the unmaterialized edit goes with the draft.
    this.touchedFrom = null;
    this.materializer = null;
    this.selectedTextIntent = null;
    this.recoveryReload = false;
    this.expectedHash = undefined;
    this.recoveryHeld = false;
    this.failedAttempt = null;
    this.selectedRetry = null;
    this.selectedExpectedVersion = undefined;
    this.recoveryBypass = null;
    const generation = this.state.generation + 1;
    this.state = {
      ...this.state,
      latestDraft: '',
      generation,
      acknowledgedGeneration: generation,
      inFlightGeneration: null,
      failure: null,
      childDrafts: {},
      mergeBase: null,
      reconcileRequired: false,
      recoveryAck: undefined,
    };
    this.publish();
    return true;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish() {
    for (const listener of this.listeners) listener();
  }
  /** Rich typing, per keystroke and O(1). Subscribers hear only the change from
   * clean to dirty; later keystrokes in the same window publish nothing. */
  touch(materialize: () => string): void {
    if (this.retired) return;
    if (this.materializer !== materialize) {
      // Another presentation's unread edit is settled before this one binds.
      this.materialize();
      this.materializer = materialize;
    }
    if (this.touchedFrom !== null) return;
    const wasClean = this.state.generation === this.state.acknowledgedGeneration;
    this.touchedFrom = this.state.generation;
    this.state.generation += 1;
    if (!wasClean) return;
    this.quiet = true;
    try {
      this.publish();
    } finally {
      this.quiet = false;
    }
  }
  /** Materialize now: a debounce that found nothing new to save, or a leave's
   * synchronous preparation. */
  settleDraft(): void {
    this.materialize();
  }
  /** The presentation is going: its last edit becomes exact text first. */
  releaseMaterializer(materialize: () => string): void {
    if (this.materializer !== materialize) return;
    this.materialize();
    this.materializer = null;
  }
  /** The pending edit as text, exactly as `edit(markdown, 'rich')` would have
   * recorded it. One that changed nothing withdraws its bump, so a page that
   * was clean reports clean again without a write. */
  private materialize(): void {
    const from = this.touchedFrom;
    const read = this.materializer;
    if (from === null || read === null) return;
    this.touchedFrom = null;
    let markdown: string | null = null;
    try {
      markdown = read();
    } catch (error) {
      // As a serializer that threw per keystroke did: nothing is recorded, and
      // the fault reaches the diagnostic log rather than this reader.
      queueMicrotask(() => {
        throw error;
      });
    }
    if (
      markdown !== null &&
      (markdown !== this.state.latestDraft || this.state.bodyFormat !== 'rich')
    ) {
      this.selectedTextIntent = null;
      this.recoveryBypass = null;
      this.selectedRetry = null;
      this.state.bodyFormat = 'rich';
      this.state.latestDraft = markdown;
      return;
    }
    this.state.generation = from;
    // Never synchronously: a reader may be rendering. Listeners then read
    // the clean state the withdrawn bump left.
    if (from === this.state.acknowledgedGeneration && !this.cleanQueued) {
      this.cleanQueued = true;
      queueMicrotask(() => {
        this.cleanQueued = false;
        this.publish();
      });
    }
  }
  /** The drain's loop condition, over exact text. */
  private unsaved(): boolean {
    this.materialize();
    return this.state.generation > this.state.acknowledgedGeneration;
  }
  private currentSelectedText(): SelectedTextIntent | null {
    return this.selectedTextIntent?.generation === this.state.generation
      ? this.selectedTextIntent
      : null;
  }
  /** A read cannot settle this generation's explicit canonical-adoption intent.
   * Once acknowledged, later observations follow ordinary merge behavior. */
  hasSelectedTextIntent(): boolean {
    this.materialize();
    return (
      this.currentSelectedText() !== null &&
      this.state.generation > this.state.acknowledgedGeneration
    );
  }
  /** A person's explicit save of a proven clean selected presentation. It
   * books a generation, while the existing drain alone freezes and writes it. */
  saveSelectedText(raw: string, generation: number): Promise<SaveOutcome> {
    this.materialize();
    const base = this.state.mergeBase;
    const reason = this.blockedReason();
    if (
      this.selectedTarget === undefined ||
      this.retired ||
      this.recoveryBusy() ||
      reason !== null ||
      this.state.failure !== null ||
      this.state.generation !== generation ||
      this.state.acknowledgedGeneration !== generation ||
      !base ||
      base.raw !== raw ||
      this.state.latestDraft !== (this.state.bodyFormat === 'source' ? raw : base.canon)
    )
      return Promise.resolve({
        kind: 'blocked',
        ownerId: this.key.ownerId,
        generation: this.state.generation,
        reason: reason ?? 'reconcile',
      });
    this.selectedTextIntent = {
      generation: generation + 1,
      body: raw,
      bodyFormat: this.state.bodyFormat ?? 'rich',
      canon: this.state.bodyFormat === 'source' ? raw : base.canon,
    };
    this.selectedRetry = null;
    this.failedAttempt = null;
    this.recoveryBypass = null;
    this.state.generation = generation + 1;
    this.publish();
    return this.flush();
  }
  edit(markdown: string, bodyFormat = this.state.bodyFormat ?? 'rich'): number {
    if (this.retired) return this.state.generation;
    this.materialize();
    if (markdown !== this.state.latestDraft || bodyFormat !== this.state.bodyFormat) {
      this.selectedTextIntent = null;
      this.recoveryBypass = null;
      this.selectedRetry = null;
      this.state.bodyFormat = bodyFormat;
      this.state.latestDraft = markdown;
      this.state.generation += 1;
      this.publish();
    }
    return this.state.generation;
  }
  /** A view change is not an edit. Callers validate representation and, for
   * a clean raw view, provide the exact authoritative body read. */
  present(markdown: string, bodyFormat: BodyFormat): void {
    if (this.retired) return;
    this.materialize();
    if (markdown !== this.state.latestDraft || bodyFormat !== this.state.bodyFormat) {
      const intent = this.currentSelectedText();
      if (intent === null) {
        this.failedAttempt = null;
        this.selectedRetry = null;
        this.recoveryBypass = null;
      } else {
        // Only the view changed. The raw payload, original format/key and
        // failed-copy authorization still belong to this exact generation.
        intent.canon = markdown;
        for (const attempt of [this.selectedAttempt, this.selectedRetry])
          if (attempt?.generation === intent.generation && attempt.body === intent.body)
            attempt.presentationCanon = markdown;
        if (this.state.mergeBase?.raw === intent.body)
          this.setMergeBase({ raw: intent.body, canon: markdown });
      }
    }
    this.state.latestDraft = markdown;
    this.state.bodyFormat = bodyFormat;
    this.publish();
  }
  /** An external read made before an active write settles is not ordered
   * after that write. Keep the draft unresolved until the caller rereads. */
  acceptExternal(markdown: string, base = { raw: markdown, canon: markdown }): boolean {
    if (this.retired) return false;
    this.materialize();
    if (this.selectedAttempt !== null || this.state.inFlightGeneration !== null) {
      this.holdForReconcile();
      return false;
    }
    this.edit(markdown);
    this.state.acknowledgedGeneration = this.state.generation;
    this.state.failure = null;
    this.setMergeBase(base);
    this.publish();
    return true;
  }
  /** A fresh native observation plus the person's existing whole-page choice
   * settles only terminal OutcomeUnknown. It cannot cancel a durable pending
   * intent or a transport-unknown attempt. The next writer revalidates natively. */
  settleSelectedReconcile(choice: {
    requestKey: string;
    generation: number;
    snapshot: SelectedEditorSnapshot;
    choice: 'mine' | 'theirs';
  }): boolean {
    this.materialize();
    const attempt = this.selectedAttempt;
    const observed = choice.snapshot;
    if (
      this.retired ||
      this.running !== null ||
      this.preparations.size > 0 ||
      this.renameHeld ||
      this.recoveryHeld ||
      Object.keys(this.state.childDrafts ?? {}).length > 0 ||
      attempt?.status !== 'reconcile' ||
      this.state.inFlightGeneration !== null ||
      attempt.request.requestKey !== choice.requestKey ||
      this.state.generation !== choice.generation ||
      attempt.destination.vaultId !== this.key.vaultId ||
      attempt.destination.path !== this.key.path ||
      observed.path !== this.key.path ||
      !sameSelectedTarget(observed.target, this.selectedTarget) ||
      !sameSelectedTarget(observed.version, this.selectedTarget) ||
      observed.observedBodyHash !== sha256Hex(observed.body) ||
      (observed.coherence === 'paired' &&
        observed.version.bodyHash !== observed.observedBodyHash) ||
      (choice.choice === 'mine' &&
        (!observed.editable ||
          (this.selectedExpectedVersion !== undefined && observed.coherence !== 'paired')))
    )
      return false;
    if (this.selectedExpectedVersion !== undefined)
      this.selectedExpectedVersion = Object.freeze({ ...observed.version });
    this.selectedAttempt = null;
    this.selectedRetry = null;
    this.state.selectedSave = undefined;
    this.state.failure = null;
    this.failedAttempt = null;
    this.recoveryBypass = null;
    this.state.recoveryAck = undefined;
    this.recoveryReload = false;
    this.state.reconcileRequired = false;
    if (choice.choice === 'theirs') {
      this.selectedTextIntent = null;
      this.edit(observed.body, this.state.bodyFormat);
      this.state.acknowledgedGeneration = this.state.generation;
    }
    this.setMergeBase({ raw: observed.body, canon: observed.body });
    this.publish();
    return true;
  }
  /** Explicit comparison of a definitely refused dependent transform. */
  compareSelectedRefusal(): boolean {
    this.materialize();
    const retry = this.selectedRetry;
    if (
      this.retired ||
      this.selectedExpectedVersion === undefined ||
      this.selectedAttempt !== null ||
      retry === null ||
      this.recoveryBusy() ||
      this.renameHeld ||
      this.recoveryHeld ||
      Object.keys(this.state.childDrafts ?? {}).length > 0 ||
      this.state.failure === null ||
      this.state.failure.generation !== retry.generation ||
      this.state.generation !== retry.generation ||
      this.state.latestDraft !== retry.body ||
      this.state.bodyFormat !== retry.bodyFormat ||
      retry.destination.path !== this.key.path ||
      retry.destination.vaultId !== this.key.vaultId ||
      retry.request.phase !== 'start' ||
      retry.request.original != null ||
      !sameSelectedTarget(retry.request.target, this.selectedTarget)
    )
      return false;
    // This is a local comparison of a definitely refused authored draft. The
    // frozen native payload/expectation is unchanged and no request is sent.
    retry.status = 'reconcile';
    this.selectedAttempt = retry;
    this.selectedRetry = null;
    this.state.failure = null;
    this.state.reconcileRequired = true;
    this.state.selectedSave = {
      status: 'reconcile',
      generation: retry.generation,
      requestKey: retry.request.requestKey,
      reason: 'refused',
    };
    this.publish();
    return true;
  }
  retry(): Promise<SaveOutcome> {
    this.recoveryBypass = null;
    return this.flush();
  }
  /** A human's choice authorizes only the exact failed attempt, once. */
  saveWithoutRecoveryCopy(nonce: string, generation: number): Promise<SaveOutcome> {
    this.materialize();
    const attempt = this.failedAttempt;
    if (
      this.running !== null ||
      this.selectedAttempt !== null ||
      !attempt ||
      generation !== this.state.generation ||
      attempt.generation !== generation ||
      attempt.body !== (this.currentSelectedText()?.body ?? this.state.latestDraft) ||
      attempt.format !== (this.currentSelectedText()?.bodyFormat ?? this.state.bodyFormat) ||
      this.state.failure?.code !== `recovery_required:${nonce}` ||
      this.blockedReason() !== null
    )
      return Promise.resolve({
        kind: 'blocked',
        ownerId: this.key.ownerId,
        generation: this.state.generation,
        reason: 'choice',
      });
    this.recoveryBypass = { nonce, generation };
    return this.flush();
  }
  flush(): Promise<SaveOutcome> {
    if (this.retired)
      return Promise.resolve({
        kind: 'clean',
        ownerId: this.key.ownerId,
        generation: this.state.generation,
      });
    if (this.running !== null) return this.running;
    const run = this.drain();
    this.running = run;
    void run.finally(() => {
      if (this.running === run) {
        this.running = null;
        this.publish();
      }
    });
    return run;
  }
  private holdSelected(
    attempt: SelectedAttempt,
    status: 'pending' | 'unknown',
    code: string,
  ): SaveOutcome {
    attempt.status = status;
    attempt.request.phase = 'resolve';
    this.selectedAttempt = attempt;
    this.selectedRetry = null;
    this.failedAttempt = null;
    this.state.failure = null;
    this.state.selectedSave = {
      status,
      generation: attempt.generation,
      requestKey: attempt.request.requestKey,
    };
    return {
      kind: 'pending',
      ownerId: this.key.ownerId,
      generation: attempt.generation,
      status,
      code,
    };
  }
  private refuseSelected(attempt: SelectedAttempt, code: string): SaveOutcome {
    this.selectedAttempt = null;
    this.selectedRetry = attempt;
    this.state.selectedSave = undefined;
    this.failedAttempt = {
      body: attempt.body,
      format: attempt.bodyFormat,
      generation: attempt.generation,
    };
    const result: Extract<SaveOutcome, { kind: 'failed' }> = {
      kind: 'failed',
      ownerId: this.key.ownerId,
      generation: attempt.generation,
      code,
    };
    this.state.failure = result;
    return result;
  }
  /** The selected protocol uses this same owner and callback. Its frozen attempt
   * survives a lost response; only a definite native ack can advance generation. */
  private async drainSelected(target: SelectedEditorTarget): Promise<SaveOutcome> {
    let result: SaveOutcome = {
      kind: 'clean',
      ownerId: this.key.ownerId,
      generation: this.state.generation,
    };
    while (this.selectedAttempt !== null || this.unsaved()) {
      if (this.selectedAttempt?.status === 'reconcile')
        return {
          kind: 'blocked',
          ownerId: this.key.ownerId,
          generation: this.state.generation,
          reason: 'reconcile',
        };
      if (this.selectedAttempt === null) {
        const reason = this.blockedReason();
        if (reason !== null)
          return {
            kind: 'blocked',
            ownerId: this.key.ownerId,
            generation: this.state.generation,
            reason,
          };
      }
      let attempt = this.selectedAttempt;
      if (attempt === null) {
        const previous = this.selectedRetry;
        const intent = this.currentSelectedText();
        const body = intent?.body ?? this.state.latestDraft;
        const bodyFormat = intent?.bodyFormat ?? this.state.bodyFormat ?? 'rich';
        const generation = this.state.generation;
        if (
          previous !== null &&
          previous.generation === generation &&
          previous.body === body &&
          previous.bodyFormat === bodyFormat &&
          previous.destination.path === this.key.path &&
          previous.destination.vaultId === this.key.vaultId
        ) {
          attempt = previous;
        } else {
          // Allocation happens before invoking the existing IPC callback. A local
          // allocation failure is a definite non-dispatch, never an unknown save.
          let requestKey: string;
          try {
            requestKey = crypto.randomUUID();
          } catch {
            const failure: Extract<SaveOutcome, { kind: 'failed' }> = {
              kind: 'failed',
              ownerId: this.key.ownerId,
              generation,
              code: 'editor_request_identity_unavailable',
            };
            this.state.failure = failure;
            this.publish();
            return failure;
          }
          attempt = {
            generation,
            body,
            bodyFormat,
            destination: { ...this.key },
            status: 'dispatch',
            ...(intent === null ? {} : { presentationCanon: intent.canon }),
            request: {
              target: { ...target },
              requestKey,
              phase: 'start',
              original: null,
              ...(this.selectedExpectedVersion === undefined
                ? {}
                : { expectedVersion: { ...this.selectedExpectedVersion } }),
            },
          };
        }
        this.selectedAttempt = attempt;
        this.selectedRetry = null;
      }
      const resolving = attempt.request.phase === 'resolve';
      this.state.inFlightGeneration = attempt.generation;
      this.publish();
      try {
        const bypass =
          !resolving && this.recoveryBypass?.generation === attempt.generation
            ? this.recoveryBypass.nonce
            : undefined;
        this.recoveryBypass = null;
        const write = await this.write(
          attempt.body,
          attempt.bodyFormat,
          bypass,
          undefined,
          { ...attempt.destination },
          structuredClone(attempt.request),
        );
        if (write.kind === 'selected_pending') {
          if (!matchingOperation(write.operation, attempt))
            return this.holdSelected(attempt, 'unknown', 'selected_reply_identity_changed');
          attempt.request.original = structuredClone(write.operation);
          return this.holdSelected(attempt, 'pending', write.error.message);
        }
        if (write.kind === 'selected_outcome_unknown') {
          // A later explicit existing page choice must own reconciliation. The
          // general rich merge/finishReconcile path cannot silently reapply A.
          attempt.status = 'reconcile';
          attempt.request.phase = 'resolve';
          this.state.failure = null;
          this.state.selectedSave = {
            status: 'reconcile',
            generation: attempt.generation,
            requestKey: attempt.request.requestKey,
          };
          this.state.reconcileRequired = true;
          return {
            kind: 'blocked',
            ownerId: this.key.ownerId,
            generation: this.state.generation,
            reason: 'reconcile',
          };
        }
        if (write.kind !== 'selected_applied' && write.kind !== 'selected_unchanged')
          return this.holdSelected(attempt, 'unknown', 'selected_reply_identity_changed');
        const current = write.kind === 'selected_applied' ? write.currentVersion : write.version;
        if (
          !sameSelectedTarget(current, target) ||
          (write.kind === 'selected_unchanged' && current.bodyHash !== sha256Hex(attempt.body)) ||
          (write.kind === 'selected_applied' &&
            (!matchingOperation(write.operation, attempt) ||
              (!write.reconcileRequired &&
                Object.keys(write.operation.version).some(
                  (key) =>
                    current[key as keyof typeof current] !==
                    write.operation.version[key as keyof typeof current],
                ))))
        )
          return this.holdSelected(attempt, 'unknown', 'selected_reply_identity_changed');
        this.state.acknowledgedGeneration = attempt.generation;
        this.setMergeBase({
          raw: attempt.body,
          canon:
            this.state.bodyFormat === 'source'
              ? attempt.body
              : (attempt.presentationCanon ?? attempt.body),
        });
        if (this.selectedTextIntent?.generation === attempt.generation)
          this.selectedTextIntent = null;
        this.state.recoveryAck =
          write.kind === 'selected_applied' && write.recovery != null
            ? { generation: attempt.generation, outcome: write.recovery }
            : undefined;
        this.state.failure = null;
        this.failedAttempt = null;
        this.selectedAttempt = null;
        this.selectedRetry = null;
        this.state.selectedSave = undefined;
        if (write.kind === 'selected_applied' && write.reconcileRequired)
          this.state.reconcileRequired = true;
        result = {
          kind: 'acknowledged',
          ownerId: this.key.ownerId,
          generation: attempt.generation,
          write,
        };
      } catch (error) {
        const refusal = resolving ? null : selectedRefusal(error);
        if (refusal !== null) return this.refuseSelected(attempt, refusal);
        return this.holdSelected(
          attempt,
          'unknown',
          error instanceof Error ? error.message : 'selected_save_outcome_unknown',
        );
      } finally {
        this.state.inFlightGeneration = null;
        this.publish();
      }
    }
    const reason = this.blockedReason();
    return reason === null
      ? result
      : { kind: 'blocked', ownerId: this.key.ownerId, generation: this.state.generation, reason };
  }
  private async drain(): Promise<SaveOutcome> {
    if (this.selectedTarget !== undefined) return this.drainSelected(this.selectedTarget);
    let result: SaveOutcome = {
      kind: 'clean',
      ownerId: this.key.ownerId,
      generation: this.state.generation,
    };
    while (this.unsaved()) {
      const reason = this.blockedReason();
      if (reason !== null)
        return {
          kind: 'blocked',
          ownerId: this.key.ownerId,
          generation: this.state.generation,
          reason,
        };
      const generation = this.state.generation;
      const body = this.state.latestDraft;
      const bodyFormat = this.state.bodyFormat ?? 'rich';
      this.state.inFlightGeneration = generation;
      this.publish();
      try {
        const bypass =
          this.recoveryBypass?.generation === generation ? this.recoveryBypass.nonce : undefined;
        this.recoveryBypass = null;
        const write = await this.write(body, bodyFormat, bypass, this.expectedHash, {
          ...this.key,
        });
        if (write.kind !== 'file' && write.kind !== 'governed')
          throw new Error('selected_editor_unavailable');
        if (this.expectedHash !== undefined && write.kind === 'file')
          this.expectedHash = write.contentHash;
        this.failedAttempt = null;
        this.state.recoveryAck =
          write.kind === 'file' && write.recovery
            ? { generation, outcome: write.recovery }
            : undefined;
        this.state.acknowledgedGeneration = generation;
        this.setMergeBase({ raw: body, canon: body });
        if (this.state.failure === null || this.state.failure.generation <= generation)
          this.state.failure = null;
        result = { kind: 'acknowledged', ownerId: this.key.ownerId, generation, write };
      } catch (error) {
        if (this.expectedHash !== undefined) this.recoveryHeld = true;
        this.failedAttempt = { body, format: bodyFormat, generation };
        result = {
          kind: 'failed',
          ownerId: this.key.ownerId,
          generation,
          code: error instanceof Error ? error.message : String(error),
        };
        this.state.failure = result;
        this.state.inFlightGeneration = null;
        this.publish();
        return result;
      }
      this.state.inFlightGeneration = null;
      this.publish();
    }
    const reason = this.blockedReason();
    return reason === null
      ? result
      : { kind: 'blocked', ownerId: this.key.ownerId, generation: this.state.generation, reason };
  }
}
