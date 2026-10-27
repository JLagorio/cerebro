import type { RecoveryStatus, RecoveryVersion, RecoveryFailure } from '@/engine/recovery';
import type { Extraction } from '@/engine/extracted';
import type {
  MetadataPatchRequest,
  MetadataPatchResult,
  SelectedPropertySnapshot,
  AuthorityError,
  WorkspaceBackupAvailability,
  WorkspaceBackupChoiceResult,
  WorkspaceBackupCommitResult,
  WorkspaceBackupCancelResult,
  WorkspaceBackupOperation,
  EditorSaveRefusal,
  EditorSaveRequest,
  EditorSaveResult,
  LegacyRecordSnapshot,
  SelectedMetadataAck,
  SelectedEditorSnapshot,
  SelectedEditorTarget,
  SelectedMode,
  SelectedRecordVersion,
} from './generated/workspace';
import { setSelectedFullWidth } from './selectedMock';
import type { Followup, FollowupClaim } from '@/engine/followups';
import type {
  ClientTokenRequest,
  ClientToken,
  CreatedClientToken,
  ClientAccessStatus,
} from '@/engine/clientAccess';
// IPC facade: every vault operation in the app goes through these functions.
// Inside Tauri (detected via __TAURI_INTERNALS__) they invoke the Rust
// commands; in the browser (pnpm dev, vitest, Playwright) they delegate to
// the in-memory mock in mockIpc.ts. A browser branch may pass through
// `faulted` (mockFaults.ts, M64.1), which fails it once when the state lab or
// a test arms that command; a part wraps exactly the commands its presets
// fail. ipcContract.test.ts holds every command name and payload key here
// to Rust's generate_handler!.
// The watcher's two events are heard here: `vault-changed`
// (listenVaultChanged) and `comments-changed` (listenCommentsChanged), which
// the browser has no watcher to emit. So is the shell's
// `cerebro://quit-requested` (listenQuitRequested, M55.10), which the mock
// fires from `window.__cerebroMockQuit`.
import type { PageAttribution } from '@/engine/attribution';
import type { CommentAnchor } from '@/engine/commentAnchor';
import type { CommentsFile } from '@/engine/comments';
import type { ConnectorStatusRow } from '@/engine/connectors';
import type { TrashedItem } from '@/engine/trash';
import type { BatchApplied, BatchOp, OpenReport } from '@/engine/batch';
import type { Entry } from '@/engine/types';
import type { SheetInput, SheetResult } from '@/engine/sheet/fence';
import type { DroppedFile, DroppedText, OsDropEvent } from '@/engine/osDrop';
import type { AttachmentImport } from '@/engine/attachments';
import { faulted } from './mockFaults';
import * as mock from './mockIpc';

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Transport availability only; the native snapshot and writer still admit each page. */
export function supportsSelectedEditor(): boolean {
  return inTauri();
}

async function invokeTauri<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export function pickVault(): Promise<string | null> {
  return inTauri() ? invokeTauri('pick_vault') : mock.pickVault();
}

/**
 * Copy the demo vault out of the app bundle into a folder the user can edit,
 * and return its path. In the browser the mock vault is already that folder.
 */
export function openDemoVault(): Promise<string> {
  return inTauri() ? invokeTauri('open_demo_vault') : mock.openDemoVault();
}

export interface StarterMarker {
  kit: number;
  outcome: 'added' | 'declined';
  offered_at?: string;
}

export function starterMarker(vault: string): Promise<StarterMarker | null> {
  return inTauri()
    ? invokeTauri('starter_marker', { vault })
    : faulted('starter_marker', () => mock.starterMarker(vault));
}

export function installStarterKit(vault: string): Promise<{ marker_saved: boolean }> {
  return inTauri()
    ? invokeTauri('install_starter_kit', { vault })
    : faulted('install_starter_kit', () => mock.installStarterKit(vault));
}

export function declineStarterKit(vault: string): Promise<void> {
  return inTauri() ? invokeTauri('decline_starter_kit', { vault }) : mock.declineStarterKit(vault);
}

export function getLastVault(): Promise<string | null> {
  return inTauri() ? invokeTauri('get_last_vault') : mock.getLastVault();
}

/**
 * The Agent record handle this vault's assistant panel is bound to, or null
 * for the plain assistant (M56.6). Stored in the app's config.json by vault
 * path, never in the vault, so a vault cannot choose who the panel answers
 * as.
 */
export function getPanelAgent(vault: string): Promise<string | null> {
  return inTauri() ? invokeTauri('panel_agent', { vault }) : mock.getPanelAgent(vault);
}

/** Bind this vault's panel to a handle, or unbind it with null or a blank.
 * Throws, writing nothing, for a value that is not a handle. */
export function setPanelAgent(vault: string, handle: string | null): Promise<void> {
  return inTauri()
    ? invokeTauri('set_panel_agent', { vault, handle })
    : mock.setPanelAgent(vault, handle);
}

export function scanVault(vault: string): Promise<Entry[]> {
  // Faulted so the state lab can stage a failed vault read (M64.7's Speakers).
  return inTauri()
    ? invokeTauri('scan_vault', { vault })
    : faulted('scan_vault', () => mock.scanVault(vault));
}

/** Dedicated selected one-key metadata action; no general patch/body writer. */
export async function setPageFullWidth(
  vault: string,
  path: string,
  expected: SelectedRecordVersion,
  mode: SelectedMode,
): Promise<SelectedMetadataAck> {
  return inTauri()
    ? invokeTauri('set_page_full_width', { vault, path, expected, mode })
    : setSelectedFullWidth(vault, path, expected, mode);
}

export interface MailGateRead {
  state: 'closed' | 'other_vault' | 'open';
  kinds: string[];
}
export function mailGateRead(vault: string): Promise<MailGateRead> {
  return inTauri()
    ? invokeTauri('mail_gate_read', { vault })
    : faulted('mail_gate_read', () => mock.mailGateRead(vault));
}

export function readNote(vault: string, path: string): Promise<string> {
  return inTauri()
    ? invokeTauri('read_note', { vault, path })
    : faulted('read_note', () => mock.readNote(vault, path));
}

/** One native selected snapshot returns the complete file without legacy
 * frontmatter splitting or newline normalization. */
export function readEditorBody(
  vault: string,
  path: string,
  target: SelectedEditorTarget,
): Promise<SelectedEditorSnapshot> {
  return inTauri()
    ? invokeTauri('read_editor_body', { vault, path, target })
    : Promise.reject(selectedBrowserUnavailable());
}

/** Guarded native canonical value only; the browser has no selected store. */
export function readSelectedProperty(vault:string,path:string,target:SelectedEditorTarget,field:string):Promise<SelectedPropertySnapshot>{
 return inTauri()?invokeTauri<SelectedPropertySnapshot>('read_selected_property',{vault,path,target,field}):Promise.reject(selectedBrowserUnavailable());
}
/** Retain the real invoke through quit/leave; timeout never cancels its owner. */
export function patchSelectedMetadata(vault:string,path:string,request:MetadataPatchRequest):Promise<MetadataPatchResult>{
 return pageWrite<MetadataPatchResult>(inTauri()?invokeTauri<MetadataPatchResult>('patch_selected_metadata',{vault,path,request}):Promise.reject({kind:'metadata_refused',error:selectedBrowserUnavailable()}));
}

/** Whole bytes and their hash from one read, for a save that compares versions. */
export function readNoteSource(vault: string, path: string): Promise<LegacyRecordSnapshot> {
  return inTauri()
    ? invokeTauri('read_note_source', { vault, path })
    : faulted('read_note_source', () => mock.readNoteSource(vault, path));
}

import type { ExcerptPart, VaultHit, VaultSearch } from './mockIpc';
export type { ExcerptPart, VaultHit, VaultSearch };

/**
 * ⌘K's page-text search (M59.4): the vault's notes ranked by search.rs over
 * its cached corpus, the same ranker search_notes uses, up to `limit` hits
 * (at most 50). The browser mock matches by containment only.
 */
export function searchVault(vault: string, query: string, limit: number): Promise<VaultSearch> {
  return inTauri()
    ? invokeTauri('search_vault', { vault, query, limit })
    : mock.searchVault(vault, query, limit);
}

export function resolveSource(
  vault: string,
  locator: import('@/engine/sourceLocation').SourceLocator,
): Promise<import('@/engine/sourceLocation').ResolveSourceResult> {
  return inTauri()
    ? invokeTauri('resolve_source', { vault, locator })
    : mock.resolveSource(vault, locator);
}

/** Contextual raw-source occurrences; mentions are explicitly requested. */
export function findSourceOccurrences(
  vault: string,
  targetPath: string,
  mode: import('@/engine/sourceOccurrences').OccurrenceMode,
  cursor: string | null = null,
): Promise<import('@/engine/sourceOccurrences').OccurrencePage> {
  return inTauri()
    ? invokeTauri('find_source_occurrences', { vault, targetPath, mode, cursor })
    : faulted('find_source_occurrences', () =>
        mock.findSourceOccurrences(vault, targetPath, mode, cursor),
      );
}

// --- Page writes (M55.10) ---------------------------------------------------
//
// A quit waits for the writes a page makes: the editor's save, a property
// commit and a title commit. Each goes through `pageWrite`, which keeps a
// settled copy until it lands and counts the ones that fail. Callers get a
// promise that settles the same way, so a rejection still reaches them, and
// one nobody handles is still reported as unhandled (M53.24). A create,
// rename, delete or view save is not tracked.

const pageWrites = new Set<Promise<void>>();
let pageWriteFailureCount = 0;

function pageWrite<T>(write: Promise<T>): Promise<T> {
  const settled: Promise<void> = write
    .then(
      () => undefined,
      () => {
        pageWriteFailureCount += 1;
      },
    )
    .finally(() => {
      pageWrites.delete(settled);
    });
  pageWrites.add(settled);
  return write.then((value) => value);
}

/** How many page writes have failed in this session. */
export function pageWriteFailures(): number {
  return pageWriteFailureCount;
}

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Wait for every page write in flight, including one started while waiting.
 * Resolves true once none is left and none starts for one more macrotask, or
 * false when `budgetMs` runs out first. Never rejects.
 */
export async function settlePageWrites(budgetMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const budget = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), budgetMs);
  });
  const drained = (async () => {
    while (!done) {
      while (pageWrites.size > 0 && !done) await Promise.all([...pageWrites]);
      await macrotask();
      if (pageWrites.size === 0) return true;
    }
    return false;
  })();
  try {
    return await Promise.race([drained, budget]);
  } finally {
    done = true;
    clearTimeout(timer);
  }
}

/** Test isolation: forget every tracked write and failure. */
export function __resetPageWrites(): void {
  pageWrites.clear();
  pageWriteFailureCount = 0;
}

export type { NoteWriteAck } from '@/editor/documentOwner';

