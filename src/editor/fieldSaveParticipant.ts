import type { DocumentKey, OwnerSnapshot, SaveOutcome } from './documentOwner';
import type { SaveParticipant } from './saveParticipants';
import { retainedSaveParticipant } from './openPages';
import type { RecoveryAdapter } from './deletedDraftRecovery';

export type FieldValidation = { ok: true; value: unknown } | { ok: false; error: string };
export type FieldWriteResult = boolean | 'unchanged';
export type FieldWriter = (value: unknown) => Promise<FieldWriteResult>;
export type FieldValidator = (text: string) => FieldValidation;
/** Retains focused text; the existing guarded field mutation remains the only writer. */
export class FieldSaveParticipant implements SaveParticipant {
  readonly phase = 'field' as const;
  private state: OwnerSnapshot;
  private running: Promise<SaveOutcome> | null = null;
  private retired = false;
  private recoveryHeld = false;
  private renameHeld = false;
  private renamed = false;
  private listeners = new Set<() => void>();
  private saved: string;
  private error: string | null = null;
  constructor(
    readonly key: DocumentKey,
    initial: string,
    private validate: FieldValidator,
    private write: FieldWriter,
  ) {
    // The caller's attachment identity must not change when our registry key
    // moves: its writer still closes over the path that created that view.
    this.key = { ...key };
    this.saved = initial;
    this.state = {
      latestDraft: initial,
      generation: 0,
      acknowledgedGeneration: 0,
      inFlightGeneration: null,
      failure: null,
    };
  }
  configure(validate: FieldValidator, write: FieldWriter, attachedPath = this.key.path): void {
    if (attachedPath !== this.key.path) return;
    if (this.retired) return;
    this.validate = validate;
    this.write = write;
    if (this.renamed && this.renameHeld) {
      this.renameHeld = false;
      this.change({ reconcileRequired: this.recoveryHeld });
    }
  }
  readonly rename = {
    hold: () => {
      this.renamed = false;
      this.renameHeld = true;
      this.change({ reconcileRequired: true });
    },
    landed: (_path: string) => {
      this.renamed = true;
    },
    release: () => {
      if (!this.renamed) {
        this.renameHeld = false;
        this.change({ reconcileRequired: this.recoveryHeld });
      }
    },
  };
  snapshot = (): OwnerSnapshot => this.state;
  message = (): string | null => this.error;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private change(patch: Partial<OwnerSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  prepare = (): void => undefined; // edit() captures every input event synchronously.
  edit(text: string): void {
    if (this.retired) return;
    if (text === this.state.latestDraft) return;
    this.error = null;
    this.change({ latestDraft: text, generation: this.state.generation + 1, failure: null });
  }
  discard(): boolean {
    if (this.retired) return false;
    if (this.running !== null) return false;
    this.error = null;
    const generation = this.state.generation + 1;
    this.change({
      latestDraft: this.saved,
      generation,
      acknowledgedGeneration: generation,
      failure: null,
    });
    return true;
  }
  get recovery(): RecoveryAdapter {
    return {
      key: this.key,
      identity: this,
      snapshot: this.snapshot,
      subscribe: this.subscribe,
      busy: () => this.running !== null || this.state.inFlightGeneration !== null,
      requiresRecovery: () => this.recoveryHeld,
      hold: () => {
        if (!this.retired && !this.recoveryHeld) {
          this.recoveryHeld = true;
          this.change({ reconcileRequired: true });
        }
      },
      resume: () => {
        if (!this.retired) {
          this.recoveryHeld = false;
          this.change({ reconcileRequired: false });
        }
      },
      payload: () => ({
        kind: 'field',
        body: null,
        field: { name: this.key.ownerId.replace(/^field:/, ''), text: this.state.latestDraft },
        children: {},
        metadata: { kind: 'unavailable' },
      }),
      retire: () => {
        if (this.running !== null || this.state.inFlightGeneration !== null) return false;
        this.retired = true;
        this.recoveryHeld = false;
        this.error = null;
        const generation = this.state.generation + 1;
        this.change({
          latestDraft: '',
          generation,
          acknowledgedGeneration: generation,
          inFlightGeneration: null,
          failure: null,
          reconcileRequired: false,
        });
        return true;
      },
    };
  }
  flush = (): Promise<SaveOutcome> => {
    if (this.retired)
      return Promise.resolve({
        kind: 'clean',
        ownerId: this.key.ownerId,
        generation: this.state.generation,
      });
    if ((this.recoveryHeld || this.renameHeld) && this.running === null)
      return Promise.resolve({
        kind: 'blocked',
        ownerId: this.key.ownerId,
        generation: this.state.generation,
        reason: 'choice',
      });
    if (this.running !== null) return this.running;
    let complete!: (result: SaveOutcome) => void;
    const run = new Promise<SaveOutcome>((resolve) => {
      complete = resolve;
    });
    this.running = run;
    void this.drain().then(complete, () =>
      complete(
        this.fail(
          this.state.generation,
          'field_failed',
          'Could not save. Your draft is kept. Retry saving or press Enter to retry.',
        ),
      ),
    );
    void run.then(() => {
      if (this.running === run) {
        this.running = null;
        this.change({});
      }
    });
    return run;
  };
  private fail(generation: number, code: string, message: string): SaveOutcome {
    const failure = { kind: 'failed' as const, ownerId: this.key.ownerId, generation, code };
    this.error = message;
    this.change({ inFlightGeneration: null, failure });
    return failure;
  }
  private async drain(): Promise<SaveOutcome> {
    let result: SaveOutcome = {
      kind: 'clean',
      ownerId: this.key.ownerId,
      generation: this.state.generation,
    };
    while (this.state.generation > this.state.acknowledgedGeneration) {
      if (this.recoveryHeld || this.renameHeld)
        return {
          kind: 'blocked',
          ownerId: this.key.ownerId,
          generation: this.state.generation,
          reason: 'choice',
        };
      const generation = this.state.generation,
        text = this.state.latestDraft;
      const value = this.validate(text);
      if (!value.ok) return this.fail(generation, 'invalid_field', value.error);
      this.change({ inFlightGeneration: generation });
      let written: FieldWriteResult;
      try {
        written = await this.write(value.value);
        if (written !== true && written !== 'unchanged')
          return this.fail(
            generation,
            'field_refused',
            'Could not save. Your draft is kept. Retry saving or press Enter to retry.',
          );
      } catch {
        return this.fail(
          generation,
          'field_failed',
          'Could not save. Your draft is kept. Retry saving or press Enter to retry.',
        );
      }
      this.saved = text;
      this.error = null;
      this.change({ acknowledgedGeneration: generation, inFlightGeneration: null, failure: null });
      result =
        written === 'unchanged'
          ? { kind: 'clean', ownerId: this.key.ownerId, generation }
          : {
              kind: 'committed',
              ownerId: this.key.ownerId,
              generation,
              source: 'guarded_field',
            };
    }
    return result;
  }
}
export function fieldKey(vaultId: string, path: string, field: string): DocumentKey {
  return { vaultId, path, ownerId: `field:${field}` };
}
export function retainedField(key: DocumentKey): FieldSaveParticipant | undefined {
  const owner = retainedSaveParticipant(key);
  return owner instanceof FieldSaveParticipant ? owner : undefined;
}
export function unresolvedField(key: DocumentKey): FieldSaveParticipant | undefined {
  const owner = retainedField(key),
    state = owner?.snapshot();
  return state !== undefined &&
    (state.generation > state.acknowledgedGeneration ||
      state.inFlightGeneration !== null ||
      state.failure !== null)
    ? owner
    : undefined;
}
