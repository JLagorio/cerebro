import { creationDraftKey, type CreationContext } from '@/engine/creationDestination';

export type CreationDraft = {
  /** Raw scalar edits are session UI state, never frontmatter. */
  scalarDrafts?: Record<string, { text: string; error: string | null; kind?: string }>;
  context: CreationContext;
  revision: number;
  title: string;
  values: Record<string, unknown>;
  createMore: boolean;
  fieldErrors: Record<string, string>;
  formError: string | null;
};
export type CreationSubmission = {
  id: string;
  context: CreationContext;
  draftRevision: number;
  snapshot: CreationDraft;
  state: 'pending' | 'succeeded' | 'failed';
  path: string | null;
  error: string | null;
};
export type CreationSubmitStart =
  | { kind: 'started'; submission: CreationSubmission }
  | { kind: 'pending'; submission: CreationSubmission }
  | { kind: 'stale' };

// Deliberately process memory only: no vault, browser-storage or runtime.db writes.
const drafts = new Map<string, CreationDraft>();
const claims = new Map<string, string>();
const submissions = new Map<string, CreationSubmission>();
const latest = new Map<string, string>();
const cleared = new Set<string>();
const listeners = new Set<() => void>();
let nextSubmission = 0;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const snapshot = <T>(value: T): T => freeze(structuredClone(value));
const publish = () => {
  for (const listener of listeners) listener();
};
export function subscribeCreationDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function readCreationDraft(context: CreationContext): CreationDraft | null {
  return drafts.get(creationDraftKey(context)) ?? null;
}
export function saveCreationDraft(draft: CreationDraft): void {
  const key = creationDraftKey(draft.context);
  if ((drafts.get(key)?.revision ?? -1) >= draft.revision) return;
  drafts.set(key, snapshot(draft));
  publish();
}
export function readCreationSubmission(context: CreationContext): CreationSubmission | null {
  const id = latest.get(creationDraftKey(context));
  return id === undefined ? null : (submissions.get(id) ?? null);
}
const pending = (context: CreationContext) => readCreationSubmission(context)?.state === 'pending';

export function discardCreationDraft(context: CreationContext, revision: number): boolean {
  const key = creationDraftKey(context);
  if (drafts.get(key)?.revision !== revision || pending(context)) return false;
  drafts.delete(key);
  publish();
  return true;
}
export function clearCreationDraftsForVault(vault: string): void {
  for (const [key, draft] of drafts) if (draft.context.vault === vault) drafts.delete(key);
  for (const key of claims.keys()) if (JSON.parse(key)[0] === vault) claims.delete(key);
  for (const [id, submission] of submissions) {
    if (submission.context.vault !== vault) continue;
    if (submission.state === 'pending') cleared.add(id);
    else {
      submissions.delete(id);
      const key = creationDraftKey(submission.context);
      if (latest.get(key) === id) latest.delete(key);
    }
  }
  publish();
}
export function claimCreationDraft(context: CreationContext, ownerId: string): boolean {
  const key = creationDraftKey(context);
  const owner = claims.get(key);
  if (owner !== undefined && owner !== ownerId) return false;
  claims.set(key, ownerId);
  return true;
}
export function releaseCreationDraft(context: CreationContext, ownerId: string): void {
  const key = creationDraftKey(context);
  if (claims.get(key) === ownerId) claims.delete(key);
}
export function moveCreationDraft(
  from: CreationContext,
  to: CreationContext,
  revision: number,
): boolean {
  const source = creationDraftKey(from);
  const target = creationDraftKey(to);
  const draft = drafts.get(source);
  if (
    source === target ||
    from.vault !== to.vault ||
    draft?.revision !== revision ||
    pending(from) ||
    pending(to) ||
    drafts.has(target) ||
    claims.has(target)
  )
    return false;
  drafts.set(target, snapshot({ ...draft, context: to, revision: revision + 1 }));
  drafts.delete(source);
  const owner = claims.get(source);
  if (owner !== undefined) {
    claims.set(target, owner);
    claims.delete(source);
  }
  publish();
  return true;
}
export function beginCreationSubmission(
  context: CreationContext,
  revision: number,
): CreationSubmitStart {
  const existing = readCreationSubmission(context);
  if (existing?.state === 'pending') return { kind: 'pending', submission: existing };
  const draft = readCreationDraft(context);
  if (draft === null || draft.revision !== revision) return { kind: 'stale' };
  const submission: CreationSubmission = snapshot({
    id: `creation-${++nextSubmission}`,
    context: draft.context,
    draftRevision: revision,
    snapshot: draft,
    state: 'pending',
    path: null,
    error: null,
  });
  submissions.set(submission.id, submission);
  latest.set(creationDraftKey(context), submission.id);
  publish();
  return { kind: 'started', submission };
}
export function settleCreationSubmission(
  id: string,
  result: { kind: 'succeeded'; path: string } | { kind: 'failed'; error: string },
): void {
  const previous = submissions.get(id);
  if (previous?.state !== 'pending') return;
  const key = creationDraftKey(previous.context);
  if (cleared.delete(id)) {
    submissions.delete(id);
    if (latest.get(key) === id) latest.delete(key);
    publish();
    return;
  }
  submissions.set(
    id,
    snapshot({
      ...previous,
      state: result.kind,
      path: result.kind === 'succeeded' ? result.path : null,
      error: result.kind === 'failed' ? result.error : null,
    }),
  );
  const current = drafts.get(key);
  if (current?.revision === previous.draftRevision) {
    if (result.kind === 'succeeded') drafts.delete(key);
    else drafts.set(key, snapshot({ ...current, formError: result.error }));
  }
  publish();
}
