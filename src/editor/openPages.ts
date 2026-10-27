import {
  documentAdmission,
  documentReaderKeys,
  holdDocumentReader,
  reserveDocumentDestinations,
  resetDocumentAdmission,
  containsPath,
} from './documentAdmission';
import {
  DocumentOwner,
  type DocumentKey,
  type BodyFormat,
  type SaveOutcome,
  type FlushReport,
} from './documentOwner';
import {
  SaveParticipants,
  saveParticipantId,
  type SaveParticipant,
  type OpenPageSnapshot,
} from './saveParticipants';
import {
  registerRecovery,
  releaseRecovery,
  resetRecoveryRegistry,
  unmountRecovery,
  remapRecovery,
  recoveryKeys,
  deferredRecoverySnapshots,
  deferredRecoveryAdmission,
} from './deletedDraftRecovery';
/**
 * The pages open in the editor, as the rest of the app reaches them (M53.6).
 *
 * Two channels, both module-level because their callers sit nowhere near the
 * editors they need: a panel turn in the assistant, and the bridge that hears
 * the agent's MCP writes.
 *
 * - **Flush.** Every open page registers how to land its pending save. A turn
 *   flushes them all before its child starts, so the agent reads, and appends
 *   to, what is on screen rather than what was on disk half a second ago. A
 *   page that cannot land its save yet says so (`heldOpenPages`).
 * - **External writes.** The agent's MCP writes go through the app's own
 *   `write_file`, which registers each write as the app's, so the watcher
 *   drops the echo. The tools announce what they changed instead, and a page
 *   with that file open hears it here by path, holds its saves until the
 *   vault has caught up, and then merges the write in place (M55.6).
 */

type Flush = () => Promise<void | SaveOutcome>;
const participants = new SaveParticipants();
let registrationSequence = 0;
let deferredAdmissions = new WeakMap<object, import('./documentAdmission').DocumentAdmission>();

/** New owners expose exact retained state and an authoritative result. */
export function registerSaveParticipant(
  participant: SaveParticipant,
): (() => void) & { admission: import('./documentAdmission').DocumentAdmission } {
  const identity = participant.identity ?? participant;
  const admission =
    deferredAdmissions.get(identity) ??
    deferredRecoveryAdmission(participant.recovery?.identity ?? identity) ??
    documentAdmission(participant.key, identity);
  if (participants.identityRetired(identity)) return Object.assign(() => {}, { admission });
  if (admission.kind === 'deferred') {
    deferredAdmissions.set(identity, admission);
    participant.rename?.hold();
  }
  if (admission.kind === 'ready')
    for (const claim of renameClaims) claim.admitParticipant(participant);
  const recovery =
    participant.recovery ??
    (admission.kind === 'deferred' ? participant.deferredRecovery : undefined);
  if (recovery)
    registerRecovery({
      ...recovery,
      retire: () => {
        if (!recovery.retire()) return false;
        participants.retire(participant.key, participant);
        return true;
      },
    });
  const stop = participants.register(participant, admission);
  return Object.assign(
    () => {
      stop();
      if (recovery) unmountRecovery(participant.key, recovery.identity);
    },
    { admission },
  );
}

export function retainedSaveParticipant(key: DocumentKey): SaveParticipant | undefined {
  return participants.get(key);
}

/** Compatibility for existing callback owners while they migrate to explicit
 * participants. Completion is not a byte acknowledgement: retained document
 * state and holds are independently inspected before any dependent action. */
export function registerFlush(flush: Flush): () => void {
  const key = { vaultId: '', path: '', ownerId: `flush-${++registrationSequence}` };
  return participants.register({
    key,
    prepare: () => undefined,
    snapshot: () => ({
      latestDraft: '',
      generation: 0,
      acknowledgedGeneration: 0,
      inFlightGeneration: null,
      failure: null,
    }),
    flush: async () => (await flush()) ?? { kind: 'clean', ownerId: key.ownerId, generation: 0 },
  });
}

