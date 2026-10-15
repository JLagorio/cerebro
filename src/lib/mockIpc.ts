// In-memory IPC backend for browser dev, vitest, and Playwright. The whole
// "disk" is a Map<vault-relative path, raw file content>, seeded at module
// load from the committed demo-vault/ and mutated by the write commands.
// The map is exposed as window.__cerebroMockFs so Playwright can assert on
// "disk" state, page comment sidecars (`.comments/<page>.json`, M70.2)
// included. Neither 'vault-changed' nor 'comments-changed' has an equivalent
// here: startWatcher is a no-op, writers trigger rescans directly (see
// vaultStore), and a comment write answers the file it wrote. Every write is
// also logged with its stamp, as Rust's `vault_writes` records it, on
// window.__cerebroMockWrites (M58.1).
import YAML, { type Document } from 'yaml';
import type { CommentAnchor } from '@/engine/commentAnchor';
import {
  applyCommentOp,
  carriedRel,
  emptyComments,
  isCommentPage,
  OWNER,
  parseComments,
  rustTrim,
  serializeComments,
  sizeRefusal,
  sidecarPathOf,
  threadId,
  type CommentOp,
  type CommentsFile,
  type CommentThread,
} from '@/engine/comments';
import { agentHandle, askFirstOf, isAgentEntry, parseReadScope, parseScope } from '@/engine/agents';
import type { ConnectorStatusRow } from '@/engine/connectors';
import { runOptionsRefusal, storedChoice } from '@/engine/runOptions';
import { parseAllowedTools } from '@/engine/skills';
import { diskFolded, hfsHeard, isKnowledgePath, KNOWLEDGE_DIR } from '@/engine/okf';
import type { Entry } from '@/engine/types';
import {
  MANIFEST,
  TRASH_DIR,
  UNREADABLE_ITEM,
  alreadyExists,
  expired,
  isHiddenName,
  isItemPath,
  manifestBytes,
  newStamp,
  notAPage,
  nothingAt,
  parseManifest,
  parseStamp,
  rfc3339,
  type TrashedItem,
} from '@/engine/trash';
import type { AgentStreamEvent, TranscriptRead } from '@/agent/types';
import { normalizeAliasV1 } from './epistemic/normalize';
import { validateFieldPath, validateOverridePointer } from './epistemic/schema';
import { humanize, splitFrontmatter } from '@/engine/frontmatter';
import {
  anchorContext,
  commentMatches,
  context as quoteContext,
  lineAt,
  listed,
  occurrencesOf,
  planEdits,
  quoteMarkdown,
  type QuoteEdit,
} from '@/engine/quote';
import { firstH1LineIndex, parseNote } from './mockParse';
import { sha256Hex } from './sha256';
import { draftRefusal } from '@/engine/writeDraft';
import type { PageAttribution, RunPageWrites } from '@/engine/attribution';
import { APPROVAL_MESSAGES, QUEUE_LIMITS } from './policy/toolApproval';
import { toolSchema } from './policy/tools';
import {
  AMBIENT_CONCURRENCY_DEFAULT,
  AMBIENT_CONCURRENCY_MAX,
  demoChanges,
  demoFleetDetails,
  demoRunWrites,
  demoFleetRuns,
  demoLanes,
  demoPipelineOverview,
  demoReviewCards,
  demoRevertables,
} from './demoOperational';
import { demoRunTranscripts } from './demoTranscripts';
import { loadRegistry } from './trigger/registry';
import type { ParentRule, Variant as TriggerVariant } from './trigger/registry';

const SEED_TIME = '2026-07-24T00:00:00.000Z';

/**
 * When each of the demo's knowledge files was last written (M52.5), as the
 * story tells it — the update log's days and each concept's own stamps. At
 * the seed time every concept read "Updated 4d ago", beside an update log
 * that said Sync error rate was rewritten yesterday and a page that said it
 * was written nine days ago. A file this map does not name keeps the seed
 * time.
 */
const DEMO_KNOWLEDGE_MODIFIED: Record<string, string> = {
  'knowledge/index.md': '2026-07-28T09:27:00.000Z',
  'knowledge/log.md': '2026-07-28T09:27:00.000Z',
  'knowledge/metrics/onboarding-completion.md': '2026-07-24T10:12:00.000Z',
  'knowledge/metrics/sync-error-rate.md': '2026-07-27T15:40:00.000Z',
  'knowledge/metrics/webinar-attendance.md': '2026-07-27T08:20:00.000Z',
  'knowledge/playbooks/warehouse-cutover.md': '2026-07-28T09:05:00.000Z',
  'knowledge/systems/offline-guarantee.md': '2026-07-26T11:20:00.000Z',
  'knowledge/systems/offline-window-pilot.md': '2026-07-26T11:25:00.000Z',
  'knowledge/systems/pick-queue-drain.md': '2026-07-28T09:26:00.000Z',
  'knowledge/systems/status-model.md': '2026-07-25T14:20:00.000Z',
};