interface NoteBodySaveInput {
  vault: string;
  path: string;
  body: string;
  bodyFormat?: 'rich' | 'source';
  recoveryBypass?: string;
}
class SelectedEditorSaveError extends Error {
  readonly kind = 'selected_refused';
  constructor(readonly error: EditorSaveRefusal['error']) {
    super(error.message);
    this.name = 'SelectedEditorSaveError';
  }
}
function selectedBrowserUnavailable(): AuthorityError {
  return {
    code: 'capability_unavailable',
    kind: 'unsupported_operation',
    message: 'Selected page editing is unavailable here.',
    retryable: false,
  };
}
function selectedSaveError(value: unknown): unknown {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('kind' in value) ||
    value.kind !== 'selected_refused' ||
    !('error' in value) ||
    typeof value.error !== 'object' ||
    value.error === null
  )
    return value;
  const detail = value.error;
  if (
    !('code' in detail) ||
    detail.code !== 'capability_unavailable' ||
    !('kind' in detail) ||
    typeof detail.kind !== 'string' ||
    !('message' in detail) ||
    typeof detail.message !== 'string' ||
    !('retryable' in detail) ||
    typeof detail.retryable !== 'boolean'
  )
    return value;
  // The closed native envelope is the discriminant; its inner kind is detail,
  // never a permission. Transport and legacy string failures remain unchanged.
  return new SelectedEditorSaveError(detail as AuthorityError);
}
export function saveNoteBody(
  input: NoteBodySaveInput & { editorRequest: EditorSaveRequest },
): Promise<EditorSaveResult>;
export function saveNoteBody(
  input: NoteBodySaveInput & { editorRequest?: undefined },
): Promise<import('@/editor/documentOwner').NoteWriteAck>;
export function saveNoteBody(
  input: NoteBodySaveInput & { editorRequest?: EditorSaveRequest },
): Promise<import('@/editor/documentOwner').DocumentWriteResult>;
export function saveNoteBody({
  vault,
  path,
  body,
  bodyFormat = 'rich',
  recoveryBypass,
  editorRequest,
}: NoteBodySaveInput & { editorRequest?: EditorSaveRequest }): Promise<
  import('@/editor/documentOwner').DocumentWriteResult
> {
  if (editorRequest === undefined)
    return pageWrite(
      inTauri()
        ? invokeTauri('save_note', { vault, path, body, bodyFormat, recoveryBypass })
        : mock.saveNoteBody({ vault, path, body, bodyFormat, recoveryBypass }),
    );
  const write = inTauri()
    ? invokeTauri<EditorSaveResult>('save_note', {
        vault,
        path,
        body,
        bodyFormat,
        recoveryBypass,
        editorRequest,
      })
    : Promise.reject<EditorSaveResult>(new SelectedEditorSaveError(selectedBrowserUnavailable()));
  return pageWrite(
    write.catch((error: unknown) => {
      throw selectedSaveError(error);
    }),
  );
}

export function recoveryStatus(vault: string): Promise<RecoveryStatus> {
  return inTauri()
    ? invokeTauri('recovery_status', { vault })
    : faulted('recovery_status', () => mock.recoveryStatus(vault));
}
export function setRecoveryEnabled(vault: string, enabled: boolean): Promise<RecoveryStatus> {
  return inTauri()
    ? invokeTauri('set_recovery_enabled', { vault, enabled })
    : mock.setRecoveryEnabled(vault, enabled);
}
export function listRecovery(vault: string, path: string): Promise<RecoveryVersion[]> {
  return inTauri()
    ? invokeTauri('list_recovery', { vault, path })
    : faulted('list_recovery', () => mock.listRecovery(vault, path));
}
export function readRecovery(vault: string, path: string, recoveryId: string): Promise<string> {
  return inTauri()
    ? invokeTauri('read_recovery', { vault, path, recoveryId })
    : mock.readRecovery(vault, path, recoveryId);
}
export function deleteRecovery(vault: string, path: string, recoveryId: string): Promise<boolean> {
  return inTauri()
    ? invokeTauri('delete_recovery', { vault, path, recoveryId })
    : mock.deleteRecovery(vault, path, recoveryId);
}
export function clearRecovery(vault: string): Promise<number> {
  return inTauri() ? invokeTauri('clear_recovery', { vault }) : mock.clearRecovery(vault);
}
export function recoveryFailure(
  vault: string,
  path: string,
  nonce: string,
): Promise<RecoveryFailure> {
  return inTauri()
    ? invokeTauri('recovery_failure', { vault, path, nonce })
    : mock.recoveryFailure(vault, path, nonce);
}
export function restoreRecovery(
  vault: string,
  path: string,
  recoveryId: string,
  expectHash: string,
  recoveryBypass?: string,
): Promise<import('@/editor/documentOwner').NoteWriteAck> {
  return pageWrite(
    inTauri()
      ? invokeTauri('restore_recovery', { vault, path, recoveryId, expectHash, recoveryBypass })
      : mock.restoreRecovery(vault, path, recoveryId, expectHash, recoveryBypass),
  );
}
export function exportRecovery(
  vault: string,
  path: string,
  recoveryId: string,
): Promise<string | null> {
  return inTauri()
    ? invokeTauri('export_recovery', { vault, path, recoveryId })
    : mock.exportRecovery(vault, path, recoveryId);
}

/** Session-only draft recovery. These doors never flush or acknowledge the source. */
export type DraftTargetProbe =
  { kind: 'present' | 'missing' } | { kind: 'unavailable'; code: string };
export type DraftExportFormat = 'json' | 'md' | 'mmd' | 'canvas';
export type DraftExportChoice = { kind: 'chosen'; token: string } | { kind: 'cancelled' };
export type DraftExportResult = { kind: 'exported'; destination: string };
export type RecoveredPage = { path: string; contentHash: string; batch: BatchApplied };

export function probeDraftTarget(vault: string, path: string): Promise<DraftTargetProbe> {
  return inTauri()
    ? invokeTauri('probe_draft_target', { vault, path })
    : faulted('probe_draft_target', () => mock.probeDraftTarget(vault, path));
}
export function chooseDraftExport(
  vault: string,
  path: string,
  defaultName: string,
  format: DraftExportFormat,
  contentHash: string,
): Promise<DraftExportChoice> {
  return inTauri()
    ? invokeTauri('choose_draft_export', { vault, path, defaultName, format, contentHash })
    : faulted('choose_draft_export', () =>
        mock.chooseDraftExport(vault, path, defaultName, format, contentHash),
      );
}
export function commitDraftExport(
  vault: string,
  token: string,
  content: string,
): Promise<DraftExportResult> {
  return inTauri()
    ? invokeTauri('commit_draft_export', { vault, token, content })
    : faulted('commit_draft_export', () => mock.commitDraftExport(vault, token, content));
}
export function cancelDraftExport(token: string): Promise<void> {
  return inTauri() ? invokeTauri('cancel_draft_export', { token }) : mock.cancelDraftExport(token);
}
export function createRecoveredPage(
  vault: string,
  originalPath: string,
  destinationPath: string,
  content: string,
): Promise<RecoveredPage> {
  return inTauri()
    ? invokeTauri('create_recovered_page', { vault, originalPath, destinationPath, content })
    : faulted('create_recovered_page', () =>
        mock.createRecoveredPage(vault, originalPath, destinationPath, content),
      );
}

export async function saveNote(
  vault: string,
  path: string,
  body: string,
  expectHash?: string,
): Promise<string | null> {
  const ack: import('@/editor/documentOwner').NoteWriteAck = await pageWrite(
    inTauri()
      ? invokeTauri('save_note', { vault, path, body, expectHash })
      : mock.saveNoteBody({ vault, path, body, expectHash }),
  );
  return ack.kind === 'file' ? ack.contentHash : null;
}

/**
 * Patch a note's frontmatter. Answers the SHA-256 of the bytes written
 * (M55.2), or null when the knowledge capture valve took the write: the
 * projection is the ledger's, and the next scan reads its hash.
 */
export function updateFrontmatter(
  vault: string,
  path: string,
  patch: Record<string, unknown>,
): Promise<string | null> {
  return pageWrite(
    inTauri()
      ? invokeTauri('update_frontmatter', { vault, path, patch })
      : mock.updateFrontmatter(vault, path, patch),
  );
}

/**
 * Record a human verification on a knowledge concept (M5). Separate from
 * updateFrontmatter because that path REFUSES writes under `knowledge/` —
 * the bundle is the agent's to write and yours to verify. Both backends
 * scope this command to the `verified` key.
 */
export function verifyConcept(
  vault: string,
  path: string,
  patch: Record<string, unknown>,
  viewedBodyHash: string,
): Promise<void> {
  return inTauri()
    ? invokeTauri('verify_concept', { vault, path, patch, viewedBodyHash })
    : mock.verifyConcept(vault, path, patch, viewedBodyHash);
}

/**
 * The M23.5 capture boundary: a structured edit to a knowledge projection
 * becomes an assertion+revision batch; an editorial edit becomes a
 * projection override. The M23.7 valve routes in-app projection edits here
 * instead of the guard refusal. `request.kind` selects the channel.
 */
export function captureConceptEdit(vault: string, request: Record<string, unknown>): Promise<void> {
  return inTauri()
    ? invokeTauri('capture_concept_edit', { vault, request })
    : mock.captureConceptEdit(vault, request);
}

