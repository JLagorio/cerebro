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
import type {
  BeliefChips,
  CardTarget,
  ChangesView,
  LanesView,
  ReviewCard,
  RevertableApplication,
} from './mockIpc';

export type { CardTarget, ReviewCard, RevertableApplication };
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
  return inTauri() ? invokeTauri('review_queue', { vault }) : mock.reviewQueue(vault);
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

/** What changed since the last time anybody looked (M26.8, read aloud in
 * M27.8b). `fromSeq` omitted means "since the last stored run", which is the
 * question a person actually asks. */
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
  FleetRun,
  FleetCostComponent,
  FleetAssemblyMetrics,
  FleetRunDetail,
  FleetActorSummary,
  FleetFilter,
} from './mockIpc';

export type {
  FleetRun,
  FleetCostComponent,
  FleetAssemblyMetrics,
  FleetRunDetail,
  FleetActorSummary,
  FleetFilter,
};

/**
 * One page of run history, newest first (M33.2).
 *
 * Takes no vault: the fleet spans them, and a caller that wants one vault's
 * runs says so in the filter. REFUSES when there is no runtime database —
 * the section renders "unavailable", which is not "no runs".
 */
export function fleetRuns(filter: FleetFilter = {}): Promise<FleetRun[]> {
  return inTauri() ? invokeTauri('fleet_runs', { filter }) : mock.fleetRunsPage(filter);
}

/** One run and whatever the governance tables recorded about it. An unknown
 * id is refused, so a typo and an unmetered run never look the same. */
export function fleetRunDetail(runId: string): Promise<FleetRunDetail> {
  return inTauri() ? invokeTauri('fleet_run_detail', { runId }) : mock.fleetRunDetail(runId);
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
 * the caller must not spawn. The two-window arbitration lives in the store,
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
  return inTauri() ? invokeTauri('fleet_actor_summaries') : mock.fleetActorSummaries();
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