const seededNotes = import.meta.glob('/demo-vault/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
// Every YAML shape the vault holds (M10): legacy `views/*.yml`, the M10
// `*.list.yml` Lists, and the `collection.yml` markers that make a folder a
// Collection. A narrower glob was the bug — seeding only `views/` meant the
// browser and Playwright saw a vault with no Collections in it at all.
const seededYaml = import.meta.glob('/demo-vault/**/*.yml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
// Standalone mermaid files (M29.20) — raw diagram source, scanned as entries.
const seededDiagrams = import.meta.glob('/demo-vault/**/*.mmd', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const files = new Map<string, string>();
// Connector config (M13.3) — config, not a note; scan never sees it.
let connectorsJson = '';
const times = new Map<string, { createdAt: string; modifiedAt: string }>();
// Directories created explicitly (create_folder) — the file map alone can't
// represent an empty folder. Parity with real dirs on disk.
const folders = new Set<string>();

/** Who a person's writes are stamped as: vault/receipt.rs `HUMAN_ACTOR` (D1). */
export const HUMAN_ACTOR = 'human:me';

/** One write as Rust's `vault_writes` records it (M58.1), with its stamp. */
export interface MockWrite {
  kind: 'vault.write' | 'vault.create' | 'vault.rename' | 'vault.delete' | 'vault.comment';
  path: string;
  to: string | null;
  actor: string;
  runId: string | null;
  approvedBy: string | null;
}

/** An agent write's stamp (M58.1): the run's actor and id, and who allowed
 * it. Required on every agent door, so a caller that forgets it fails
 * typecheck. */
export interface WriteStamp {
  actor: string;
  runId: string;
  approvedBy?: string | null;
}

/** The mock's write log, exposed as `window.__cerebroMockWrites` and reset
 * with the mock fs. Every door logs its write, as Rust's records it, under
 * Rust's kinds; unlike Rust, nothing coalesces. */
const writes: MockWrite[] = [];

/** What Rust's row holds beside a logged write's stamp (M58.1b): the hash of
 * the bytes it wrote and when. Kept off `MockWrite`, whose shape the door
 * replay compares whole. */
const writtenAs = new WeakMap<MockWrite, { hash: string | null; at: string }>();

/** Log one write under `stamp`, or as the person's when there is none. A
 * comment's stamp is its author's, with or without a run. An agent door
 * passes the bytes it replaced (`before`, null for a new file), so the row
 * carries the lines it changed (M58.3, `mockRowLines`) and a live run keeps
 * the path's first bytes for its changeset. */
function logWrite(
  kind: MockWrite['kind'],
  path: string,
  stamp: { actor: string; runId: string | null; approvedBy?: string | null } | null = null,
  to: string | null = null,
  before?: string | null,
): void {
  const logged: MockWrite = {
    kind,
    path,
    to,
    actor: stamp?.actor ?? HUMAN_ACTOR,
    runId: stamp?.runId ?? null,
    approvedBy: stamp?.approvedBy ?? null,
  };
  writes.push(logged);
  if (before !== undefined) {
    const { additions, deletions } = diffLines(before, files.get(path) ?? null);
    rowLines.set(logged, { additions, deletions });
    const live = logged.runId === null ? undefined : liveRuns.get(logged.runId);
    if (live !== undefined && !live.baseline.has(path)) live.baseline.set(path, before);
  }
  // Every door logs after its bytes land, so this is the hash Rust records.
  const landed = kind === 'vault.write' || kind === 'vault.create' ? files.get(path) : undefined;
  writtenAs.set(logged, {
    hash: landed === undefined ? null : sha256Hex(landed),
    at: new Date().toISOString(),
  });
}

/** The lines each agent door's write changed (M58.3), kept off `MockWrite`
 * like `writtenAs`. */
const rowLines = new WeakMap<MockWrite, { additions: number; deletions: number }>();

/** A logged write's line counts, or null for a row no agent door wrote. */
export function mockRowLines(write: MockWrite): { additions: number; deletions: number } | null {
  return rowLines.get(write) ?? null;
}

/** `before` against `after`, line by line, the common head and tail left
 * out: what the mock's changesets count and show. Null is no file. */
export function diffLines(
  before: string | null,
  after: string | null,
): { additions: number; deletions: number; removed: string[]; added: string[]; at: number } {
  const lines = (text: string | null) =>
    text === null || text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const a = lines(before);
  const b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  return { additions: added.length, deletions: removed.length, removed, added, at: head };
}

/** One mock run that is live (M58.3), by its stamp's run id: its actor, where
 * its writes start in the log, and each path's bytes before its first write. */
interface LiveMockRun {
  actor: string;
  from: number;
  baseline: Map<string, string | null>;
}
const liveRuns = new Map<string, LiveMockRun>();

/** A mock run starts: from here, the paths it writes are its own until it
 * ends, as Rust's `claim_run` holds them. */
export function beginMockRun(runId: string, actor: string): void {
  liveRuns.set(runId, { actor, from: writes.length, baseline: new Map() });
}

/** A mock run ends: its paths are no longer anyone's. */
export function endMockRun(runId: string): void {
  liveRuns.delete(runId);
}

/** The paths a live mock run wrote, in order, each once: its own stamp's
 * rows only, never an IPC write in the same turn, which is the person's. */
export function liveRunPaths(runId: string): string[] {
  const live = liveRuns.get(runId);
  if (live === undefined) return [];
  const paths: string[] = [];
  for (const w of writes.slice(live.from)) {
    if (w.runId !== runId) continue;
    for (const path of w.to === null ? [w.path] : [w.path, w.to]) {
      if (!paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

/** Every path a live mock run owns, with its run and actor (Rust's
 * `changeset::owned_paths`). The first run to name a path keeps it. */
export function liveRunOwners(): Map<string, { runId: string; actor: string }> {
  const owners = new Map<string, { runId: string; actor: string }>();
  for (const [runId, live] of liveRuns) {
    for (const path of liveRunPaths(runId)) {
      if (!owners.has(path)) owners.set(path, { runId, actor: live.actor });
    }
  }
  return owners;
}

/** What one path of a mock run changed, for its commit. */
export interface MockRunChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  /** Other stamps that wrote the path while the run was live. */
  alsoBy: string[];
  /** A unified diff of the change. */
  patch: string;
  /** The path's bytes before the run's first write, null for none (M58.4):
   * what the mock's history reads as the page before the run's commit. */
  before: string | null;
}

/** What a live mock run changed: each of its paths, its first bytes against
 * the bytes now. A path whose bytes ended as they began changed nothing and
 * is left out, as `git status` would leave it out. */
export function mockRunChanges(runId: string): MockRunChange[] {
  const live = liveRuns.get(runId);
  if (live === undefined) return [];
  const changes: MockRunChange[] = [];
  for (const path of liveRunPaths(runId)) {
    const before = live.baseline.has(path) ? (live.baseline.get(path) ?? null) : null;
    const after = files.get(path) ?? null;
    if (before === after) continue;
    const diff = diffLines(before, after);
    const alsoBy: string[] = [];
    for (const w of writes.slice(live.from)) {
      if (w.runId === runId || (w.path !== path && w.to !== path)) continue;
      if (!alsoBy.includes(w.actor)) alsoBy.push(w.actor);
    }
    const header = [
      `diff --git a/${path} b/${path}`,
      before === null ? '--- /dev/null' : `--- a/${path}`,
      after === null ? '+++ /dev/null' : `+++ b/${path}`,
      `@@ -${diff.at + 1},${diff.deletions} +${diff.at + 1},${diff.additions} @@`,
    ];
    changes.push({
      path,
      kind: before === null ? 'added' : after === null ? 'deleted' : 'modified',
      additions: diff.additions,
      deletions: diff.deletions,
      alsoBy,
      patch: [
        ...header,
        ...diff.removed.map((l) => `-${l}`),
        ...diff.added.map((l) => `+${l}`),
      ].join('\n'),
      before,
    });
  }
  return changes;
}

/** How many renames into a path are followed back (`write_log::RENAME_HOPS`). */
const RENAME_HOPS = 8;

/**
 * Who last changed one page (M58.1b), as Rust's `write_log::page_attribution`
 * reads `vault_writes`: the newest write or create of the path, following
 * renames into it back at most `RENAME_HOPS` times, held against the hash of
 * the page's content now. An edit made straight to `__cerebroMockFs` logs
 * nothing, so it reads unattributed. A path the map does not hold refuses,
 * as Rust's read of a missing file does.
 */
export async function pageAttribution(_vault: string, path: string): Promise<PageAttribution> {
  if (path.split('/').some((part) => part === '..') || path.startsWith('/')) {
    return { state: 'not_recorded' };
  }
  const content = files.get(path);
  if (content === undefined) throw new Error(`reading ${path}: No such file or directory`);
  const bundle = isKnowledgePath(path);
  let target = path;
  let before = writes.length;
  let found: MockWrite | undefined;
  for (let hop = 0; hop <= RENAME_HOPS && found === undefined; hop++) {
    let i = before - 1;
    for (; i >= 0; i--) {
      const w = writes[i];
      if ((w.kind === 'vault.write' || w.kind === 'vault.create') && w.path === target) break;
      if (w.kind === 'vault.rename' && w.to === target) break;
    }
    if (i < 0) break;
    if (writes[i].kind === 'vault.rename') {
      target = writes[i].path;
      before = i;
    } else {
      found = writes[i];
    }
  }
  if (found === undefined) return { state: bundle ? 'knowledge' : 'not_recorded' };
  const { hash, at } = writtenAs.get(found) ?? { hash: null, at: new Date().toISOString() };
  const last = {
    kind: found.kind,
    actor: found.actor,
    run_id: found.runId,
    approved_by: found.approvedBy,
    at,
  };
  if (hash === null || hash === sha256Hex(content)) return { state: 'recorded', ...last };
  return bundle ? { state: 'knowledge' } : { state: 'unattributed', ...last };
}

/** `vault.create` for a file that was absent, else `vault.write`. */
const writeKind = (existed: boolean): MockWrite['kind'] =>
  existed ? 'vault.write' : 'vault.create';

/**
 * Restore the operational fixtures (M33.10). Exported for test isolation, and
 * called by `resetMockFs` so one reset puts the whole mock back.
 *
 * The runs, the queue and the meter are as much part of the golden corpus as
 * the notes are — they are simply kept here rather than in `demo-vault/`,
 * because they live in SQLite rather than on disk.
 */
export function resetOperational(): void {
  lanes = demoLanes();
  changes = demoChanges();
  review.cards = demoReviewCards();
  review.applications = demoRevertables();
  pipeline = demoPipelineOverview(LANES);
  fleetRuns = demoFleetRuns();
  fleetDetails = demoFleetDetails();
  runWrites = demoRunWrites();
  runTranscripts = demoRunTranscripts();
  fleetAvailable = true;
  connectorStatusRows = [];
  connectorStatusFails = false;
  resetAgentPauses();
  resetPanelAgents();
  resetCliTranscripts();
  resetPendingWrites();
}

/** Re-seed the file map alone. Split from `resetMockFs` because module init
 * runs it BEFORE the operational fixtures below are initialized, and reaching
 * them from here would be a temporal-dead-zone error at import time. */
function seedFiles(): void {
  files.clear();
  times.clear();
  folders.clear();
  writes.length = 0;
  liveRuns.clear();
  connectorsJson = '';
  for (const [absPath, raw] of Object.entries({
    ...seededNotes,
    ...seededYaml,
    ...seededDiagrams,
  })) {
    const rel = absPath.replace(/^\/demo-vault\//, '');
    files.set(rel, raw);
    times.set(rel, { createdAt: SEED_TIME, modifiedAt: DEMO_KNOWLEDGE_MODIFIED[rel] ?? SEED_TIME });
  }
}
seedFiles();

/** Re-seed the whole mock — files and the operational fixtures — for test
 * isolation. Safe to call once the module has finished evaluating. */
export function resetMockFs(): void {
  seedFiles();
  resetOperational();
}

/**
 * Vault format v2 containment (parity with the scan.rs post-pass): an
 * entry's project is the nearest ancestor directory holding a `project.md`.
 * A vault-root project.md is ignored — it would own every file.
 */
export function assignProjects(entries: Entry[]): Entry[] {
  const projectDirs = entries
    .filter((e) => e.path.endsWith('/project.md'))
    .map((e) => e.path.slice(0, -'/project.md'.length));
  return entries.map((entry) => {
    let best: string | null = null;
    for (const dir of projectDirs) {
      if (entry.path.startsWith(`${dir}/`) && (best === null || dir.length > best.length)) {
        best = dir;
      }
    }
    return { ...entry, project: best === null ? null : `${best}/project.md` };
  });
}

if (typeof window !== 'undefined') {
  (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs = files;
  (window as unknown as { __cerebroMockWrites: MockWrite[] }).__cerebroMockWrites = writes;
}

function touch(path: string): void {
  const now = new Date().toISOString();
  const prev = times.get(path);
  times.set(path, { createdAt: prev?.createdAt ?? now, modifiedAt: now });
}

function mustGet(path: string): string {
  const raw = files.get(path);
  if (raw === undefined) throw new Error(`Note not found: ${path}`);
  return raw;
}

export async function pickVault(): Promise<string | null> {
  return '/demo-vault';
}

export async function openDemoVault(): Promise<string> {
  return '/demo-vault';
}

export async function getLastVault(): Promise<string | null> {
  return '/demo-vault';
}

// --- The panel's agent (M56.6) ----------------------------------------------
//
// app_config.rs keeps it in config.json by vault path; the browser keeps it
// here, in memory, so a reload unbinds it.

/** `vault` → the handle its panel answers as. Absent is the plain assistant. */
const panelAgentByVault = new Map<string, string>();

function resetPanelAgents(): void {
  panelAgentByVault.clear();
}

/** The longest handle a binding takes, in characters (app_config.rs). */
const HANDLE_MAX = 64;
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function getPanelAgent(vault: string): Promise<string | null> {
  return panelAgentByVault.get(vault) ?? null;
}

/** Bind or unbind, refusing what Rust refuses in Rust's words: a value
 * outside the slug grammar, cut at 64 characters, and nothing stored. */
export async function setPanelAgent(vault: string, handle: string | null): Promise<void> {
  const named = handle?.trim() ?? '';
  if (named === '') {
    panelAgentByVault.delete(vault);
    return;
  }
  const chars = Array.from(named);
  if (named.length > HANDLE_MAX || !HANDLE.test(named)) {
    const cut = chars.length > HANDLE_MAX ? '…' : '';
    throw new Error(`"${chars.slice(0, HANDLE_MAX).join('')}${cut}" is not an agent handle`);
  }
  panelAgentByVault.set(vault, named);
}

/**
 * Parity with scan.rs `is_hidden`: a dotfile or a dot-folder, Obsidian-style,
 * heard as HFS+ hears the name — its first character HFS+ does not ignore is
 * `.`, so `\u200c.claude` IS `.claude`. scanVault hides it, and the note
 * writers refuse it (`noteRefusal`).
 */
const isHidden = (name: string): boolean => hfsHeard(name).startsWith('.');

/**
 * Parity with scan.rs `is_skipped_dir`: a folder the scan never descends
 * into — a hidden one, or exactly `views` or `attachments`, at any depth (v2
 * project folders carry their own views/). The note writers ask it too.
 */
const isSkippedDir = (name: string): boolean =>
  isHidden(name) || name === 'views' || name === 'attachments';

export async function scanVault(_vault: string): Promise<Entry[]> {
  const paths = [...files.keys()]
    .filter((p) => {
      const names = p.split('/');
      return (
        (p.endsWith('.md') || p.endsWith('.mmd')) &&
        !isHidden(names.at(-1) ?? '') &&
        !names.slice(0, -1).some(isSkippedDir)
      );
    })
    .sort();
  const entries = paths.map((p) => {
    const t = times.get(p) ?? { createdAt: SEED_TIME, modifiedAt: SEED_TIME };
    return parseNote(p, files.get(p) ?? '', t.createdAt, t.modifiedAt);
  });
  return assignProjects(entries);
}

export async function readNote(_vault: string, path: string): Promise<string> {
  // .mmd is RAW (M29.20): mermaid's own `---` header is diagram syntax, so
  // it must never be stripped as frontmatter (parity with read_note).
  if (path.endsWith('.mmd')) return mustGet(path);
  return splitFrontmatter(mustGet(path)).body.replace(/^\n+/, '');
}

// --- ⌘K's page-text search (M59.4) -------------------------------------------
//
// search.rs `vault_search` ranks with BM25 over the cached corpus. The mock
// does containment ONLY, on purpose, so it is no ranker twin (D3): the whole
// trimmed query, ignoring case, in a title or a body, in scan order. Its
// excerpt is the raw first matching line, since chip cleanup is Rust's.

/** One run of an excerpt: marked when it is the query. Drawn as text. */
export interface ExcerptPart {
  text: string;
  mark: boolean;
}

/** One ⌘K page-text hit (search.rs `VaultHit`). */
export interface VaultHit {
  path: string;
  title: string;
  type: string | null;
  parts: ExcerptPart[];
}

/** ⌘K's page-text answer (search.rs `VaultSearch`): the hits, how many
 * matched in all, whether nothing held every word, and how many long pages
 * were searched in part. */
export interface VaultSearch {
  hits: VaultHit[];
  total: number;
  widened: boolean;
  capped: number;
}

/** The most hits search_vault returns (search.rs `VAULT_SEARCH_MAX`). */
const VAULT_SEARCH_MAX = 50;
/** The mock's excerpt: this many characters before the first hit, so the
 * hit always shows near the start, and at most this many in all. */
const MOCK_LEAD = 60;
const MOCK_WINDOW = 180;

/** Set by `window.__cerebroFailSearchVault`: searchVault rejects with it
 * until it is cleared with null. */
let searchVaultFailure: string | null = null;

/** Test-only seam, mirroring `window.__cerebroMockFs`: make searchVault
 * reject with `message` until called again with null. */
export function __failSearchVault(message: string | null): void {
  searchVaultFailure = message;
}

/** `text`'s regex syntax escaped, so a query is matched as written. */
const escapeRegExp = (text: string): string => text.replace(/[\^$\\.*+?()[\]{}|/]/g, '\\$&');

/** `line` windowed around its first match, every whole match marked. */
function mockExcerpt(line: string, matches: { start: number; end: number }[]): ExcerptPart[] {
  const from = Math.max(0, (matches[0]?.start ?? 0) - MOCK_LEAD);
  const to = Math.min(line.length, from + MOCK_WINDOW);
  const parts: ExcerptPart[] = [];
  const push = (text: string, mark: boolean) => {
    if (text === '') return;
    const last = parts.at(-1);
    if (last !== undefined && last.mark === mark) last.text += text;
    else parts.push({ text, mark });
  };
  if (from > 0) push('\u2026', false);
  let at = from;
  for (const m of matches) {
    if (m.start < at || m.end > to) continue;
    push(line.slice(at, m.start), false);
    push(line.slice(m.start, m.end), true);
    at = m.end;
  }
  push(line.slice(at, to), false);
  if (to < line.length) push('\u2026', false);
  return parts;
}

export async function searchVault(
  vault: string,
  query: string,
  limit = VAULT_SEARCH_MAX,
): Promise<VaultSearch> {
  if (searchVaultFailure !== null) throw new Error(searchVaultFailure);
  const needle = query.trim();
  const found: VaultHit[] = [];
  if (needle !== '') {
    const pattern = new RegExp(escapeRegExp(needle), 'giu');
    for (const entry of await scanVault(vault)) {
      const body = await readNote(vault, entry.path);
      let parts: ExcerptPart[] | null = null;
      for (const line of body.split(/\r?\n/)) {
        const matches = [...line.matchAll(pattern)].map((m) => ({
          start: m.index,
          end: m.index + m[0].length,
        }));
        if (matches.length > 0) {
          parts = mockExcerpt(line, matches);
          break;
        }
      }
      if (parts === null && entry.title.match(pattern) !== null) {
        const snippet = entry.snippet.trim();
        parts = snippet === '' ? [] : [{ text: snippet, mark: false }];
      }
      if (parts !== null) {
        found.push({ path: entry.path, title: entry.title, type: entry.type, parts });
      }
    }
  }
  const shown = Math.min(Math.max(1, Math.floor(limit)), VAULT_SEARCH_MAX);
  return { hits: found.slice(0, shown), total: found.length, widened: false, capped: 0 };
}

/**
 * Mirrors src-tauri/src/knowledge.rs. The mock backend must refuse exactly
 * what Tauri refuses — otherwise the boundary "works" in dev and vitest and
 * only fails in the packaged app, which is the worst way to find out.
 */
const READ_ONLY_KNOWLEDGE =
  'knowledge/ is maintained by the AI knowledge base and is read-only here. ' +
  'Verify the concept, or ask the agent to revise it.';

export function guardHumanWrite(path: string): void {
  if (isKnowledgePath(path)) throw new Error(READ_ONLY_KNOWLEDGE);
}

/** Log a person's write from outside this module (mockGit's discard). */
export function logHumanWrite(kind: MockWrite['kind'], path: string): void {
  logWrite(kind, path);
}

/** What the markdown-only note writers accept (write.rs `MARKDOWN`). */
const MARKDOWN = ['md'];
/** `save_note`'s set: diagrams save raw through the same door (M29.20). */
const MARKDOWN_OR_DIAGRAM = ['md', 'mmd'];

/**
 * Mirror of `note_refusal` in write.rs (PLATFORM-API-1): why `path` is not a
 * note a note writer may touch, or null when it is. No component may be
 * hidden (scanVault's own `isHidden`) — not `.git/`, `.cerebro/`, `.claude/`,
 * any dot-folder or dotfile, which scanVault hides; the extension must be one
 * the door takes, spelled as the scanner spells it; and a markdown note may
 * not sit in a folder the scanner skips, asked with scanVault's own
 * `isSkippedDir` — past the dot rule, exactly `views/` and `attachments/`, so
 * `Attachments/` and `Views/`, which it lists, save. A `.mmd` may, for the
 * legacy-List whiteboards write.rs names.
 */
function noteRefusal(path: string, extensions: readonly string[]): string | null {
  const names = path.split('/').filter((name) => name !== '' && name !== '.');
  if (names.some(isHidden)) {
    return 'dot-folders and dotfiles hold no notes';
  }
  const leaf = names.at(-1) ?? '';
  const dot = leaf.lastIndexOf('.');
  const extension = dot > 0 ? leaf.slice(dot + 1) : '';
  if (!extensions.includes(extension)) {
    return `only ${extensions.map((e) => `.${e}`).join(' and ')} files are notes`;
  }
  if (extension === 'md' && names.slice(0, -1).some(isSkippedDir)) {
    return 'views/ and attachments/ hold no notes';
  }
  return null;
}

/**
 * Mirror of `note_join` in write.rs: contained (as `safe_join` judges, and
 * first), AND a note, AND not the bundle under another name — a first
 * component a folding disk hears as `knowledge` (`Knowledge`, U+212A KELVIN
 * SIGN + `nowledge`) that is not exactly `knowledge` (M53.28). The bundle's
 * guards hear those names as the bundle too; this refuses them without
 * leaning on the guards, so a note door reaches the bundle by its own name or
 * not at all. Rust also judges where a path LANDS — through a symlink, under
 * a name APFS folds, inside the folder `knowledge/` resolves to — and that
 * half has nothing to mirror here: this disk is a Map, and a key only ever
 * lands on itself. Both backends replay src-tauri/fixtures/note-targets.json.
 */
function guardNoteTarget(path: string, extensions: readonly string[]): void {
  if (path === '' || path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`path escapes the vault: ${path}`);
  }
  const refusal = noteRefusal(path, extensions);
  if (refusal !== null) throw new Error(`not a note: ${path} — ${refusal}`);
  const head = path.split('/').find((name) => name !== '' && name !== '.');
  if (head !== undefined && diskFolded(head) === KNOWLEDGE_DIR && head !== KNOWLEDGE_DIR) {
    throw new Error(
      `${path} is inside knowledge/ by another name — the bundle is reached by its own name or not at all`,
    );
  }
}

/** One file's bytes on the mock disk, or null when there is none (M58.4):
 * what a mock commit snapshots. */
export function peekFile(path: string): string | null {
  return files.get(path) ?? null;
}

/** Restore's target (M58.4), as git_commands.rs `restore_note_version_in`
 * judges it before it mints a receipt: a markdown note, as `note_join`
 * says, then the bundle guard, in Rust's words. */
export function guardRestoreTarget(path: string): void {
  guardNoteTarget(path, MARKDOWN);
  guardHumanWrite(path);
}

/** Restore's write (M58.4), as write.rs `restore_note`: the target judged,
 * then `raw` exactly, logged as the person's write, its times stamped. */
export function restoreFile(path: string, raw: string): void {
  guardRestoreTarget(path);
  mustGet(path);
  files.set(path, raw);
  touch(path);
  logWrite('vault.write', path);
}

export async function saveNote(_vault: string, path: string, body: string): Promise<void> {
  // Note targets first, as save_note's note_join does (PLATFORM-API-1).
  guardNoteTarget(path, MARKDOWN_OR_DIAGRAM);
  // The M23.7 capture valve: an in-app body edit to a knowledge projection
  // is CAPTURED (Rust: an editorial override), no longer refused. The mock
  // applies the same edit; the ledger half exists only in Tauri.
  // .mmd is RAW (M29.20): the body IS the whole file — no frontmatter
  // compose (parity with save_note in write.rs). mustGet keeps the .md
  // contract: save only overwrites an existing file.
  if (path.endsWith('.mmd')) {
    mustGet(path);
    files.set(path, body);
    touch(path);
    logWrite('vault.write', path);
    return;
  }
  const { yaml } = splitFrontmatter(mustGet(path));
  files.set(path, yaml !== null ? `---\n${yaml}\n---\n\n${body}` : body);
  touch(path);
  logWrite('vault.write', path);
}

/** Mirror of knowledge.rs `AGENT_USE_WRITE_CONCEPT`: the agent's refusal at
 *  the bundle's edge, in the agent's words. */
const AGENT_USE_WRITE_CONCEPT =
  'knowledge/ is written only through write_concept and recheck_concept, which record ' +
  "provenance. Use recheck_concept to move only a concept's `stale_after`, and write_concept " +
  "otherwise; `verified` is the user's stamp and is never yours to set.";

/** Mirror of mcp.rs `TYPE_DOC_REFUSAL`, word for word. */
const TYPE_DOC_REFUSAL =
  "type: Type docs are the vault's schema and are changed by people, not by agent runs. " +
  'Tell the user what schema change you need instead.';

/** Mirror of mcp.rs `AGENT_DOC_REFUSAL`, word for word. */
const AGENT_DOC_REFUSAL =
  'type: Agent records are grants — their scope:, read-scope: and allowed-tools: are what a ' +
  'run of them is handed, and hand_to starts a run of any of them. They are written by ' +
  'people, not by agent runs. Tell the user what agent you need instead.';

/**
 * Mirror of mcp.rs `governed_type_refusal`: the refusal a governed type earns,
 * or null for ordinary content. Matched exactly, as the scanner types them.
 */
function governedTypeRefusal(declared: string | null): string | null {
  if (declared === 'Type') return TYPE_DOC_REFUSAL;
  if (declared === 'Agent') return AGENT_DOC_REFUSAL;
  return null;
}

/** The `type` a file's leading frontmatter declares, read the way scanVault
 *  reads it (parse.rs `declared_type`): no fence at byte zero, or a block
 *  that does not parse, is untyped. */
function declaredType(path: string, raw: string): string | null {
  return parseNote(path, raw, SEED_TIME, SEED_TIME).type;
}

/** Mirror of mcp.rs `MALFORMED_EXPECT_HASH`, word for word. */
const MALFORMED_EXPECT_HASH = "expect_hash must be the 64-character hash from get_note's Hash line";

/** Mirror of mcp.rs `parse_expect_hash` (M55.3): absent is no expectation,
 *  64 hex characters in either case are lowercased, anything else refuses. */
function parseExpectHash(expectHash: unknown): string | null {
  if (expectHash === undefined || expectHash === null) return null;
  if (typeof expectHash === 'string' && /^[0-9a-fA-F]{64}$/.test(expectHash)) {
    return expectHash.toLowerCase();
  }
  throw new Error(MALFORMED_EXPECT_HASH);
}

/** Mirror of mcp.rs `stale_content_message`, word for word. */
function staleContentMessage(path: string): string {
  return (
    `stale_content: ${path} changed since you read it, so nothing was written. ` +
    'Read it again with get_note and decide whether your change still applies.'
  );
}

/**
 * The agent's `append_to_note` (mcp.rs `tool_append_in`), for the browser-mode
 * mock agent (M53.6): the content as its own paragraph at the end of the
 * body, under the frontmatter the note already has, and the file touched the
 * way an MCP write moves its stamp, and logged under the run's `stamp`
 * (M58.1). Refuses what Rust refuses, in Rust's order and words, before
 * writing or logging a byte: a malformed `expectHash`
 * (`parse_expect_hash`), the bundle (`guard_agent_write`), a `.mmd` and
 * anything that is not a note (`append_note_checked`), then bytes other than
 * the ones `expectHash` names (`stale_content`, M55.3), then a Type doc or an
 * Agent record, judged on the bytes the note holds and on the bytes the
 * append would land (`governed_bytes_refusal`, M55.1).
 */
export async function agentAppend(
  _vault: string,
  path: string,
  content: string,
  expectHash: string | undefined,
  stamp: WriteStamp,
): Promise<void> {
  const expected = parseExpectHash(expectHash);
  if (isKnowledgePath(path)) throw new Error(AGENT_USE_WRITE_CONCEPT);
  if (path.endsWith('.mmd')) {
    throw new Error(
      `${path}: a .mmd is raw diagram source, and markdown appended to it is not a diagram`,
    );
  }
  guardNoteTarget(path, MARKDOWN);
  const current = mustGet(path);
  if (expected !== null && sha256Hex(current) !== expected) {
    throw new Error(staleContentMessage(path));
  }
  const governed = governedTypeRefusal(declaredType(path, current));
  if (governed !== null) throw new Error(governed);
  const { yaml, body } = splitFrontmatter(current);
  const joined = `${body.trimEnd()}\n\n${content.trim()}\n`;
  // Composed as save_note composes it (write.rs `compose`): the note's block,
  // then the body. A blank block is dropped, so there, as with no block, the
  // body is the whole file.
  const saved = yaml !== null && yaml.trim() !== '' ? `---\n${yaml}\n---\n${joined}` : joined;
  // What those bytes DECLARE, which asking what the note IS cannot see: a
  // body that parks an unterminated `---\ntype: Agent` fence is untyped until
  // the append closes it, and then it is frontmatter at byte zero.
  const minted = governedTypeRefusal(declaredType(path, saved));
  if (minted !== null) throw new Error(minted);
  files.set(path, saved);
  touch(path);
  logWrite('vault.write', path, stamp, null, current);
}

/**
 * The agent's `edit_note` (mcp.rs `tool_edit_note_in`, M55.5), for the
 * browser-mode mock agent: quoted passages of the body replaced in place,
 * every edit or none, with every byte before the body and every byte no edit
 * quoted left as it was. Refuses what Rust refuses, in Rust's order and
 * words, before writing a byte: a malformed `expectHash`, the bundle
 * (`guard_agent_write`), anything that is not a markdown note (`note_join`,
 * a `.mmd` included), a missing note, bytes other than the ones `expectHash`
 * names (`stale_content`), a Type doc or an Agent record as the note stands,
 * the quotes themselves (`planEdits`, the twin of quote.rs), and bytes the
 * edits would make a Type doc or an Agent record. The read scope that gates
 * it in Rust is the grant's, which the mock agent has none of. A landed edit
 * is logged under the run's `stamp` (M58.1). Returns the report the tool
 * answers with.
 */
export async function agentEdit(
  _vault: string,
  path: string,
  edits: readonly QuoteEdit[],
  expectHash: string | undefined,
  stamp: WriteStamp,
): Promise<string> {
  const expected = parseExpectHash(expectHash);
  if (isKnowledgePath(path)) throw new Error(AGENT_USE_WRITE_CONCEPT);
  guardNoteTarget(path, MARKDOWN);
  const current = files.get(path);
  if (current === undefined) throw new Error(`no note at ${path}`);
  if (expected !== null && sha256Hex(current) !== expected) {
    throw new Error(staleContentMessage(path));
  }
  const governed = governedTypeRefusal(declaredType(path, current));
  if (governed !== null) throw new Error(governed);
  const { body } = splitFrontmatter(current);
  const prefix = current.slice(0, current.length - body.length);
  const plan = planEdits(body, prefix, edits);
  if (!plan.ok) throw new Error(plan.message);
  const saved = prefix + plan.text;
  const minted = governedTypeRefusal(declaredType(path, saved));
  if (minted !== null) throw new Error(minted);
  files.set(path, saved);
  touch(path);
  logWrite('vault.write', path, stamp, null, current);
  const count = `${edits.length} ${edits.length === 1 ? 'edit' : 'edits'}`;
  return [
    `Edited ${path}: ${count}; nothing outside the quoted text changed.`,
    ...plan.lines.map((line, i) => `  ${i + 1}. now at line ${line}`),
    `Hash: ${sha256Hex(saved)}`,
  ].join('\n');
}

/**
 * The agent's `create_note` (mcp.rs `tool_create_note`), for the
 * browser-mode mock agent (M57.4): a new note in `folder` named by `slug`,
 * `-2`, `-3` and so on when the name is taken, holding `body` under no
 * frontmatter. Refuses what Rust refuses, in Rust's order and words, before
 * writing a byte: the bundle (`guard_agent_write`), a slug that is not one
 * name (`safe_component`), then anything the planned file would be that is
 * no note (`judge_new_note`). A governed type in its frontmatter stays
 * Rust's to refuse (M53.6): the mock agent writes none. The new note is
 * logged under the run's `stamp` (M58.1). Returns the report the tool answers
 * with.
 */
export async function agentCreate(
  _vault: string,
  args: { folder: string; slug: string; body: string },
  stamp: WriteStamp,
): Promise<string> {
  const { folder, slug, body } = args;
  if (isKnowledgePath(folder)) throw new Error(AGENT_USE_WRITE_CONCEPT);
  if (slug === '' || slug === '.' || slug === '..' || /[/\\]/.test(slug)) {
    throw new Error(`invalid slug: ${JSON.stringify(slug)}`);
  }
  const prefix = folder === '' ? '' : `${folder}/`;
  let name = slug;
  for (let n = 2; files.has(`${prefix}${name}.md`); n++) name = `${slug}-${n}`;
  const path = `${prefix}${name}.md`;
  guardNoteTarget(path, MARKDOWN);
  files.set(path, body);
  touch(path);
  logWrite('vault.create', path, stamp, null, null);
  return `Created ${path}`;
}

export async function updateFrontmatter(
  _vault: string,
  path: string,
  patch: Record<string, unknown>,
): Promise<string | null> {
  // Parity with update_frontmatter in write.rs (M29.23): mermaid's config
  // header IS valid YAML, so patching a .mmd would merge into the diagram's
  // own header and reserialize it. There is no frontmatter here to update.
  if (path.endsWith('.mmd')) {
    throw new Error(`${path}: a .mmd is raw diagram source and has no frontmatter to update`);
  }
  guardNoteTarget(path, MARKDOWN);
  if (isKnowledgePath(path)) {
    // The valve's frontmatter half, with the SAME hard refusals as Rust:
    // provenance stamps are never a human patch, and alias removal has no
    // v1 event.
    for (const key of Object.keys(patch)) {
      if (key === 'generated' || key === 'verified') {
        throw new Error(`provenance forgery: the ${key} stamp is never a human edit — refused`);
      }
    }
    for (const key of RELATION_FIELDS) {
      if (key in patch) refuseAmbiguousLinks(patch[key], frontmatterValue(path, key));
    }
    if ('aliases' in patch) {
      const { yaml } = splitFrontmatter(mustGet(path));
      const doc: Document = YAML.parseDocument(yaml ?? '');
      const existing = (doc.toJS() as Record<string, unknown> | null)?.aliases;
      // Compared NORMALIZED, as Rust does (M49.6, K28): `Churn` → `churn`
      // is not a removal, and a raw-string compare called it one.
      const norms = (list: unknown) =>
        new Set(
          (Array.isArray(list) ? list.map(String) : [])
            .map(normalizeAliasV1)
            .filter((a) => a !== ''),
        );
      const before = norms(existing);
      const after = norms(patch.aliases);
      if ([...before].some((a) => !after.has(a))) {
        throw new Error(
          'unsupported_alias_removal: alias removal has no v1 event — keep the alias or wait ' +
            'for the maintenance channel',
        );
      }
    }
    // A captured write answers no hash, as Rust's valve answers None: the
    // projection is the ledger's, and the next scan reads it (M55.2).
    await writeFrontmatter(path, patch);
    logWrite('vault.write', path);
    return null;
  }
  await writeFrontmatter(path, patch);
  logWrite('vault.write', path);
  // The hash of the bytes written, as lib.rs `update_frontmatter` answers it.
  return sha256Hex(mustGet(path));
}

/** The one sanctioned human write into the bundle: `verified` and nothing
 * else. Scoping lives here so it cannot become a general-purpose bypass. */
export async function verifyConcept(
  vault: string,
  path: string,
  patch: Record<string, unknown>,
  viewedBodyHash: string,
): Promise<void> {
  if (!isKnowledgePath(path)) {
    throw new Error('verify_concept only applies to knowledge/ concepts');
  }
  const keys = Object.keys(patch);
  const offending = keys.find((k) => k !== 'verified');
  if (offending !== undefined) {
    throw new Error(`verify_concept may only write \`verified\`, not \`${offending}\``);
  }
  if (keys.length === 0) throw new Error('verify_concept requires a `verified` value');
  // M49.3: the stamp attests the body the person READ. Mirrors verify_with.
  if (sha256Hex(await readNote(vault, path)) !== viewedBodyHash) {
    throw new Error(`stale_view: ${path} changed since you opened it — reopen it and verify again`);
  }
  await writeFrontmatter(path, patch);
  logWrite('vault.write', path);
}

/** A wire TypedValue → its plain JSON value (`missing` means delete). */
function plainFromTyped(typed: Record<string, unknown>): unknown {
  switch (typed.type) {
    case 'missing':
      return undefined;
    case 'array':
      return (typed.value as Record<string, unknown>[]).map(plainFromTyped);
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(typed.value as Record<string, Record<string, unknown>>)) {
        out[k] = plainFromTyped(v);
      }
      return out;
    }
    default:
      return typed.value;
  }
}

/**
 * The M23.5 capture boundary, browser half. The GUARDS come from
 * `src/lib/epistemic` — the same module the conformance vectors pin — so
 * no schema rule grows a third hand-written copy here: editorial pointers
 * are restricted to `/body` and the declared presentation-only fields
 * (generated/verified provenance, epistemic frontmatter, and relation
 * pointers stay hard-refused), and structured pointers must be canonical
 * belief-state paths. The mock has no ledger; application is the file
 * update the Rust projection would regenerate.
 */
export async function captureConceptEdit(
  _vault: string,
  request: Record<string, unknown>,
): Promise<void> {
  const path = String(request.path ?? '');
  if (!isKnowledgePath(path)) {
    throw new Error('capture applies only to knowledge/ projections');
  }
  if (typeof request.request_id !== 'string' || request.request_id.length === 0) {
    throw new Error('capture requires the UI request id');
  }
  const kind = request.kind;
  if (kind === 'editorial') {
    const ops = (request.ops ?? []) as Record<string, unknown>[];
    if (ops.length === 0) throw new Error('an editorial capture with no ops changes nothing');
    for (const op of ops) validateOverridePointer(String(op.field_path ?? ''));
    applyCaptureOps(path, ops);
    logWrite('vault.write', path);
    return;
  }
  if (kind === 'structured') {
    const fields = (request.fields ?? []) as Record<string, unknown>[];
    const aliases = (request.alias_adds ?? []) as string[];
    if (fields.length === 0 && aliases.length === 0) {
      throw new Error('an empty capture request captures nothing');
    }
    for (const edit of fields) validateFieldPath(String(edit.field_path ?? ''));
    // Rust's capture refuses an alias that normalizes to nothing (M49.6).
    for (const alias of aliases) {
      if (normalizeAliasV1(alias) === '') {
        throw new Error(`alias ${JSON.stringify(alias)} normalizes to empty`);
      }
    }
    applyCaptureOps(path, fields);
    if (aliases.length > 0) {
      const { yaml } = splitFrontmatter(mustGet(path));
      const doc: Document = YAML.parseDocument(yaml ?? '');
      const existing = (doc.get('aliases') as string[] | undefined) ?? [];
      await writeFrontmatter(path, { aliases: [...existing, ...aliases] });
    }
    logWrite('vault.write', path);
    return;
  }
  throw new Error(`unknown capture kind ${String(kind)}`);
}

function applyCaptureOps(path: string, ops: Record<string, unknown>[]): void {
  for (const op of ops) {
    const pointer = String(op.field_path ?? '');
    const after = op.after as Record<string, unknown>;
    if (pointer === '/body') {
      const { yaml } = splitFrontmatter(mustGet(path));
      const body = String(plainFromTyped(after) ?? '');
      files.set(path, yaml !== null ? `---\n${yaml}---\n${body}` : body);
      touch(path);
      continue;
    }
    const key = pointer.slice('/fields/'.length).split('/')[0];
    const value = plainFromTyped(after);
    void writeFrontmatter(path, { [key]: value === undefined ? null : value });
  }
}

async function writeFrontmatter(path: string, patch: Record<string, unknown>): Promise<void> {
  const { yaml, body } = splitFrontmatter(mustGet(path));
  // parseDocument preserves key order and untouched keys on round-trip.
  // Typed as plain Document so the null-contents fallback assignment
  // typechecks (the Parsed narrowing would reject createNode's Node).
  const doc: Document = YAML.parseDocument(yaml ?? '');
  if (doc.contents === null) doc.contents = doc.createNode({});
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) doc.delete(key);
    else doc.set(key, value);
  }
  // Parity with write.rs `serialize_mapping`: a mapping the patch emptied
  // leaves no fence block, only the body (M55.11: removing a page's last key,
  // its icon, gives back exactly the page it was).
  const emptied = YAML.isMap(doc.contents) && doc.contents.items.length === 0;
  files.set(path, emptied ? body : `---\n${doc.toString()}---\n${body}`);
  touch(path);
}

export async function createNote(
  _vault: string,
  folder: string,
  slug: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<string> {
  // '' means the vault root — no separator, or the path grows a leading '/'
  // (parity with note_candidates in write.rs).
  const prefix = folder === '' ? '' : `${folder}/`;
  let finalSlug = slug;
  for (let n = 2; files.has(`${prefix}${finalSlug}.md`); n++) finalSlug = `${slug}-${n}`;
  const path = `${prefix}${finalSlug}.md`;
  // Judged on the file it will write, as write.rs create_note judges it: a
  // dot-folder (`.git/hooks`), a skipped folder, a dotfile slug, or the
  // bundle under another name refuses. Then the folder, as lib.rs guards it:
  // `knowledge/` itself refuses as read-only on both backends. A folded
  // spelling of the bundle refuses here as a note target, where Rust's
  // command refuses it as read-only first; both refuse (M53.28).
  guardNoteTarget(path, MARKDOWN);
  guardHumanWrite(folder);
  // Parity with write.rs create_note: null-valued keys are skipped, an empty
  // mapping omits the fence block, and an empty body gets a humanized H1.
  const kept = Object.entries(frontmatter).filter(([, value]) => value !== null);
  const finalBody = body.trim() === '' ? `# ${humanize(slug)}\n` : body;
  files.set(
    path,
    kept.length > 0
      ? `---\n${YAML.stringify(Object.fromEntries(kept))}---\n\n${finalBody}`
      : finalBody,
  );
  touch(path);
  logWrite('vault.create', path);
  return path;
}

export async function setNoteTitle(_vault: string, path: string, title: string): Promise<void> {
  guardHumanWrite(path);
  // Parity with set_note_title in write.rs: a .mmd's title is its filename,
  // and `# title` spliced into mermaid source breaks the diagram (M29.21).
  if (path.endsWith('.mmd')) {
    throw new Error(
      `${path}: a .mmd is raw diagram source, and its title is its filename — there is no H1 to set`,
    );
  }
  guardNoteTarget(path, MARKDOWN);
  const { yaml, body } = splitFrontmatter(mustGet(path));
  // Parity with write.rs replace_h1: rewrite exactly the line the parser
  // reads the title from (fence/indent-aware, shared firstH1LineIndex);
  // when the body has no real H1, prepend one at the very start.
  const h1Index = firstH1LineIndex(body);
  let newBody: string;
  if (h1Index >= 0) {
    const lines = body.split('\n');
    const hadCr = lines[h1Index].endsWith('\r');
    lines[h1Index] = `# ${title}${hadCr ? '\r' : ''}`;
    newBody = lines.join('\n');
  } else {
    newBody = `# ${title}\n\n${body}`;
  }
  files.set(path, yaml !== null ? `---\n${yaml}\n---\n${newBody}` : newBody);
  touch(path);
  logWrite('vault.write', path);
}

interface RawList {
  id: string;
  yaml: string;
  project: string | null;
  collection: string | null;
  path: string;
}

const LIST_SUFFIX = '.list.yml';
const COLLECTION_MARKER = 'collection.yml';

const dirOf = (path: string) => {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
};

/**
 * True when this folder's own note declares it a Collection (M47.5) — parity
 * with write.rs `declared_by_page`.
 *
 * `delivery/delivery.md` carrying `type: Collection` is what a
 * `collection.yml` used to be. Only the FOLDER NOTE speaks for its folder.
 */
function declaredByPage(dir: string): boolean {
  if (dir === '') return false;
  const base = dir.split('/').pop() ?? dir;
  const text = files.get(`${dir}/${base}.md`);
  if (text === undefined) return false;
  // Parity with write.rs, which reads `type:` the way the scanner does — so
  // CRLF, a BOM, a quoted value and a trailing comment all count, and a
  // `type: Collection` in prose does not.
  const { yaml } = splitFrontmatter(text);
  if (yaml === null) return false;
  try {
    return (YAML.parse(yaml) as { type?: unknown } | null)?.type === 'Collection';
  } catch {
    return false;
  }
}

/** Nearest ancestor folder declaring itself a Collection — parity with write.rs. */
function collectionOf(path: string): string | null {
  const markers = new Set(
    [...files.keys()]
      .filter((p) => p === COLLECTION_MARKER || p.endsWith(`/${COLLECTION_MARKER}`))
      .map(dirOf),
  );
  let dir = dirOf(path);
  for (;;) {
    // Either marker counts. A vault mid-conversion carries both shapes, and a
    // List whose container declared itself with a PAGE must not be reported as
    // living at the vault root — the app would then look for it under a
    // collection it does not have and find nothing, which is exactly what
    // "This list no longer exists" was on a freshly created list.
    if (markers.has(dir) || declaredByPage(dir)) return dir;
    if (dir === '') return null;
    dir = dirOf(dir);
  }
}

export async function listViews(_vault: string): Promise<RawList[]> {
  // Parity with write.rs list_views: M10 `*.list.yml` anywhere, plus the two
  // legacy shapes — root views/ is global; a views/ dir next to a project.md is
  // scoped to that project. Sorted by (collection, project, id).
  const projectDirs = [...files.keys()]
    .filter((p) => p.endsWith('/project.md'))
    .map((p) => p.slice(0, -'/project.md'.length));
  const views: RawList[] = [];
  for (const p of [...files.keys()].sort()) {
    if (!p.endsWith('.yml')) continue;
    // write.rs `vault_walker` never enters a dot-folder: a List in the
    // Trash (M60.8) is no List.
    if (p.split('/').slice(0, -1).some(isHidden)) continue;

    if (p.endsWith(LIST_SUFFIX)) {
      const id = (p.split('/').pop() ?? '').slice(0, -LIST_SUFFIX.length);
      if (id === '') continue;
      views.push({
        id,
        yaml: files.get(p) ?? '',
        project: null,
        collection: collectionOf(p),
        path: p,
      });
      continue;
    }

    if (p.startsWith('views/') && !p.slice('views/'.length).includes('/')) {
      views.push({
        id: p.slice('views/'.length, -'.yml'.length),
        yaml: files.get(p) ?? '',
        project: null,
        collection: null,
        path: p,
      });
      continue;
    }
    const dir = projectDirs.find(
      (d) => p.startsWith(`${d}/views/`) && !p.slice(`${d}/views/`.length).includes('/'),
    );
    if (dir !== undefined) {
      views.push({
        id: p.slice(`${dir}/views/`.length, -'.yml'.length),
        yaml: files.get(p) ?? '',
        project: `${dir}/project.md`,
        collection: null,
        path: p,
      });
    }
  }
  views.sort(
    (a, b) =>
      (a.collection ?? '').localeCompare(b.collection ?? '') ||
      (a.project ?? '').localeCompare(b.project ?? '') ||
      a.id.localeCompare(b.id),
  );
  return views;
}

/** As lib.rs save_view: the bundle guard on the file it writes, which
 * neither backend had before M58.1. */
export async function saveView(
  _vault: string,
  id: string,
  yaml: string,
  folder: string | null = null,
): Promise<void> {
  const path = folder === null ? `views/${id}.yml` : `${folder}/views/${id}.yml`;
  guardHumanWrite(path);
  const existed = files.has(path);
  files.set(path, yaml);
  touch(path);
  logWrite(writeKind(existed), path);
}

export async function listCollections(_vault: string): Promise<{ folder: string; yaml: string }[]> {
  return [...files.keys()]
    .filter((p) => p === COLLECTION_MARKER || p.endsWith(`/${COLLECTION_MARKER}`))
    .filter((p) => !p.split('/').slice(0, -1).some(isHidden))
    .map((p) => ({ folder: dirOf(p), yaml: files.get(p) ?? '' }))
    .sort((a, b) => a.folder.localeCompare(b.folder));
}

export async function saveCollection(_vault: string, folder: string, yaml: string): Promise<void> {
  // The bundle first, as lib.rs save_collection guards it (M53.28): the mock
  // had no guard here, so a collection.yml landed in knowledge/.
  guardHumanWrite(folder);
  if (folder === '') throw new Error('the vault root is not a collection');
  const path = `${folder}/${COLLECTION_MARKER}`;
  const existed = files.has(path);
  files.set(path, yaml);
  touch(path);
  logWrite(writeKind(existed), path);
}

export async function saveList(
  _vault: string,
  folder: string,
  id: string,
  yaml: string,
): Promise<void> {
  // As lib.rs save_list guards it (M53.28), and as saveCollection does.
  guardHumanWrite(folder);
  const path = folder === '' ? `${id}${LIST_SUFFIX}` : `${folder}/${id}${LIST_SUFFIX}`;
  const existed = files.has(path);
  files.set(path, yaml);
  touch(path);
  logWrite(writeKind(existed), path);
}

export async function startWatcher(_vault: string): Promise<void> {
  // The mock has no file watcher; writers trigger rescans directly. The open
  // does run lib.rs's launch purge of the Trash (M60.8).
  purgeExpiredTrash(new Date());
}

// The browser mock has no ledger (M21.7): the tamper-evident chain is a Rust
// substrate, and mirroring it here would be guard logic the mock must not
// grow. Parity is only that the command exists on both sides.
export async function ledgerHead(_vault: string): Promise<null> {
  return null;
}

/** Ledger diagnostics (M21.8): the live verdict on a vault's ledger.
 * Verdict tags are the Rust recovery states (kebab-case). The recording and
 * reconciliation banners read it (M49.2, M49.6). */
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
  /** Every knowledge file that is not the ledger's, with why (M49.6). */
  quarantined: QuarantinedPath[];
  /** Capture is stopped for the WHOLE vault (a mass mismatch, a migration
   * refusal, a rewound history) rather than per file (M49.5). */
  stopped: boolean;
  /** The vault HAS a ledger and its history could not be read, so
   * `quarantined` could not be computed — never "nothing quarantined". */
  history_unreadable: boolean;
  /** `[replacement, replaced]` supersessions a person approved on a card
   * (M49.8) — what `listConcepts` gates retirement on. */
  approved_supersessions: [string, string][];
  /** Concepts whose current review the ledger records as a person's (M49.8)
   * — what `listConcepts` gates supersession on when a ledger answers. */
  recorded_human: string[];
  /** Whether THIS process is recording the vault right now (M49.2). The
   * verdict is read from disk and cannot say it. */
  writer: WriterStatus;
}

/** One quarantined file (M49.6). `adoptable`: Keep can record it.
 * `refused`: Keep cannot (`reason` says why); Restore can. `deleted`: the
 * file is gone; Restore brings it back. `unrecorded`: Cerebro never
 * recorded it; Restore sets it aside. */
export interface QuarantinedPath {
  path: string;
  class: 'adoptable' | 'refused' | 'deleted' | 'unrecorded';
  reason: string;
}

/** `held` records. Every other state refuses knowledge writes (M49.1):
 * `lost-lock` (another Cerebro holds the vault), `refused` (the startup
 * verdict), `fail-stopped`, `other-vault`, `inactive`. `none` is the browser
 * mock, which keeps no ledger and writes its fake disk directly. */
export interface WriterStatus {
  state: 'held' | 'lost-lock' | 'refused' | 'fail-stopped' | 'other-vault' | 'inactive' | 'none';
  detail: string | null;
}

/** The relation fields whose wikilinks name other concepts. */
const RELATION_FIELDS = ['supersedes', 'refines', 'contradicts'] as const;

/** One frontmatter key of the file at `path`, as parsed. */
function frontmatterValue(path: string, key: string): unknown {
  const { yaml } = splitFrontmatter(mustGet(path));
  return (YAML.parse(yaml ?? '') as Record<string, unknown> | null)?.[key];
}

/**
 * Mirrors `migrate::resolve_link` + `ambiguous_link` (M49.10): a relation
 * link an edit ADDS whose stem two concepts share names neither, and is
 * refused with the same sentence Rust returns. A path-form link
 * (`[[metrics/churn]]`) names exactly one, and a link the file already
 * carried (`previous`) is not re-judged — as Rust's `relation_diff`.
 */
function refuseAmbiguousLinks(value: unknown, previous: unknown): void {
  const before = (Array.isArray(previous) ? previous : []).filter(
    (item): item is string => typeof item === 'string',
  );
  const after = (Array.isArray(value) ? value : []).filter(
    (item): item is string => typeof item === 'string',
  );
  const concepts = [...files.keys()]
    .filter((p) => p.startsWith('knowledge/') && p.endsWith('.md'))
    .map((p) => p.slice('knowledge/'.length))
    .sort();
  const linkOf = (item: string) => /^\[\[(.*)\]\]$/.exec(item)?.[1] ?? null;
  const targetOf = (link: string) => (link.split('|')[0] ?? '').trim();
  const stemOf = (krel: string) => krel.replace(/^.*\//, '').replace(/\.md$/, '');
  // The concepts a bare link's stem names, when it names more than one.
  const ambiguity = (link: string): string[] | null => {
    const target = targetOf(link);
    if (target.includes('/')) return null;
    const hits = concepts.filter((krel) => stemOf(krel) === target);
    return hits.length > 1 ? hits : null;
  };
  const refuse = (link: string, hits: string[]): never => {
    const example = hits[0].replace(/\.md$/, '');
    throw new Error(
      `[[${link}]] names more than one concept (${hits.map((h) => `knowledge/${h}`).join(', ')}) — link by path, e.g. [[${example}]]`,
    );
  };
  for (const item of after.filter((i) => !before.includes(i))) {
    const link = linkOf(item);
    const hits = link === null ? null : ambiguity(link);
    if (link !== null && hits !== null) refuse(link, hits);
  }
  // A path link removed beside a KEPT ambiguous link that could be read as
  // keeping it cannot be told apart from keeping it (Rust `relation_diff`).
  const removed = before
    .filter((i) => !after.includes(i))
    .map(linkOf)
    .filter((l): l is string => l !== null)
    .map((l) =>
      targetOf(l)
        .replace(/^\//, '')
        .replace(/^knowledge\//, '')
        .replace(/\.md$/, ''),
    );
  for (const item of after.filter((i) => before.includes(i))) {
    const link = linkOf(item);
    const hits = link === null ? null : ambiguity(link);
    if (link === null || hits === null) continue;
    if (removed.some((r) => hits.some((h) => h.replace(/\.md$/, '') === r))) refuse(link, hits);
  }
}

/**
 * The mock's ledger picture (M49.6, K28). The browser keeps no ledger, so by
 * default this is the fixed no-ledger status below; a spec seeds a diverged
 * one through `window.__cerebroSeedLedger` to render and drive the banners —
 * the incident path had never been rendered in any test.
 */
interface MockLedger {
  quarantined: QuarantinedPath[];
  stopped: boolean;
  open: boolean;
  writer: { state: WriterStatus['state']; detail: string | null };
  /** When set, `ledgerStatus` FAILS with this message — the read that
   * could not be made, which must never render as "all is well". */
  unreadable: string | null;
  historyUnreadable: boolean;
  approvedSupersessions: [string, string][];
  recordedHuman: string[];
}

let mockLedger: MockLedger | null = null;

/** Test-only seam, mirroring `__cerebroSeedReview`. `null` restores the
 * no-ledger default. */
export function __seedLedger(seed: Partial<MockLedger> | null): void {
  mockLedger =
    seed === null
      ? null
      : {
          quarantined: seed.quarantined ?? [],
          stopped: seed.stopped ?? false,
          open: seed.open ?? (seed.quarantined ?? []).length > 0,
          writer: seed.writer ?? { state: 'held', detail: null },
          unreadable: seed.unreadable ?? null,
          historyUnreadable: seed.historyUnreadable ?? false,
          approvedSupersessions: seed.approvedSupersessions ?? [],
          recordedHuman: seed.recordedHuman ?? [],
        };
}

// A spec can seed BEFORE the app loads (the banners read the status as the
// vault opens): `page.addInitScript` sets `window.__cerebroLedgerSeed`.
if (typeof window !== 'undefined') {
  const initial = (window as unknown as { __cerebroLedgerSeed?: Partial<MockLedger> })
    .__cerebroLedgerSeed;
  if (initial !== undefined) __seedLedger(initial);
}

if (typeof window !== 'undefined') {
  (
    window as unknown as { __cerebroSeedLedger: (s: Partial<MockLedger> | null) => void }
  ).__cerebroSeedLedger = __seedLedger;
}

/** Why Keep cannot record a file — the Rust refusals, verbatim in shape. */
function keepRefusal(q: QuarantinedPath): string | null {
  switch (q.class) {
    case 'adoptable':
      return null;
    case 'refused':
      return q.reason;
    case 'deleted':
      return 'the file was deleted, and a deletion is not something Keep can record yet — Restore brings it back';
    case 'unrecorded':
      return 'Cerebro never recorded this file, so there is no history to adopt it into — move it out of knowledge/, or Restore to set it aside';
  }
}

/** Mirrors `reconcile::resolve` / `resolve_path`: per file, or the whole
 * vault — Keep-all keeps what it can and names what it could not. */
export async function resolveReconciliation(
  _vault: string,
  action: string,
  path?: string,
): Promise<void> {
  const ledger = mockLedger;
  if (ledger === null) {
    throw new Error('no ledger in the browser — reconciliation is a Tauri-only surface');
  }
  const close = () => {
    if (ledger.quarantined.length === 0) ledger.open = false;
  };
  if (path !== undefined) {
    const q = ledger.quarantined.find((item) => item.path === path);
    if (q === undefined) throw new Error(`${path} is not quarantined`);
    if (action === 'keep') {
      const refusal = keepRefusal(q);
      if (refusal !== null) throw new Error(refusal);
    } else if (action !== 'restore') {
      throw new Error(`unknown per-file action "${action}"`);
    }
    ledger.quarantined = ledger.quarantined.filter((item) => item !== q);
    close();
    return;
  }
  if (!ledger.open) throw new Error('no open reconciliation to resolve');
  if (action === 'restore_ledger_authority') {
    ledger.quarantined = [];
    close();
    return;
  }
  if (action !== 'accept_current_files') {
    throw new Error(`unknown reconciliation action "${action}"`);
  }
  const all = ledger.quarantined;
  const refused = all.flatMap((q) => {
    const refusal = keepRefusal(q);
    return refusal === null ? [] : [{ q, refusal }];
  });
  ledger.quarantined = refused.map(({ q }) => q);
  close();
  if (refused.length > 0) {
    throw new Error(
      `kept ${all.length - refused.length} of ${all.length} files; these could not be kept — Restore them, or fix them and Keep again: ${refused.map(({ q, refusal }) => `${q.path}: ${refusal}`).join('; ')}`,
    );
  }
}

/** Fixed no-ledger status (M21.8) unless a spec seeded one: the browser mock
 * has no ledger, and the parity test asserts only that the command exists on
 * both sides. Its writer is `none` (M49.2) — not `held`, which would claim a
 * recording that does not exist, and not a refusal, which would put a "Not
 * recording" banner on every browser session. */
export async function ledgerStatus(_vault: string): Promise<LedgerStatus> {
  if (mockLedger?.unreadable != null) throw new Error(mockLedger.unreadable);
  if (mockLedger !== null) {
    return {
      verdict: 'valid',
      detail: 'seeded by a spec',
      head: null,
      seq: null,
      segments: 1,
      anomalies: 0,
      reconciliation_open: mockLedger.open,
      divergences: mockLedger.open ? ['seeded-divergence'] : [],
      quarantined: mockLedger.quarantined.map((q) => ({ ...q })),
      stopped: mockLedger.stopped,
      history_unreadable: mockLedger.historyUnreadable,
      approved_supersessions: mockLedger.approvedSupersessions.map(([a, b]) => [a, b]),
      recorded_human: [...mockLedger.recordedHuman],
      writer: { ...mockLedger.writer },
    };
  }
  return {
    verdict: 'no-ledger',
    detail: 'no ledger exists here yet',
    head: null,
    seq: null,
    segments: 0,
    anomalies: 0,
    reconciliation_open: false,
    divergences: [],
    quarantined: [],
    stopped: false,
    history_unreadable: false,
    approved_supersessions: [],
    recorded_human: [],
    writer: { state: 'none', detail: 'the browser mock keeps no ledger' },
  };
}

// --- Connectors (M13.3) ----------------------------------------------------
// Mirrors src-tauri/src/connectors.rs: raw JSON string, object-validated on
// save, empty when absent. Lives outside the files map — it is config, not a
// note, and scan must never see it.

export async function readConnectors(_vault: string): Promise<string> {
  return connectorsJson;
}

export async function saveConnectors(_vault: string, json: string): Promise<void> {
  // Parity with connectors.rs: an empty payload deletes the config, which
  // is the one way back to inheriting the user's global MCP setup.
  if (json.trim() === '') {
    connectorsJson = '';
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`connectors.json is not valid JSON: ${String(e)}`, { cause: e });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('connectors.json must be a JSON object');
  }
  connectorsJson = json;
}

// --- Connector status (M54.11) ----------------------------------------------
// Rust reads these rows from runtime.db, where the meter records what each
// run saw of its connectors. The browser runs nothing, so it has none until a
// spec or test seeds them, and it cannot compute `refused`: a row carries one
// only when it was seeded with one. `resetOperational()` restores both.

let connectorStatusRows: ConnectorStatusRow[] = [];
/** True models a runtime database that cannot be read. */
let connectorStatusFails = false;

export async function connectorStatus(_vault: string): Promise<ConnectorStatusRow[]> {
  if (connectorStatusFails) throw new Error('no runtime database for this workspace');
  return connectorStatusRows.map((row) => ({ ...row }));
}

/** Test-only seam, mirroring `__cerebroSeedFleet`: the rows a status read
 * returns, or `'fail'` for a read that rejects. */
export function __seedConnectorStatus(rows: ConnectorStatusRow[] | 'fail'): void {
  connectorStatusFails = rows === 'fail';
  connectorStatusRows = rows === 'fail' ? [] : rows.map((row) => ({ ...row }));
}

if (typeof window !== 'undefined') {
  (
    window as unknown as { __cerebroSeedConnectorStatus: typeof __seedConnectorStatus }
  ).__cerebroSeedConnectorStatus = __seedConnectorStatus;
}

// --- Vault format v2 file operations (M2 Task 3) ---

/** A folder holds no bytes, so it logs nothing (write.rs `UNRECORDED`). */
export async function createFolder(_vault: string, path: string): Promise<void> {
  guardHumanWrite(path);
  folders.add(path);
}

/**
 * Carry a page's comment sidecar, or a folder's mirrored sidecar folder, from
 * `from` to `to` (write.rs `rename_note_with`): an orphan at the target goes
 * first, then the sidecars move.
 */
function carryComments(from: string, to: string, isDir: boolean): void {
  const sideFrom = carriedRel(from, isDir);
  const sideTo = carriedRel(to, isDir);
  if (sideFrom === null || sideTo === null) return;
  if (!isDir) {
    if (files.delete(sideTo)) logWrite('vault.delete', sideTo);
    const sidecar = files.get(sideFrom);
    if (sidecar !== undefined) {
      files.set(sideTo, sidecar);
      files.delete(sideFrom);
      logWrite('vault.rename', sideFrom, null, sideTo);
    }
    return;
  }
  for (const p of [...files.keys()]) {
    if (p.startsWith(`${sideTo}/`)) files.delete(p);
  }
  let carried = false;
  for (const p of [...files.keys()]) {
    if (p.startsWith(`${sideFrom}/`)) {
      files.set(`${sideTo}/${p.slice(sideFrom.length + 1)}`, files.get(p)!);
      files.delete(p);
      carried = true;
    }
  }
  if (carried) logWrite('vault.rename', sideFrom, null, sideTo);
}

/** Move a note — or a whole folder prefix — within the vault, and its
 * comments with it (M70.2). */
export async function renameNote(_vault: string, from: string, to: string): Promise<void> {
  // Refused from both sides: out would strip the boundary, in would smuggle
  // human content into the agent's corpus.
  guardHumanWrite(from);
  guardHumanWrite(to);
  if (files.has(to) || folders.has(to)) throw new Error(`target already exists: ${to}`);
  if (files.has(from)) {
    carryComments(from, to, false);
    files.set(to, files.get(from)!);
    files.delete(from);
    const t = times.get(from);
    if (t) {
      times.set(to, t);
      times.delete(from);
    }
    touch(to);
    logWrite('vault.rename', from, null, to);
    return;
  }
  // Folder move: rewrite every key under the prefix.
  const prefix = `${from}/`;
  const moved = [...files.keys()].filter((p) => p.startsWith(prefix));
  if (moved.length === 0 && !folders.has(from)) throw new Error(`Note not found: ${from}`);
  carryComments(from, to, true);
  for (const p of moved) {
    const dest = `${to}/${p.slice(prefix.length)}`;
    files.set(dest, files.get(p)!);
    files.delete(p);
    const t = times.get(p);
    if (t) {
      times.set(dest, t);
      times.delete(p);
    }
  }
  if (folders.delete(from)) folders.add(to);
  logWrite('vault.rename', from, null, to);
}

// --- The vault's Trash (M60.8) ---------------------------------------------
//
// Mirrors src-tauri/src/vault/trash.rs in its order and its words: a delete
// moves the keys under `.trash/<stamp>/`, its sidecar under
// `.trash/<stamp>/.comments/`, and writes the manifest key beside them;
// Restore puts both back and refuses to overwrite. scanVault and listFolders
// already hide `.trash/`, a dot-folder. Both backends replay
// src-tauri/fixtures/trash-cases.json.

/** Every key under `prefix/`, plus whether `prefix` is a kept folder. */
const keysUnder = (prefix: string): string[] =>
  [...files.keys()].filter((p) => p.startsWith(`${prefix}/`));

/** Is anything — a file, a folder's files, an empty folder — at `path`? */
const occupied = (path: string): boolean =>
  files.has(path) || keysUnder(path).length > 0 || folders.has(path);

/** Move a file key and its times. */
function moveKey(from: string, to: string): void {
  files.set(to, files.get(from)!);
  files.delete(from);
  const t = times.get(from);
  times.delete(from);
  if (t) times.set(to, t);
}

/** Move `from` (a file, or every key and kept folder under it) to `to`. */
function moveTree(from: string, to: string): void {
  if (files.has(from)) {
    moveKey(from, to);
    return;
  }
  for (const p of keysUnder(from)) moveKey(p, `${to}${p.slice(from.length)}`);
  for (const dir of [...folders]) {
    if (dir === from || dir.startsWith(`${from}/`)) {
      folders.delete(dir);
      folders.add(`${to}${dir.slice(from.length)}`);
    }
  }
}

/** Pages under a trashed item: 1 or 0 for a file, every shown `.md`/`.mmd`
 * under a folder (trash.rs `count_pages`). */
function trashedPages(itemKey: string, rel: string, isDir: boolean): number {
  const isPage = (name: string) => name.endsWith('.md') || name.endsWith('.mmd');
  if (!isDir) return isPage(rel) ? 1 : 0;
  return keysUnder(itemKey).filter((p) => {
    const inside = p.slice(itemKey.length + 1).split('/');
    return isPage(p) && !inside.some(isHiddenName);
  }).length;
}

/** Does a stamp dir hold anything but dot-names? */
const holdsAnItem = (stampDir: string): boolean =>
  [...files.keys(), ...folders].some(
    (p) =>
      p.startsWith(`${stampDir}/`) && !isHiddenName(p.slice(stampDir.length + 1).split('/')[0]),
  );

/** A stamp's manifest, under the words a restore refuses with. */
function readTrashManifest(stamp: string) {
  if (parseStamp(stamp) === null) throw new Error(nothingAt(stamp));
  const dir = `${TRASH_DIR}/${stamp}`;
  const text = files.get(`${dir}/${MANIFEST}`);
  if (text === undefined) {
    throw new Error(holdsAnItem(dir) ? UNREADABLE_ITEM : nothingAt(stamp));
  }
  const manifest = parseManifest(text);
  if (manifest === null) throw new Error(UNREADABLE_ITEM);
  return manifest;
}

/** Move a note or folder to the vault's Trash, and its comment sidecar
 * after it (lib.rs `delete_note`, trash.rs `trash_locked`). */
export async function deleteNote(_vault: string, path: string): Promise<TrashedItem> {
  // Mirrors lib.rs delete_note (M17.1). This was the one write path with no
  // guard on either backend — parity here is the point of this file.
  guardHumanWrite(path);
  if (path === '' || path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`path escapes the vault: ${path}`);
  }
  if (!isItemPath(path)) throw new Error(notAPage(path));
  const isDir = !files.has(path);
  if (!occupied(path)) throw new Error(`not found: ${path}`);
  let stamp = newStamp(new Date(), Math.floor(Math.random() * 0x10000));
  while (occupied(`${TRASH_DIR}/${stamp}`)) {
    stamp = newStamp(new Date(), Math.floor(Math.random() * 0x10000));
  }
  const dir = `${TRASH_DIR}/${stamp}`;
  const name = path.split('/').at(-1) ?? path;
  const raw = files.get(path);
  const title =
    raw !== undefined && (path.endsWith('.md') || path.endsWith('.mmd'))
      ? parseNote(path, raw, SEED_TIME, SEED_TIME).title
      : name;
  const deletedAt = rfc3339(parseStamp(stamp)!);
  const kind = isDir ? 'folder' : 'file';
  files.set(
    `${dir}/${MANIFEST}`,
    manifestBytes({ format: 1, path, kind, title, deleted_at: deletedAt }),
  );
  moveTree(path, `${dir}/${path}`);
  logWrite('vault.delete', path);
  const side = carriedRel(path, isDir);
  if (side !== null && occupied(side)) {
    moveTree(side, `${dir}/${side}`);
    logWrite('vault.delete', side);
  }
  return {
    stamp,
    path,
    kind,
    title,
    deletedAt,
    pages: trashedPages(`${dir}/${path}`, path, isDir),
  };
}

/** Every item in the Trash, newest first (trash.rs `list_trash`). */
export async function listTrash(_vault: string): Promise<TrashedItem[]> {
  const stamps = new Set<string>();
  for (const p of [...files.keys(), ...folders]) {
    const names = p.split('/');
    if (names[0] === TRASH_DIR && names.length > 2 && parseStamp(names[1]) !== null) {
      stamps.add(names[1]);
    }
  }
  const items: TrashedItem[] = [];
  for (const stamp of [...stamps].sort().reverse()) {
    const dir = `${TRASH_DIR}/${stamp}`;
    const text = files.get(`${dir}/${MANIFEST}`);
    const manifest = text === undefined ? null : parseManifest(text);
    if (manifest !== null) {
      const itemKey = `${dir}/${manifest.path}`;
      if (!occupied(itemKey)) continue;
      items.push({
        stamp,
        path: manifest.path,
        kind: manifest.kind,
        title: manifest.title,
        deletedAt: manifest.deleted_at,
        pages: trashedPages(itemKey, manifest.path, manifest.kind === 'folder'),
      });
    } else if (holdsAnItem(dir)) {
      items.push({
        stamp,
        path: dir,
        kind: 'unreadable',
        title: '',
        deletedAt: rfc3339(parseStamp(stamp)!),
        pages: null,
      });
    }
  }
  return items;
}

/** Put a Trash item back (lib.rs `restore_from_trash`, trash.rs
 * `untrash_locked`): never over anything, its sidecar too unless one now
 * sits at its place. Resolves the path it restored. */
export async function restoreFromTrash(_vault: string, stamp: string): Promise<string> {
  const manifest = readTrashManifest(stamp);
  const target = manifest.path;
  guardHumanWrite(target);
  const dir = `${TRASH_DIR}/${stamp}`;
  const itemKey = `${dir}/${target}`;
  const isDir = manifest.kind === 'folder';
  const there = isDir ? keysUnder(itemKey).length > 0 || folders.has(itemKey) : files.has(itemKey);
  if (!there) throw new Error(occupied(itemKey) ? UNREADABLE_ITEM : nothingAt(stamp));
  if (occupied(target)) throw new Error(alreadyExists(target));
  moveTree(itemKey, target);
  if (isDir) folders.add(target);
  logWrite('vault.create', target);
  const side = carriedRel(target, isDir);
  if (side !== null && occupied(`${dir}/${side}`) && !occupied(side)) {
    moveTree(`${dir}/${side}`, side);
    logWrite('vault.create', side);
  }
  files.delete(`${dir}/${MANIFEST}`);
  for (const kept of [...folders]) {
    if (kept === dir || kept.startsWith(`${dir}/`)) folders.delete(kept);
  }
  return target;
}

/** The launch purge (trash.rs `purge_expired`): every stamp dir past its
 * days at `now`, by its stamp, goes to `remove` — by default, gone from the
 * mock disk, as the OS Trash takes it — and one `remove` refuses stays. */
export function purgeExpiredTrash(
  now: Date,
  remove: (stampDir: string) => void = (stampDir) => {
    for (const p of keysUnder(stampDir)) {
      files.delete(p);
      times.delete(p);
    }
    for (const kept of [...folders]) if (kept.startsWith(`${stampDir}/`)) folders.delete(kept);
  },
): { moved: number; kept: number } {
  const report = { moved: 0, kept: 0 };
  const stamps = new Set<string>();
  for (const p of [...files.keys(), ...folders]) {
    const names = p.split('/');
    if (names[0] === TRASH_DIR && names.length > 2) stamps.add(names[1]);
  }
  for (const stamp of [...stamps].sort()) {
    const at = parseStamp(stamp);
    if (at === null || !expired(at, now)) continue;
    try {
      remove(`${TRASH_DIR}/${stamp}`);
      report.moved += 1;
    } catch {
      report.kept += 1;
    }
  }
  return report;
}

// --- Page comments (M70.2) --------------------------------------------------
//
// Mirrors src-tauri/src/vault/comments.rs in its order and its words: the
// page is judged as a note (`guardNoteTarget`, note_join's mirror) and must
// exist; the sidecar is read and parsed, and one that can't be read refuses
// and is never overwritten; the op applies; nothing is written when nothing
// changed; the result must fit the cap and read back; then it lands in the
// files Map. No knowledge guard: a comment writes no page byte. Both backends
// replay src-tauri/fixtures/comment-cases.json.

/** The page a comment belongs to: a markdown note that exists. */
function commentPage(path: string): void {
  guardNoteTarget(path, MARKDOWN);
  if (!files.has(path)) throw new Error(`no note at ${path}`);
}

/** A page's sidecar as a file, or the reason it can't be read. */
function readSidecar(path: string): CommentsFile | { reason: string } {
  const text = files.get(sidecarPathOf(path));
  if (text === undefined) return emptyComments();
  const parsed = parseComments(text);
  return parsed.ok ? parsed.file : { reason: parsed.reason };
}

/** Sixteen random lowercase hex characters no comment in `file` has. */
function freshCommentId(file: CommentsFile): string {
  const taken = new Set(file.threads.flatMap((t) => t.comments.map((c) => c.id)));
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (!taken.has(id)) return id;
  }
}

/** Now, RFC 3339 UTC to the second. */
const nowSecs = (): string => `${new Date().toISOString().slice(0, 19)}Z`;

/**
 * `vault::comments::rewrite`: apply `op` to `path`'s sidecar as `by`, with
 * the run that asked. Exported for the agent comment tools (M70.3).
 */
export function writeMockComment(
  path: string,
  op: CommentOp,
  by: string,
  runId: string | null,
): CommentsFile {
  commentPage(path);
  const current = readSidecar(path);
  if ('reason' in current) {
    throw new Error(
      `Comments for ${path} can't be read (${current.reason}), so nothing was written.`,
    );
  }
  const outcome = applyCommentOp(current, op, {
    ids: [freshCommentId(current)],
    now: nowSecs(),
    by,
    run_id: runId,
    page: path,
  });
  if (!outcome.ok) throw new Error(outcome.error);
  if (outcome.file === null) return current;
  const text = serializeComments(outcome.file);
  const tooBig = sizeRefusal(path, text);
  if (tooBig !== null) throw new Error(tooBig);
  const back = parseComments(text);
  if (!back.ok) {
    throw new Error(
      `Comments for ${path} would not read back (${back.reason}), so nothing was written.`,
    );
  }
  files.set(sidecarPathOf(path), text);
  // A comment changes no page: its own kind, as comments.rs records it.
  logWrite('vault.comment', sidecarPathOf(path), { actor: by, runId });
  return outcome.file;
}

export async function listComments(_vault: string, path: string): Promise<CommentsFile> {
  commentPage(path);
  const current = readSidecar(path);
  if ('reason' in current)
    throw new Error(`Comments for ${path} can't be read: ${current.reason}.`);
  return current;
}

export async function startCommentThread(
  _vault: string,
  path: string,
  anchor: CommentAnchor | null,
  body: string,
): Promise<CommentsFile> {
  return writeMockComment(path, { op: 'start', anchor, body }, OWNER, null);
}

export async function replyToCommentThread(
  _vault: string,
  path: string,
  thread: string,
  body: string,
): Promise<CommentsFile> {
  return writeMockComment(path, { op: 'reply', thread, body }, OWNER, null);
}

export async function setCommentThreadResolved(
  _vault: string,
  path: string,
  thread: string,
  resolved: boolean,
): Promise<CommentsFile> {
  return writeMockComment(path, { op: 'set_resolved', thread, resolved }, OWNER, null);
}

export async function deleteComment(
  _vault: string,
  path: string,
  thread: string,
  comment: string,
): Promise<CommentsFile> {
  return writeMockComment(path, { op: 'delete_comment', thread, comment }, OWNER, null);
}

export async function deleteCommentThread(
  _vault: string,
  path: string,
  thread: string,
): Promise<CommentsFile> {
  return writeMockComment(path, { op: 'delete_thread', thread }, OWNER, null);
}

// --- The agent comment tools (M70.3) ------------------------------------------
//
// Mirrors src-tauri/src/comment_tools.rs in its order and its words: the
// arguments, the note (a markdown page that exists, then commentPage), the
// sidecar, the thread or the quote, then the write as the run's actor with
// its run id. The quote is found by quote.ts's one finder, kept where the
// page shows it as text (`commentMatches`). Both replay
// src-tauri/fixtures/comment-tools.json. The per-run cap of 20 is Rust's
// alone (the M53.6 precedent for Rust-only rules). Each answers the report
// the tool answers with, and throws its refusal.

const NOTHING_POSTED = 'Nothing was posted.';
/** The most characters (code points) an agent's comment holds. */
export const AGENT_COMMENT_MAX_CHARS = 8000;

/** A string argument, as Rust's `arg_str` reads one: anything else is absent. */
const commentArg = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === 'string' ? (args[key] as string) : undefined;

/** `text`, trimmed as the store trims it, or why it can't be posted. */
function agentCommentText(text: string): string {
  const trimmed = rustTrim(text);
  if (trimmed === '') {
    throw new Error(`\`text\` is empty. Write the comment to post. ${NOTHING_POSTED}`);
  }
  const n = [...trimmed].length;
  if (n > AGENT_COMMENT_MAX_CHARS) {
    throw new Error(
      `A comment holds at most ${AGENT_COMMENT_MAX_CHARS} characters; this one has ${n}. ${NOTHING_POSTED}`,
    );
  }
  return trimmed;
}

/** `occurrence` as Rust reads it: absent or null is none, a whole number
 * from 0 up is that one, and anything else is 0, which is refused. */
function agentOccurrence(args: Record<string, unknown>): number | undefined {
  const value = args.occurrence;
  if (value === undefined || value === null) return undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** The page a comment tool works on: a markdown note that exists. */
function agentNote(path: string): void {
  if (!isCommentPage(path) || !files.has(path)) throw new Error(`no note at ${path}`);
  commentPage(path);
}

function agentThreads(path: string): CommentsFile {
  const current = readSidecar(path);
  if ('reason' in current) {
    throw new Error(
      `Cerebro could not read the comments on ${path} (${current.reason}), so nothing was posted.`,
    );
  }
  return current;
}

function agentPost(path: string, op: CommentOp, stamp: WriteStamp): CommentsFile {
  const runId = stamp.runId.trim() === '' ? null : stamp.runId;
  try {
    return writeMockComment(path, op, stamp.actor, runId);
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).replace(/\.+$/, '');
    throw new Error(
      `Cerebro could not save the comment on ${path} (${error}), so nothing was posted.`,
      { cause: err },
    );
  }
}

/** Where `quote` sits in `body` among the page's own text, or why not. */
function agentLocate(
  body: string,
  prefix: string,
  quote: string,
  occurrence: number | undefined,
): number {
  const found = commentMatches(body, quote);
  const refuseListed = (head: string): never => {
    throw new Error([...listed(head, body, quote, found), NOTHING_POSTED].join('\n'));
  };
  const n = found.length;
  if (n === 0) {
    if (occurrencesOf(body, quote).length > 0) {
      throw new Error(
        `The quoted text appears only inside a fence, a \`:::\` line, a line's marker or a link's target, which the page doesn't show as text. Quote words the page shows. ${NOTHING_POSTED}`,
      );
    }
    if (prefix.includes(quote)) {
      throw new Error(
        `The quoted text is in the frontmatter; comments anchor to the note's body. ${NOTHING_POSTED}`,
      );
    }
    throw new Error(
      `The quoted text is not in the note's body. Quote plain words exactly as get_note shows them (for a formatted passage, a part with no markdown inside), or read the note again if it may have changed. ${NOTHING_POSTED}`,
    );
  }
  if (occurrence === undefined) {
    if (n === 1) return found[0];
    return refuseListed(
      `The quoted text appears ${n} times. Pass \`occurrence\` (counting from 1) or quote a longer passage:`,
    );
  }
  if (occurrence > n) {
    return refuseListed(
      `\`occurrence\` is ${occurrence}, but the quoted text appears ${n} ${n === 1 ? 'time' : 'times'}:`,
    );
  }
  return found[occurrence - 1];
}

/** Thread `id` on `path`, open: refused unknown, deleted, and resolved in
 * `resolved`'s words. */
function agentOpenThread(
  file: CommentsFile,
  path: string,
  id: string,
  resolved: string,
): CommentThread {
  const thread = file.threads.find((t) => threadId(t) === id);
  if (thread === undefined) {
    throw new Error(
      `No thread ${id} on ${path}. get_note lists a note's open threads with their ids. ${NOTHING_POSTED}`,
    );
  }
  if (thread.deleted) throw new Error(`Thread ${id} on ${path} was deleted. ${NOTHING_POSTED}`);
  if (thread.resolved) throw new Error(`Thread ${id} on ${path} ${resolved}`);
  return thread;
}

/**
 * The agent's `comment_on_note` (comment_tools.rs), for the browser-mode
 * mock agent: a new thread on the whole page, or on the quoted passage,
 * written as `stamp`'s actor with its run. The page's bytes never change.
 */
export async function agentComment(
  _vault: string,
  args: Record<string, unknown>,
  stamp: WriteStamp,
): Promise<string> {
  const path = commentArg(args, 'path');
  if (path === undefined) throw new Error('comment_on_note needs a path');
  const raw = commentArg(args, 'text');
  if (raw === undefined) throw new Error('comment_on_note needs `text`, the comment to post');
  const text = agentCommentText(raw);
  const quote = commentArg(args, 'quote');
  const occurrence = agentOccurrence(args);
  if (quote !== undefined) {
    if (rustTrim(quote) === '') {
      throw new Error(
        `\`quote\` is empty. Quote the passage the comment is about, or leave \`quote\` out to comment on the whole page. ${NOTHING_POSTED}`,
      );
    }
    const what = quoteMarkdown(quote);
    if (what !== null) {
      throw new Error(
        `\`quote\` holds markdown (${what}). Quote plain words from one line, as the page reads, or leave \`quote\` out to comment on the whole page. ${NOTHING_POSTED}`,
      );
    }
  } else if (occurrence !== undefined) {
    throw new Error(`\`occurrence\` only applies with \`quote\`. ${NOTHING_POSTED}`);
  }
  if (occurrence === 0) throw new Error(`\`occurrence\` counts from 1. ${NOTHING_POSTED}`);
  agentNote(path);
  agentThreads(path);
  if (quote === undefined) {
    const file = agentPost(path, { op: 'start', anchor: null, body: text }, stamp);
    const id = threadId(file.threads[file.threads.length - 1]);
    return `Commented on ${path} as thread ${id}, about the whole page.`;
  }
  const current = mustGet(path);
  const { body } = splitFrontmatter(current);
  const prefix = current.slice(0, current.length - body.length);
  const start = agentLocate(body, prefix, quote, occurrence);
  const end = start + quote.length;
  const k = commentMatches(body, quote).indexOf(start) + 1;
  const anchor = { quote, occurrence: k, ...anchorContext(body, start, end) };
  const file = agentPost(path, { op: 'start', anchor, body: text }, stamp);
  const id = threadId(file.threads[file.threads.length - 1]);
  return `Commented on ${path} as thread ${id}, on line ${lineAt(body, start)}: ${quoteContext(body, start, end)}`;
}

/** The agent's `reply_to_comment` (comment_tools.rs): a reply at the end of
 * an open thread. */
export async function agentReply(
  _vault: string,
  args: Record<string, unknown>,
  stamp: WriteStamp,
): Promise<string> {
  const path = commentArg(args, 'path');
  if (path === undefined) throw new Error('reply_to_comment needs a path');
  const thread = commentArg(args, 'thread');
  const raw = commentArg(args, 'text');
  if (thread === undefined || raw === undefined) {
    throw new Error('reply_to_comment needs `thread`, the id get_note lists, and `text`');
  }
  const text = agentCommentText(raw);
  agentNote(path);
  agentOpenThread(
    agentThreads(path),
    path,
    thread,
    `is resolved, and reopening it is the person's call. Start a new comment if your point is new. ${NOTHING_POSTED}`,
  );
  agentPost(path, { op: 'reply', thread, body: text }, stamp);
  return `Replied in thread ${thread} on ${path}.`;
}

/** The agent's `resolve_comment` (comment_tools.rs): resolve an open
 * thread, with a closing reply in the same write when `text` is given. */
export async function agentResolve(
  _vault: string,
  args: Record<string, unknown>,
  stamp: WriteStamp,
): Promise<string> {
  const path = commentArg(args, 'path');
  if (path === undefined) throw new Error('resolve_comment needs a path');
  const thread = commentArg(args, 'thread');
  if (thread === undefined) {
    throw new Error('resolve_comment needs `thread`, the id get_note lists');
  }
  const raw = commentArg(args, 'text');
  const closing = raw === undefined ? null : agentCommentText(raw);
  agentNote(path);
  agentOpenThread(agentThreads(path), path, thread, 'is already resolved. Nothing changed.');
  agentPost(path, { op: 'set_resolved', thread, resolved: true, closing }, stamp);
  return closing === null
    ? `Resolved thread ${thread} on ${path}.`
    : `Resolved thread ${thread} on ${path}, after your closing reply.`;
}

// --- An @agent in a comment thread (M70.4) ----------------------------------
//
// Mirrors src-tauri/src/agent/thread_turn.rs in its order and its words:
// exactly one agent answers the handle, it is not paused, the page is a note,
// its read scope admits the page, the sidecar reads, the thread and the
// comment exist, a person wrote it, and this agent has not answered it; then
// the record's model and effort. Both replay
// src-tauri/fixtures/thread-turns.json. The placeholder and its settling
// write the sidecar as comments.rs's rewrite does.

/** What a thread turn asks: the page, the thread, the comment, the handle. */
export interface ThreadTurnRequest {
  page: string;
  thread: string;
  message: string;
  handle: string;
}

/** A turn the mock agreed to start: who answers, on what record's limits,
 * and the person's text. */
export interface ThreadTurnPlan {
  title: string;
  actor: string;
  scope: string[] | null;
  readScope: string[] | null;
  allowedTools: string[] | null;
  model: string | null;
  effort: string | null;
  askFirst: boolean;
  text: string;
}

/** The prefix check both scope axes share (mcp.rs `scope_admits`). */
function scopeAdmits(scope: string[] | null, path: string): boolean {
  if (scope === null) return true;
  const target = path.replace(/^\.\//, '').replace(/^\/+/, '');
  return scope.some((raw) => {
    const folder = raw.replace(/^\/+|\/+$/g, '');
    return folder === '' || target === folder || target.startsWith(`${folder}/`);
  });
}

/** The asking comment's checks (thread_turn.rs `asking_refusal`): answers
 * the thread's index and the comment's, or throws the refusal. */
function threadTurnAsking(
  file: CommentsFile,
  req: ThreadTurnRequest,
  title: string,
  actor: string,
): [number, number] {
  const t = file.threads.findIndex((x) => threadId(x) === req.thread && x.deleted === undefined);
  if (t < 0) throw new Error('That thread is gone, so nobody was asked.');
  const thread = file.threads[t];
  const m = thread.comments.findIndex((c) => c.id === req.message && c.deleted === undefined);
  if (m < 0) throw new Error('That comment is gone, so nobody was asked.');
  if (!thread.comments[m].author.startsWith('human:')) {
    throw new Error("Only a person's comment can ask an agent, so nobody was asked.");
  }
  const earlier = thread.comments.find((c) => c.answers === req.message && c.author === actor);
  if (earlier !== undefined) {
    throw new Error(
      earlier.state === 'pending'
        ? `${title} is already answering that comment.`
        : `${title} has already answered that comment.`,
    );
  }
  return [t, m];
}

/**
 * Check a thread turn as thread_turn.rs `plan` does, in its words, and
 * answer the plan. Writes nothing.
 */
export async function threadTurnRefusal(
  vault: string,
  req: ThreadTurnRequest,
): Promise<ThreadTurnPlan> {
  const entries = await scanVault(vault);
  const answering = entries.filter(isAgentEntry).filter((e) => agentHandle(e) === req.handle);
  if (answering.length === 0) {
    throw new Error(`No agent answers to @${req.handle}, so nobody was asked.`);
  }
  if (answering.length > 1) {
    const paths = answering.map((e) => e.path).sort();
    throw new Error(
      `More than one agent answers to @${req.handle} (${paths.join(', ')}), so nobody was asked. Give each its own \`slug:\`.`,
    );
  }
  const record = answering[0];
  const title = record.title;
  const actor = `process:${agentHandle(record)}`;
  if (record.properties.paused === true) {
    throw new Error(`${title} is paused, so it can't answer here.`);
  }
  const page = req.page;
  if (!entries.some((e) => e.path === page) || !page.endsWith('.md')) {
    throw new Error(`no note at ${page}`);
  }
  commentPage(page);
  const readScope = parseReadScope(record);
  if (!scopeAdmits(readScope, page)) {
    const folders =
      readScope === null || readScope.length === 0 ? 'nothing' : `only ${readScope.join(', ')}`;
    throw new Error(
      `${title} can't read ${page} (it may read ${folders}), so it can't answer here.`,
    );
  }
  const file = readSidecar(page);
  if ('reason' in file) {
    throw new Error(
      `Cerebro could not read the comments on ${page} (${file.reason}), so nobody was asked.`,
    );
  }
  const [t, m] = threadTurnAsking(file, req, title, actor);
  const model = storedChoice(record.properties.model);
  const effort = storedChoice(record.properties.effort);
  const refused = runOptionsRefusal({ model, effort });
  if (refused !== null) throw new Error(`${title}'s record: ${refused}`);
  return {
    title,
    actor,
    scope: parseScope(record),
    readScope,
    allowedTools: parseAllowedTools(record.properties['allowed-tools']),
    model,
    effort,
    askFirst: askFirstOf(record).on,
    text: file.threads[t].comments[m].body,
  };
}

/**
 * Post a turn's pending placeholder (thread_turn.rs `post_placeholder`):
 * authored by the agent, bound to `runId`, naming the comment it answers,
 * with the asking checks run again on the sidecar as it stands, so two
 * starts post one. Answers the placeholder's id.
 */
export function postThreadPlaceholder(
  req: ThreadTurnRequest,
  plan: Pick<ThreadTurnPlan, 'title' | 'actor'>,
  runId: string,
): string {
  commentPage(req.page);
  const current = readSidecar(req.page);
  if ('reason' in current) {
    throw new Error(
      `Cerebro could not save the comment on ${req.page} (Comments for ${req.page} can't be read (${current.reason}), so nothing was written), so nobody was asked.`,
    );
  }
  const [t] = threadTurnAsking(current, req, plan.title, plan.actor);
  const id = freshCommentId(current);
  const next: CommentsFile = structuredClone(current);
  next.threads[t].comments.push({
    id,
    author: plan.actor,
    created: nowSecs(),
    body: '',
    run_id: runId,
    state: 'pending',
    answers: req.message,
  });
  writeSidecarAs(req.page, next, plan.actor, runId);
  return id;
}

/** How a mock thread turn ended, as Rust's `RunEnd` carries it. */
export interface ThreadTurnEnd {
  outcome:
    | 'succeeded'
    | 'failed'
    | 'quota_failed'
    | 'cancelled'
    | 'elapsed_aborted'
    | 'abandoned_usage_unknown';
  answer: string | null;
  failure: string | null;
}

/** Where an answer is cut, in code points (thread_turn.rs). */
export const THREAD_ANSWER_MAX_CHARS = 8000;

/** The words a turn's ending settles its placeholder with, and its state
 * (thread_turn.rs `settle_words`). */
export function settleWords(
  title: string,
  end: ThreadTurnEnd,
): { text: string; state: 'answered' | 'failed' } {
  switch (end.outcome) {
    case 'succeeded': {
      const answer = end.answer !== null && rustTrim(end.answer) !== '' ? end.answer : null;
      if (answer === null) {
        return { text: `${title} finished without writing a reply.`, state: 'answered' };
      }
      const chars = [...answer];
      if (chars.length > THREAD_ANSWER_MAX_CHARS) {
        return {
          text: `${chars.slice(0, THREAD_ANSWER_MAX_CHARS).join('')}\n\n(Cut at 8000 characters; the whole reply is in the run's transcript.)`,
          state: 'answered',
        };
      }
      return { text: answer, state: 'answered' };
    }
    case 'failed':
    case 'quota_failed':
      return {
        text:
          end.failure !== null && rustTrim(end.failure) !== ''
            ? `${title} couldn't answer: ${end.failure}`
            : `${title} couldn't answer. The run's detail in Fleet says what happened.`,
        state: 'failed',
      };
    case 'cancelled':
      return { text: `${title} was stopped before it answered.`, state: 'failed' };
    case 'elapsed_aborted':
      return { text: `${title} ran out of time before it answered.`, state: 'failed' };
    case 'abandoned_usage_unknown':
      return { text: `${title} ended before it finished answering.`, state: 'failed' };
  }
}

/**
 * Replace run `runId`'s pending placeholder with `text` in `state`
 * (comments.rs `settle_answer`). A deleted thread or placeholder, or one no
 * longer this run's pending answer, is 'gone' and writes nothing.
 */
export function settleThreadPlaceholder(
  binding: { page: string; thread: string; placeholder: string; actor: string },
  runId: string,
  text: string,
  state: 'answered' | 'failed',
): 'written' | 'gone' {
  commentPage(binding.page);
  const current = readSidecar(binding.page);
  if ('reason' in current) {
    throw new Error(
      `Comments for ${binding.page} can't be read (${current.reason}), so nothing was written.`,
    );
  }
  const next: CommentsFile = structuredClone(current);
  const thread = next.threads.find(
    (t) => threadId(t) === binding.thread && t.deleted === undefined,
  );
  const comment = thread?.comments.find(
    (c) =>
      c.id === binding.placeholder &&
      c.deleted === undefined &&
      c.state === 'pending' &&
      c.run_id === runId,
  );
  if (comment === undefined) return 'gone';
  comment.body = text;
  comment.state = state;
  writeSidecarAs(binding.page, next, binding.actor, runId);
  return 'written';
}

/** Write `file` as `page`'s sidecar, as the rewrite funnel does: the cap,
 * the read-back, the files Map and one vault.comment row. */
function writeSidecarAs(page: string, file: CommentsFile, by: string, runId: string): void {
  const text = serializeComments(file);
  const tooBig = sizeRefusal(page, text);
  if (tooBig !== null) throw new Error(tooBig);
  const back = parseComments(text);
  if (!back.ok) {
    throw new Error(
      `Comments for ${page} would not read back (${back.reason}), so nothing was written.`,
    );
  }
  files.set(sidecarPathOf(page), text);
  logWrite('vault.comment', sidecarPathOf(page), { actor: by, runId });
}

// --- Attachments (M16.13c) --------------------------------------------------

/** No native picker in a browser. `canPickFiles()` is what callers branch on;
 * this exists so the facade has something to delegate to. */
export async function pickFiles(): Promise<string[]> {
  return [];
}

/**
 * Mirror of `vault::write::import_attachment` — same forced folder, same
 * stem-not-extension dedupe, same absolute-source guard. The mock disk is
 * text-only, so the copy is a stub; what the tests care about is the returned
 * VAULT-RELATIVE path and the fact that the file lands somewhere the mock
 * scanner already skips.
 */
export async function importAttachment(_vault: string, source: string): Promise<string> {
  if (!source.startsWith('/')) throw new Error(`attachment source must be absolute: ${source}`);
  const name = source.split('/').pop() ?? '';
  if (name === '' || name === '.' || name === '..') {
    throw new Error(`unusable file name: ${source}`);
  }
  const dot = name.lastIndexOf('.');
  // A leading dot is the whole name (".gitignore"), not an extension.
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 1; ; n += 1) {
    const rel = `attachments/${stem}${n === 1 ? '' : `-${n}`}${ext}`;
    if (!files.has(rel)) {
      files.set(rel, '');
      touch(rel);
      logWrite('vault.create', rel);
      return rel;
    }
  }
}

/**
 * Mirror of lib.rs `write_text_file` and `vault::write::write_text_file`
 * (M29.22): the same knowledge guard its command mints the receipt from,
 * same `.mmd`-only extension allowlist, same stem dedupe, the same vault
 * containment `safe_join` enforces (no absolute paths, no `..`, no empty
 * path), and the same note-target rules (PLATFORM-API-1): no dot-folder.
 * Returns the vault-relative path actually written.
 */
export async function writeTextFile(
  _vault: string,
  path: string,
  content: string,
): Promise<string> {
  guardHumanWrite(path);
  if (path === '' || path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`path escapes the vault: ${path}`);
  }
  const dot = path.lastIndexOf('.');
  if (dot === -1) throw new Error(`write_text_file requires an extension: ${path}`);
  const [stem, ext] = [path.slice(0, dot), path.slice(dot + 1)];
  if (ext !== 'mmd') {
    throw new Error(`write_text_file only writes ["mmd"] files: ${path}`);
  }
  guardNoteTarget(path, ['mmd']);
  let actual = path;
  for (let n = 2; files.has(actual); n += 1) actual = `${stem}-${n}.${ext}`;
  files.set(actual, content);
  touch(actual);
  logWrite('vault.create', actual);
  return actual;
}

/**
 * All directories in the vault (derived from file paths + explicit folders),
 * skipping the folders scanVault skips and everything under them — parity
 * with scan.rs `list_folders`.
 */
export async function listFolders(_vault: string): Promise<string[]> {
  const dirs = new Set<string>(folders);
  for (const p of files.keys()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }
  return [...dirs].filter((d) => !d.split('/').some(isSkippedDir)).sort();
}

// --- Mermaid diagram export (M29.4) -----------------------------------------

/** Browser stand-in for the native PNG save: a plain download. */
export async function exportPng(defaultName: string, bytes: Uint8Array): Promise<string | null> {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultName;
  a.click();
  URL.revokeObjectURL(url);
  return defaultName;
}

/** Browser stand-in for the native SVG save: the text, as a plain download (M44.3). */
export async function exportSvg(defaultName: string, svg: string): Promise<string | null> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultName;
  a.click();
  URL.revokeObjectURL(url);
  return defaultName;
}

// --- The review surface (M24.9) --------------------------------------------
// The browser mock has no ledger, so it has no proposals, no policy, and
// nothing to review. It holds FIXTURE cards a UI test can drive — data, not
// rules: no verdict is computed here and no refusal is decided here, because
// mirroring the interpreter would be exactly the twin-implementation defect
// the policy table exists to prevent. A Playwright spec seeds these; a real
// vault never touches them.

/** One target's expected-versus-current version, as a card shows it. */
export interface CardTarget {
  target_class: string;
  target_id: string;
  expected_version: number | null;
  current_version: number | null;
  /** The world moved under this card: approving it will refuse. */
  stale: boolean;
  /** The concept file a belief target is (M50.3), or null. Optional on the
   *  wire so an older fixture reads as "not known", never as a path. */
  path?: string | null;
  /** For a relation an `edit_relation` card would add or remove: its kind
   *  and the concept file at each end (M52.5). Mirrors `review.rs`'s
   *  `CardLink`; optional so an older fixture reads as "not known". */
  link?: CardLink | null;
}

export interface CardLink {
  action: 'add' | 'remove';
  relation: 'supersedes' | 'refines' | 'contradicts';
  from_path: string | null;
  to_path: string | null;
}

/** What a reviewer is being asked about. Mirrors policy/review.rs — every
 * field is typed, and `reason` is display text with no policy effect. */
export interface ReviewCard {
  proposal_id: string;
  commit_set_id: string;
  run_id: string;
  actor: string;
  op: string;
  effective_risk: string;
  /** The risk rung's review mode — `diff` on the CRITICAL rung. */
  review: string | null;
  /** Codes holding this beyond the risk ladder (M24.8). */
  queued_for: string[];
  intended_use_kind: string;
  intended_use_stakes: string;
  transition_cause: string;
  evidence_refs: string[];
  coverage_refs: string[];
  authority_refs: string[];
  targets: CardTarget[];
  reason: string;
  set_members: string[];
  set_ready: boolean;
}

/** An applied change a human may still undo. */
export interface RevertableApplication {
  proposal_id: string;
  op: string;
  applied_event_id: string;
  reason: string;
  /** The concept it changed, by file (M52.5), or null when no belief target
   * projects one. Optional for a spec's hand-built fixture: absent reads as
   * null. */
  path?: string | null;
}

interface ReviewFixture {
  cards: ReviewCard[];
  applications: RevertableApplication[];
}

/**
 * Seeded from the demo corpus (M33.10), not empty.
 *
 * The review queue lives in the vault ledger, which the browser does not
 * have. Answering empty was fine while this surface was a door; M33.3 made it
 * a body, and a body with nothing in it cannot be evaluated or designed
 * against. `resetOperational()` restores these, so a spec that wants the
 * empty case asks for it.
 */
const review: ReviewFixture = { cards: demoReviewCards(), applications: demoRevertables() };

/** Test-only seam, mirroring `window.__cerebroMockFs`: a spec stages the
 * cards it wants to see and the surface renders them. */
export function __seedReview(fixture: Partial<ReviewFixture>): void {
  review.cards = fixture.cards ?? [];
  review.applications = fixture.applications ?? [];
}

if (typeof window !== 'undefined') {
  (
    window as unknown as { __cerebroSeedReview: (f: Partial<ReviewFixture>) => void }
  ).__cerebroSeedReview = __seedReview;
}

export async function reviewQueue(_vault: string): Promise<ReviewCard[]> {
  return review.cards;
}

export async function revertableApplications(_vault: string): Promise<RevertableApplication[]> {
  return review.applications;
}

export async function decideProposal(
  _vault: string,
  proposalId: string,
  approve: boolean,
  _reviewer: string,
  reason: string | null,
): Promise<string | null> {
  // The ONE rule mirrored, because it is a precondition of the call rather
  // than a policy decision: a rejection with no reason is refused before
  // anything is written, on both sides.
  if (!approve && (reason ?? '').trim() === '') {
    throw new Error('a rejection needs a reason');
  }
  const card = review.cards.find((c) => c.proposal_id === proposalId);
  if (card === undefined) throw new Error(`no queued proposal ${proposalId}`);
  review.cards = review.cards.filter((c) => !card.set_members.includes(c.proposal_id));
  return approve ? 'apply' : 'human_reject';
}

export async function revertApplication(
  _vault: string,
  proposalId: string,
  appliedEventIds: string[],
  _reviewer: string,
): Promise<string> {
  const application = review.applications.find((a) => a.proposal_id === proposalId);
  if (application === undefined) throw new Error(`no applied proposal ${proposalId}`);
  if (appliedEventIds.length !== 1 || appliedEventIds[0] !== application.applied_event_id) {
    throw new Error('revert_not_current: this is not the application on record');
  }
  review.applications = review.applications.filter((a) => a.proposal_id !== proposalId);
  return 'apply';
}

// --- Queued page writes (M57.4c) -------------------------------------------
//
// Rust keeps these in runtime.db's `pending_writes` (`runtime::pending_writes`
// and `mcp::decide_pending`); the browser keeps them here, in memory, with
// the same dedupe key (vault, actor, tool, the draft's canonical hash), the
// same cap and size from the table's `queue_limits`, the same words, and
// the same decision shapes. A write is queued only once the mock door would
// take it (`agentWriteRefusal`), and an Allow runs the door for real.

/** One page write an ask-first agent queued for Review, as Rust's
 * `pending_writes` command lists it. */
export interface PendingWrite {
  pending_id: string;
  run_id: string;
  actor: string;
  tool: string;
  /** The page the write lands on, or for a new page the file it would
   * create. */
  target: string;
  /** The page's bytes' hash when it was queued; null for a new page. */
  target_hash: string | null;
  input: Record<string, unknown>;
  queued_at: string;
  state: string;
}

/** What a decision came to, as Rust's `PendingDecision` serializes it. */
export type PendingDecision =
  | { outcome: 'applied'; path: string }
  | { outcome: 'refused'; reason: string }
  | { outcome: 'rejected' }
  | { outcome: 'edit_refused'; reason: string }
  | { outcome: 'no_longer_waiting'; state: string };

interface PendingRow extends PendingWrite {
  vault: string;
  inputHash: string;
  reason: string | null;
  result: string | null;
}

let pendingRows: PendingRow[] = [];

function resetPendingWrites(): void {
  pendingRows = [];
}

/** Mirror of mcp.rs `REJECTION_NEEDS_A_REASON`, word for word. */
export const REJECTION_NEEDS_A_REASON = 'a rejection needs a reason';

/** Mirror of pending_writes.rs `canonical_json`: every object's keys sorted,
 * recursively. */
function canonicalJson(value: unknown): string {
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (typeof v === 'object' && v !== null) {
      const record = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
          .map((key) => [key, sorted(record[key])]),
      );
    }
    return v;
  };
  return JSON.stringify(sorted(value));
}