export function createNote(
  vault: string,
  folder: string,
  slug: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<string> {
  return inTauri()
    ? invokeTauri('create_note', { vault, folder, slug, frontmatter, body })
    : mock.createNote(vault, folder, slug, frontmatter, body);
}

export function setNoteTitle(vault: string, path: string, title: string): Promise<void> {
  return pageWrite(
    inTauri()
      ? invokeTauri('set_note_title', { vault, path, title })
      : mock.setNoteTitle(vault, path, title),
  );
}

export interface RawList {
  id: string;
  yaml: string;
  project: string | null;
  /** Owning Collection's folder; null for a top-level List (M10). */
  collection: string | null;
  /** Vault-relative file path — what rename and delete operate on. */
  path: string;
}

/** Every List in the vault, in all three on-disk shapes (see vault/write.rs). */
export function listViews(vault: string): Promise<RawList[]> {
  return inTauri() ? invokeTauri('list_views', { vault }) : mock.listViews(vault);
}

/** folder scopes the view to a project dir (writes <folder>/views/<id>.yml).
 * Legacy shape — new Lists go through saveList. */
export function saveView(
  vault: string,
  id: string,
  yaml: string,
  folder: string | null = null,
): Promise<void> {
  return inTauri()
    ? invokeTauri('save_view', { vault, id, yaml, folder })
    : mock.saveView(vault, id, yaml, folder);
}

// --- Collections (M10) -----------------------------------------------------

/** Every Collection: each folder holding a `collection.yml`. */
export function listCollections(vault: string): Promise<{ folder: string; yaml: string }[]> {
  return inTauri() ? invokeTauri('list_collections', { vault }) : mock.listCollections(vault);
}

/** Write `<folder>/collection.yml`, creating the folder. */
export function saveCollection(vault: string, folder: string, yaml: string): Promise<void> {
  return inTauri()
    ? invokeTauri('save_collection', { vault, folder, yaml })
    : mock.saveCollection(vault, folder, yaml);
}

/** Write `<folder>/<id>.list.yml`; folder '' means the vault root. */
export function saveList(vault: string, folder: string, id: string, yaml: string): Promise<void> {
  return inTauri()
    ? invokeTauri('save_list', { vault, folder, id, yaml })
    : mock.saveList(vault, folder, id, yaml);
}

/** Legacy opens report measured recovery. Selected opens return null: the
 * legacy recovery protocol is unadopted, so its counts were not recorded. */
export function startWatcher(vault: string): Promise<OpenReport | null> {
  return inTauri() ? invokeTauri('start_watcher', { vault }) : mock.startWatcher(vault);
}

/**
 * Call `handler` on every `vault-changed` event the watcher emits; resolves
 * to the unlisten function once the listener is bound. The browser has no
 * watcher (the mock's startWatcher is a no-op, and its writers rescan
 * directly), so there it binds nothing and resolves a no-op.
 */
export async function listenVaultChanged(handler: () => void): Promise<() => void> {
  if (!inTauri()) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen('vault-changed', () => handler());
}

// --- Connectors (M13.3) ----------------------------------------------------

/** Raw `.cerebro/connectors.json`, '' when the vault has none. Rejects when
 * the file exists but cannot be read — permissions, or a symlinked path the
 * backend refuses to follow (PR #5 review). Runs fail closed on that config,
 * so Settings must render it as blocked, and the conversation rail's
 * Connectors card as unavailable (M92.9), never as "no list". */
export function readConnectors(vault: string): Promise<string> {
  return inTauri()
    ? invokeTauri('read_connectors', { vault })
    : faulted('read_connectors', () => mock.readConnectors(vault));
}

export function saveConnectors(vault: string, json: string): Promise<void> {
  return inTauri()
    ? invokeTauri('save_connectors', { vault, json })
    : mock.saveConnectors(vault, json);
}

/** Each connector in the vault's list with the last status a run saw it in
 * (M54.11). Rejects when the runtime database or the list cannot be read,
 * which Settings shows as unavailable, never as "not observed yet". */
export function connectorStatus(vault: string): Promise<ConnectorStatusRow[]> {
  return inTauri()
    ? invokeTauri('connector_status', { vault })
    : faulted('connector_status', () => mock.connectorStatus(vault));
}

// --- Vault format v2 file operations (M2 Task 3) ---

export function createFolder(vault: string, path: string): Promise<void> {
  return inTauri() ? invokeTauri('create_folder', { vault, path }) : mock.createFolder(vault, path);
}

/** Move a note or folder within the vault. Fails if the target exists. */
export function renameNote(vault: string, from: string, to: string): Promise<void> {
  return inTauri()
    ? invokeTauri('rename_note', { vault, from, to })
    : mock.renameNote(vault, from, to);
}

/** Move a note or folder to the vault's own Trash, `.trash/<stamp>/`, with
 * its comments (M60.8). Resolves the item Settings can restore. */
export function deleteNote(vault: string, path: string): Promise<TrashedItem> {
  return inTauri() ? invokeTauri('delete_note', { vault, path }) : mock.deleteNote(vault, path);
}

/** The vault's Trash, newest first (M60.8). Rejects when it can't be read,
 * which Settings shows as unavailable, never as an empty Trash. */
export function listTrash(vault: string): Promise<TrashedItem[]> {
  return inTauri()
    ? invokeTauri('list_trash', { vault })
    : faulted('list_trash', () => mock.listTrash(vault));
}

/** Put one Trash item back where it came from (M60.8). Resolves the path it
 * restored; refuses rather than overwrite anything. */
export function restoreFromTrash(vault: string, stamp: string): Promise<string> {
  return inTauri()
    ? invokeTauri('restore_from_trash', { vault, stamp })
    : mock.restoreFromTrash(vault, stamp);
}

/** Apply `ops` as one change, all or nothing (M60.6). Resolves one result per
 * page written; rejects in the backend's words, a stale page as
 * `stale_content: …`. The store's `applyBatch` is the caller. */
export function applyBatch(vault: string, ops: BatchOp[]): Promise<BatchApplied> {
  return inTauri()
    ? invokeTauri('apply_batch', { vault, ops })
    : faulted('apply_batch', () => mock.applyBatch(vault, ops));
}

/** All vault directories (for folder trees, including empty folders). */
export function listFolders(vault: string): Promise<string[]> {
  return inTauri() ? invokeTauri('list_folders', { vault }) : mock.listFolders(vault);
}

// --- Page comments (M70.2) --------------------------------------------------
//
// A page's threads live in `.comments/<page>.json`, never in the page. Each
// write answers the page's whole file as written; a person's comments are
// always signed `human:owner` by the backend, never by the webview. Rejects
// in plain words (CV-03): `commentsStore` toasts them.

/** A page's threads: none when it has no sidecar; rejects when the sidecar
 * can't be read, which the page shows as unavailable (CV-05). */
export function listComments(vault: string, path: string): Promise<CommentsFile> {
  return inTauri() ? invokeTauri('list_comments', { vault, path }) : mock.listComments(vault, path);
}

/** Start a thread on a passage, or on the whole page with no anchor. */
export function startCommentThread(
  vault: string,
  path: string,
  anchor: CommentAnchor | null,
  body: string,
): Promise<CommentsFile> {
  return inTauri()
    ? invokeTauri('start_comment_thread', { vault, path, anchor, body })
    : mock.startCommentThread(vault, path, anchor, body);
}

/** Reply at the end of a thread; a resolved thread reopens. */
export function replyToCommentThread(
  vault: string,
  path: string,
  thread: string,
  body: string,
): Promise<CommentsFile> {
  return inTauri()
    ? invokeTauri('reply_to_comment_thread', { vault, path, thread, body })
    : mock.replyToCommentThread(vault, path, thread, body);
}

/** Resolve or reopen a thread. */
export function setCommentThreadResolved(
  vault: string,
  path: string,
  thread: string,
  resolved: boolean,
): Promise<CommentsFile> {
  return inTauri()
    ? invokeTauri('set_comment_thread_resolved', { vault, path, thread, resolved })
    : mock.setCommentThreadResolved(vault, path, thread, resolved);
}

/** Delete one comment: it keeps its place, emptied and stamped. */
export function deleteComment(
  vault: string,
  path: string,
  thread: string,
  comment: string,
): Promise<CommentsFile> {
  return inTauri()
    ? invokeTauri('delete_comment', { vault, path, thread, comment })
    : mock.deleteComment(vault, path, thread, comment);
}

/** Delete a whole thread, stamping it and every live comment. */
export function deleteCommentThread(
  vault: string,
  path: string,
  thread: string,
): Promise<CommentsFile> {
  return inTauri()
    ? invokeTauri('delete_comment_thread', { vault, path, thread })
    : mock.deleteCommentThread(vault, path, thread);
}

/**
 * Call `handler` on every `comments-changed` event the watcher emits: the
 * pages whose sidecars changed outside Cerebro, or null when the OS dropped
 * events and every loaded page should reload. The browser has no watcher,
 * so there it binds nothing and resolves a no-op.
 */
export async function listenCommentsChanged(
  handler: (pages: string[] | null) => void,
): Promise<() => void> {
  if (!inTauri()) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen<{ pages: string[] | null }>('comments-changed', (event) =>
    handler(event.payload?.pages ?? null),
  );
}

// --- Attachments (M16.13c) --------------------------------------------------

/**
 * Whether a native file picker exists at all.
 *
 * Browser builds (pnpm dev, vitest, Playwright) have none, and `pickFiles`
 * returning [] there is indistinguishable from the user cancelling. A files
 * field has to know the difference: one means "offer the typed-path fallback
 * instead", the other means "do nothing".
 */
export function canPickFiles(): boolean {
  return inTauri();
}

/** Native multi-file picker; absolute paths, or [] when cancelled. */
export function pickFiles(): Promise<string[]> {
  return inTauri() ? invokeTauri('pick_files') : mock.pickFiles();
}

export function inspectDropped(paths: readonly string[]): Promise<DroppedFile[]> {
  return inTauri() ? invokeTauri('inspect_dropped', { paths }) : mock.inspectDropped(paths);
}

export function readDroppedText(path: string): Promise<DroppedText> {
  return inTauri() ? invokeTauri('read_dropped_text', { path }) : mock.readDroppedText(path);
}

/** Read a kept Office document; the original is never modified. */
export function extractDocument(vault: string, path: string): Promise<Extraction> {
  return inTauri()
    ? invokeTauri('extract_document', { vault, path })
    : mock.extractDocument(vault, path);
}

/** Tauri positions are physical pixels; DOM hit testing uses CSS pixels. */
export async function listenOsFileDrop(handler: (event: OsDropEvent) => void): Promise<() => void> {
  if (!inTauri()) return mock.listenOsFileDrop(handler);
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  return getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === 'leave') handler({ type: 'leave' });
    else {
      const ratio = window.devicePixelRatio || 1;
      const position = { x: payload.position.x / ratio, y: payload.position.y / ratio };
      if (payload.type === 'over') handler({ type: 'over', position });
      else handler({ type: payload.type, paths: payload.paths, position });
    }
  });
}

/**
 * Copy a file from anywhere on disk into the vault's `attachments/` folder and
 * return its vault-relative path and whether identical bytes were reused.
 *
 * Relative is the whole point: an absolute path breaks the moment the vault is
 * synced to another machine, and a files-first vault has to survive being
 * moved. The destination folder is chosen by the backend, not passed in.
 */
export function importAttachment(vault: string, source: string): Promise<AttachmentImport> {
  return inTauri()
    ? invokeTauri('import_attachment', { vault, source })
    : mock.importAttachment(vault, source);
}

export function importAttachmentBytes(
  vault: string,
  name: string,
  bytesBase64: string,
): Promise<AttachmentImport> {
  return inTauri()
    ? invokeTauri('import_attachment_bytes', { vault, name, bytesBase64 })
    : mock.importAttachmentBytes(vault, name, bytesBase64);
}

/**
 * Write a raw text file (`.mmd` only) into the vault, deduping the stem
 * (`-2`, `-3`, …) when the path is taken; returns the vault-relative path
 * actually written (M29.22). Both backends enforce the extension allowlist
 * and refuse `knowledge/` — this is the door a mermaid block uses to move
 * its source out into a standalone diagram file, not a general writer.
 */
export function writeTextFile(vault: string, path: string, content: string): Promise<string> {
  return inTauri()
    ? invokeTauri('write_text_file', { vault, path, content })
    : mock.writeTextFile(vault, path, content);
}

// --- Open with (M55.9) ------------------------------------------------------

