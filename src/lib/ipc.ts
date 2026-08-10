// IPC facade: every vault operation in the app goes through these functions.
// Inside Tauri (detected via __TAURI_INTERNALS__) they invoke the Rust
// commands; in the browser (pnpm dev, vitest, Playwright) they delegate to
// the in-memory mock in mockIpc.ts. Signatures follow the plan's IPC table.
import type { Entry } from '@/engine/types';
import * as mock from './mockIpc';

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
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

export function getLastVault(): Promise<string | null> {
  return inTauri() ? invokeTauri('get_last_vault') : mock.getLastVault();
}

export function scanVault(vault: string): Promise<Entry[]> {
  return inTauri() ? invokeTauri('scan_vault', { vault }) : mock.scanVault(vault);
}

export function readNote(vault: string, path: string): Promise<string> {
  return inTauri() ? invokeTauri('read_note', { vault, path }) : mock.readNote(vault, path);
}

export function saveNote(vault: string, path: string, body: string): Promise<void> {
  return inTauri()
    ? invokeTauri('save_note', { vault, path, body })
    : mock.saveNote(vault, path, body);
}

export function updateFrontmatter(
  vault: string,
  path: string,
  patch: Record<string, unknown>,
): Promise<void> {
  return inTauri()
    ? invokeTauri('update_frontmatter', { vault, path, patch })
    : mock.updateFrontmatter(vault, path, patch);
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
): Promise<void> {
  return inTauri()
    ? invokeTauri('verify_concept', { vault, path, patch })
    : mock.verifyConcept(vault, path, patch);
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
  return inTauri()
    ? invokeTauri('set_note_title', { vault, path, title })
    : mock.setNoteTitle(vault, path, title);
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

export function startWatcher(vault: string): Promise<void> {
  return inTauri() ? invokeTauri('start_watcher', { vault }) : mock.startWatcher(vault);
}

// --- Connectors (M13.3) ----------------------------------------------------

/** Raw `.cerebro/connectors.json`, '' when the vault has none. Rejects when
 * the file exists but cannot be read — permissions, or a symlinked path the
 * backend refuses to follow (PR #5 review). Runs fail closed on that config,
 * so Settings must render it as blocked, never as "no list". */
export function readConnectors(vault: string): Promise<string> {
  return inTauri() ? invokeTauri('read_connectors', { vault }) : mock.readConnectors(vault);
}

export function saveConnectors(vault: string, json: string): Promise<void> {
  return inTauri()
    ? invokeTauri('save_connectors', { vault, json })
    : mock.saveConnectors(vault, json);
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

/** Move a note or folder to the OS trash (never a hard delete). */
export function deleteNote(vault: string, path: string): Promise<void> {
  return inTauri() ? invokeTauri('delete_note', { vault, path }) : mock.deleteNote(vault, path);
}

/** All vault directories (for folder trees, including empty folders). */
export function listFolders(vault: string): Promise<string[]> {
  return inTauri() ? invokeTauri('list_folders', { vault }) : mock.listFolders(vault);
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

/**
 * Copy a file from anywhere on disk into the vault's `attachments/` folder and
 * return its VAULT-RELATIVE path.
 *
 * Relative is the whole point: an absolute path breaks the moment the vault is
 * synced to another machine, and a files-first vault has to survive being
 * moved. The destination folder is chosen by the backend, not passed in.
 */
export function importAttachment(vault: string, source: string): Promise<string> {
  return inTauri()
    ? invokeTauri('import_attachment', { vault, source })
    : mock.importAttachment(vault, source);
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

// --- Mermaid diagram export (M29.4) -----------------------------------------

/**
 * Save PNG bytes via the native save dialog (M29.4). Base64 because Tauri's
 * JSON invoke channel has no efficient raw-bytes lane for commands; diagrams
 * are small enough that this does not matter. Returns the chosen absolute
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

/** The ledger chain head, as `{ seq, hash }` — or null when the vault has no
 * readable ledger. Best-effort by design (M21.7): checkpoint trailers are
 * periodic anchoring, and a missing head must change nothing about a commit. */
export interface LedgerHead {
  seq: number | null;
  hash: string;
}

export function ledgerHead(vault: string): Promise<LedgerHead | null> {
  return inTauri() ? invokeTauri('ledger_head', { vault }) : mock.ledgerHead(vault);
}

/** Shadow-mode diagnostics (M21.8): the live verdict on a vault's ledger.
 * Verdict tags are the Rust recovery states (kebab-case); no UI consumes
 * this yet — it exists so a human can ask. */
export interface LedgerStatus {
  verdict: string;
  detail: string;
  head: string | null;
  seq: number | null;
  segments: number;
  anomalies: number;
  /** The M23.6 circuit breaker: the named reconciliation mode is open. */
  reconciliation_open: boolean;
  /** Unresolved divergence detection keys while the mode is open. */
  divergences: string[];
}

/** The M23.7 reconciliation exits. `action` is `accept_current_files` or
 * `restore_ledger_authority`; only the Tauri backend can resolve (the
 * browser has no ledger). */
export function resolveReconciliation(vault: string, action: string): Promise<void> {
  return inTauri()
    ? invokeTauri('resolve_reconciliation', { vault, action })
    : mock.resolveReconciliation(vault, action);
}

export function ledgerStatus(vault: string): Promise<LedgerStatus> {
  return inTauri() ? invokeTauri('ledger_status', { vault }) : mock.ledgerStatus(vault);
}

// --- The review surface (M24.9) --------------------------------------------

// The card shapes live in mockIpc so the module graph stays a tree: ipc
// imports the mock, and a type import pointing back would close a cycle that
// vitest's module ordering can trip over. Re-exported here because the app
// imports its IPC types from the IPC module.
import type { CardTarget, ReviewCard, RevertableApplication } from './mockIpc';

export type { CardTarget, ReviewCard, RevertableApplication };

/** Cards awaiting a human. Rebuilt from the ledger on every call — nothing
 * is cached, so a wiped app-data directory cannot lose one. */
export function reviewQueue(vault: string): Promise<ReviewCard[]> {
  return inTauri() ? invokeTauri('review_queue', { vault }) : mock.reviewQueue(vault);
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
} from './mockIpc';

export type {
  PipelineActivity,
  PipelineBanner,
  PipelineHeld,
  PipelineLane,
  PipelineMeter,
  PipelineOverview,
};

/** The pause, the meter, the lanes, recent activity, and every banner — one
 * query, so the panel cannot render a paused pipeline beside a budget it read
 * a second earlier. */
export function pipelineOverview(vault: string): Promise<PipelineOverview> {
  return inTauri() ? invokeTauri('pipeline_overview', { vault }) : mock.pipelineOverview(vault);
}

/** Subscription-wide, and persisted: one CLI account, one pause. */
export function setGlobalPause(paused: boolean): Promise<void> {
  return inTauri() ? invokeTauri('set_global_pause', { paused }) : mock.setGlobalPause(paused);
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