const argText = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === 'string' ? (args[key] as string) : '';

/** One of the mock's agent doors, by tool name, writing under `stamp`:
 * what it answers, and the page it wrote. The mock has no agent frontmatter
 * door (M56.10). */
async function agentDoor(
  vault: string,
  tool: string,
  args: Record<string, unknown>,
  stamp: WriteStamp,
): Promise<{ path: string; reply: string }> {
  const expectHash = typeof args.expect_hash === 'string' ? args.expect_hash : undefined;
  switch (tool) {
    case 'create_note': {
      const reply = await agentCreate(
        vault,
        {
          folder: argText(args, 'folder'),
          slug: argText(args, 'slug'),
          body: argText(args, 'body'),
        },
        stamp,
      );
      return { path: reply.replace(/^Created /, ''), reply };
    }
    case 'append_to_note': {
      const path = argText(args, 'path');
      await agentAppend(vault, path, argText(args, 'content'), expectHash, stamp);
      return { path, reply: `Appended to ${path}` };
    }
    case 'edit_note': {
      const path = argText(args, 'path');
      const edits = Array.isArray(args.edits) ? (args.edits as QuoteEdit[]) : [];
      return { path, reply: await agentEdit(vault, path, edits, expectHash, stamp) };
    }
    default:
      throw new Error(`${tool} is not available here`);
  }
}