/** Capture nested buffers before any parent can serialize. The owning page
 * retains and writes the captured value; this never creates a second writer. */
export function registerSavePreparation(prepare: () => void): () => void {
  const key = { vaultId: '', path: '', ownerId: `prepare-${++registrationSequence}` };
  return participants.register({
    key,
    prepare,
    snapshot: () => ({
      latestDraft: '',
      generation: 0,
      acknowledgedGeneration: 0,
      inFlightGeneration: null,
      failure: null,
    }),
    flush: async () => ({ kind: 'clean', ownerId: key.ownerId, generation: 0 }),
  });
}

/** Whether Save has mounted or retained work to inspect. */
export function hasOpenPages(): boolean {
  return participants.size > 0 || unresolvedDocumentOwners().length > 0;
}

type Holding = () => string | null;

const holders = new Set<Holding>();

/**
 * Register how a page says it is holding a save: its path while a save, a
 * merge or a choice waits there, null otherwise. The returned function
 * unregisters it.
 */
export function registerHold(holding: Holding): () => void {
  holders.add(holding);
  return () => {
    holders.delete(holding);
  };
}

/**
 * The open pages a flush could not land (M55.13): each still holds a save
 * while it waits on an outside write, a reconcile or the person's choice. A
 * caller about to move one of these files refuses instead, because the save
 * would land at the old path once it releases.
 */
export function heldOpenPages(): string[] {
  const paths = new Set<string>(
    unresolvedOpenPages()
      .map((state) => state.key.path)
      .filter(Boolean),
  );
  for (const holding of holders) {
    const path = holding();
    if (path !== null) paths.add(path);
  }
  return [...paths];
}

/** Field mutations may inspect dependent bodies without refusing their own
 * in-flight field participant. Legacy reconcile holds still count here. */
export function heldOpenPageBodies(): string[] {
  const paths = new Set(
    participants
      .unresolved()
      .filter((state) => (participants.get(state.key)?.phase ?? 'body') === 'body')
      .map((state) => state.key.path)
      .filter(Boolean),
  );
  for (const owner of unresolvedDocumentOwners()) paths.add(owner.key.path);
  for (const holding of holders) {
    const path = holding();
    if (path !== null) paths.add(path);
  }
  return [...paths];
}

/** `fn()`, with a synchronous throw turned into a rejection. */
function attempt(fn: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => resolve(fn()));
}

/** Capture child buffers synchronously before deciding whether navigation
 * can remain synchronous. Every write still belongs to its registered owner. */
export function prepareOpenPages(): void {
  participants.prepare();
}

/** Current unresolved payloads, including owners whose view has unmounted.
 * Every identity includes vault and path; a pane name is never globally unique. */
export function unresolvedOpenPages(): OpenPageSnapshot[] {
  const states = new Map(
    [...participants.unresolved(), ...deferredRecoverySnapshots()].map((state) => [
      state.participantId,
      state,
    ]),
  );
  for (const owner of unresolvedDocumentOwners()) {
    const participantId = saveParticipantId(owner.key);
    states.set(participantId, {
      ...owner.snapshot(),
      key: owner.key,
      participantId,
      blocked:
        states.get(participantId)?.blocked ??
        (owner.snapshot().reconcileRequired
          ? 'reconcile'
          : Object.keys(owner.snapshot().childDrafts ?? {}).length > 0
            ? 'choice'
            : null),
    });
  }
  for (const holding of holders) {
    const path = holding();
    if (path === null) continue;
    const existing = [...states.values()].filter((state) => state.key.path === path);
    if (existing.length > 0) {
      for (const state of existing) state.blocked ??= 'reconcile';
      continue;
    }
    const key = { vaultId: '', path, ownerId: `held:${path}` };
    const participantId = saveParticipantId(key);
    states.set(participantId, {
      key,
      participantId,
      latestDraft: '',
      generation: 0,
      acknowledgedGeneration: 0,
      inFlightGeneration: null,
      failure: null,
      blocked: 'reconcile',
    });
  }
  return [...states.values()];
}