/** What an agent link did: Rust's `AgentLinkOutcome`. */
export type AgentLinkOutcome = 'opened' | 'too_long' | 'no_app';

const DESKTOP_ONLY = 'Desktop app only';

/**
 * Whether Open with can reach Finder, the default app and the agent apps.
 * A browser build has none of them, so the menu disables those items.
 */
export function canOpenOutside(): boolean {
  return inTauri();
}

/** Finder selects the note. Rust refuses anything but a vault note. */
export function revealInFinder(vault: string, path: string): Promise<void> {
  return inTauri()
    ? invokeTauri('reveal_in_finder', { vault, path })
    : Promise.reject(new Error(DESKTOP_ONLY));
}

/** The app the Mac opens markdown with opens the note. */
export function openInDefaultApp(vault: string, path: string): Promise<void> {
  return inTauri()
    ? invokeTauri('open_in_default_app', { vault, path })
    : Promise.reject(new Error(DESKTOP_ONLY));
}

/**
 * Hand a prompt to an agent app by its `agent-links.v1.json` id. Rust builds
 * the link and checks its length; `too_long` and `no_app` open nothing, and
 * the caller copies the prompt instead.
 */
export function openAgentLink(target: string, prompt: string): Promise<AgentLinkOutcome> {
  return inTauri()
    ? invokeTauri('open_agent_link', { target, prompt })
    : Promise.reject(new Error(DESKTOP_ONLY));
}

/**
 * Write the clipboard. In the app this goes through `/usr/bin/pbcopy`,
 * because WebKit allows a clipboard write only inside a user gesture and a
 * prompt is built after awaits. The browser writes it itself, and rejects
 * when it has no clipboard.
 */
export function writeClipboard(text: string): Promise<void> {
  if (inTauri()) return invokeTauri('write_clipboard', { text });
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  return clipboard === undefined
    ? Promise.reject(new Error('No clipboard here'))
    : clipboard.writeText(text);
}

// --- Mermaid diagram export (M29.4) -----------------------------------------

/**
 * Save PNG bytes via the native save dialog (M29.4). The export_png command
 * accepts base64 in its JSON request. Returns the chosen absolute
 * path, or null when the user cancels.
 */
export function exportPng(defaultName: string, bytes: Uint8Array): Promise<string | null> {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const bytesBase64 = btoa(binary);
  return inTauri()
    ? invokeTauri('export_png', { defaultName, bytesBase64 })
    : mock.exportPng(defaultName, bytes);
}

/**
 * Save an SVG document via the native save dialog (M44.3). A plain string
 * lane — text needs no base64. Returns the chosen absolute path, or null
 * when the user cancels.
 */
export function exportSvg(defaultName: string, svg: string): Promise<string | null> {
  return inTauri()
    ? invokeTauri('export_svg', { defaultName, svg })
    : mock.exportSvg(defaultName, svg);
}

/** A CSV document leaves through a save dialog, outside the vault write doors. */
export function exportCsv(defaultName: string, csv: string): Promise<string | null> {
  return inTauri()
    ? invokeTauri('export_csv', { defaultName, csv })
    : mock.exportCsv(defaultName, csv);
}

/** The ledger chain head, as `{ seq, hash }` — or null when the vault has no
 * readable ledger. Best-effort by design (M21.7): a checkpoint trailer joins a
 * commit to the ledger head it was made at — a join key, not rewind
 * detection (M49.10) — and a missing head must change nothing about a
 * commit. */
export interface LedgerHead {
  seq: number | null;
  hash: string;
}

export function ledgerHead(vault: string): Promise<LedgerHead | null> {
  return inTauri() ? invokeTauri('ledger_head', { vault }) : mock.ledgerHead(vault);
}

// The ledger status shapes live in mockIpc (the module graph stays a tree:
// ipc imports the mock, never the reverse), re-exported here because the app
// imports its IPC types from the IPC module.
import type { LedgerStatus, QuarantinedPath, WriterStatus } from './mockIpc';
export type { LedgerStatus, QuarantinedPath, WriterStatus };

/** The M23.7 reconciliation exits. Whole vault: `action` is
 * `accept_current_files` or `restore_ledger_authority`. One file (M49.5):
 * pass its `path` with `keep` or `restore`. Only the Tauri backend can
 * resolve (the browser has no ledger). */
export function resolveReconciliation(vault: string, action: string, path?: string): Promise<void> {
  return inTauri()
    ? invokeTauri('resolve_reconciliation', { vault, action, path: path ?? null })
    : mock.resolveReconciliation(vault, action, path);
}

export function ledgerStatus(vault: string): Promise<LedgerStatus> {
  return inTauri() ? invokeTauri('ledger_status', { vault }) : mock.ledgerStatus(vault);
}

// --- The review surface (M24.9) --------------------------------------------

// The card shapes live in mockIpc so the module graph stays a tree: ipc
// imports the mock, and a type import pointing back would close a cycle that
// vitest's module ordering can trip over. Re-exported here because the app
// imports its IPC types from the IPC module.
import type {
  BeliefChips,
  CardLink,
  CardTarget,
  ChangesView,
  LanesView,
  ReviewCard,
  RevertableApplication,
} from './mockIpc';
import type { PendingDecision, PendingWrite } from './mockIpc';

export type { CardLink, CardTarget, ReviewCard, RevertableApplication };
export type {
  AuthorityScope,
  BeliefChips,
  BeliefFacetKey,
  ChangeLine,
  ChangeSection,
  ChangesView,
  Coverage,
  FacetChips,
  FacetPredicate,
  FreshnessBasis,
  LaneItem,
  LanesView,
  LaneView,
  ReviewStatus,
  Support,
  SupportFamily,
  Validity,
} from './mockIpc';

/** Cards awaiting a human. Rebuilt from the ledger on every call — nothing
 * is cached, so a wiped app-data directory cannot lose one. */
export function reviewQueue(vault: string): Promise<ReviewCard[]> {
  return inTauri()
    ? invokeTauri('review_queue', { vault })
    : faulted('review_queue', () => mock.reviewQueue(vault));
}

/** Support/Coverage/Validity per belief facet (M27.5b).
 *
 * Rebuilt from the ledger on every call, and derived nowhere else: the `line`
 * each row carries is composed in Rust so the sentence exists once. A vault
 * with no ledger REFUSES rather than answering `[]` — "there is no ledger
 * here" and "nothing rests under anything" are opposite sentences, and the
 * caller decides which one to show. */
export function beliefChips(vault: string): Promise<BeliefChips[]> {
  return inTauri() ? invokeTauri('belief_chips', { vault }) : mock.beliefChips(vault);
}

/** The four attention lanes, after §33's firewall (M27.8b).
 *
 * Every lane the artifact declares comes back whether or not it holds
 * anything, and every sentence in it was composed beside the rule that
 * produced it. A vault with no ledger REFUSES — the caller renders that
 * differently from four empty lanes, because it is a different fact. */
export function attentionLanes(vault: string): Promise<LanesView> {
  return inTauri() ? invokeTauri('attention_lanes', { vault }) : mock.attentionLanes(vault);
}

/** The convergence window after the last stored run, unless explicitly set.
 * Home reads its Done window through homeChanges (M64.4b). */
export function converge(vault: string, fromSeq?: number): Promise<ChangesView> {
  return inTauri()
    ? invokeTauri('converge', { vault, fromSeq: fromSeq ?? null })
    : mock.converge(vault, fromSeq);
}

export function revertableApplications(vault: string): Promise<RevertableApplication[]> {
  return inTauri()
    ? invokeTauri('revertable_applications', { vault })
    : mock.revertableApplications(vault);
}

/** Approve or reject one card. A rejection REQUIRES a reason — the server
 * refuses without one, and the caller is expected to read the result rather
 * than fire and forget (the proposal-channel carve-out in AGENTS.md).
 * Resolves to the set's transition code once its last member is decided,
 * or null while the set is still waiting on its peers. */
export function decideProposal(
  vault: string,
  proposalId: string,
  approve: boolean,
  reviewer: string,
  reason: string | null,
): Promise<string | null> {
  return inTauri()
    ? invokeTauri('decide_proposal', {
        vault,
        proposalId,
        approve,
        reviewer,
        reason,
      })
    : mock.decideProposal(vault, proposalId, approve, reviewer, reason);
}

/** Undo an applied change by appending a NEW forward mutation. The applied
 * event ids are the ones the card showed: handing back anything else is
 * `revert_not_current`. History is never rewound. */
export function revertApplication(
  vault: string,
  proposalId: string,
  appliedEventIds: string[],
  reviewer: string,
): Promise<string> {
  return inTauri()
    ? invokeTauri('revert_application', {
        vault,
        proposalId,
        appliedEventIds,
        reviewer,
      })
    : mock.revertApplication(vault, proposalId, appliedEventIds, reviewer);
}

// --- Queued page writes (M57.4c) --------------------------------------------

export type { PendingDecision, PendingWrite };

/** The page writes ask-first agents queued for Review, oldest first. They
 * live in runtime.db, not the ledger: a read that fails rejects, and Review
 * says it could not tell rather than showing none. */
export function pendingWrites(vault: string): Promise<PendingWrite[]> {
  return inTauri()
    ? invokeTauri('pending_writes', { vault })
    : faulted('pending_writes', () => mock.pendingWrites(vault));
}

/** Allow or Reject one queued write. `input` is the person's edit of the
 * draft, sent only with Allow; a Reject needs a reason. The answer is typed
 * and READ at the call site (the proposal-channel carve-out in AGENTS.md):
 * an edit Cerebro refused keeps the card, and a write another decision got
 * to first is no error. */
export function decidePendingWrite(
  vault: string,
  pendingId: string,
  allow: boolean,
  input: Record<string, unknown> | null,
  reason: string | null,
): Promise<PendingDecision> {
  return inTauri()
    ? invokeTauri('decide_pending_write', { vault, pendingId, allow, input, reason })
    : mock.decidePendingWrite(vault, pendingId, allow, input, reason);
}

// --- The control surface (M25.7) -------------------------------------------

// Same module-graph rule as the review surface: the shapes live in mockIpc so
// ipc imports it one way only.
import type {
  PipelineActivity,
  PipelineBanner,
  PipelineHeld,
  PipelineLane,
  PipelineMeter,
  PipelineOverview,
  ItemState,
  Asked,
  AskRefusal,
  QueryIntendedUse,
} from './mockIpc';

export type {
  PipelineActivity,
  PipelineBanner,
  PipelineHeld,
  PipelineLane,
  PipelineMeter,
  PipelineOverview,
  ItemState,
  Asked,
  AskRefusal,
  QueryIntendedUse,
};

/** The pause, the meter, the lanes, recent activity, and every banner — one
 * query, so the panel cannot render a paused pipeline beside a budget it read
 * a second earlier. */
export function pipelineOverview(vault: string): Promise<PipelineOverview> {
  return inTauri() ? invokeTauri('pipeline_overview', { vault }) : mock.pipelineOverview(vault);
}