/** The door run as a preview (Rust's `WriteMode::Preview`): what it would
 * land on and the page's hash now, or its refusal. The mock doors refuse
 * before writing, and a door that would land is undone at once, its logged
 * write included, so a preview leaves the mock disk and its write log as it
 * found them. */
async function previewAgentWrite(
  vault: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ target: string; hash: string | null } | { refused: string }> {
  const kept = new Map(files);
  const keptTimes = new Map(times);
  const logged = writes.length;
  try {
    const { path } = await agentDoor(vault, tool, args, PREVIEW_STAMP);
    const before = kept.get(path);
    return { target: path, hash: before === undefined ? null : sha256Hex(before) };
  } catch (err) {
    return { refused: err instanceof Error ? err.message : String(err) };
  } finally {
    files.clear();
    for (const [path, raw] of kept) files.set(path, raw);
    times.clear();
    for (const [path, at] of keptTimes) times.set(path, at);
    writes.length = logged;
  }
}

/** The stamp a preview's undone write carries; it never stays logged. */
const PREVIEW_STAMP: WriteStamp = { actor: 'preview', runId: 'preview' };

/** Why the mock door would refuse this write now, or null (M57.4c): both
 * backends refuse a doomed write instead of queueing it. */
export async function agentWriteRefusal(
  vault: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const preview = await previewAgentWrite(vault, tool, args);
  return 'refused' in preview ? preview.refused : null;
}