/** Prepare while mounted, then save. Timeout and refusal remain unresolved;
 * callers must inspect the report before mutating a path or leaving a view. */
export async function flushOpenPages(budgetMs = 5_000): Promise<FlushReport> {
  const report = await participants.flush(budgetMs);
  return {
    ...report,
    unresolvedOwnerIds: [
      ...new Set([
        ...report.unresolvedOwnerIds,
        ...unresolvedOpenPages().map((state) => state.participantId),
      ]),
    ],
  };
}

/** A field's existing writer may depend on saved bodies. Excluding field
 * commits here avoids recursively awaiting the very mutation doing the flush. */
export async function flushOpenPageBodies(budgetMs = 5_000): Promise<FlushReport> {
  const report = await participants.flush(budgetMs, 'body');
  return {
    ...report,
    unresolvedOwnerIds: [
      ...new Set([
        ...report.unresolvedOwnerIds,
        ...unresolvedDocumentOwners().map((owner) => saveParticipantId(owner.key)),
      ]),
    ],
  };
}

/** What a page does when a write to its file is announced. */
export interface ExternalWriteHandlers {
  /** Called synchronously to hold a known write through its IPC and refresh,
   *  or to reconcile an outside write that already happened. */
  pending: () => void;
  /** Called once the vault has caught up with the write, failed or not. */
  settled: () => void;
}

const watchers = new Map<string, Set<ExternalWriteHandlers>>();

/** Hear the writes announced for `path`; the returned function stops. */
export function onExternalWrite(path: string, handlers: ExternalWriteHandlers): () => void {
  let set = watchers.get(path);
  if (set === undefined) {
    set = new Set();
    watchers.set(path, set);
  }
  const own = set;
  own.add(handlers);
  return () => {
    own.delete(handlers);
    if (own.size === 0 && watchers.get(path) === own) watchers.delete(path);
  };
}

/** `catchUp()`, never rejecting. */
const quietly = (catchUp: () => Promise<void>): Promise<void> =>
  attempt(catchUp).catch(() => undefined);

/**
 * Hold the pages showing `paths` while another writer and its refresh run,
 * or reconcile an already completed outside write through `catchUp`. An empty `paths` is a write somewhere the
 * announcement could not name: it still catches up, and the pages fall back
 * on their entries' content hashes (M55.6). Never rejects.
 *
 * `catchUp` is called once per announcement, synchronously, and coalesces
 * itself when it delegates to the store's rescan, which runs one scan at a time
 * plus one trailing and resolves only after a scan that started after the
 * call (M58.2). A write announced while a scan runs is covered by that
 * trailing scan, so a burst costs two scans.
 */
export async function announceExternalWrites(
  paths: readonly string[],
  catchUp: () => Promise<void>,
): Promise<void> {
  const told = [...new Set(paths)].flatMap((path) => [...(watchers.get(path) ?? [])]);
  for (const handlers of told) handlers.pending();
  try {
    await quietly(catchUp);
  } finally {
    for (const handlers of told) handlers.settled();
  }
}

/** Test isolation: forget every page and its flush. */
export function __resetOpenPages(): void {
  resetDocumentAdmission();
  resetRecoveryRegistry();
  participants.clear();
  registrationSequence = 0;
  deferredAdmissions = new WeakMap();
  holders.clear();
  watchers.clear();
  editorHolders.clear();
  editorSnapshots.clear();
  editorListeners.clear();
  documentOwners.clear();
  deferredDocumentOwners.clear();
  documentPresentations.clear();
  renameClaims.clear();
}

/** Live editor owners, separate from pending-save holds. Counts preserve a
 * holder until its final mounted editor releases it. */