// --- The fleet read surface (M33.2) ----------------------------------------

import type {
  ActivityRun,
  HistoryActivity,
  FleetRun,
  FleetRunCause,
  FleetCostComponent,
  FleetAssemblyMetrics,
  FleetRunDetail,
  FleetRefusal,
  FleetActorSummary,
  FleetFilter,
  RunTranscript,
  RunWrite,
} from './mockIpc';

export type {
  ActivityRun,
  HistoryActivity,
  FleetRun,
  FleetRunCause,
  FleetCostComponent,
  FleetAssemblyMetrics,
  FleetRunDetail,
  FleetRefusal,
  FleetActorSummary,
  FleetFilter,
  RunTranscript,
  RunWrite,
};

/** Runs placed by recorded subjects and their bounded hop descendants. */
export function fleetSubjectRuns(
  vault: string,
  subjects: string[],
  limit = 100,
): Promise<FleetRun[]> {
  return inTauri()
    ? invokeTauri('fleet_subject_runs', { vault, subjects, limit })
    : faulted('fleet_subject_runs', () => mock.fleetSubjectRuns(vault, subjects, limit));
}

/**
 * One page of run history, newest first (M33.2).
 *
 * Takes no vault: the fleet spans them, and a caller that wants one vault's
 * runs says so in the filter. REFUSES when there is no runtime database —
 * the section renders "unavailable", which is not "no runs".
 */
export function fleetRuns(filter: FleetFilter = {}): Promise<FleetRun[]> {
  return inTauri()
    ? invokeTauri('fleet_runs', { filter })
    : faulted('fleet_runs', () => mock.fleetRunsPage(filter));
}

import type {
  RunCursor,
  RunHistoryPage,
  RunHistoryScope,
  RunLineage,
  RunOrigin,
} from './runHistory';
export type { RunCursor, RunHistoryPage, RunHistoryScope, RunLineage, RunOrigin };

export function fleetRunsPage(
  scope: RunHistoryScope,
  cursor?: RunCursor,
  limit?: number,
): Promise<RunHistoryPage> {
  return inTauri()
    ? invokeTauri('fleet_runs_page', { scope, cursor, limit })
    : faulted('fleet_runs_page', () => mock.scopedFleetRunsPage(scope, cursor, limit));
}

export function fleetRunLineage(rootRunId: string): Promise<RunLineage> {
  return inTauri()
    ? invokeTauri('fleet_run_lineage', { rootRunId })
    : faulted('fleet_run_lineage', () => mock.fleetRunLineage(rootRunId));
}

/** Captured historical configuration; caller supplies the run's actual open vault. */
export function fleetRunConfiguration(
  vault: string,
  runId: string,
): Promise<import('./runConfiguration').RunConfigurationRead> {
  return inTauri()
    ? invokeTauri('fleet_run_configuration', { vault, runId })
    : faulted('fleet_run_configuration', () => mock.fleetRunConfiguration(vault, runId));
}

export function fleetRunOrigin(vaultId: string | null): Promise<RunOrigin> {
  return inTauri()
    ? invokeTauri('fleet_run_origin', { vaultId })
    : faulted('fleet_run_origin', () => mock.fleetRunOrigin(vaultId));
}

/** Who last changed one page (M58.1b), from runtime.db's write log, read
 * through a read-only handle. Rust hashes the file itself; a path outside the
 * vault reads not recorded. A failed read REFUSES, so the page says it could
 * not tell rather than that nobody changed it. */
export function pageAttribution(vault: string, path: string): Promise<PageAttribution> {
  return inTauri()
    ? invokeTauri('page_attribution', { vault, path })
    : mock.pageAttribution(vault, path);
}

/** What happened in one vault over `[since, until)` (M64.2): its write rows,
 * its runs and when Cerebro had it open, each lane read alone through a
 * read-only handle, for `engine/activity.ts` to fold. A window that is not
 * one REFUSES in words, and so does a runtime database that will not open,
 * which History renders as unavailable, never as an empty year. */
export function vaultActivity(
  vault: string,
  since: string,
  until: string,
): Promise<HistoryActivity> {
  return inTauri()
    ? invokeTauri('vault_activity', { vault, since, until })
    : faulted('vault_activity', () => mock.vaultActivity(vault, since, until));
}

import type { HistoryPageActivity } from './mockIpc';
export type { HistoryPageActivity };

/** What one page's History reads (M64.2b): the names it has had, the write
 * rows under any of them and its comment sidecar, the runs those rows name,
 * when the vault began recording, and on a knowledge page the ledger's
 * events, each lane read alone. A path outside the vault REFUSES in words. */
export function pageActivity(vault: string, path: string): Promise<HistoryPageActivity> {
  return inTauri()
    ? invokeTauri('page_activity', { vault, path })
    : faulted('page_activity', () => mock.pageActivity(vault, path));
}

/** What one run changed in Knowledge (M50.3): the concepts its proposals
 * named and what became of each. `null` is NOT RECORDED — a vault that keeps
 * no ledger — never "changed nothing", which is `[]`. */
export function runKnowledgeWrites(vault: string, runId: string): Promise<RunWrite[] | null> {
  return inTauri()
    ? invokeTauri('run_knowledge_writes', { vault, runId })
    : mock.runKnowledgeWrites(vault, runId);
}

/** One run and whatever the governance tables recorded about it, with the
 * model Claude Code reported answering, the refusals recorded against it
 * (M56.9) and what it wrote (M58.1b). An unknown id is refused, so a typo
 * and an unmetered run never look the same. */
export function fleetRunDetail(runId: string): Promise<FleetRunDetail> {
  return inTauri()
    ? invokeTauri('fleet_run_detail', { runId })
    : faulted('fleet_run_detail', () => mock.fleetRunDetail(runId));
}

/** One run's transcript, folded from Claude Code's own session file (M56.9,
 * D5): read only when asked for, and stored nowhere. A run with no session
 * reads not recorded; an unknown id is refused, as `fleetRunDetail` is. */
export function fleetRunTranscript(runId: string): Promise<RunTranscript> {
  return inTauri()
    ? invokeTauri('fleet_run_transcript', { runId })
    : faulted('fleet_run_transcript', () => mock.fleetRunTranscript(runId));
}

/** What one actor's runs add up to (M33.6). An actor with no runs answers
 * with zeros and a null last outcome rather than refusing — "no runs yet" is
 * what a freshly written Agent record's dossier has to be able to say. */
export function fleetActorSummary(actor: string): Promise<FleetActorSummary> {
  return inTauri() ? invokeTauri('fleet_actor_summary', { actor }) : mock.fleetActorSummary(actor);
}

// --- Job ledgers (M34.2.2) --------------------------------------------------

import type { JobLedgers } from './mockIpc';

export type { JobLedgers };

/**
 * One vault's three scheduling ledgers. REFUSES without a runtime database —
 * an empty ledger reads as "nothing ever ran", which would re-fire every
 * schedule, so the runner must treat this error as "do not run yet".
 */
export function jobLedgerRead(vault: string): Promise<JobLedgers> {
  return inTauri() ? invokeTauri('job_ledger_read', { vault }) : mock.jobLedgerRead(vault);
}

/** Record a run key and learn whether the record was FRESH — false means this
 * exact fire was already answered (another window, an earlier session) and
 * a queue caller must not spawn. Run now may still run manually without
 * consuming that fire. Resume and schedule edits claim without running,
 * recording the newest fire owed nothing. The two-window arbitration lives in the store,
 * not in a renderer promise to be quick. */
export function jobLedgerClaim(
  vault: string,
  ledger: 'attempts' | 'skillRuns',
  key: string,
  runKey: string,
): Promise<boolean> {
  return inTauri()
    ? invokeTauri('job_ledger_claim', { vault, ledger, key, runKey })
    : mock.jobLedgerClaim(vault, ledger, key, runKey);
}

/** Surrender a claim this caller holds — the deferred runner's revert, so a
 * budget refusal never eats the fire it refused. Conditional on the exact
 * runKey: a claim another window re-won is never destroyed. */
export function jobLedgerUnclaim(
  vault: string,
  ledger: 'attempts' | 'skillRuns',
  key: string,
  runKey: string,
): Promise<boolean> {
  return inTauri()
    ? invokeTauri('job_ledger_unclaim', { vault, ledger, key, runKey })
    : mock.jobLedgerUnclaim(vault, ledger, key, runKey);
}

/** Overwrite the trigger cooldown clock. No verdict — a clock is not a claim. */
export function jobLedgerStamp(vault: string, key: string, runKey: string): Promise<void> {
  return inTauri()
    ? invokeTauri('job_ledger_stamp', { vault, ledger: 'triggerRuns', key, runKey })
    : mock.jobLedgerStamp(vault, 'triggerRuns', key, runKey);
}

/** One-time import from the localStorage era. Keys the store already holds
 * are kept — it has been the arbiter since it existed. Returns how many
 * landed. */
export function jobLedgerImport(
  vault: string,
  entries: readonly { ledger: string; key: string; runKey: string }[],
): Promise<number> {
  return inTauri()
    ? invokeTauri('job_ledger_import', { vault, entries })
    : mock.jobLedgerImport(vault, entries);
}

/**
 * Where the ingest scheduler holds one item (M26.4j).
 *
 * `null` means the scheduler has never seen it — an unscanned vault, or
 * ambient ingest that has never been turned on. That is a real answer and
 * renders as "not queued", never as an error.
 */
export function ingestItemState(vault: string, path: string): Promise<ItemState | null> {
  return inTauri()
    ? invokeTauri('ingest_item_state', { vault, path })
    : mock.ingestItemState(vault, path);
}

/**
 * Ask the base a question, attended (M26.5e).
 *
 * The refusal is a RESULT, not a thrown error: `cap_conflict` means accessible
 * counterevidence would not fit under the caps and nothing was synthesized,
 * which is a card the person who asked has to see rather than a toast to
 * dismiss. Read the `state` field.
 */
export function askQuestion(
  vault: string,
  question: string,
  aliases: string[],
  intendedUse: QueryIntendedUse,
): Promise<Asked> {
  return inTauri()
    ? invokeTauri('ask_question', { vault, question, aliases, intendedUse })
    : mock.askQuestion(vault, question, aliases, intendedUse);
}

/**
 * Subscription-wide, and persisted: one CLI account, one background.
 *
 * The WIDER of two pauses since M33b.5 — `setAgentPaused` stops one agent
 * wherever it would have been started from. Neither overrides the other: both
 * are collected at the gate and either is enough to refuse, so resuming one
 * agent while this is on starts nothing.
 */
export function setGlobalPause(paused: boolean): Promise<void> {
  return inTauri() ? invokeTauri('set_global_pause', { paused }) : mock.setGlobalPause(paused);
}