/**
 * An unattended ask-first write queued for Review (mcp.rs `queue_step`):
 * refused as the door would refuse it, then over the table's `input_bytes`,
 * then the same write already waiting answers with its id, then an agent at
 * `open_per_actor` waiting writes is refused; else it waits. Resolves to
 * what the model reads; a refusal throws, as the mock doors do.
 */
export async function queueAgentWrite(
  vault: string,
  write: { actor: string; runId: string; tool: string; input: Record<string, unknown> },
): Promise<string> {
  const preview = await previewAgentWrite(vault, write.tool, write.input);
  if ('refused' in preview) throw new Error(preview.refused);
  const input = canonicalJson(write.input);
  if (new TextEncoder().encode(input).length > QUEUE_LIMITS.input_bytes) {
    throw new Error(
      APPROVAL_MESSAGES.queue_too_large.replace('{max}', String(QUEUE_LIMITS.input_bytes)),
    );
  }
  const inputHash = sha256Hex(input);
  const open = pendingRows.filter(
    (row) => row.vault === vault && row.actor === write.actor && row.state === 'pending',
  );
  const twin = open.find((row) => row.tool === write.tool && row.inputHash === inputHash);
  if (twin !== undefined) {
    return APPROVAL_MESSAGES.queued_already.replace('{id}', twin.pending_id);
  }
  if (open.length >= QUEUE_LIMITS.open_per_actor) {
    throw new Error(APPROVAL_MESSAGES.queue_full.replace('{n}', String(open.length)));
  }
  const id = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  pendingRows.push({
    pending_id: id,
    run_id: write.runId,
    actor: write.actor,
    tool: write.tool,
    target: preview.target,
    target_hash: preview.hash,
    input: JSON.parse(input) as Record<string, unknown>,
    queued_at: new Date().toISOString(),
    state: 'pending',
    vault,
    inputHash,
    reason: null,
    result: null,
  });
  return APPROVAL_MESSAGES.queued.replace('{id}', id);
}