const editorHolders = new Map<string, Map<string, number>>();
const editorSnapshots = new Map<string, readonly string[]>();
const editorListeners = new Set<() => void>();
const NO_EDITORS: readonly string[] = [];
export function editorHoldersOf(path: string): readonly string[] {
  return editorSnapshots.get(path) ?? NO_EDITORS;
}
export function subscribeEditorHolders(listener: () => void): () => void {
  editorListeners.add(listener);
  return () => {
    editorListeners.delete(listener);
  };
}
export function holdEditor(path: string, owner: string, vault?: string | null): () => void {
  const releaseReader = vault
    ? holdDocumentReader({ vaultId: vault, path, ownerId: owner })
    : () => {};
  const owners = editorHolders.get(path) ?? new Map<string, number>();
  const before = owners.get(owner) ?? 0;
  owners.set(owner, before + 1);
  editorHolders.set(path, owners);
  const publish = () => {
    if (owners.size) editorSnapshots.set(path, [...owners.keys()]);
    else {
      editorHolders.delete(path);
      editorSnapshots.delete(path);
    }
    for (const listener of editorListeners) listener();
  };
  if (before === 0) publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseReader();
    const count = owners.get(owner) ?? 0;
    if (count > 1) owners.set(owner, count - 1);
    else {
      owners.delete(owner);
      publish();
    }
  };
}

/** Retain unresolved drafts after their presentation unmounts. */
const documentOwners = new Map<string, DocumentOwner>();
const deferredDocumentOwners = new Set<DocumentOwner>();
const documentKey = (key: DocumentKey) => JSON.stringify([key.vaultId, key.path, key.ownerId]);
export function retainedDocumentOwner(key: DocumentKey): DocumentOwner | undefined {
  return documentOwners.get(documentKey(key));
}
export function retainDocumentOwner(
  key: DocumentKey,
  initial: string,
  write: Parameters<DocumentOwner['setWriter']>[0],
  selectedTarget?: import('@/lib/generated/workspace').SelectedEditorTarget,
): DocumentOwner {
  const id = documentKey(key);
  const existing = documentOwners.get(id);
  const admission = documentAdmission(key, existing);
  if (existing !== undefined && admission.kind === 'ready') {
    existing.setWriter(write, selectedTarget);
    for (const claim of renameClaims) claim.admitOwner(existing);
    return existing;
  }
  const owner = new DocumentOwner(key, initial, write, selectedTarget);
  if (admission.kind === 'deferred') {
    deferredDocumentOwners.add(owner);
    deferredAdmissions.set(owner, admission);
    owner.holdRecovery();
    void admission.settled.then(() => {
      const state = owner.snapshot();
      if (
        state.generation === state.acknowledgedGeneration &&
        state.inFlightGeneration === null &&
        !Object.keys(state.childDrafts ?? {}).length
      ) {
        releaseRecovery(owner.key, owner);
        deferredDocumentOwners.delete(owner);
        owner.retireRecovery();
      }
    });
  } else documentOwners.set(id, owner);
  if (admission.kind === 'ready') for (const claim of renameClaims) claim.admitOwner(owner);
  registerRecovery({
    key,
    identity: owner,
    snapshot: () => owner.snapshot(),
    subscribe: (listener) => owner.subscribe(listener),
    busy: () => owner.recoveryBusy(),
    hold: () => owner.holdRecovery(),
    requiresRecovery: () => owner.requiresRecovery(),
    resume: () => owner.resumeRecovery(!key.path.endsWith('.mmd')),
    ...(key.path.endsWith('.mmd')
      ? {
          restoreRaw: async (
            source: import('./deletedDraftRecovery').RestoredRawSource,
            pick: 'base' | 'mine' | 'theirs',
          ) => {
            owner.expectTargetHash(source.hash);
            owner.setMergeBase({ raw: source.text, canon: source.text });
            if (pick === 'theirs') owner.acceptExternal(source.text);
            owner.resumeRecovery(false);
            return pick === 'mine' ? owner.flush() : undefined;
          },
        }
      : {}),
    payload: () => ({
      kind: key.path.endsWith('.mmd') ? 'mermaid' : 'markdown',
      body: {
        format: key.path.endsWith('.mmd') ? 'raw' : (owner.snapshot().bodyFormat ?? 'rich'),
        text: owner.snapshot().latestDraft,
      },
      field: null,
      children: { ...owner.snapshot().childDrafts },
      metadata: { kind: 'unavailable' },
    }),
    retire: () => {
      const deferred = deferredDocumentOwners.has(owner);
      if (
        (!deferred && documentOwners.get(documentKey(owner.key)) !== owner) ||
        !owner.retireRecovery()
      )
        return false;
      if (deferred) {
        participants.retireIdentity(owner);
        deferredDocumentOwners.delete(owner);
        return true;
      }
      participants.retire(key);
      documentOwners.delete(documentKey(owner.key));
      documentPresentations.delete(documentKey(owner.key));
      return true;
    },
  });
  return owner;
}
export function releaseDocumentOwner(owner: DocumentOwner, attachedPath = owner.key.path): void {
  if (attachedPath !== owner.key.path || owner.renamePending()) return;
  const state = owner.snapshot();
  const key = documentKey(owner.key);
  if (state.bodyFormat === 'source') documentPresentations.set(key, 'source');
  else documentPresentations.delete(key);

  if (
    state.generation === state.acknowledgedGeneration &&
    state.inFlightGeneration === null &&
    !owner.recoveryBusy() &&
    state.reconcileRequired !== true &&
    Object.keys(state.childDrafts ?? {}).length === 0 &&
    documentOwners.get(documentKey(owner.key)) === owner
  ) {
    releaseRecovery(owner.key, owner);
    documentOwners.delete(documentKey(owner.key));
  }
}
export function unresolvedDocumentOwners(): DocumentOwner[] {
  return [...documentOwners.values()].filter((owner) => {
    const state = owner.snapshot();
    return (
      state.selectedSave !== undefined ||
      state.generation > state.acknowledgedGeneration ||
      state.inFlightGeneration !== null ||
      Object.keys(state.childDrafts ?? {}).length > 0 ||
      ('reconcileRequired' in state && state.reconcileRequired === true)
    );
  });
}