/**
 * How many background runs may be live at once (M33b.2). Subscription-wide
 * and persisted, like the pause; 1 unless somebody raised it.
 *
 * The CURRENT value and the cap arrive on `pipelineOverview` rather than
 * through a getter of their own — the section already does one read and owns
 * one failure, and a second round trip would give the ceiling its own way to
 * be unavailable. This is the write half only.
 *
 * **It rejects rather than clamping.** Below 1 or above the process cap comes
 * back as a thrown refusal naming which end was hit, so the number on screen
 * can never disagree with the number in force.
 */
export function setAmbientConcurrency(ceiling: number): Promise<void> {
  return inTauri()
    ? invokeTauri('set_ambient_concurrency', { ceiling })
    : mock.setAmbientConcurrency(ceiling);
}

/** Per vault, because somebody may want scheduled agents at work and nothing
 * at all in their journal. */
export function setLaneEnabled(vault: string, lane: string, enabled: boolean): Promise<void> {
  return inTauri()
    ? invokeTauri('set_lane_enabled', { vault, lane, enabled })
    : mock.setLaneEnabled(vault, lane, enabled);
}

/** Resolve a held pile: `baseline` accepts today's content as accounted for,
 * `process` queues it. Either way the question is asked once. */
export function resolveHeldItems(
  vault: string,
  which: 'baseline_held' | 'recovery_held',
  choice: 'baseline' | 'process',
): Promise<number> {
  return inTauri()
    ? invokeTauri('resolve_held_items', { vault, which, choice })
    : mock.resolveHeldItems(vault, which, choice);
}

// --- The deferral gates (M28.1) ---------------------------------------------

import type {
  TriggerEntryStatus,
  TriggerGateOutcome,
  TriggerGateRun,
  TriggerGateStatus,
  TriggerLatest,
  TriggerRunReport,
  VerificationScope,
} from './mockIpc';

export type {
  TriggerEntryStatus,
  TriggerGateOutcome,
  TriggerGateRun,
  TriggerGateStatus,
  TriggerLatest,
  TriggerRunReport,
  VerificationScope,
};

/** The board: every gate the shared artifact declares, with its newest
 * recorded evaluation or an explicit never-evaluated. */
export function triggerStatus(vault: string): Promise<TriggerEntryStatus[]> {
  return inTauri() ? invokeTauri('trigger_status', { vault }) : mock.triggerStatus(vault);
}

/** One pass over every gate with a measurable leg. Safe whenever the surface
 * opens — a same-day rerun replays byte-identically. */
export function triggerRun(vault: string): Promise<TriggerRunReport> {
  return inTauri() ? invokeTauri('trigger_run', { vault }) : mock.triggerRun(vault);
}

/** Declare what R7 should count for this vault; returns the canonical digest
 * recorded evaluations will carry. */
export function triggerDeclareR7Scope(vault: string, scopeJson: string): Promise<string> {
  return inTauri()
    ? invokeTauri('trigger_declare_r7_scope', { vault, scopeJson })
    : mock.triggerDeclareR7Scope(vault, scopeJson);
}

/** The declared R7 scope, if any. `null` is "nothing declared"; a rejection
 * is "cannot tell" — the two are never conflated. */
export function triggerR7Scope(vault: string): Promise<VerificationScope | null> {
  return inTauri() ? invokeTauri('trigger_r7_scope', { vault }) : mock.triggerR7Scope(vault);
}

import type { PackRecorded } from './mockIpc';
export type { PackRecorded };

/** Record an owner evidence pack (M28.2): the discretionary road, or R2's
 * hybrid assembly, dispatched on the pack's own gate. `result` is required
 * for discretionary packs ("fired" | "not_fired") and refused for R2, whose
 * result is measured. */
export function triggerRecordPack(
  vault: string,
  repoRoot: string,
  packPath: string,
  result: string | null,
): Promise<PackRecorded> {
  return inTauri()
    ? invokeTauri('trigger_record_pack', { vault, repoRoot, packPath, result })
    : mock.triggerRecordPack(vault, repoRoot, packPath, result);
}

// --- The fleet roster (M33b.3) ---------------------------------------------

/**
 * Every actor the run table has attributed anything to, summed.
 *
 * Deliberately NOT the list of agents: agents are records in a vault, and the
 * roster joins the two so it can say which side each row came from — an agent
 * that has never run, and work that ran under no agent record. Taking no
 * vault, for the same reason `fleetRuns` takes none.
 *
 * An empty array is measured-at-zero. A missing runtime database REFUSES, and
 * the roster renders that as unavailable rather than as an empty team.
 */
export function fleetActorSummaries(): Promise<FleetActorSummary[]> {
  return inTauri()
    ? invokeTauri('fleet_actor_summaries')
    : faulted('fleet_actor_summaries', () => mock.fleetActorSummaries());
}

// --- One agent's own pause (M33b.5) -----------------------------------------

/**
 * Which agents are paused in this vault.
 *
 * Vault-scoped, unlike `setGlobalPause`, and for the opposite reason: the
 * global pause is a property of one CLI subscription, spent once however many
 * vaults debit it, while an agent is a RECORD — two vaults may each hold a
 * `digest` without them being the same colleague.
 *
 * An EMPTY array is measured-at-zero: the rows were read and nobody is paused.
 * A missing runtime database REFUSES, and the roster renders that as
 * unavailable rather than as a fleet it is sure is running.
 */
export function pausedAgents(vault: string): Promise<string[]> {
  return inTauri() ? invokeTauri('paused_agents', { vault }) : mock.pausedAgents(vault);
}

/**
 * Stop or restart ONE agent, without deleting its record (M33b.5).
 *
 * **It THROWS rather than no-opping** when there is nowhere to store the
 * answer. A pause that silently failed to persist would be the worst outcome
 * this control has: the button would look pressed and the agent would keep
 * running.
 *
 * Resuming is not the same as starting. The global pause is collected
 * separately and either is enough to refuse a run, so an agent resumed while
 * the background is paused stays stopped — and the roster row says which of
 * the two is holding it.
 */
export function setAgentPaused(vault: string, actor: string, paused: boolean): Promise<void> {
  return inTauri()
    ? invokeTauri('set_agent_paused', { vault, actor, paused })
    : mock.setAgentPaused(vault, actor, paused);
}

// --- Durable wakes (M63.1) ---------------------------------------------------

import type { AdmitReport, PendingWake, WakeCancel, WakeOffer } from '@/engine/wakes';
export type { AdmitReport, PendingWake, WakeCancel, WakeOffer };

/** Offer trigger matches for admission, each admitted once: a live key is
 * counted, never admitted twice, and a malformed offer or an agent paused on
 * the fleet is refused by name. Throws without a runtime database; the runner
 * keeps the batch and offers it again. */
export function admitWakes(
  vault: string,
  seenAt: string,
  wakes: readonly WakeOffer[],
): Promise<AdmitReport> {
  return inTauri()
    ? invokeTauri('admit_wakes', { vault, seenAt, wakes })
    : mock.admitWakes(vault, wakes, new Date(), seenAt);
}

/** A removed assignment cancels its pending wake, leaving started work alone. */
export function releaseAssignedWakes(
  vault: string,
  agentKey: string,
  subject: string,
  keyPrefix: string,
): Promise<number> {
  return inTauri()
    ? invokeTauri('release_assigned_wakes', { vault, agentKey, subject, keyPrefix })
    : mock.releaseAssignedWakes(vault, agentKey, subject, keyPrefix);
}

/** The vault's pending wakes, oldest first. A failed read throws, and the
 * runner derives no woken run and cancels nothing: gated, not empty. */
export function wakesPending(vault: string): Promise<PendingWake[]> {
  return inTauri() ? invokeTauri('wakes_pending', { vault }) : mock.wakesPending(vault);
}

/** Cancel pending wakes the vault no longer backs, each with its why.
 * Answers how many were still pending and are now cancelled. */
export function cancelWakes(vault: string, cancels: readonly WakeCancel[]): Promise<number> {
  return inTauri()
    ? invokeTauri('cancel_wakes', { vault, cancels })
    : mock.cancelWakes(vault, cancels);
}

import type { FleetWake } from './mockIpc';
export type { FleetWake };

/** What is waiting to wake this vault's agents, and what was skipped or
 * expired this week (M63.1b), optionally for one agent: pending oldest
 * first, then the rest newest first, at most 200. A failed read throws, and
 * the list says unavailable, never that nothing is waiting (CV-05). */
export function fleetWakes(vault: string, actor?: string): Promise<FleetWake[]> {
  return inTauri()
    ? invokeTauri('fleet_wakes', { vault, actor: actor ?? null })
    : mock.fleetWakes(vault, actor ?? null);
}

// --- Diagnostics (M53.24) --------------------------------------------------

import type { FrontendLogEntry } from './mockIpc';
export type { FrontendLogEntry };

/**
 * Hand one uncaught webview error to the diagnostic log. Rust redacts,
 * clamps and writes it; the browser mock drops it, since its console already
 * shows the error.
 *
 * It never rejects. A report that failed would be an unhandled rejection
 * itself, and `installErrorReporting` would report that one too, forever.
 */
export function logFrontend(entry: FrontendLogEntry): Promise<void> {
  const sent = inTauri() ? invokeTauri<void>('log_frontend', { entry }) : mock.logFrontend(entry);
  return sent.catch(() => undefined);
}

// --- Quit (M55.10) -----------------------------------------------------------

import type { QuitRequest } from './mockIpc';
export type { QuitRequest };

/**
 * Hear the shell ask to quit: ⌘Q, the close button or ⌘W. The webview saves
 * and answers with `finishQuit`, or `cancelQuit` to stay open. Resolves to
 * the unlisten function. In the browser, `window.__cerebroMockQuit` asks.
 */
export async function listenQuitRequested(
  handler: (request: QuitRequest) => void,
): Promise<() => void> {
  if (!inTauri()) return mock.listenQuitRequested(handler);
  const { listen } = await import('@tauri-apps/api/event');
  return listen<QuitRequest>('cerebro://quit-requested', (event) => handler(event.payload));
}

/** Every pending edit is saved: exit. Rejects when no quit is in progress. */
export function finishQuit(): Promise<void> {
  return inTauri() ? invokeTauri('finish_quit') : mock.finishQuit();
}

/** A save failed: stay open, and let a later quit ask again. */
export function cancelQuit(): Promise<void> {
  return inTauri() ? invokeTauri('cancel_quit') : mock.cancelQuit();
}

