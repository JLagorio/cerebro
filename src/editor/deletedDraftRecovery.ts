import { documentAdmission, type DocumentAdmission } from './documentAdmission';
import type { BatchApplied } from '@/engine/batch';
import { splitFrontmatter } from '@/engine/frontmatter';
import { isKnowledgePath } from '@/engine/okf';
import { sha256Hex } from '@/lib/sha256';
import type { DocumentKey, OwnerSnapshot } from './documentOwner';
import type {
  DraftExportChoice,
  DraftExportFormat,
  DraftExportResult,
  RecoveredPage,
} from '@/lib/ipc';
import DRAFT_EXPORT from '../../shared/policy/draft-export.v1.json';

export interface RecoveryPayload {
  kind: 'markdown' | 'mermaid' | 'canvas' | 'field';
  body: { format: 'rich' | 'source' | 'raw'; text: string } | null;
  field: { name: string; text: string } | null;
  children: Record<string, string>;
  metadata: { kind: 'unavailable' };
}
export interface RecoveryAdapter {
  key: DocumentKey;
  identity: object;
  snapshot: () => OwnerSnapshot;
  payload: () => RecoveryPayload;
  subscribe: (listener: () => void) => () => void;
  busy: () => boolean;
  hold: () => void;
  retire: () => boolean;
  resume?: (current: () => boolean) => void | Promise<boolean>;
  requiresRecovery?: () => boolean;
  restoreRaw?: (
    source: RestoredRawSource,
    pick: 'base' | 'mine' | 'theirs',
  ) => Promise<import('./documentOwner').SaveOutcome | void>;
}
export interface RecoveryRef {
  key: DocumentKey;
  instanceId: number;
  revision: number;
}
export interface RestoredRawSource {
  text: string;
  hash: string;
}
export interface RawRestoreChoice {
  ref: RecoveryRef;
  source: RestoredRawSource;
}
export type RawRestoreResult =
  RecoveryResult | { kind: 'restore_choice'; choice: RawRestoreChoice };
export interface RecoveryDraft {
  ref: RecoveryRef;
  payload: RecoveryPayload;
  state: OwnerSnapshot;
  busy: boolean;
  requiresRecovery: boolean;
  deferredAdmission?: boolean;
}
export type RecoveryResult =
  | { kind: 'copied' | 'discarded' | 'cancelled' | 'retired' | 'resumed' }
  | { kind: 'blocked'; reason: 'in_flight' | 'changed' | 'unavailable' }
  | { kind: 'failed'; message: string }
  | { kind: 'exported'; destination: string }
  | { kind: 'created'; path: string; contentHash: string; refreshFailed?: boolean };
interface Registration {
  adapter: RecoveryAdapter;
  instanceId: number;
  revision: number;
  fingerprint: string;
  stop: () => void;
  operations: number;
  mounts: number;
  deferred?: boolean;
  admission?: DocumentAdmission;
}
const entries = new Map<string, Registration>();
const pendingEntries = new Map<object, Registration>();
const allEntries = () => [...entries.values(), ...pendingEntries.values()];
export function deferredRecoveryAdmission(identity: object): DocumentAdmission | undefined {
  return pendingEntries.get(identity)?.admission;
}
export const recoveryKeys = (): DocumentKey[] =>
  allEntries().map(({ adapter }) => ({ ...adapter.key }));
const listeners = new Set<() => void>();
const id = (key: DocumentKey) => JSON.stringify([key.vaultId, key.path, key.ownerId]);
let sequence = 0,
  epoch = 0;