/** The writes waiting in `vault`, oldest first (Rust's `list_open`). */
export async function pendingWrites(vault: string): Promise<PendingWrite[]> {
  return pendingRows
    .filter((row) => row.vault === vault && row.state === 'pending')
    .map((row) => ({
      pending_id: row.pending_id,
      run_id: row.run_id,
      actor: row.actor,
      tool: row.tool,
      target: row.target,
      target_hash: row.target_hash,
      input: row.input,
      queued_at: row.queued_at,
      state: row.state,
    }));
}

/**
 * Review's decision of one queued write (mcp.rs `decide_pending`): a Reject
 * needs a reason; an Allow holds the draft, or the person's edit, to the
 * tool's schema and the door's refusals, so a refused edit answers
 * `edit_refused` and keeps the write waiting, while a refused unedited write
 * is settled refused; otherwise the door writes it, once.
 */
export async function decidePendingWrite(
  vault: string,
  pendingId: string,
  allow: boolean,
  input: Record<string, unknown> | null,
  reason: string | null,
): Promise<PendingDecision> {
  if (!allow && (reason ?? '').trim() === '') throw new Error(REJECTION_NEEDS_A_REASON);
  const row = pendingRows.find((r) => r.vault === vault && r.pending_id === pendingId);
  if (row === undefined) throw new Error(`no queued write ${pendingId} in this vault`);
  if (row.state !== 'pending') return { outcome: 'no_longer_waiting', state: row.state };
  if (!allow) {
    row.state = 'rejected';
    row.reason = (reason ?? '').trim();
    return { outcome: 'rejected' };
  }
  const edited = input !== null && canonicalJson(input) !== canonicalJson(row.input);
  const draft = edited && input !== null ? input : row.input;
  const refusal =
    draftRefusal(toolSchema(row.tool), draft) ?? (await agentWriteRefusal(vault, row.tool, draft));
  if (refusal !== null) {
    if (edited) return { outcome: 'edit_refused', reason: refusal };
    row.state = 'refused';
    row.reason = refusal;
    return { outcome: 'refused', reason: refusal };
  }
  row.state = 'applying';
  try {
    // The agent's write, under its run, that the person allowed (M57 Q21).
    const { path } = await agentDoor(vault, row.tool, draft, {
      actor: row.actor,
      runId: row.run_id,
      approvedBy: HUMAN_ACTOR,
    });
    row.state = 'applied';
    row.result = path;
    return { outcome: 'applied', path };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    row.state = 'refused';
    row.reason = why;
    return { outcome: 'refused', reason: why };
  }
}

// --- Belief chips (M27.5b) -------------------------------------------------
//
// The wire shapes of `dynamics::bundle`, and NOTHING ELSE. No axis is derived
// here and no sentence is composed here: `line` arrives already read aloud,
// because a line assembled on this side from three serialized values would be
// a second implementation of it. Same reason the review surface holds cards
// rather than a policy engine.
//
// The browser has no ledger, so it has no beliefs and no axes. A spec seeds
// the rows it wants to see.

/** The predicate half of a facet key. `unknown` is a member, not a null —
 * "no predicate was recorded" and "the predicate is ci_status" are different
 * keys. */
export type FacetPredicate = { kind: 'known'; value: string } | { kind: 'unknown' };

export interface BeliefFacetKey {
  belief_id: string;
  belief_revision_event_id: string;
  predicate: FacetPredicate;
  state_stage: string;
}

/** Where authority came from, scoped to one predicate at one stage. */
export interface AuthorityScope {
  predicate: string;
  state_stage: string;
  authority_class: string;
  authority_route_id: string;
  authority_rule_version: number;
  authority_artifact_hash: string;
  assertion_event_id: string;
  source_registration_event_id: string;
  authority_provenance: string;
}

/** One collapsed evidence family. */
export interface SupportFamily {
  family_id: string;
  members: string[];
  source_ids: string[];
  independence: 'known_independent' | 'independence_unknown';
}

export interface IndependenceEdge {
  left_family_id: string;
  right_family_id: string;
  proof_kind: string;
  rule_version: string | null;
  proposal_id: string | null;
  decision_event_id: string | null;
  recorded_by_event_id: string;
}

/** What rests underneath — never lifted by a review. */
export interface Support {
  level: 'unsupported' | 'single_source' | 'corroborated' | 'authoritative_for_predicate_stage';
  ancestral_family_count: number;
  independent_family_count: number;
  independence_unknown_count: number;
  authority_scope?: AuthorityScope;
}

export interface CoverageDimensionInput {
  assessment_id: string;
  source_id: string;
  state: string;
  basis_event_ids: string[];
  as_of: string;
}

export interface FoldedDimension {
  state: string;
  inputs: CoverageDimensionInput[];
}

/** How much anybody has looked. `no_assessments` and a folded `blind` are
 * different answers, which is why the tag survives the wire. */
export interface Coverage {
  kind: 'no_assessments' | 'assessed';
  summary: 'observed' | 'partial' | 'blind';
  assessment_ids: string[];
  fold_rule_version: string;
  dimensions?: Record<string, FoldedDimension>;
}

/** Whether it still holds. Three subfields, deliberately not one enum. */
export interface Validity {
  freshness: 'fresh' | 'stale' | 'unknown';
  conflict: 'clear' | 'contested';
  lifecycle: 'active' | 'superseded' | 'archived' | 'tombstoned';
}

export interface FreshnessBasis {
  predicate_class: string | null;
  anchor_event_id: string | null;
  anchor_at: string | null;
  stale_after: string | null;
}

/** D8 channel 1 — beside the axes, never inside Support. */
export interface ReviewStatus {
  status: 'unreviewed' | 'current' | 'predates_current';
  attestation_event_id?: string;
  attested_belief_revision_event_id?: string;
}

export interface FacetChips {
  key: BeliefFacetKey;
  support: Support;
  families: SupportFamily[];
  independence_edges: IndependenceEdge[];
  coverage: Coverage;
  validity: Validity;
  freshness_basis: FreshnessBasis;
  review: ReviewStatus;
  /** Each axis, already read aloud. A chip renders one of these verbatim —
   * mapping `(kind, summary)` to "sources not yet assessed" on this side would be
   * the fold rule spelled a second time in another language. */
  support_text: string;
  coverage_text: string;
  validity_text: string;
  /** The three above, joined in axis order. One wording, one place. */
  line: string;
}

export interface BeliefChips {
  belief_id: string;
  /** The knowledge-relative projection path — how a file on screen finds the
   * belief these axes are about. Null for a belief no file projects. */
  path: string | null;
  belief_revision_event_id: string;
  /** One row per facet. A multi-facet belief renders separate scoped rows. */
  facets: FacetChips[];
}

let chips: BeliefChips[] = [];

/** Test-only seam, mirroring `__cerebroSeedReview`. */
export function __seedChips(rows: BeliefChips[]): void {
  chips = rows;
}

if (typeof window !== 'undefined') {
  (window as unknown as { __cerebroSeedChips: (r: BeliefChips[]) => void }).__cerebroSeedChips =
    __seedChips;
}

export async function beliefChips(_vault: string): Promise<BeliefChips[]> {
  return chips;
}

// --- The Epistemic Status surface (M27.8b) ----------------------------------
//
// FIXED SHAPES, NO ENGINE — the same rule the control surface below states.
// Every sentence on this wire is composed in `attention::status`, so a spec
// seeds prose rather than facts and nothing here can disagree with the lane
// rules it never loaded. Seeding a lane the artifact does not declare is a
// spec bug the Rust wire-shape test is there to make loud.

/** One thing in one lane, with the words already attached. */
export interface LaneItem {
  lane: 'contradiction' | 'blindness' | 'staleness' | 'epistemic_debt';
  belief_id: string;
  entity_id: string;
  path: string | null;
  predicate: string | null;
  state_stage: string | null;
  /** "CI status, at the implemented stage", or null for a belief's only
   * facet (its scope is the belief's) and for the contradiction lane, whose
   * subject is a belief PAIR and not a facet. */
  scope_text: string | null;
  reasons: string[];
  /** Never empty. A lane item that could not say why would be a badge. */
  reason_text: string;
  reliance: string[];
  reliance_text: string | null;
  edge_id: string | null;
  relation_id: string | null;
}

/** One lane. Present in the payload whether or not it holds anything — an
 * absent lane and an empty one are the confusion this surface exists to end. */
export interface LaneView {
  id: string;
  label: string;
  blurb: string;
  empty_text: string;
  /** §33: no preference could have hidden this one. */
  protected: boolean;
  items: LaneItem[];
  withheld: number;
}

export interface LanesView {
  rule_version: string;
  lanes: LaneView[];
  /** What a preference held back, in total. Rendered, because a cap nobody
   * can see reads as "there is nothing else". */
  withheld: number;
  /** What this answer could not see. Empty is the ordinary case. */
  incomplete: string[];
}

/** One thing that moved (M26 convergence, read aloud by M27.8). With a
 * subject, `text` follows the concept's name ("was revised"); with none, it
 * is a whole sentence. */
export interface ChangeLine {
  text: string;
  belief_id: string | null;
  entity_id: string | null;
  /** The subject's knowledge-relative file, as on a lane item (M52.4). Null
   * with no subject, or when no file projects it. */
  path: string | null;
}

export interface ChangeSection {
  id: string;
  label: string;
  empty_text: string;
  lines: ChangeLine[];
}