// Durable reminder and Done state (M64.3). Only these adapters reach Rust.
import type {
  ReminderClaim,
  ReminderClaimResult,
  ReminderState,
  DoneMark,
  DoneMarkInput,
  DoneMarkResult,
} from '@/engine/reminderState';
export function reminderState(vault: string): Promise<ReminderState> {
  return inTauri()
    ? invokeTauri('reminder_state', { vault })
    : faulted('reminder_state', () => mock.reminderState(vault));
}
export function reminderClaim(
  vault: string,
  fires: ReminderClaim[],
): Promise<ReminderClaimResult[]> {
  return inTauri()
    ? invokeTauri('reminder_claim', { vault, fires })
    : mock.reminderClaim(vault, fires);
}
export function reminderImport(vault: string, fires: ReminderClaim[]): Promise<number> {
  return inTauri()
    ? invokeTauri('reminder_import', { vault, fires })
    : mock.reminderImport(vault, fires);
}
export function doneMarksRead(vault: string): Promise<DoneMark[]> {
  return inTauri()
    ? invokeTauri('done_marks_read', { vault })
    : faulted('done_marks_read', () => mock.doneMarksRead(vault));
}
export function doneMark(vault: string, mark: DoneMarkInput): Promise<DoneMarkResult> {
  return inTauri() ? invokeTauri('done_mark', { vault, mark }) : mock.doneMark(vault, mark);
}
export function doneUnmark(
  vault: string,
  mark: DoneMark,
  restore: DoneMark | null = null,
): Promise<boolean> {
  return inTauri()
    ? invokeTauri('done_unmark', { vault, mark, restore })
    : mock.doneUnmark(vault, mark, restore);
}
export function doneMarksImport(
  vault: string,
  marks: Pick<DoneMarkInput, 'lane' | 'subject'>[],
): Promise<number> {
  return inTauri()
    ? invokeTauri('done_marks_import', { vault, marks })
    : mock.doneMarksImport(vault, marks);
}

export function homeRuns(
  vault: string,
  limit?: number,
): Promise<{ runs: FleetRun[]; truncated: boolean }> {
  return inTauri()
    ? invokeTauri('home_runs', { vault, limit: limit ?? null })
    : faulted('home_runs', () => mock.homeRuns(vault, limit));
}
export function homeChanges(vault: string, afterSeq?: number): Promise<ChangesView | null> {
  return inTauri()
    ? invokeTauri('home_changes', { vault, afterSeq: afterSeq ?? null })
    : faulted('home_changes', () => mock.homeChanges(vault, afterSeq));
}

export type NotificationPermission = 'allowed' | 'quiet' | 'denied' | 'not-asked' | 'unknown';
export type NotificationPost = NotificationPermission | 'posted' | 'failed';
function permissionWord(word: string): NotificationPermission {
  return word === 'allowed' || word === 'quiet' || word === 'denied' || word === 'not-asked'
    ? word
    : 'unknown';
}
export async function notificationPermission(): Promise<NotificationPermission> {
  const word: string = inTauri()
    ? await invokeTauri('notification_permission')
    : await faulted('notification_permission', () => mock.notificationPermission());
  return permissionWord(word);
}
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  return permissionWord(
    inTauri()
      ? await invokeTauri('request_notification_permission')
      : await mock.requestNotificationPermission(),
  );
}
export async function postNotification(
  id: string,
  title: string,
  body: string,
): Promise<NotificationPost> {
  const word: string = inTauri()
    ? await invokeTauri('post_notification', { id, title, body })
    : await mock.postNotification(id, title, body);
  return word === 'posted' || word === 'failed' ? word : permissionWord(word);
}

export function clientTokens(vault: string): Promise<ClientToken[]> {
  return inTauri()
    ? invokeTauri('client_tokens', { vault })
    : faulted('client_tokens', () => mock.clientTokens(vault));
}
export function createClientToken(
  vault: string,
  request: ClientTokenRequest,
): Promise<CreatedClientToken> {
  return inTauri()
    ? invokeTauri('create_client_token', { vault, request })
    : mock.createClientToken(vault, request);
}
export function revokeClientToken(tokenId: string): Promise<boolean> {
  return inTauri()
    ? invokeTauri('revoke_client_token', { tokenId })
    : mock.revokeClientToken(tokenId);
}
export function clientAccessStatus(): Promise<ClientAccessStatus> {
  return inTauri()
    ? invokeTauri('client_access_status')
    : faulted('client_access_status', () => mock.clientAccessStatus());
}
export function setClientAccess(enabled: boolean, port: number): Promise<ClientAccessStatus> {
  return inTauri()
    ? invokeTauri('set_client_access', { enabled, port })
    : mock.setClientAccess(enabled, port);
}

/** App links are already parsed by Rust; the webview only checks the payload shape. */
export function takeDeepLink(): Promise<unknown> {
  return inTauri() ? invokeTauri('take_deep_link') : mock.takeDeepLink();
}
export async function listenDeepLinks(handler: (payload: unknown) => void): Promise<() => void> {
  if (!inTauri()) return mock.listenDeepLinks(handler);
  const { listen } = await import('@tauri-apps/api/event');
  return listen<unknown>('cerebro://deep-link', (event) => handler(event.payload));
}
export function appLink(vault: string, path: string): Promise<string> {
  return inTauri() ? invokeTauri('app_link', { vault, path }) : mock.appLink(vault, path);
}

/** Sheet calculations return values only; source cells stay on the page. */
export function calculateSheets(sheets: SheetInput[]): Promise<SheetResult[]> {
  return inTauri() ? invokeTauri('calculate_sheets', { sheets }) : mock.calculateSheets(sheets);
}

/** An agent's booked later runs; failed reads remain unavailable. */
export function listFollowups(vault: string): Promise<Followup[]> {
  return inTauri() ? invokeTauri('list_followups', { vault }) : mock.listFollowups(vault);
}
export function claimFollowup(vault: string, id: string): Promise<FollowupClaim> {
  return inTauri() ? invokeTauri('claim_followup', { vault, id }) : mock.claimFollowup(vault, id);
}
export function cancelFollowup(vault: string, id: string): Promise<boolean> {
  return inTauri() ? invokeTauri('cancel_followup', { vault, id }) : mock.cancelFollowup(vault, id);
}

/** UI refusals from the whiteboard doors; transport failures still reject. */
export interface CanvasRefusal {
  code:
    | 'missing'
    | 'too_large'
    | 'not_text'
    | 'not_a_board_path'
    | 'unreadable_on_disk'
    | 'invalid_content'
    | 'read_only';
  message: string;
}
export type CanvasResult<T> = ({ ok: true } & T) | { ok: false; refusal: CanvasRefusal };
export type CanvasSource = { content: string; hash: string };

function isCanvasRefusal(value: unknown): value is CanvasRefusal {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<CanvasRefusal>;
  return (
    typeof item.message === 'string' &&
    [
      'missing',
      'too_large',
      'not_text',
      'not_a_board_path',
      'unreadable_on_disk',
      'invalid_content',
      'read_only',
    ].includes(item.code ?? '')
  );
}
async function canvasResult<T>(read: () => Promise<T>): Promise<CanvasResult<T>> {
  try {
    return { ok: true, ...(await read()) };
  } catch (error) {
    if (isCanvasRefusal(error)) return { ok: false, refusal: error };
    throw error;
  }
}
export function readCanvasFile(vault: string, path: string): Promise<CanvasResult<CanvasSource>> {
  return canvasResult(() =>
    inTauri()
      ? invokeTauri<CanvasSource>('read_canvas_file', { vault, path })
      : mock.readCanvasFile(vault, path),
  );
}
export function saveCanvasFile(
  vault: string,
  path: string,
  content: string,
): Promise<CanvasResult<{ hash: string }>> {
  return canvasResult(() =>
    inTauri()
      ? invokeTauri<{ hash: string }>('save_canvas_file', { vault, path, content })
      : mock.saveCanvasFile(vault, path, content),
  );
}
export function createCanvasFile(
  vault: string,
  path: string,
  content: string,
  mode: 'preview' | 'commit',
): Promise<CanvasResult<{ path: string; hash: string | null }>> {
  return canvasResult(() =>
    inTauri()
      ? invokeTauri<{ path: string; hash: string | null }>('create_canvas_file', {
          vault,
          path,
          content,
          mode,
        })
      : mock.createCanvasFile(vault, path, content, mode),
  );
}

export function sheetRestructure(
  sheets: SheetInput[],
  sheet: number,
  change: import('@/engine/sheet/gridEdit').GridChange,
  at: number,
  count: number,
): Promise<import('@/engine/sheet/gridEdit').RestructureResult> {
  return inTauri()
    ? invokeTauri('sheet_restructure', { sheets, sheet, change, at, count })
    : mock.sheetRestructure(sheets, sheet, change, at, count);
}
export function sheetFill(
  sheets: SheetInput[],
  sheet: number,
  area: import('@/engine/sheet/selection').Area,
  axis: import('@/engine/sheet/gridEdit').FillAxis,
  to: number,
): Promise<import('@/engine/sheet/gridEdit').FillResult> {
  return inTauri()
    ? invokeTauri('sheet_fill', { sheets, sheet, area, axis, to })
    : mock.sheetFill(sheets, sheet, area, axis, to);
}
export function sheetComplete(
  names: string[],
  sheet: number,
  row: number,
  column: number,
  text: string,
  cursor: number,
): Promise<import('@/engine/sheet/formulaComplete').CompletionContext> {
  return inTauri()
    ? invokeTauri('sheet_complete', { names, sheet, row, column, text, cursor })
    : mock.sheetComplete(names, sheet, row, column, text, cursor);
}

export function pickSheetFile(): Promise<import('@/engine/sheet/import').PickedSheet | null> {
  return inTauri() ? invokeTauri('pick_sheet_file') : mock.pickSheetFile();
}

/** Export the live page's sheets through the native workbook writer and save dialog. */
export function exportSheetXlsx(defaultName: string, page: string): Promise<string | null> {
  return inTauri()
    ? invokeTauri('export_sheet_xlsx', { defaultName, page })
    : mock.exportSheetXlsx(defaultName, page);
}

export function mailDismissalsRead(
  vault: string,
): Promise<import('@/engine/unfiled').MailDismissal[]> {
  return inTauri()
    ? invokeTauri('mail_dismissals_read', { vault })
    : faulted('mail_dismissals_read', () => mock.mailDismissalsRead(vault));
}
export function mailDismiss(
  vault: string,
  kind: import('@/engine/unfiled').DismissalKind,
  value: string,
): Promise<void> {
  return inTauri()
    ? invokeTauri('mail_dismiss', { vault, kind, value })
    : mock.mailDismiss(vault, kind, value);
}
export function mailUndismiss(
  vault: string,
  kind: import('@/engine/unfiled').DismissalKind,
  value: string,
): Promise<void> {
  return inTauri()
    ? invokeTauri('mail_undismiss', { vault, kind, value })
    : mock.mailUndismiss(vault, kind, value);
}

