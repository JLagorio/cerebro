import type { DocumentAdmission } from './documentAdmission';
import type { DocumentKey, FlushReport, OwnerSnapshot, SaveOutcome } from './documentOwner';
import type { RecoveryAdapter } from './deletedDraftRecovery';

export interface SaveParticipant {
  key: DocumentKey;
  identity?: object;
  /** Move child buffers into their owner synchronously, before any writer
   * snapshots it. This phase must not wait for a network or disk operation. */
  prepare: () => void;
  snapshot: () => OwnerSnapshot;
  blocked?: () => 'reconcile' | 'choice' | null;
  flush: () => Promise<SaveOutcome>;
  /** Fields may depend on a saved body. Their existing writer can flush only
   * body participants, without waiting recursively for its own field commit. */
  phase?: 'body' | 'field';
  recovery?: RecoveryAdapter;
  /** Already-authored late admission can expose a separate recovery handle. */
  deferredRecovery?: RecoveryAdapter;
  /** Existing owner rebinds its own writer and listeners after a landed move. */
  retention?: { held: () => boolean; release: () => void };
  rename?: { hold: () => void; landed: (path: string) => void; release: () => void };
}
export interface OpenPageSnapshot extends OwnerSnapshot {
  key: DocumentKey;
  participantId: string;
  blocked: 'reconcile' | 'choice' | null;
}
interface Registration {
  participant: SaveParticipant;
  mounted: boolean;
  lastOutcome: SaveOutcome | null;
  deferred?: boolean;
}
/** Pane names alone are not identities: a retained draft may outlive a vault
 * switch or another page in the same pane. Reports use the complete key. */
export const saveParticipantId = (key: DocumentKey): string =>
  JSON.stringify([key.vaultId, key.path, key.ownerId]);

/** The registry owns no file writer. Each participant retains its exact draft
 * and reports what its existing authoritative write door actually accepted. */
export class SaveParticipants {
  private entries = new Map<string, Registration>();
  private sequence = 0;
  private retiredIdentities = new WeakSet<object>();

  values(includeDeferred = true): SaveParticipant[] {
    return [...this.entries.values()]
      .filter((entry) => includeDeferred || !entry.deferred)
      .map(({ participant }) => participant);
  }
  remap(vault: string, from: string, to: string): void {
    for (const [id, entry] of [...this.entries]) {
      const [origin, path] = JSON.parse(id) as string[];
      if (entry.deferred || origin !== vault || !(path === from || path.startsWith(`${from}/`)))
        continue;
      this.entries.delete(id);
      entry.participant.key.path = to + path.slice(from.length);
      this.entries.set(saveParticipantId(entry.participant.key), entry);
    }
  }
  get size(): number {
    return this.entries.size;
  }

  get(key: DocumentKey): SaveParticipant | undefined {
    return this.entries.get(saveParticipantId(key))?.participant;
  }
  retire(key: DocumentKey, expected?: SaveParticipant): void {
    for (const [id, value] of this.entries)
      if (expected ? value.participant === expected : id === saveParticipantId(key)) {
        value.participant.retention?.release();
        this.entries.delete(id);
      }
  }

  /** Successful explicit disposition belongs to one captured incarnation,
   * including all of its view wrappers. Keys may also name a different draft. */
  retireIdentity(identity: object): void {
    this.retiredIdentities.add(identity);
    for (const [id, entry] of this.entries) {
      if ((entry.participant.identity ?? entry.participant) !== identity) continue;
      entry.participant.retention?.release();
      if (this.entries.get(id) === entry) this.entries.delete(id);
    }
  }
  identityRetired(identity: object): boolean {
    return this.retiredIdentities.has(identity);
  }

  register(participant: SaveParticipant, admission?: DocumentAdmission): () => void {
    if (this.identityRetired(participant.identity ?? participant)) return () => {};
    const deferred = admission?.kind === 'deferred';
    const id = deferred
      ? JSON.stringify([
          participant.key.vaultId,
          participant.key.path,
          participant.key.ownerId,
          'pending',
          ++this.sequence,
        ])
      : saveParticipantId(participant.key);
    const entry: Registration = { participant, mounted: true, lastOutcome: null, deferred };
    this.entries.set(id, entry);
    if (admission?.kind === 'deferred')
      void admission.settled.then(() => {
        const state = participant.snapshot();
        if (
          this.entries.get(id) === entry &&
          state.generation === state.acknowledgedGeneration &&
          state.inFlightGeneration === null &&
          state.failure === null &&
          !Object.keys(state.childDrafts ?? {}).length
        )
          this.entries.delete(id);
      });
    return () => {
      const currentId = deferred ? id : saveParticipantId(participant.key);
      if (this.entries.get(currentId) !== entry) return;
      entry.mounted = false;
      this.retireSettled(currentId, entry);
    };
  }

