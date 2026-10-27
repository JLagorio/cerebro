import type { RecoveryAdapter } from '@/editor/deletedDraftRecovery';
import {
  documentAdmission,
  waitForDocumentAdmission,
  holdDocumentReader,
} from '@/editor/documentAdmission';
import { stampActivation, SCHEDULE_STAMP_FAILED } from '@/agent/activation';
import type { BatchApplied } from '@/engine/batch';
import { firstH1LineIndex, replaceH1, splitFrontmatter } from '@/engine/frontmatter';
import { recordIdentity } from '@/engine/identity';
import {
  skillDraft,
  skillPatch,
  templateDraft,
  templatePatch,
  type SkillDraft,
  type TemplateDraft,
} from '@/engine/libraryDraft';
import { scheduleText } from '@/engine/skills';
import { isStaleContent } from '@/engine/staleContent';
import type { Entry } from '@/engine/types';
import type { DocumentKey, OwnerSnapshot, SaveOutcome } from '@/editor/documentOwner';
import { retainedSaveParticipant } from '@/editor/openPages';
import type { SaveParticipant } from '@/editor/saveParticipants';
import { readNoteSource } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';

const MOVE_PENDING = 'The move is still in progress. Your draft is kept; save after it finishes.';

export type LibraryDraft =
  { kind: 'skill'; value: SkillDraft } | { kind: 'template'; value: TemplateDraft };
export const libraryDraftKey = (vaultId: string, path: string, pane: string): DocumentKey => ({
  vaultId,
  path,
  ownerId: `library-form:${pane}`,
});
export function retainedLibraryDraft(
  vaultId: string,
  path: string,
  pane: string,
): LibraryDraftOwner | undefined {
  const participant = retainedSaveParticipant(libraryDraftKey(vaultId, path, pane));
  return participant instanceof LibraryDraftOwner ? participant : undefined;
}

/** Match the scanned metadata to the exact source version before allowing a
 * composite edit. One refresh retries a racing scan; a moving target refuses. */
export async function loadLibraryDraftOwner(
  key: DocumentKey,
  kind: 'skill' | 'template',
  stillCurrent: () => boolean,
): Promise<LibraryDraftOwner | null> {
  const release = holdDocumentReader(key);
  try {
    let attempt = 0;
    let waitedForMove = false;
    while (attempt < 2) {
      waitedForMove ||= documentAdmission(key).kind === 'deferred';
      if (!(await waitForDocumentAdmission(key, stillCurrent))) return null;
      const retained = waitedForMove
        ? retainedLibraryDraft(key.vaultId, key.path, key.ownerId.replace(/^library-form:/, ''))
        : undefined;
      if (retained) return retained;
      const source = await readNoteSource(key.vaultId, key.path);
      if (!stillCurrent()) return null;
      if (documentAdmission(key).kind === 'deferred') {
        waitedForMove = true;
        continue;
      }
      const state = useVaultStore.getState();
      const entry =
        state.entriesVault === key.vaultId
          ? state.entries.find((candidate) => candidate.path === key.path)
          : undefined;
      if (entry?.hash === source.hash) return new LibraryDraftOwner(key, entry, kind, source);
      if (attempt++ === 0) await state.rescan();
    }
    throw new Error('The file changed while loading. Retry to load one complete version.');
  } finally {
    release();
  }
}

const bodyOf = (draft: LibraryDraft): string =>
  draft.kind === 'skill' ? draft.value.instructions : draft.value.body;
const withBody = (draft: LibraryDraft, body: string): LibraryDraft =>
  draft.kind === 'skill'
    ? { kind: 'skill', value: { ...draft.value, instructions: body } }
    : { kind: 'template', value: { ...draft.value, body } };
const h1Line = (body: string): string | null => {
  const index = firstH1LineIndex(body);
  return index < 0 ? null : body.split('\n')[index];
};

/** One explicit decision, retained independently of its view. Preparation never
 * submits grants. The batch receipt and schedule boundary are separate steps. */