/** Managed app-owned account metadata; no vault/run/person or credential crosses this door. */
export function managedConnections(
  cursor: string | null,
): Promise<import('./generated/actions').ManagedConnectionPage> {
  return inTauri()
    ? invokeTauri('managed_connections', { cursor })
    : mock.managedConnections(cursor);
}
export function managedConnectionStatus(
  connectionId: string,
): Promise<import('./generated/actions').ConnectionStatus> {
  return inTauri()
    ? invokeTauri('managed_connection_status', { connectionId })
    : mock.managedConnectionStatus(connectionId);
}
export function managedConnectionAdd(
  host: string,
  login: string,
): Promise<import('./generated/actions').ConnectionStatus> {
  return inTauri()
    ? invokeTauri('managed_connection_add', { host, login })
    : mock.managedConnectionAdd(host, login);
}
export function managedConnectionDisable(
  connectionId: string,
  expectedRevision: number,
): Promise<import('./generated/actions').ConnectionStatus> {
  return inTauri()
    ? invokeTauri('managed_connection_disable', { connectionId, expectedRevision })
    : mock.managedConnectionDisable(connectionId, expectedRevision);
}

/** Browser preview never starts a native credential acquisition. */
export function hasNativeCredentialImport(): boolean {
  return inTauri();
}

/** Safe account selectors; credential bytes remain entirely in Rust. */
export function beginGhImport(
  connectionId: string,
  host: string,
  login: string,
  expectedRevision: number,
): Promise<import('./generated/actions').CredentialAcquisitionView> {
  return inTauri()
    ? invokeTauri('begin_gh_import', { connectionId, host, login, expectedRevision })
    : Promise.reject('unavailable');
}
export function credentialAcquisition(
  attemptId: string,
): Promise<import('./generated/actions').CredentialAcquisitionView> {
  return inTauri()
    ? invokeTauri('credential_acquisition', { attemptId })
    : Promise.reject('unavailable');
}
export function cancelCredentialAcquisition(
  attemptId: string,
): Promise<import('./generated/actions').CredentialAcquisitionView> {
  return inTauri()
    ? invokeTauri('cancel_credential_acquisition', { attemptId })
    : Promise.reject('unavailable');
}

// Native backups use only original-owner nonces; renderer paths never authorize output.
export function workspaceBackupAvailability(
  expectedVault: string | null,
): Promise<WorkspaceBackupAvailability> {
  return inTauri()
    ? invokeTauri('workspace_backup_availability', { expectedVault })
    : mock.workspaceBackupAvailability(expectedVault);
}
export function chooseWorkspaceBackup(expectedVault: string): Promise<WorkspaceBackupChoiceResult> {
  return inTauri()
    ? invokeTauri('choose_workspace_backup', { expectedVault })
    : mock.chooseWorkspaceBackup(expectedVault);
}
export function checkWorkspaceBackup(): Promise<WorkspaceBackupChoiceResult> {
  return inTauri() ? invokeTauri('check_workspace_backup') : mock.checkWorkspaceBackup();
}
export function chooseWorkspaceRestore(token: string): Promise<WorkspaceBackupChoiceResult> {
  return inTauri()
    ? invokeTauri('choose_workspace_restore', { token })
    : mock.chooseWorkspaceRestore(token);
}
export function commitWorkspaceBackup(token: string): Promise<WorkspaceBackupCommitResult> {
  return inTauri()
    ? invokeTauri('commit_workspace_backup', { token })
    : mock.commitWorkspaceBackup(token);
}
export function commitWorkspaceRestore(token: string): Promise<WorkspaceBackupCommitResult> {
  return inTauri()
    ? invokeTauri('commit_workspace_restore', { token })
    : mock.commitWorkspaceRestore(token);
}
export function cancelWorkspaceBackupChoice(token: string): Promise<WorkspaceBackupCancelResult> {
  return inTauri()
    ? invokeTauri('cancel_workspace_backup_choice', { token })
    : mock.cancelWorkspaceBackupChoice(token);
}
export function workspaceBackupOperation(): Promise<WorkspaceBackupOperation> {
  return inTauri() ? invokeTauri('workspace_backup_operation') : mock.workspaceBackupOperation();
}
/** Payload-free notification; always reread the original owner's status. */
export async function onWorkspaceBackupChanged(handler: () => void): Promise<() => void> {
  if (!inTauri()) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen('workspace-backup-changed', () => handler());
}

/** Workflow selectors are data; native commands bind the actual authenticated opening. */
function workflowUnavailable(): Promise<never> {
  return Promise.reject({ code: 'unavailable', diagnostics: [] } satisfies import('./generated/workflows').WorkflowError);
}
export function workflowContext(): Promise<import('./generated/workflows').WorkflowContext> {
  return inTauri() ? invokeTauri('workflow_context') : workflowUnavailable();
}
export function workflowCatalog(context: import('./generated/workflows').WorkflowContext, after: string | null): Promise<import('./generated/workflows').WorkflowCatalog> {
  return inTauri() ? invokeTauri('workflow_catalog', { context, after }) : workflowUnavailable();
}
export function workflowDocument(context: import('./generated/workflows').WorkflowContext, workflowId: string): Promise<import('./generated/workflows').WorkflowDocument> {
  return inTauri() ? invokeTauri('workflow_document', { context, workflowId }) : workflowUnavailable();
}
export function workflowVersion(context: import('./generated/workflows').WorkflowContext, version: import('./generated/workflows').WorkflowVersionRef): Promise<import('./generated/workflows').WorkflowDraft> {
  return inTauri() ? invokeTauri('workflow_version', { context, version }) : workflowUnavailable();
}
export function workflowSave(request: import('./generated/workflows').WorkflowSaveRequest): Promise<import('./generated/workflows').WorkflowDraftSnapshot> {
  return inTauri() ? invokeTauri('workflow_save', { request }) : workflowUnavailable();
}
export function workflowPublish(request: import('./generated/workflows').WorkflowPublishRequest): Promise<import('./generated/workflows').WorkflowPublication> {
  return inTauri() ? invokeTauri('workflow_publish', { request }) : workflowUnavailable();
}
export function workflowUnpublish(request: import('./generated/workflows').WorkflowUnpublishRequest): Promise<import('./generated/workflows').WorkflowUnpublishAck> {
  return inTauri() ? invokeTauri('workflow_unpublish', { request }) : workflowUnavailable();
}
export function workflowValidate(context: import('./generated/workflows').WorkflowContext, draft: import('./generated/workflows').WorkflowDraft): Promise<import('./generated/workflows').WorkflowValidation> {
  return inTauri() ? invokeTauri('workflow_validate', { context, draft }) : workflowUnavailable();
}
export function workflowActions(context: import('./generated/workflows').WorkflowContext): Promise<import('./generated/actions').ActionDefinition[]> {
  return inTauri() ? invokeTauri('workflow_actions', { context }) : workflowUnavailable();
}

export function workflowStart(request: import('./generated/workflows').WorkflowStartRequest): Promise<import('./generated/workflows').WorkflowStartAck> {
  return inTauri() ? invokeTauri('workflow_start', { request }) : workflowUnavailable();
}
export function workflowContinue(request: import('./generated/workflows').WorkflowRunRequest): Promise<import('./generated/workflows').WorkflowStartAck> {
  return inTauri() ? invokeTauri('workflow_continue', { request }) : workflowUnavailable();
}
export function workflowReauthorize(request: import('./generated/workflows').WorkflowReauthorizeRequest): Promise<import('./generated/workflows').WorkflowStartAck> {
  return inTauri() ? invokeTauri('workflow_reauthorize', { request }) : workflowUnavailable();
}
export function workflowCancel(request: import('./generated/workflows').WorkflowRunRequest): Promise<import('./generated/workflows').WorkflowRunView> {
  return inTauri() ? invokeTauri('workflow_cancel', { request }) : workflowUnavailable();
}
export function workflowRuns(context: import('./generated/workflows').WorkflowContext, after: string | null): Promise<import('./generated/workflows').WorkflowRunCatalog> {
  return inTauri() ? invokeTauri('workflow_runs', { context, after }) : workflowUnavailable();
}
export function workflowRun(context: import('./generated/workflows').WorkflowContext, runId: string): Promise<import('./generated/workflows').WorkflowRunView> {
  return inTauri() ? invokeTauri('workflow_run', { context, runId }) : workflowUnavailable();
}
export function workflowValue(request: import('./generated/workflows').WorkflowValueRequest): Promise<import('./generated/workflows').WorkflowValueDetail> {
  return inTauri() ? invokeTauri('workflow_value', { request }) : workflowUnavailable();
}
export function workflowActionDetails(context: import('./generated/workflows').WorkflowContext, runId: string, invocationId: string): Promise<import('./generated/actions').ActionEffectDetails> {
  return inTauri() ? invokeTauri('workflow_action_details', { context, runId, invocationId }) : workflowUnavailable();
}
export function workflowAnswerAction(request: import('./generated/workflows').WorkflowActionAnswer): Promise<import('./generated/workflows').WorkflowRunView> {
  return inTauri() ? invokeTauri('workflow_answer_action', { request }) : workflowUnavailable();
}
export function workflowAnswerWait(request: import('./generated/workflows').WorkflowWaitAnswer): Promise<import('./generated/workflows').WorkflowRunView> {
  return inTauri() ? invokeTauri('workflow_answer_wait', { request }) : workflowUnavailable();
}

/** Recorded original ceiling and current selection; metadata is never native authority. */
export function workflowAccess(context: import('./generated/workflows').WorkflowContext, runId: string): Promise<import('./generated/workflows').WorkflowAccessView> {
  return inTauri() ? invokeTauri('workflow_access', { context, runId }) : workflowUnavailable();
}

/** Explicit schedule configuration and monitoring; browser preview never executes. */
export function workflowSchedule(context: import('./generated/workflows').WorkflowContext, workflow: string): Promise<import('./generated/workflows').WorkflowScheduleView> {
 return inTauri() ? invokeTauri('workflow_schedule', { context, workflow }) : workflowUnavailable();
}
export function workflowScheduleEnable(request: import('./generated/workflows').WorkflowScheduleEnableRequest): Promise<import('./generated/workflows').WorkflowScheduleAck> {
 return inTauri() ? invokeTauri('workflow_schedule_enable', { request }) : workflowUnavailable();
}
export function workflowSchedulePause(request: import('./generated/workflows').WorkflowScheduleChangeRequest): Promise<import('./generated/workflows').WorkflowScheduleAck> {
 return inTauri() ? invokeTauri('workflow_schedule_pause', { request }) : workflowUnavailable();
}
export function workflowScheduleRemove(request: import('./generated/workflows').WorkflowScheduleChangeRequest): Promise<import('./generated/workflows').WorkflowScheduleAck> {
 return inTauri() ? invokeTauri('workflow_schedule_remove', { request }) : workflowUnavailable();
}
export function workflowSchedulePreview(context: import('./generated/workflows').WorkflowContext, workflow: string): Promise<import('./generated/workflows').WorkflowSchedulePreview> {
 return inTauri() ? invokeTauri('workflow_schedule_preview', { context, workflow }) : workflowUnavailable();
}
export function workflowScheduleWake(context: import('./generated/workflows').WorkflowContext): Promise<import('./generated/workflows').WorkflowScheduleMonitorAck> {
 return inTauri() ? invokeTauri('workflow_schedule_wake', { context }) : workflowUnavailable();
}