export interface ChangesView {
  schema_version: string;
  window: { from_seq: number; to_seq: number };
  /** M26's own answer to "did anything move", not a recount of the sections. */
  quiet: boolean;
  sections: ChangeSection[];
}

const NO_LANES: LanesView = { rule_version: 'lanes-v1', lanes: [], withheld: 0, incomplete: [] };

// Seeded from the demo corpus (M33.10), like the operational fixtures below.
// A hub whose every section says "nothing" or "could not be read" cannot be
// evaluated; `resetOperational()` restores these, and a spec that wants the
// empty or refused case stages it.
let lanes: LanesView = demoLanes();
let changes: ChangesView | null = demoChanges();

/** Test-only seam, mirroring `__cerebroSeedChips`. */
export function __seedLanes(next: LanesView | null): void {
  lanes = next ?? NO_LANES;
}

/** `null` restores the refusal — a vault with no ledger cannot answer this,
 * and a spec needs to be able to render that case too. */
export function __seedChanges(next: ChangesView | null): void {
  changes = next;
}

if (typeof window !== 'undefined') {
  (window as unknown as { __cerebroSeedLanes: typeof __seedLanes }).__cerebroSeedLanes =
    __seedLanes;
  (window as unknown as { __cerebroSeedChanges: typeof __seedChanges }).__cerebroSeedChanges =
    __seedChanges;
}

export async function attentionLanes(_vault: string): Promise<LanesView> {
  return lanes;
}

export async function converge(_vault: string, _fromSeq?: number): Promise<ChangesView> {
  // The real command REFUSES a vault with no ledger store rather than
  // answering an empty window, because "nothing changed" and "there is
  // nothing here to compare" are opposite sentences.
  if (changes === null) throw new Error('this vault has no ledger store');
  return changes;
}

// --- The control surface (M25.7) -------------------------------------------
//
// FIXED SHAPES, NO ENGINE. The mock serves whatever a spec seeds and computes
// nothing: a second budget engine here would be the twin-implementation
// defect `shared/policy/README.md` exists to prevent, arrived at from the
// operational side. The real arithmetic is one SQLite transaction in
// `runtime/budget.rs`, and TypeScript cannot hold that transaction open
// across an `await` anyway.

/** Today's ambient spend across EVERY vault against one subscription. */
export interface PipelineMeter {
  window_start_utc: string;
  window_end_utc: string;
  timezone_id: string;
  ceiling_state: string;
  ceiling_reasons: string[];
  /** `exact` or `unknown` — a day whose spend was lost is not a day with
   * budget left, and the meter says which rather than showing a zero. */
  accounting_state: string;
  runs_started: number;
  max_daily_runs: number;
  tokens_used: number;
  max_daily_tokens: number;
  output_tokens_used: number;
  max_daily_output_tokens: number;
  reserved_total_tokens: number;
  reserved_output_tokens: number;
}

export interface PipelineLane {
  lane: string;
  priority: number;
  enabled: boolean;
}

/** One Activity log row: run → tokens → proposals → applied/rejected. */
export interface PipelineActivity {
  run_id: string;
  vault_id: string | null;
  mode: string;
  lane: string;
  started_at: string;
  ended_at: string | null;
  outcome: string;
  usage_state: string;
  total_tokens: number;
  output_tokens: number;
  proposals_submitted: number;
  applied: number;
  rejected: number;
}

/** The three faces of failure keep three kinds. Merging them would tell a
 * person neither "wait" nor "fix a file". */
export interface PipelineBanner {
  kind: string;
  detail: string;
  count: number;
}

export interface PipelineHeld {
  baseline_held: number;
  recovery_held: number;
  pending_review: number;
  pending: number;
}

export interface PipelineOverview {
  global_pause: boolean;
  /** How many background runs may be live at once (M33b.2). 1 unless raised. */
  ambient_concurrency: number;
  /** The highest this build accepts, from Rust's `agent::MAX_CONCURRENT_RUNS`.
   * Sent over the wire so no second copy of the number lives here. */
  ambient_concurrency_max: number;
  runtime_status: string;
  meter: PipelineMeter;
  lanes: PipelineLane[];
  activity: PipelineActivity[];
  banners: PipelineBanner[];
  held: PipelineHeld;
}

const LANES = ['filed', 'scheduled', 'agent', 'behind', 'refresh', 'stale', 'schema'];

function emptyOverview(): PipelineOverview {
  return {
    global_pause: false,
    ambient_concurrency: AMBIENT_CONCURRENCY_DEFAULT,
    ambient_concurrency_max: AMBIENT_CONCURRENCY_MAX,
    runtime_status: 'ready',
    meter: {
      window_start_utc: '2026-08-09T00:00:00.000Z',
      window_end_utc: '2026-08-10T00:00:00.000Z',
      timezone_id: 'UTC',
      ceiling_state: 'under_budget',
      ceiling_reasons: [],
      accounting_state: 'exact',
      runs_started: 0,
      max_daily_runs: 20,
      tokens_used: 0,
      max_daily_tokens: 200000,
      output_tokens_used: 0,
      max_daily_output_tokens: 40000,
      reserved_total_tokens: 0,
      reserved_output_tokens: 0,
    },
    lanes: LANES.map((lane, priority) => ({ lane, priority, enabled: true })),
    activity: [],
    banners: [],
    held: { baseline_held: 0, recovery_held: 0, pending_review: 0, pending: 0 },
  };
}

let pipeline: PipelineOverview = demoPipelineOverview(LANES);

/** Test-only seam, mirroring `window.__cerebroSeedReview`. */
export function __seedPipeline(fixture: Partial<PipelineOverview>): void {
  pipeline = { ...emptyOverview(), ...fixture };
}

if (typeof window !== 'undefined') {
  (window as unknown as { __cerebroSeedPipeline: typeof __seedPipeline }).__cerebroSeedPipeline =
    __seedPipeline;
}

export interface ItemState {
  state: string;
  route: string | null;
}

/**
 * What one attended question came back with (M26.5e).
 *
 * The manifest and the answer are the Rust types verbatim — deep, closed, and
 * validated on the Rust side before they ever reach here. They are typed as
 * `unknown` on purpose: re-declaring `WorkingMemoryManifest` and
 * `SynthesisAnswer` in TypeScript would be a second definition of a contract
 * that already has exactly one, and the second one is always the stale one.
 * A surface that needs a field reads it through a narrow accessor, so the
 * shape is asserted in one place rather than assumed in ten.
 */
export type Asked =
  | { state: 'answered'; manifest: unknown; answer: unknown }
  | { state: 'unanswered'; manifest: unknown; detail: string }
  | { state: 'refused'; code: AskRefusal; detail: string };

/**
 * Why there is no answer. Closed, and mirrored from `assembly::Asked` — a
 * surface routes on these, so they are names rather than message text.
 */
export type AskRefusal =
  'cap_conflict' | 'retrieval_unavailable' | 'base_incoherent' | 'assembly_invalid';

/** What a question declares itself to be for. Mirrors `QueryIntendedUse`. */
export interface QueryIntendedUse {
  kind:
    | 'draft_note'
    | 'reversible_work'
    | 'operational_decision'
    | 'production_release'
    | 'safety_or_compliance';
  stakes: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  predicate_class: string | null;
  description: string;
}

/**
 * The browser mock refuses rather than inventing an answer (M26.5e).
 *
 * An attended question assembles from a real ledger and spends a real CLI run
 * against the user's own subscription. There is no honest browser version of
 * either: a mock that returned a plausible answer would be a fabricated
 * synthesis with a fabricated manifest behind it, and every ref in it would
 * cite evidence that never existed — which is precisely the failure the whole
 * manifest apparatus exists to make impossible. `retrieval_unavailable` is
 * the true answer here, and it is a state the real backend can also reach.
 */
export async function askQuestion(
  _vault: string,
  _question: string,
  _aliases: string[],
  _intendedUse: QueryIntendedUse,
): Promise<Asked> {
  return {
    state: 'refused',
    code: 'retrieval_unavailable',
    detail:
      'This is the browser mock. Asking Knowledge needs a real ledger and a real CLI run, and a ' +
      'made-up answer would cite evidence that never existed.',
  };
}

export async function pipelineOverview(_vault: string): Promise<PipelineOverview> {
  return pipeline;
}

/**
 * One run as the fleet shows it (M33.2). The Rust shape verbatim.
 *
 * `actor` is null for a run written before M33.1 and for bare attended chat.
 * That is a real category — "unattributed" — and nothing backfills it.
 */
export interface FleetRun {
  run_id: string;
  actor: string | null;
  vault_id: string | null;
  mode: string;
  lane: string;
  started_at: string;
  ended_at: string | null;
  outcome: string;
  /** `pending` | `exact` | `unknown`. Read this BEFORE the token counts. */
  usage_state: string;
  input_tokens: number;
  output_tokens: number;
  /** The proposal counters (M49.9). `null` is NOT RECORDED: a row written
   * before anything booked them, whose zeros were never a measurement. On a
   * booked row, `0` is measured-at-zero. All three are null or none are. */
  proposals_submitted: number | null;
  applied: number | null;
  rejected: number | null;
  /** M34.3's hop lineage (M41): the run this one was spawned FROM; null is
   * a root. Mirrors fleet.rs — the parity the mock owes the wire. */
  parent_run_id: string | null;
  /** Why the run started (M56.7), in Rust's words. `null` is "why not
   * recorded": a row from before causes, or a run that named none. */
  cause: FleetRunCause | null;
  /** The Claude Code session the run ran as, from its stream (M56.7). `null`
   * is not recorded. */
  cli_session_id: string | null;
}

/**
 * Why one run started, as fleet.rs serves it (`cause::CauseView`). `why` is
 * the kind's words from Rust's one vocabulary, so this side renders it and
 * keeps no list of kinds. `due_at` is set for a schedule's fire.
 */
export interface FleetRunCause {
  kind: string;
  why: string;
  subject: string | null;
  detail: string | null;
  due_at: string | null;
}

/** One `run_cost_components` row (M31.6). */
export interface FleetCostComponent {
  component: string;
  unit: string;
  model_id: string | null;
  quantity: number;
  observed_cost_micros: number | null;
  /** Derived rather than measured. Showing an estimate as a measurement is
   * worse than showing nothing. */
  estimated: boolean;
  pricing_snapshot_id: string | null;
  recorded_at: string;
}

/** One `assembly_metrics` row (M31.6). */
export interface FleetAssemblyMetrics {
  manifest_id: string;
  intended_stakes: string;
  source_count: number;
  evidence_item_count: number;
  context_bytes: number;
  retrieval_query_count: number;
  blocked_intent_count: number;
  answer_latency_micros: number | null;
  recorded_at: string;
}

/** One refusal recorded against a run in `operational_log` (M56.9). */
export interface FleetRefusal {
  code: string;
  surface: string;
  detail: string;
  rule: string | null;
  recorded_at: string;
}

/**
 * One run, its governance joins, its model, what it was refused and what it
 * wrote (M58.1b).
 *
 * `cost_components: null` means NOT RECORDED — pre-M31.6, or a path M31.6
 * does not cover. An empty array would mean "measured, and it cost nothing",
 * which is a different fact; the UI must not render either as $0.
 *
 * `model_id` is the model Claude Code reported answering, as the run's last
 * assistant turn named it; `null` is not recorded (M56.9). `refusals` are the
 * rows recorded with the run's id, in id order, at most 50 and with telemetry
 * left out, and `refusals_total` counts them all, so a cut list says so.
 * Refusals have carried their run since M54.9, so `[]` is measured: nothing
 * was refused.
 */
export interface FleetRunDetail {
  run: FleetRun;
  cost_components: FleetCostComponent[] | null;
  assembly: FleetAssemblyMetrics | null;
  model_id: string | null;
  refusals: FleetRefusal[];
  refusals_total: number;
  /** What the run wrote in the vault (M58.1b): `recorded` with no rows is
   * measured, it wrote nothing; `partial` is booked, but the shell may have
   * written elsewhere; `not_recorded` is a run whose writes were not booked. */
  wrote: RunPageWrites;
}

/**
 * A run's transcript as its detail reads it (M56.9, `transcript::RunTranscript`):
 * Claude Code's session file folded on read, and how many runs share that
 * session. Stored nowhere.
 */
export interface RunTranscript {
  runs_in_session: number;
  /** The retention Claude Code is configured with; null when it never
   * sweeps, or when there was no folder to look in. */
  retention_days: number | null;
  read: TranscriptRead;
}

/** What one actor's rows add up to (M33.2). */
export interface FleetActorSummary {
  actor: string;
  run_count: number;
  /** Summed across `usage_state === 'exact'` runs ONLY. */
  input_tokens: number;
  output_tokens: number;
  /** Runs that happened but never said what they spent. Counted rather than
   * added as zero, so a lifetime total reads as visibly partial. */
  unknown_runs: number;
  /** Rows still carrying `outcome: 'running'` (M33b.4) — the whole of what
   * "working" means. A count, not a flag, because the row count is what the
   * table holds. */
  running_runs: number;
  last_outcome: string | null;
  last_started_at: string | null;
}

/** Which runs to return. Absent field means "any". */
export interface FleetFilter {
  vault_id?: string | null;
  lane?: string | null;
  mode?: string | null;
  actor?: string | null;
  limit?: number | null;
}

/** Mirrors `fleet.rs`'s two constants. */
const FLEET_MAX_LIMIT = 200;
const FLEET_DEFAULT_LIMIT = 50;

let fleetRuns: FleetRun[] = demoFleetRuns();
let fleetDetails: Record<string, FleetRunDetail> = demoFleetDetails();
/** Null models a missing runtime DB: every fleet command refuses, which is
 * how the section reaches `unavailable` rather than `empty`. */
let fleetAvailable = true;

/** Test-only seam, mirroring `__cerebroSeedPipeline`. */
export function __seedFleet(
  runs: FleetRun[] | null,
  details: Record<string, FleetRunDetail> = {},
): void {
  fleetAvailable = runs !== null;
  fleetRuns = runs ?? [];
  fleetDetails = details;
}

if (typeof window !== 'undefined') {
  (window as unknown as { __cerebroSeedFleet: typeof __seedFleet }).__cerebroSeedFleet =
    __seedFleet;
}

function fleetUnavailable(): Error {
  return new Error('no runtime database for this workspace');
}

/**
 * Book a mock run's row (M57.2): the one browser path that writes the fleet,
 * for a run whose shell ceiling withheld tools nobody could ask about, as
 * Rust's meter books its `agent.ask` refusal. Nothing when the fleet is
 * unavailable, as Rust records nothing without a runtime database.
 */
export function bookMockRun(detail: FleetRunDetail): boolean {
  if (!fleetAvailable) return false;
  fleetRuns = [...fleetRuns, detail.run];
  fleetDetails = { ...fleetDetails, [detail.run.run_id]: detail };
  return true;
}

/** A booked mock run ended: its row says how. */
export function finishMockRun(runId: string, outcome: string): void {
  const ended = new Date().toISOString();
  const close = (run: FleetRun): FleetRun =>
    run.run_id === runId ? { ...run, outcome, ended_at: ended } : run;
  fleetRuns = fleetRuns.map(close);
  const detail = fleetDetails[runId];
  if (detail !== undefined) {
    fleetDetails = { ...fleetDetails, [runId]: { ...detail, run: close(detail.run) } };
  }
}

export async function fleetRunsPage(filter: FleetFilter = {}): Promise<FleetRun[]> {
  if (!fleetAvailable) throw fleetUnavailable();
  const matches = fleetRuns.filter(
    (run) =>
      (filter.vault_id == null || run.vault_id === filter.vault_id) &&
      (filter.lane == null || run.lane === filter.lane) &&
      (filter.mode == null || run.mode === filter.mode) &&
      (filter.actor == null || run.actor === filter.actor),
  );
  // Same ordering and the same server-side clamp as `fleet.rs`: a mock that
  // trusted the caller's limit would let a test pass against a page the real
  // backend would have truncated.
  const ordered = [...matches].sort(
    (a, b) => b.started_at.localeCompare(a.started_at) || b.run_id.localeCompare(a.run_id),
  );
  return ordered.slice(0, Math.min(filter.limit ?? FLEET_DEFAULT_LIMIT, FLEET_MAX_LIMIT));
}

/** One concept a run's proposals named (M50.3, `knowledge::RunWrite`). */
export interface RunWrite {
  path: string;
  state: 'submitted' | 'queued' | 'rejected' | 'applied' | 'reverted';
}

let runWrites: Record<string, RunWrite[]> = demoRunWrites();

/** What one run changed in Knowledge. `null` is not recorded: the mock keeps
 *  no ledger, and a run the fixture does not name is not a run that changed
 *  nothing. */
export async function runKnowledgeWrites(
  _vault: string,
  runId: string,
): Promise<RunWrite[] | null> {
  return runWrites[runId] ?? null;
}

export async function fleetRunDetail(runId: string): Promise<FleetRunDetail> {
  if (!fleetAvailable) throw fleetUnavailable();
  const detail = fleetDetails[runId];
  // Refused, not null — the same way Rust refuses. A typo and a run that
  // recorded nothing must not look the same.
  if (detail === undefined) throw new Error(`no run with id ${runId}`);
  // A seeded detail that names no writes reads not recorded, never "wrote
  // nothing": an e2e seam's detail arrives untyped.
  return { ...detail, wrote: detail.wrote ?? { state: 'not_recorded' } };
}

/** Run id → its transcript. The demo's are synthetic (`demoTranscripts.ts`). */
let runTranscripts: Record<string, RunTranscript> = demoRunTranscripts();

/**
 * One run's transcript (M56.9). Refuses when the fleet is unavailable and for
 * an id the fleet does not know, as Rust does; a run with no session reads
 * not recorded. An unseeded run reads back through the browser's session
 * files, so it is cleared unless a mock turn wrote one.
 */
export async function fleetRunTranscript(runId: string): Promise<RunTranscript> {
  if (!fleetAvailable) throw fleetUnavailable();
  const run = fleetDetails[runId]?.run ?? fleetRuns.find((r) => r.run_id === runId);
  if (run === undefined) throw new Error(`no run with id ${runId}`);
  const sessionRuns = fleetRuns.filter(
    (r) => r.cli_session_id !== null && r.cli_session_id === run.cli_session_id,
  ).length;
  if (run.cli_session_id === null) {
    return {
      runs_in_session: 1,
      retention_days: null,
      read: { state: 'unavailable', reason: 'not_recorded', retention_days: null },
    };
  }
  return (
    runTranscripts[runId] ?? {
      runs_in_session: Math.max(sessionRuns, 1),
      retention_days: 30,
      read: readMockCliTranscript(run.cli_session_id),
    }
  );
}

/** Test-only seam: what each run's transcript reads back as. `null` puts the
 * demo's back. */
export function __seedRunTranscripts(transcripts: Record<string, RunTranscript> | null): void {
  runTranscripts = transcripts ?? demoRunTranscripts();
}

if (typeof window !== 'undefined') {
  (
    window as unknown as { __cerebroSeedRunTranscripts: typeof __seedRunTranscripts }
  ).__cerebroSeedRunTranscripts = __seedRunTranscripts;
}

/** The one fold both summary reads share, mirroring `fleet.rs`'s `summaries`.
 * Two copies of the sum-only-what-was-metered rule is two places for one to
 * drift, on this side of the wire as much as on the other. */
function summariseActor(actor: string, runs: FleetRun[]): FleetActorSummary {
  const metered = runs.filter((run) => run.usage_state === 'exact');
  const latest = [...runs].sort(
    (a, b) => b.started_at.localeCompare(a.started_at) || b.run_id.localeCompare(a.run_id),
  )[0];
  return {
    actor,
    run_count: runs.length,
    input_tokens: metered.reduce((sum, run) => sum + run.input_tokens, 0),
    output_tokens: metered.reduce((sum, run) => sum + run.output_tokens, 0),
    unknown_runs: runs.length - metered.length,
    running_runs: runs.filter((run) => run.outcome === 'running').length,
    last_outcome: latest?.outcome ?? null,
    last_started_at: latest?.started_at ?? null,
  };
}

export async function fleetActorSummary(actor: string): Promise<FleetActorSummary> {
  if (!fleetAvailable) throw fleetUnavailable();
  return summariseActor(
    actor,
    fleetRuns.filter((run) => run.actor === actor),
  );
}

/**
 * Every attributed actor, summed (M33b.3).
 *
 * `actor: null` is not an actor and gets no row, exactly as the SQL's
 * `WHERE r.actor IS NOT NULL` decides — the unattributed run stays visible in
 * `fleetRunsPage`, which is where it belongs. Byte-sorted like the `ORDER BY
 * r.actor` beside it, so a roster does not reshuffle between reads.
 */
export async function fleetActorSummaries(): Promise<FleetActorSummary[]> {
  if (!fleetAvailable) throw fleetUnavailable();
  const byActor = new Map<string, FleetRun[]>();
  for (const run of fleetRuns) {
    if (run.actor === null) continue;
    const bucket = byActor.get(run.actor);
    if (bucket === undefined) byActor.set(run.actor, [run]);
    else bucket.push(run);
  }
  return [...byActor.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([actor, runs]) => summariseActor(actor, runs));
}

// --- Job ledgers (M34.2.2) — parity with runtime/job_ledger.rs -------------

/** One vault's three scheduling ledgers, as the hydration read returns them. */
export interface JobLedgers {
  attempts: Record<string, string>;
  skillRuns: Record<string, string>;
  triggerRuns: Record<string, string>;
}