  private unresolvedEntry(entry: Registration): boolean {
    const state = entry.participant.snapshot();
    return (
      entry.deferred === true ||
      state.selectedSave !== undefined ||
      state.generation > state.acknowledgedGeneration ||
      state.inFlightGeneration !== null ||
      state.failure !== null ||
      state.reconcileRequired === true ||
      Object.keys(state.childDrafts ?? {}).length > 0 ||
      (entry.participant.blocked?.() ?? null) !== null ||
      (entry.lastOutcome?.kind === 'failed' &&
        (entry.lastOutcome.code === 'prepare_failed' ||
          entry.lastOutcome.generation > state.acknowledgedGeneration ||
          // Compatibility callbacks have no generation-bearing owner. Their
          // failure stays unresolved until that callback succeeds explicitly.
          (entry.lastOutcome.generation === 0 && state.generation === 0)))
    );
  }

  private retireSettled(id: string, entry: Registration): void {
    if (
      !entry.mounted &&
      !entry.participant.retention?.held() &&
      this.entries.get(id) === entry &&
      !this.unresolvedEntry(entry)
    )
      this.entries.delete(id);
  }

  unresolved(): OpenPageSnapshot[] {
    return [...this.entries].flatMap(([participantId, entry]) =>
      this.unresolvedEntry(entry)
        ? [
            {
              ...entry.participant.snapshot(),
              key: entry.participant.key,
              participantId,
              blocked: entry.deferred ? 'choice' : (entry.participant.blocked?.() ?? null),
            },
          ]
        : [],
    );
  }

  /** Capture buffers before a synchronous navigation decides whether it
   * needs to wait. Capturing itself never retires an editor. */
  prepare(): void {
    for (const [id, entry] of this.entries) {
      try {
        entry.participant.prepare();
        if (entry.lastOutcome?.kind === 'failed' && entry.lastOutcome.code === 'prepare_failed')
          entry.lastOutcome = null;
      } catch {
        entry.lastOutcome = {
          kind: 'failed',
          ownerId: id,
          generation: entry.participant.snapshot().generation,
          code: 'prepare_failed',
        };
      }
    }
  }

  clear(): void {
    for (const { participant } of this.entries.values()) participant.retention?.release();
    this.entries.clear();
  }

  async flush(budgetMs = 5_000, phase?: 'body'): Promise<FlushReport> {
    const selected = [...this.entries].filter(
      ([, entry]) => phase === undefined || (entry.participant.phase ?? 'body') === phase,
    );
    if (selected.length === 0) return { outcomes: [], unresolvedOwnerIds: [] };
    const outcomes = new Map<string, SaveOutcome>();
    const outcome = (id: string, entry: Registration, result: SaveOutcome) => {
      // Snapshot the complete identity into the report; the writer may use
      // a pane-local owner name internally.
      const normalized = { ...result, ownerId: id };
      entry.lastOutcome = normalized;
      outcomes.set(id, normalized);
      this.retireSettled(id, entry);
    };
    const fail = (id: string, entry: Registration, code: string) =>
      outcome(id, entry, {
        kind: 'failed',
        ownerId: id,
        generation: entry.participant.snapshot().generation,
        code,
      });
    for (const [id, entry] of selected) {
      try {
        entry.participant.prepare();
      } catch {
        fail(id, entry, 'prepare_failed');
      }
    }
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(
        () => {
          expired = true;
          resolve();
        },
        Math.max(0, budgetMs),
      );
    });
    const run = async () => {
      for (const group of ['body', 'field'] as const) {
        if (expired) return;
        await Promise.all(
          selected.map(async ([id, entry]) => {
            if ((entry.participant.phase ?? 'body') !== group || outcomes.has(id)) return;
            const reason = entry.deferred ? 'choice' : entry.participant.blocked?.();
            if (reason) {
              outcome(id, entry, {
                kind: 'blocked',
                ownerId: id,
                generation: entry.participant.snapshot().generation,
                reason,
              });
              return;
            }
            try {
              outcome(id, entry, await entry.participant.flush());
            } catch {
              fail(id, entry, 'save_failed');
            }
          }),
        );
      }
    };
    try {
      await Promise.race([run(), deadline]);
    } finally {
      clearTimeout(timer);
    }
    const result = selected.map(
      ([id, entry]): SaveOutcome =>
        outcomes.get(id) ?? {
          kind: 'blocked',
          ownerId: id,
          generation: entry.participant.snapshot().generation,
          reason: 'deadline',
        },
    );
    const unresolved = new Set(
      result
        .filter(
          (value) =>
            value.kind === 'failed' || value.kind === 'blocked' || value.kind === 'pending',
        )
        .map((value) => value.ownerId),
    );
    for (const state of this.unresolved()) {
      const entry = this.entries.get(state.participantId);
      if (phase === undefined || (entry?.participant.phase ?? 'body') === phase)
        unresolved.add(state.participantId);
    }
    return { outcomes: result, unresolvedOwnerIds: [...unresolved] };
  }
}