export class LibraryDraftOwner implements SaveParticipant {
  readonly phase = 'field' as const;
  name: string;
  draft: LibraryDraft;
  message: string | null = null;
  stale = false;
  refreshFailed = false;
  private generation = 0;
  private nameGeneration = 0;
  private acknowledgedGeneration = 0;
  private writtenGeneration = 0;
  private inFlightGeneration: number | null = null;
  private failure: OwnerSnapshot['failure'] = null;
  private listeners = new Set<() => void>();
  private renameHeld = false;
  private deferredRetired = false;
  private saved: { name: string; draft: LibraryDraft };
  private pendingActivation: { identity: string; schedule: string[]; now: Date } | null = null;
  constructor(
    readonly key: DocumentKey,
    public entry: Entry,
    kind: 'skill' | 'template',
    source: { content: string; hash: string },
    private baseHash = source.hash,
  ) {
    if (entry.hash !== source.hash)
      throw new Error('The metadata and body belong to different file versions.');
    const body = splitFrontmatter(source.content).body.replace(/^\n+/, '');
    this.name = entry.title;
    this.draft =
      kind === 'template'
        ? { kind, value: templateDraft(entry, body) }
        : { kind, value: skillDraft(entry, body) };
    this.saved = { name: this.name, draft: this.draft };
  }
  get saving(): boolean {
    return this.inFlightGeneration !== null;
  }
  get dirty(): boolean {
    return this.generation > this.acknowledgedGeneration || this.pendingActivation !== null;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(): void {
    for (const listener of this.listeners) listener();
  }
  edit(name: string, draft: LibraryDraft): void {
    if (this.deferredRetired) return;
    if (name !== this.name) this.nameGeneration += 1;
    this.name = name;
    this.draft = draft;
    this.generation += 1;
    this.publish();
  }
  /** Only a rejected/deferred admission exposes this separate incarnation.
   * Ordinary Library drafts keep their existing explicit-Save presentation. */
  get deferredRecovery(): RecoveryAdapter {
    return {
      key: this.key,
      identity: this,
      snapshot: this.snapshot,
      subscribe: this.subscribe,
      busy: () => this.saving,
      requiresRecovery: () => true,
      hold: () => {
        this.renameHeld = true;
        this.publish();
      },
      payload: () => ({
        kind: 'field',
        body: { format: 'rich', text: bodyOf(this.draft) },
        field: {
          name: 'Library decision',
          text: JSON.stringify({ name: this.name, draft: this.draft }),
        },
        children: Object.fromEntries(
          this.dirty
            ? [['library-decision', JSON.stringify({ name: this.name, draft: this.draft })]]
            : [],
        ),
        metadata: { kind: 'unavailable' },
      }),
      retire: () => {
        if (this.saving) return false;
        this.deferredRetired = true;
        this.renameHeld = false;
        return this.discard();
      },
    };
  }
  readonly rename = {
    hold: () => {
      this.renameHeld = true;
      this.publish();
    },
    landed: (path: string) => {
      this.entry = { ...this.entry, path };
    },
    release: () => {
      this.renameHeld = false;
      if (this.message === MOVE_PENDING) this.message = null;
      this.publish();
    },
  };
  prepare = (): void => {};
  blocked = (): 'choice' | null =>
    this.renameHeld || this.dirty || this.saving || this.failure !== null ? 'choice' : null;
  snapshot = (): OwnerSnapshot => ({
    latestDraft: JSON.stringify({ name: this.name, draft: this.draft }),
    generation: this.generation,
    acknowledgedGeneration: this.acknowledgedGeneration,
    inFlightGeneration: this.inFlightGeneration,
    failure: this.failure,
    reconcileRequired: this.renameHeld,
  });
  flush = async (): Promise<SaveOutcome> =>
    this.blocked() === null
      ? { kind: 'clean', ownerId: this.key.ownerId, generation: this.generation }
      : {
          kind: 'blocked',
          ownerId: this.key.ownerId,
          generation: this.generation,
          reason: 'choice',
        };

  /** Explicit cancellation never rolls back an already acknowledged disk write. */
  discard(): boolean {
    if (this.saving || this.renameHeld) return false;
    this.name = this.saved.name;
    this.draft = this.saved.draft;
    this.acknowledgedGeneration = this.generation;
    this.writtenGeneration = this.generation;
    this.pendingActivation = null;
    this.failure = null;
    this.message = null;
    this.stale = false;
    this.publish();
    return true;
  }

  async save(overwrite = false): Promise<void> {
    if (this.deferredRetired) return;
    if (this.renameHeld) {
      this.message = MOVE_PENDING;
      this.publish();
      return;
    }
    if (this.saving || !this.dirty || useVaultStore.getState().vaultPath !== this.key.vaultId)
      return;
    const generation = this.generation;
    const nameGeneration = this.nameGeneration;
    const { name, draft } = this;
    let retired = false;
    const stop = useVaultStore.subscribe((next, previous) => {
      if (next.vaultPath !== previous.vaultPath) retired = true;
    });
    const current = () => !retired && useVaultStore.getState().vaultPath === this.key.vaultId;
    this.inFlightGeneration = generation;
    this.message = null;
    this.failure = null;
    this.refreshFailed = false;
    this.publish();
    try {
      // Reading also refuses deleted targets. Overwrite is still checked against
      // this fresh version; it is never a create or an unconditional write.
      const source = await readNoteSource(this.key.vaultId, this.key.path);
      if (!current()) throw new Error('The vault changed. Your draft is retained.');
      if (!overwrite && source.hash !== this.baseHash) throw new Error('stale_content: changed');
      if (generation > this.writtenGeneration || overwrite) {
        const submittedBody = bodyOf(draft);
        let body = submittedBody;
        if (!body.endsWith('\n')) body += '\n';
        const title = name.trim();
        const titleChanged = title !== '' && title !== this.saved.name;
        if (titleChanged) body = replaceH1(body, title);
        const savedDraft = withBody(draft, body);
        let receipt: BatchApplied | null = null;
        let refusal: string | null = null;
        const accept = (applied: BatchApplied) => {
          const hash = applied.files.find((file) => file.path === this.key.path)?.afterHash;
          if (!hash) return;
          receipt = applied;
          this.baseHash = hash;
          this.writtenGeneration = generation;
          if (
            draft.kind === 'skill' &&
            (this.pendingActivation !== null ||
              scheduleText(draft.value.schedule) !==
                scheduleText(
                  this.saved.draft.kind === 'skill' ? this.saved.draft.value.schedule : [],
                ))
          ) {
            const existing = this.pendingActivation;
            this.pendingActivation = {
              identity: recordIdentity({
                ...this.entry,
                properties: { ...this.entry.properties, slug: draft.value.slug },
              }),
              schedule: [...draft.value.schedule],
              now:
                existing && scheduleText(existing.schedule) === scheduleText(draft.value.schedule)
                  ? existing.now
                  : new Date(),
            };
          }
          this.saved = { name: title || this.saved.name, draft: savedDraft };
          // Carry this acknowledged name decision into newer prose only if
          // its authored H1 is still the submitted one. An intentional newer
          // H1 edit wins; ordinary edits below it must not undo the rename.
          if (
            titleChanged &&
            this.generation > generation &&
            h1Line(bodyOf(this.draft)) === h1Line(submittedBody)
          ) {
            this.draft = withBody(this.draft, replaceH1(bodyOf(this.draft), title));
            this.publish();
          }
        };
        try {
          const applied = await useVaultStore.getState().applyBatch(
            [
              {
                op: 'body',
                path: this.key.path,
                body,
                expectHash: overwrite ? source.hash : this.baseHash,
              },
              {
                op: 'patch',
                path: this.key.path,
                set: draft.kind === 'skill' ? skillPatch(draft.value) : templatePatch(draft.value),
              },
            ],
            {
              stillCurrent: current,
              onApplied: accept,
              onRefused: (message) => {
                refusal = message;
              },
            },
          );
          if (receipt === null && applied !== null) accept(applied);
        } catch (error) {
          if (receipt === null) throw error;
          this.refreshFailed = true;
        }
        if (receipt === null)
          throw new Error(refusal ?? 'The change could not be saved. Your draft is retained.');
        if (current() && useVaultStore.getState().status === 'error') this.refreshFailed = true;
      }
      if (!current())
        throw new Error('The vault changed. Your saved result will be checked on Retry.');
      if (this.pendingActivation !== null) {
        const pending = this.pendingActivation;
        if (
          !(await stampActivation(
            this.key.vaultId,
            pending.identity,
            pending.schedule,
            pending.now,
          ))
        )
          throw new Error(SCHEDULE_STAMP_FAILED);
        if (!current())
          throw new Error('The vault changed. Your schedule boundary will be checked on Retry.');
        this.pendingActivation = null;
      }
      // A directly authored H1 can change the scanned name as well. Adopt
      // only the metadata belonging to the acknowledged bytes, never a newer
      // outside scan or another vault's entry.
      const state = useVaultStore.getState();
      const refreshed =
        state.entriesVault === this.key.vaultId
          ? state.entries.find(
              (candidate) => candidate.path === this.key.path && candidate.hash === this.baseHash,
            )
          : undefined;
      if (refreshed) this.saved = { ...this.saved, name: refreshed.title };
      this.acknowledgedGeneration = generation;
      this.stale = false;
      // Newer prose does not constitute a new Name decision. Reconcile the
      // untouched field with the acknowledged H1, while preserving a Name
      // explicitly edited during Save (including an edit away and back).
      if (this.nameGeneration === nameGeneration) this.name = this.saved.name;
      if (this.generation === generation) {
        this.draft = this.saved.draft;
      }
    } catch (error) {
      this.stale = isStaleContent(error);
      this.message = this.stale
        ? 'The file changed on disk. Your draft is retained.'
        : error instanceof Error
          ? error.message
          : "Couldn't save. Your draft is retained.";
      this.failure = {
        kind: 'failed',
        ownerId: this.key.ownerId,
        generation,
        code: this.stale ? 'stale_content' : 'library_save_failed',
      };
    } finally {
      stop();
      this.inFlightGeneration = null;
      this.publish();
    }
  }
}