/** The schema's CHECK vocabulary, mirrored: a fourth name is a migration. */
const JOB_LEDGER_NAMES = ['attempts', 'skillRuns', 'triggerRuns'] as const;

/** vault → ledger → key → run_key. In-memory like the rest of the mock: the
 * browser's persistence is uiStore's localStorage mirror, re-offered through
 * the import path each session. */
const jobLedgers = new Map<string, Map<string, Map<string, string>>>();

function jobLedgerFor(vault: string, ledger: string): Map<string, string> {
  if (!(JOB_LEDGER_NAMES as readonly string[]).includes(ledger)) {
    // The schema refuses this with a CHECK; a mock that stored it would let
    // a browser test invent a fourth ledger no database admits.
    throw new Error(`job_ledger: CHECK failed — unknown ledger ${ledger}`);
  }
  let ledgers = jobLedgers.get(vault);
  if (ledgers === undefined) {
    ledgers = new Map();
    jobLedgers.set(vault, ledgers);
  }
  let map = ledgers.get(ledger);
  if (map === undefined) {
    map = new Map();
    ledgers.set(ledger, map);
  }
  return map;
}

export async function jobLedgerRead(vault: string): Promise<JobLedgers> {
  const out: JobLedgers = { attempts: {}, skillRuns: {}, triggerRuns: {} };
  for (const name of JOB_LEDGER_NAMES) {
    for (const [key, runKey] of jobLedgerFor(vault, name)) out[name][key] = runKey;
  }
  return out;
}

export async function jobLedgerClaim(
  vault: string,
  ledger: string,
  key: string,
  runKey: string,
): Promise<boolean> {
  const map = jobLedgerFor(vault, ledger);
  // The same conditional write as the Rust upsert: false iff this exact fire
  // was already answered — the two-window double-run, refused in the store.
  if (map.get(key) === runKey) return false;
  map.set(key, runKey);
  return true;
}

export async function jobLedgerStamp(
  vault: string,
  ledger: string,
  key: string,
  runKey: string,
): Promise<void> {
  jobLedgerFor(vault, ledger).set(key, runKey);
}

export async function jobLedgerUnclaim(
  vault: string,
  ledger: string,
  key: string,
  runKey: string,
): Promise<boolean> {
  const map = jobLedgerFor(vault, ledger);
  // Conditional on the exact value, like the Rust DELETE: a claim another
  // window has since re-won is never destroyed.
  if (map.get(key) !== runKey) return false;
  map.delete(key);
  return true;
}

export async function jobLedgerImport(
  vault: string,
  entries: readonly { ledger: string; key: string; runKey: string }[],
): Promise<number> {
  let landed = 0;
  for (const { ledger, key, runKey } of entries) {
    // Malformed remnants are skipped, not fatal — dying on one would re-run
    // the whole import forever. Same rule as the Rust side.
    if (key === '' || runKey === '') continue;
    const map = jobLedgerFor(vault, ledger);
    if (map.has(key)) continue;
    map.set(key, runKey);
    landed += 1;
  }
  return landed;
}

/**
 * Where the scheduler holds one item (M26.4j).
 *
 * `null` for everything, and that is the honest mock rather than a gap. The
 * scheduler is a Rust durable table fed by a Rust tick; simulating it here
 * would be a second implementation of the thing the parity rules exist to
 * forbid, and it would let a browser-only test claim a queue state no
 * database ever held. `null` is exactly what the real backend returns for a
 * vault whose ambient ingest has never run — which is every vault by
 * default.
 */
export async function ingestItemState(_vault: string, _path: string): Promise<ItemState | null> {
  return null;
}

export async function setGlobalPause(paused: boolean): Promise<void> {
  pipeline = { ...pipeline, global_pause: paused };
}

/**
 * The concurrency ceiling (M33b.2) — with both of Rust's guards, because a
 * mock that accepted what the backend refuses would let a browser-only test
 * prove a ceiling no database would ever hold.
 *
 * The refusal messages are the Rust ones' sense, not their bytes: what has to
 * match is that both ends refuse, and that neither clamps. `mockIpc.test.ts`
 * pins that parity; `settings.rs`'s
 * `a_ceiling_outside_one_through_the_process_cap_is_refused_before_it_is_stored`
 * pins the same rule from the other language.
 */
export async function setAmbientConcurrency(ceiling: number): Promise<void> {
  if (!Number.isInteger(ceiling) || ceiling < AMBIENT_CONCURRENCY_DEFAULT) {
    throw new Error(
      `a background concurrency of ${ceiling} is not a ceiling, it is a pause — ` +
        'use the pause, which says so',
    );
  }
  if (ceiling > AMBIENT_CONCURRENCY_MAX) {
    throw new Error(
      `${ceiling} background runs would exceed the ${AMBIENT_CONCURRENCY_MAX} this process ` +
        'will ever have alive at once',
    );
  }
  pipeline = { ...pipeline, ambient_concurrency: ceiling };
}

export async function setLaneEnabled(
  _vault: string,
  lane: string,
  enabled: boolean,
): Promise<void> {
  pipeline = {
    ...pipeline,
    lanes: pipeline.lanes.map((l) => (l.lane === lane ? { ...l, enabled } : l)),
  };
}

export async function resolveHeldItems(
  _vault: string,
  which: string,
  choice: string,
): Promise<number> {
  const held = { ...pipeline.held };
  const moved = which === 'baseline_held' ? held.baseline_held : held.recovery_held;
  if (which === 'baseline_held') held.baseline_held = 0;
  else held.recovery_held = 0;
  if (choice === 'process') held.pending += moved;
  pipeline = { ...pipeline, held };
  return moved;
}

// --- The deferral gates (M28.1) ---------------------------------------------
//
// The board derives from the SAME shared artifact the Rust runner reads —
// parity by shared data, not twin code. Evaluations themselves are Rust
// functions over a real runtime database, so this mock never invents a
// result: a fresh board shows every gate never-evaluated, triggerRun answers
// not-evaluated with the reason, and `__seedTriggerLatest` lets a test paint
// a recorded state the way `__seedPipeline` paints the pipeline.

export interface TriggerLatest {
  evaluation_id: string;
  result: string;
  evaluated_at: string;
  window_end: string | null;
}

export interface TriggerGateStatus {
  gate: string;
  variant: TriggerVariant;
  note: string | null;
  latest: TriggerLatest | null;
}

export interface TriggerEntryStatus {
  registry_id: string;
  capability: string;
  scope: string;
  note: string | null;
  gates: TriggerGateStatus[];
}

export type TriggerGateOutcome =
  | { kind: 'recorded'; result: string; evaluation_id: string; replayed: boolean }
  | { kind: 'not_evaluated'; reason: string }
  | { kind: 'error'; message: string };

export interface TriggerGateRun {
  gate: string;
  outcome: TriggerGateOutcome;
}

export interface TriggerRunReport {
  evaluated_at: string;
  timezone: string;
  gates: TriggerGateRun[];
}

export interface VerificationScope {
  subjects: string[];
  predicate_classes: string[];
  stage: string | null;
  environment: string | null;
  geography: string | null;
}

/** The Rust runner's note rules, over the same artifact data. Prose drift
 * here is cosmetic; the CLOSED enumeration cannot drift because both sides
 * read one file. */
function triggerGateNote(variant: TriggerVariant, parent: ParentRule | null): string | null {
  if (variant === 'measurable') {
    return parent !== null && parent.kind === 'measurable_alias'
      ? `fires only as a byte-equal alias of a fired ${parent.allowed.join(' or ')}`
      : null;
  }
  if (variant === 'hybrid') return 'hybrid — a measurable leg plus a dated owner evidence pack';
  return parent !== null && parent.kind === 'fired_parent'
    ? `awaiting a dated owner evidence pack, and its parent ${parent.allowed.join(' or ')} must have fired`
    : 'awaiting a dated owner evidence pack';
}

/** Seeded recorded states, keyed by gate ("R13:root"). */
const seededTriggerLatest = new Map<string, TriggerLatest>();

/** Test-only seam. Paint one gate's newest recorded evaluation. */
export function __seedTriggerLatest(gate: string, latest: TriggerLatest): void {
  seededTriggerLatest.set(gate, latest);
}
(
  window as unknown as { __cerebroSeedTriggerLatest: typeof __seedTriggerLatest }
).__cerebroSeedTriggerLatest = __seedTriggerLatest;

export async function triggerStatus(_vault: string): Promise<TriggerEntryStatus[]> {
  const registry = loadRegistry();
  return registry.entries.map((entry) => ({
    registry_id: entry.id,
    capability: entry.capability,
    scope: entry.scope,
    note:
      entry.subcapability_pattern !== undefined &&
      entry.subcapability_pattern.registered_connectors.length === 0
        ? `no connector is registered yet — ${entry.subcapability_pattern.prefix}<id> gates appear as connectors register`
        : null,
    gates: [
      ...entry.subcapabilities.map((sub) => ({
        gate: `${entry.id}:${sub.key}`,
        variant: sub.variant,
        note: triggerGateNote(sub.variant, sub.parent),
        latest: seededTriggerLatest.get(`${entry.id}:${sub.key}`) ?? null,
      })),
      ...(entry.subcapability_pattern?.registered_connectors ?? []).map((connector) => {
        const pattern = entry.subcapability_pattern;
        if (pattern === undefined) throw new Error('unreachable: pattern vanished mid-map');
        const gate = `${entry.id}:${pattern.prefix}${connector}`;
        return {
          gate,
          variant: pattern.variant,
          note: triggerGateNote(pattern.variant, pattern.parent),
          latest: seededTriggerLatest.get(gate) ?? null,
        };
      }),
    ],
  }));
}

export async function triggerRun(_vault: string): Promise<TriggerRunReport> {
  // The evaluators are Rust functions over a real runtime database, and a
  // made-up result would claim a state no database ever held — the
  // ingestItemState rule. Every gate answers not-evaluated, with the reason.
  const reason = 'browser mock — evaluations need the real runtime database';
  return {
    evaluated_at: SEED_TIME,
    timezone: 'UTC',
    gates: ['R1:root', 'R2:root', 'R3:root', 'R6:root', 'R7:root', 'R10:root', 'R13:root'].map(
      (gate) => ({ gate, outcome: { kind: 'not_evaluated', reason } }),
    ),
  };
}

/** The one digest rule, mirrored byte-for-byte and pinned against a
 * Rust-generated vector in mockIpc.test.ts (see settings.rs's twin pin). */
export function verificationScopeDigest(scope: VerificationScope): string {
  const canonical = JSON.stringify({
    subjects: scope.subjects,
    predicate_classes: scope.predicate_classes,
    stage: scope.stage,
    environment: scope.environment,
    geography: scope.geography,
  });
  return sha256Hex(`cerebro-verification-scope-v1\0${canonical}`);
}

/** The Rust-side guards, mirrored: shape, sortedness, and non-emptiness are
 * refused with the same key phrases the desktop build uses. */
function parseVerificationScope(scopeJson: string): VerificationScope {
  let raw: unknown;
  try {
    raw = JSON.parse(scopeJson);
  } catch (e) {
    throw new Error(`the scope does not parse: ${String(e)}`, { cause: e });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('the scope does not parse: not an object');
  }
  const known = ['subjects', 'predicate_classes', 'stage', 'environment', 'geography'];
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) throw new Error(`the scope does not parse: unknown field ${key}`);
  }
  const value = raw as Record<string, unknown>;
  const lists: [string, unknown][] = [
    ['subjects', value.subjects],
    ['predicate_classes', value.predicate_classes],
  ];
  for (const [name, list] of lists) {
    if (!Array.isArray(list) || !list.every((s) => typeof s === 'string')) {
      throw new Error(`the scope does not parse: ${name} must be a list of strings`);
    }
    if (list.length === 0) {
      throw new Error(
        `a verification scope with no ${name} verifies nothing — refusing beats counting everything`,
      );
    }
    for (let i = 1; i < list.length; i += 1) {
      if ((list[i - 1] as string) >= (list[i] as string)) {
        throw new Error(`${name} must be sorted and duplicate-free`);
      }
    }
  }
  const constraints: [string, unknown][] = [
    ['stage', value.stage],
    ['environment', value.environment],
    ['geography', value.geography],
  ];
  for (const [name, constraint] of constraints) {
    if (constraint !== null && typeof constraint !== 'string' && constraint !== undefined) {
      throw new Error(`the scope does not parse: ${name} must be a string or null`);
    }
    if (constraint === '') {
      throw new Error(`an empty ${name} constraint is a constraint on nothing`);
    }
  }
  return {
    subjects: value.subjects as string[],
    predicate_classes: value.predicate_classes as string[],
    stage: (value.stage as string | undefined) ?? null,
    environment: (value.environment as string | undefined) ?? null,
    geography: (value.geography as string | undefined) ?? null,
  };
}

let declaredR7Scope: VerificationScope | null = null;

export async function triggerDeclareR7Scope(_vault: string, scopeJson: string): Promise<string> {
  const scope = parseVerificationScope(scopeJson);
  declaredR7Scope = scope;
  return verificationScopeDigest(scope);
}

export async function triggerR7Scope(_vault: string): Promise<VerificationScope | null> {
  return declaredR7Scope;
}

export interface PackRecorded {
  gate: string;
  evaluation_id: string;
  result: string;
  replayed: boolean;
}

export async function triggerRecordPack(
  _vault: string,
  _repoRoot: string,
  _packPath: string,
  _result: string | null,
): Promise<PackRecorded> {
  // Recording writes governance rows against the real runtime database and
  // reads a pack off the real repository — the browser has neither, and a
  // made-up evaluation id would be a governance record nobody can audit.
  throw new Error(
    'browser mock — recording an evidence pack needs the real runtime database and repository',
  );
}

// --- One agent's own pause (M33b.5) -----------------------------------------
//
// Mirrors `runtime::settings`' three functions and, crucially, its REFUSAL:
// AGENTS.md requires the browser mock to enforce every Rust-side guard, and a
// per-agent pause the browser would let a run walk past is exactly the "the
// pause is a lie" failure this phase exists to disprove. `mockIpc.test.ts`
// pins the parity from this side; `settings.rs`'s
// `the_refusal_names_the_agent_and_bare_chat_has_nothing_to_refuse` pins the
// same rule from the other language.
//
// Vault-scoped, like Rust's key, because an agent is a record: two vaults may
// each hold a `digest` without them being the same colleague.

/** `vault` → the actors paused in it. Absent is NOT paused — that is the state
 * every agent ships in, and it is a measurement rather than a gap. */
const pausedByVault = new Map<string, Set<string>>();

function resetAgentPauses(): void {
  pausedByVault.clear();
}

/** Which agents are paused in this vault. Empty is measured-at-zero. */
export async function pausedAgents(vault: string): Promise<string[]> {
  return [...(pausedByVault.get(vault) ?? [])].sort();
}

/** Stop or restart one agent. Refused without an agent to be about, before
 * anything is stored — Rust refuses the same blank for the same reason. */
export async function setAgentPaused(vault: string, actor: string, paused: boolean): Promise<void> {
  const named = actor.trim();
  if (named === '') {
    throw new Error('a pause needs an agent to be about, and no actor was named');
  }
  const set = pausedByVault.get(vault) ?? new Set<string>();
  if (paused) set.add(named);
  else set.delete(named);
  pausedByVault.set(vault, set);
}

/**
 * The guard `agentIpc.runAgent` must not get past in browser mode.
 *
 * `null` is bare chat — a run nobody launched on any agent's behalf — and has
 * no pause to check. The sentence names the agent, because a person who paused
 * one of several and then triggered another needs to know which one refused
 * them. It is thrown rather than swallowed for the same reason Rust returns an
 * `Err`: a pause that eats the trigger silently is indistinguishable from a
 * broken button.
 */
export function refuseIfAgentPaused(vault: string, actor: string | null | undefined): void {
  if (actor === null || actor === undefined) return;
  if (pausedByVault.get(vault)?.has(actor) !== true) return;
  throw new Error(
    `${actor} is paused, so this run did not start. Resume it on the fleet — ` +
      'a paused agent that still ran would make the pause a lie.',
  );
}

// --- Claude Code session files (M56.3) -------------------------------------
//
// Rust reads a conversation back from the session file Claude Code writes for
// the vault and folds it into events (`read_cli_transcript`). The browser has
// no CLI and no file, so this holds what a mock run would have written, by
// session id: the replay events `agentIpc.runAgent` records as each mock run
// ends, appended per turn like the CLI's own file. Mirrored to sessionStorage
// so a reload in the same tab keeps it; a spec seeds a read directly through
// `window.__cerebroSeedCliTranscript`.
//
// What is NOT mirrored is Rust's classifier: an unseeded id reads as cleared
// with Claude Code's default retention, the one answer the browser can give
// honestly, and a seeded unavailable read is returned as given.

const CLI_TRANSCRIPTS_KEY = 'cerebro.mockCliTranscripts';

/** Session id → what reading it back gives. */
let cliTranscripts = loadCliTranscripts();

function loadCliTranscripts(): Map<string, TranscriptRead> {
  try {
    const raw = window.sessionStorage.getItem(CLI_TRANSCRIPTS_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Map(Array.isArray(parsed) ? (parsed as [string, TranscriptRead][]) : []);
  } catch {
    return new Map();
  }
}

function saveCliTranscripts(): void {
  try {
    window.sessionStorage.setItem(CLI_TRANSCRIPTS_KEY, JSON.stringify([...cliTranscripts]));
  } catch {
    // Storage unavailable: the store stays in memory for this page.
  }
}

function resetCliTranscripts(): void {
  cliTranscripts = new Map();
  saveCliTranscripts();
}

/** Append a mock run's replay events to its session, as the CLI appends a
 * resumed turn to the same file. */
export function recordMockCliTranscript(sessionId: string, events: AgentStreamEvent[]): void {
  const before = cliTranscripts.get(sessionId);
  const kept = before?.state === 'read' ? before.events : [];
  const all = [...kept, ...events];
  cliTranscripts.set(sessionId, {
    state: 'read',
    events: all,
    lines: all.length,
    unclassified: [],
  });
  saveCliTranscripts();
}

/** What reading `sessionId` back gives in the browser. */
export function readMockCliTranscript(sessionId: string | null): TranscriptRead {
  if (sessionId === null) {
    return { state: 'unavailable', reason: 'not_recorded', retention_days: 30 };
  }
  return (
    cliTranscripts.get(sessionId) ?? {
      state: 'unavailable',
      reason: 'cleared',
      retention_days: 30,
    }
  );
}

/** Test-only seam: what a session reads back as. `null` forgets it, so it
 * reads cleared again. */
export function __seedCliTranscript(sessionId: string, read: TranscriptRead | null): void {
  if (read === null) cliTranscripts.delete(sessionId);
  else cliTranscripts.set(sessionId, read);
  saveCliTranscripts();
}
if (typeof window !== 'undefined') {
  (
    window as unknown as { __cerebroSeedCliTranscript: typeof __seedCliTranscript }
  ).__cerebroSeedCliTranscript = __seedCliTranscript;
}

// --- Diagnostics (M53.24) --------------------------------------------------

/**
 * One uncaught webview error on its way to the diagnostic log, the shape
 * Rust's `log_frontend` reads. Raw text: Rust redacts and clamps it, so no
 * redaction rule lives on this side.
 */
export interface FrontendLogEntry {
  level: 'error' | 'warn';
  message: string;
  /** `file:line:col`, when the browser knows it. */
  source?: string;
  stack?: string;
}

export async function logFrontend(_entry: FrontendLogEntry): Promise<void> {
  // No-op: the browser has no app data to log into, and its console already
  // shows the error.
}

// --- Quit (M55.10) -----------------------------------------------------------

/** What the shell sends when a quit begins: how long the webview has. */
export interface QuitRequest {
  deadlineMs: number;
}

const quitHandlers = new Set<(request: QuitRequest) => void>();
/** What the webview answered, in order: `finished` or `cancelled`. */
const quitLog: string[] = [];

export async function listenQuitRequested(
  handler: (request: QuitRequest) => void,
): Promise<() => void> {
  // A fresh wrapper, so a handler registered twice is two listeners, as
  // Tauri's listen makes it.
  const own = (request: QuitRequest) => handler(request);
  quitHandlers.add(own);
  return () => {
    quitHandlers.delete(own);
  };
}

export async function finishQuit(): Promise<void> {
  quitLog.push('finished');
}

export async function cancelQuit(): Promise<void> {
  quitLog.push('cancelled');
}

/** Test-only seam, mirroring `window.__cerebroMockFs`: ask to quit, as ⌘Q,
 * the close button and ⌘W do in the app. */
export function __mockQuit(deadlineMs = 5_000): void {
  for (const handler of [...quitHandlers]) handler({ deadlineMs });
}

/** Test isolation: forget every quit listener and answer. */
export function __resetMockQuit(): void {
  quitHandlers.clear();
  quitLog.length = 0;
}

if (typeof window !== 'undefined') {
  const seams = window as unknown as {
    __cerebroMockQuit: typeof __mockQuit;
    __cerebroMockQuitLog: string[];
  };
  seams.__cerebroMockQuit = __mockQuit;
  seams.__cerebroMockQuitLog = quitLog;
}

if (typeof window !== 'undefined') {
  (
    window as unknown as { __cerebroFailSearchVault: typeof __failSearchVault }
  ).__cerebroFailSearchVault = __failSearchVault;
}