/** Presentation preferences carry no document bytes. Clean payloads still
 * release normally; reopening source reads the current authoritative file. */
const documentPresentations = new Map<string, BodyFormat>();
export function documentPresentationOf(key: DocumentKey): BodyFormat {
  return (
    retainedDocumentOwner(key)?.snapshot().bodyFormat ??
    documentPresentations.get(documentKey(key)) ??
    'rich'
  );
}

interface RenameStep {
  from: string;
  to: string;
}
interface RenameClaim {
  vault: string;
  steps: readonly RenameStep[];
  admitOwner: (owner: DocumentOwner) => void;
  admitParticipant: (participant: SaveParticipant) => void;
}
const renameClaims = new Set<RenameClaim>();
const moved = (path: string, from: string, to: string) =>
  path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
/** Reserve the exact move intent; holds start only at the existing write
 * announcement, after applyBatch's internal save barrier. */
export function beginDocumentRename(vault: string, steps: readonly RenameStep[]): () => void {
  const overlaps = (a: string, b: string) =>
    a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  for (const claim of renameClaims)
    if (
      claim.vault === vault &&
      claim.steps.some((a) =>
        steps.some((b) =>
          [a.from, a.to].some((path) => [b.from, b.to].some((other) => overlaps(path, other))),
        ),
      )
    )
      throw new Error('Another rename is still in progress for this page.');
  const inventory = [...documentOwners.values()]
    .map((owner) => ({ ...owner.key }))
    .concat(
      participants.values().map((participant) => ({ ...participant.key })),
      recoveryKeys(),
      documentReaderKeys(),
    );
  for (const { from, to } of steps) {
    const collision = inventory.find(
      (key) => key.vaultId === vault && containsPath(to, key.path) && !containsPath(from, key.path),
    );
    if (collision)
      throw new Error(
        `${collision.path} has a retained editor or recovery draft. Resolve or close it before renaming.`,
      );
    for (const key of inventory) if (key.vaultId === vault) key.path = moved(key.path, from, to);
  }
  const affectsKey = (key: DocumentKey) =>
    key.vaultId === vault &&
    steps.some(({ from }) => key.path === from || key.path.startsWith(`${from}/`));
  const unsupported = participants
    .values()
    .find(
      (participant) =>
        affectsKey(participant.key) &&
        !participant.rename &&
        !retainedDocumentOwner(participant.key),
    );
  if (unsupported)
    throw new Error(`Close the editor for ${unsupported.key.path} before renaming it.`);
  const identities = new Set<object>();
  for (const owner of documentOwners.values()) if (affectsKey(owner.key)) identities.add(owner);
  for (const participant of participants.values())
    if (affectsKey(participant.key)) {
      identities.add(participant.identity ?? participant);
      if (participant.recovery) identities.add(participant.recovery.identity);
    }
  const releaseReservation = reserveDocumentDestinations(
    vault,
    steps.map(({ to }) => to),
    identities,
  );
  let held = false;
  let closed = false;
  const owners = new Set<DocumentOwner>();
  const adapters = new Set<NonNullable<SaveParticipant['rename']>>();
  const admitOwner = (owner: DocumentOwner) => {
    if (!affectsKey(owner.key)) return;
    identities.add(owner);
    if (!held) return;
    owners.add(owner);
    owner.holdRename();
  };
  const admitParticipant = (participant: SaveParticipant) => {
    if (!affectsKey(participant.key)) return;
    identities.add(participant.identity ?? participant);
    if (participant.recovery) identities.add(participant.recovery.identity);
    if (!held || !participant.rename) return;
    if (!adapters.has(participant.rename)) {
      adapters.add(participant.rename);
      participant.rename.hold();
    }
  };
  const claim = { vault, steps, admitOwner, admitParticipant };
  renameClaims.add(claim);
  const acquire = () => {
    if (held) return;
    held = true;
    for (const owner of documentOwners.values()) admitOwner(owner);
    for (const participant of participants.values()) admitParticipant(participant);
  };
  const stops = steps.map(({ from }) =>
    onExternalWrite(from, { pending: acquire, settled: () => {} }),
  );
  return () => {
    if (closed) return;
    closed = true;
    stops.forEach((stop) => stop());
    renameClaims.delete(claim);
    for (const owner of owners)
      if (
        steps.some(({ from }) => owner.key.path === from || owner.key.path.startsWith(`${from}/`))
      )
        owner.releaseRename();
    for (const adapter of adapters) adapter.release();
    releaseReservation();
  };
}
/** Commit identities before any pointer can mount the destination. Writers
 * receive a fresh destination snapshot; prior path closures cannot persist. */
export function followDocumentRename(vault: string, from: string, to: string): void {
  for (const participant of participants.values(false)) {
    if (participant.key.vaultId !== vault) continue;
    const next = moved(participant.key.path, from, to);
    if (next !== participant.key.path) participant.rename?.landed(next);
  }
  // Each registry uses its stored old ID, because some adapters share keys.
  for (const [oldId, format] of [...documentPresentations]) {
    const [origin, path, ownerId] = JSON.parse(oldId) as string[];
    const next = moved(path, from, to);
    if (origin !== vault || path === next) continue;
    documentPresentations.delete(oldId);
    documentPresentations.set(documentKey({ vaultId: vault, path: next, ownerId }), format);
  }
  remapRecovery(vault, from, to);
  participants.remap(vault, from, to);
  for (const [oldId, owner] of [...documentOwners]) {
    const [origin, path] = JSON.parse(oldId) as string[];
    const next = moved(path, from, to);
    if (origin !== vault || path === next) continue;
    documentOwners.delete(oldId);
    owner.key.path = next;
    documentOwners.set(documentKey(owner.key), owner);
    if (!next.endsWith('.mmd')) owner.holdForReconcile();
  }
}