const notify = () => {
  epoch += 1;
  for (const listener of listeners) listener();
};
export const recoveryEpoch = () => epoch;
export function subscribeRecovery(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const fingerprint = (adapter: RecoveryAdapter) =>
  JSON.stringify([adapter.snapshot(), adapter.payload()]);
function sync(entry: Registration) {
  const value = fingerprint(entry.adapter);
  if (value !== entry.fingerprint) {
    entry.fingerprint = value;
    entry.revision += 1;
  }
}
export function registerRecovery(adapter: RecoveryAdapter): DocumentAdmission {
  const pending = pendingEntries.get(adapter.identity);
  if (pending) {
    pending.mounts += 1;
    return pending.admission!;
  }
  const admission = documentAdmission(adapter.key, adapter.identity);
  const key = id(adapter.key),
    previous = entries.get(key);
  if (previous?.adapter.identity === adapter.identity) {
    previous.mounts += 1;
    return { kind: 'ready' };
  }
  if (admission.kind === 'ready') previous?.stop();
  const entry: Registration = {
    adapter,
    instanceId: ++sequence,
    revision: 0,
    fingerprint: fingerprint(adapter),
    stop: () => {},
    operations: 0,
    mounts: 1,
  };
  if (admission.kind === 'deferred') {
    entry.deferred = true;
    entry.admission = admission;
    pendingEntries.set(adapter.identity, entry);
    void admission.settled.then(() => {
      // Already-authored handles remain distinct and discoverable. A clean
      // speculative callback can retire after the reservation settles.
      if (pendingEntries.get(adapter.identity) === entry && !authored(adapter)) {
        entry.stop();
        pendingEntries.delete(adapter.identity);
        notify();
      }
    });
  } else entries.set(key, entry);
  entry.stop = adapter.subscribe(() => {
    sync(entry);
    releaseSettled(entry);
    notify();
  });
  notify();
  return admission;
}
function authored(adapter: RecoveryAdapter): boolean {
  const state = adapter.snapshot();
  return (
    state.generation !== state.acknowledgedGeneration ||
    state.inFlightGeneration !== null ||
    state.failure !== null ||
    Object.keys(adapter.payload().children).length > 0
  );
}
function unresolved(adapter: RecoveryAdapter): boolean {
  const state = adapter.snapshot();
  return (
    state.generation !== state.acknowledgedGeneration ||
    state.inFlightGeneration !== null ||
    state.failure !== null ||
    state.reconcileRequired === true ||
    Object.keys(adapter.payload().children).length > 0
  );
}
function releaseSettled(entry: Registration): void {
  if (!entry.mounts && !entry.operations && !entry.adapter.busy() && !unresolved(entry.adapter)) {
    releaseRecovery(entry.adapter.key, entry.adapter.identity);
  }
}
export function unmountRecovery(key: DocumentKey, identity: object): void {
  const entry = pendingEntries.get(identity) ?? entries.get(id(key));
  if (entry?.adapter.identity !== identity) return;
  entry.mounts = Math.max(0, entry.mounts - 1);
  releaseSettled(entry);
}
export function releaseRecovery(key: DocumentKey, identity: object): void {
  const entry = pendingEntries.get(identity) ?? entries.get(id(key));
  if (entry?.adapter.identity !== identity) return;
  entry.stop();
  if (entry.deferred) pendingEntries.delete(identity);
  else entries.delete(id(key));
  notify();
}
/** A landed move keeps the same recovery incarnation; old refs no longer resolve. */
export function remapRecovery(vault: string, from: string, to: string): void {
  for (const [oldId, entry] of [...entries]) {
    const [origin, path] = JSON.parse(oldId) as string[];
    if (origin !== vault || !(path === from || path.startsWith(`${from}/`))) continue;
    entries.delete(oldId);
    entry.adapter.key.path = to + path.slice(from.length);
    entry.revision += 1;
    entries.set(id(entry.adapter.key), entry);
  }
  notify();
}
export function resetRecoveryRegistry(): void {
  for (const entry of allEntries()) entry.stop();
  entries.clear();
  pendingEntries.clear();
  notify();
}
export function recoveryDrafts(scope: Pick<DocumentKey, 'vaultId' | 'path'>): RecoveryDraft[] {
  return allEntries().flatMap((entry) => {
    if (entry.adapter.key.vaultId !== scope.vaultId || entry.adapter.key.path !== scope.path)
      return [];
    sync(entry);
    const state = entry.adapter.snapshot(),
      payload = entry.adapter.payload();
    if (
      state.generation === state.acknowledgedGeneration &&
      state.inFlightGeneration === null &&
      state.failure === null &&
      state.reconcileRequired !== true &&
      !Object.keys(payload.children).length
    )
      return [];
    return [
      {
        ref: {
          key: { ...entry.adapter.key },
          instanceId: entry.instanceId,
          revision: entry.revision,
        },
        payload,
        state,
        busy: entry.adapter.busy() || entry.operations > 0,
        requiresRecovery: entry.adapter.requiresRecovery?.() === true,
        ...(entry.deferred ? { deferredAdmission: true } : {}),
      },
    ];
  });
}
/** Deferred authored incarnations participate in the same save barrier. */
export function deferredRecoverySnapshots(): import('./saveParticipants').OpenPageSnapshot[] {
  return [...pendingEntries.values()]
    .filter(({ adapter }) => unresolved(adapter))
    .map((entry) => ({
      ...entry.adapter.snapshot(),
      key: entry.adapter.key,
      participantId: JSON.stringify([
        entry.adapter.key.vaultId,
        entry.adapter.key.path,
        entry.adapter.key.ownerId,
        'pending-recovery',
        entry.instanceId,
      ]),
      blocked: 'choice',
    }));
}
export function recoveryHoldFor(scope: Pick<DocumentKey, 'vaultId' | 'path'>): boolean {
  return allEntries().some(
    ({ adapter }) =>
      adapter.key.vaultId === scope.vaultId &&
      adapter.key.path === scope.path &&
      adapter.requiresRecovery?.() === true,
  );
}
function resolve(ref: RecoveryRef): Registration | RecoveryResult {
  const entry = allEntries().find(
    (candidate) =>
      id(candidate.adapter.key) === id(ref.key) && candidate.instanceId === ref.instanceId,
  );
  if (!entry || entry.instanceId !== ref.instanceId) return { kind: 'retired' };
  sync(entry);
  return entry.revision === ref.revision ? entry : { kind: 'blocked', reason: 'changed' };
}
export function holdRecovery(ref: RecoveryRef): void {
  const entry = resolve(ref);
  if ('adapter' in entry) entry.adapter.hold();
}
export async function resumeRecovery(
  ref: RecoveryRef,
  current: () => boolean,
  read: () => Promise<void>,
): Promise<RecoveryResult> {
  if (!current()) return { kind: 'retired' };
  const entry = resolve(ref);
  if (!('adapter' in entry)) return entry;
  if (entry.deferred) return { kind: 'blocked', reason: 'unavailable' };
  if (entry.operations || entry.adapter.busy()) return { kind: 'blocked', reason: 'in_flight' };
  entry.operations += 1;
  notify();
  try {
    // Presence alone is insufficient: an unreadable restored file must not
    // remove Copy/export/discard before the presentation can reconcile it.
    await read();
    if (!current()) return { kind: 'retired' };
    const after = resolve(ref);
    if (!('adapter' in after)) return after;
    if (entry.adapter.busy()) return { kind: 'blocked', reason: 'in_flight' };
    const resumed = await entry.adapter.resume?.(() => current() && resolve(ref) === entry);
    if (!current()) return { kind: 'retired' };
    return resumed === false
      ? { kind: 'failed', message: "This page couldn't be loaded. Your draft is kept." }
      : { kind: 'resumed' };
  } catch {
    return current()
      ? { kind: 'failed', message: "This page couldn't be loaded. Your draft is kept." }
      : { kind: 'retired' };
  } finally {
    entry.operations -= 1;
    releaseSettled(entry);
    notify();
  }
}
/** Reads are supplied by the existing IPC door. No registry lookup may
 * substitute another incarnation or silently update an open choice. */
export async function inspectRawRecovery(
  ref: RecoveryRef,
  current: () => boolean,
  read: () => Promise<RestoredRawSource>,
  choice?: { source: RestoredRawSource; pick: 'mine' | 'theirs' },
): Promise<RawRestoreResult> {
  if (!current()) return { kind: 'retired' };
  const entry = resolve(ref);
  if (!('adapter' in entry)) return entry;
  if (entry.deferred) return { kind: 'blocked', reason: 'unavailable' };
  if (entry.operations || entry.adapter.busy()) return { kind: 'blocked', reason: 'in_flight' };
  if (!entry.adapter.restoreRaw || isKnowledgePath(ref.key.path))
    return { kind: 'blocked', reason: 'unavailable' };
  entry.operations += 1;
  notify();
  try {
    const source = await read();
    if (!current()) return { kind: 'retired' };
    const after = resolve(ref);
    if (!('adapter' in after)) return after;
    if (source.hash !== sha256Hex(source.text))
      return {
        kind: 'failed',
        message: 'Could not verify the restored source. Your draft is kept.',
      };
    if (choice && (source.hash !== choice.source.hash || source.text !== choice.source.text))
      return { kind: 'blocked', reason: 'changed' };
    const state = entry.adapter.snapshot(),
      payload = entry.adapter.payload();
    if (Object.keys(payload.children).length)
      return {
        kind: 'failed',
        message:
          'Uncommitted child drafts are kept separately. Copy or save a recovery file before discarding them.',
      };
    let pick = choice?.pick;
    if (!pick) {
      if (source.text === state.latestDraft) pick = 'theirs';
      else if (source.text !== state.mergeBase?.raw)
        return { kind: 'restore_choice', choice: { ref, source } };
    }
    const result = await entry.adapter.restoreRaw(source, pick ?? 'base');
    if (result?.kind === 'failed')
      return {
        kind: 'failed',
        message: `Could not save the restored diagram: ${result.code}. Your draft is kept.`,
      };
    if (result?.kind === 'blocked') return { kind: 'blocked', reason: 'unavailable' };
    return current() ? { kind: 'resumed' } : { kind: 'retired' };
  } catch {
    return current()
      ? { kind: 'failed', message: 'Could not read the restored source. Your draft is kept.' }
      : { kind: 'retired' };
  } finally {
    entry.operations -= 1;
    releaseSettled(entry);
    notify();
  }
}
export function discardRecovery(ref: RecoveryRef): RecoveryResult {
  const entry = resolve(ref);
  if (!('adapter' in entry)) return entry;
  if (entry.operations || entry.adapter.busy()) return { kind: 'blocked', reason: 'in_flight' };
  if (!entry.adapter.retire()) return { kind: 'blocked', reason: 'in_flight' };
  releaseRecovery(ref.key, entry.adapter.identity);
  return { kind: 'discarded' };
}
export function recoveryBundle(draft: RecoveryDraft): string {
  return (
    JSON.stringify(
      {
        format: 'cerebro-retained-draft',
        version: 1,
        origin: {
          vaultLabel: draft.ref.key.vaultId.split(/[\\/]/).filter(Boolean).at(-1) ?? '',
          path: draft.ref.key.path,
          ownerId: draft.ref.key.ownerId,
        },
        ...draft.payload,
        governed: isKnowledgePath(draft.ref.key.path),
        state: {
          generation: draft.state.generation,
          acknowledgedGeneration: draft.state.acknowledgedGeneration,
          writeWasPending: draft.state.inFlightGeneration !== null,
        },
      },
      null,
      2,
    ) + '\n'
  );
}
export async function copyRecovery(
  ref: RecoveryRef,
  bundle: boolean,
  write: (text: string) => Promise<void>,
  current: () => boolean,
): Promise<RecoveryResult> {
  if (!current()) return { kind: 'retired' };
  const entry = resolve(ref);
  if (!('adapter' in entry)) return entry;
  const draft = recoveryDrafts(ref.key).find((item) => item.ref.instanceId === ref.instanceId);
  if (!draft) return { kind: 'retired' };
  const text = bundle
    ? recoveryBundle(draft)
    : (draft.payload.field?.text ?? draft.payload.body?.text ?? '');
  entry.operations += 1;
  notify();
  try {
    await write(text);
    if (!current()) return { kind: 'retired' };
    const after = resolve(ref);
    return 'adapter' in after ? { kind: 'copied' } : after;
  } catch {
    return current()
      ? { kind: 'failed', message: "Couldn't copy. Your draft is kept." }
      : { kind: 'retired' };
  } finally {
    entry.operations -= 1;
    releaseSettled(entry);
    notify();
  }
}
export function canCreateRecoveryPage(draft: RecoveryDraft): boolean {
  const body = draft.payload.body;
  return (
    draft.payload.kind === 'markdown' &&
    body !== null &&
    !isKnowledgePath(draft.ref.key.path) &&
    !Object.keys(draft.payload.children).length &&
    splitFrontmatter(body.text).yaml === null
  );
}
export function canExportRawRecovery(draft: RecoveryDraft): boolean {
  return (
    (draft.payload.kind === 'mermaid' || draft.payload.kind === 'canvas') &&
    draft.payload.body !== null &&
    !Object.keys(draft.payload.children).length &&
    !isKnowledgePath(draft.ref.key.path)
  );
}
export interface RecoveryDoors {
  choose: (
    vault: string,
    path: string,
    name: string,
    format: DraftExportFormat,
    hash: string,
  ) => Promise<DraftExportChoice>;
  commit: (vault: string, token: string, content: string) => Promise<DraftExportResult>;
  cancel: (token: string) => Promise<void>;
  create: (
    vault: string,
    original: string,
    destination: string,
    content: string,
  ) => Promise<RecoveredPage>;
  refresh: () => Promise<unknown>;
  record: (batch: BatchApplied) => void;
}
export async function saveRecoveryAs(
  ref: RecoveryRef,
  request: { kind: 'bundle' | 'raw' } | { kind: 'page'; path: string },
  current: () => boolean,
  doors: RecoveryDoors,
): Promise<RecoveryResult> {
  if (!current()) return { kind: 'retired' };
  const entry = resolve(ref);
  if (!('adapter' in entry)) return entry;
  const draft = recoveryDrafts(ref.key).find((item) => item.ref.instanceId === ref.instanceId);
  if (!draft) return { kind: 'retired' };
  if (request.kind === 'page' && (entry.adapter.busy() || entry.operations))
    return { kind: 'blocked', reason: 'in_flight' };
  entry.operations += 1;
  notify();
  try {
    if (request.kind === 'page') {
      const same =
        request.path.normalize('NFC').toLowerCase() === ref.key.path.normalize('NFC').toLowerCase();
      if (
        !canCreateRecoveryPage(draft) ||
        same ||
        !request.path.endsWith('.md') ||
        recoveryDrafts({ vaultId: ref.key.vaultId, path: request.path }).length
      )
        return { kind: 'blocked', reason: 'unavailable' };
      if (!current()) return { kind: 'retired' };
      const created = await doors.create(
        ref.key.vaultId,
        ref.key.path,
        request.path,
        draft.payload.body!.text,
      );
      // The acknowledged create is not the original target's acknowledgement.
      if (!current()) return { kind: 'retired' };
      doors.record(created.batch);
      let refreshFailed = false;
      try {
        await doors.refresh();
      } catch {
        refreshFailed = true;
      }
      return current()
        ? {
            kind: 'created',
            path: created.path,
            contentHash: created.contentHash,
            ...(refreshFailed ? { refreshFailed: true } : {}),
          }
        : { kind: 'retired' };
    }
    if (request.kind === 'raw' && !canExportRawRecovery(draft))
      return { kind: 'blocked', reason: 'unavailable' };
    const content = request.kind === 'raw' ? draft.payload.body!.text : recoveryBundle(draft);
    if (new TextEncoder().encode(content).byteLength > DRAFT_EXPORT.max_bytes)
      return {
        kind: 'failed',
        message:
          'Recovery file exceeds 10 MiB. Your complete draft is kept; copy individual values instead.',
      };
    const format =
      request.kind === 'raw' ? (draft.payload.kind === 'mermaid' ? 'mmd' : 'canvas') : 'json';
    const filename = ref.key.path.split('/').at(-1) ?? 'recovery';
    const picked = await doors.choose(
      ref.key.vaultId,
      ref.key.path,
      request.kind === 'raw' ? filename : `${filename}.cerebro-draft.json`,
      format,
      sha256Hex(content),
    );
    if (picked.kind === 'cancelled') return { kind: 'cancelled' };
    const after = resolve(ref);
    if (!current() || !('adapter' in after)) {
      try {
        await doors.cancel(picked.token);
      } catch {
        /* best effort; never acknowledgement */
      }
      return current() ? (after as RecoveryResult) : { kind: 'retired' };
    }
    const saved = await doors.commit(ref.key.vaultId, picked.token, content);
    return current() ? saved : { kind: 'retired' };
  } catch (error) {
    return current()
      ? { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
      : { kind: 'retired' };
  } finally {
    entry.operations -= 1;
    releaseSettled(entry);
    notify();
  }
}
