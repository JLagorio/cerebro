// In-memory IPC backend for browser dev, vitest, and Playwright. The whole
// "disk" is a Map<vault-relative path, raw file content>, seeded at module
// load from the committed demo-vault/ and mutated by the write commands.
// The map is exposed as window.__cerebroMockFs so Playwright can assert on
// "disk" state. 'vault-changed' has no equivalent here: startWatcher is a
// no-op and writers trigger rescans directly (see vaultStore).
import YAML, { type Document } from 'yaml';
import { isKnowledgePath } from '@/engine/okf';
import type { Entry } from '@/engine/types';
import { validateFieldPath, validateOverridePointer } from './epistemic/schema';
import { firstH1LineIndex, humanize, parseNote, splitFrontmatter } from './mockParse';
import { sha256Hex } from './sha256';
import {
  AMBIENT_CONCURRENCY_DEFAULT,
  AMBIENT_CONCURRENCY_MAX,
  demoChanges,
  demoFleetDetails,
  demoFleetRuns,
  demoLanes,
  demoPipelineOverview,
  demoReviewCards,
  demoRevertables,
} from './demoOperational';
import { loadRegistry } from './trigger/registry';
import type { ParentRule, Variant as TriggerVariant } from './trigger/registry';

const SEED_TIME = '2026-07-24T00:00:00.000Z';

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
  fleetAvailable = true;
  resetAgentPauses();
}

/** Re-seed the file map alone. Split from `resetMockFs` because module init
 * runs it BEFORE the operational fixtures below are initialized, and reaching
 * them from here would be a temporal-dead-zone error at import time. */
function seedFiles(): void {
  files.clear();
  times.clear();
  folders.clear();
  connectorsJson = '';
  for (const [absPath, raw] of Object.entries({
    ...seededNotes,
    ...seededYaml,
    ...seededDiagrams,
  })) {
    const rel = absPath.replace(/^\/demo-vault\//, '');
    files.set(rel, raw);
    times.set(rel, { createdAt: SEED_TIME, modifiedAt: SEED_TIME });
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

export async function scanVault(_vault: string): Promise<Entry[]> {
  // Parity with scan.rs: views/ and attachments/ and dot-dirs are skipped at
  // any depth (v2 project folders carry their own views/).
  const skipped = /(^|\/)(views|attachments|\.[^/]*)\//;
  const paths = [...files.keys()]
    .filter((p) => (p.endsWith('.md') || p.endsWith('.mmd')) && !skipped.test(p))
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

/**
 * Mirrors src-tauri/src/knowledge.rs. The mock backend must refuse exactly
 * what Tauri refuses — otherwise the boundary "works" in dev and vitest and
 * only fails in the packaged app, which is the worst way to find out.
 */
const READ_ONLY_KNOWLEDGE =
  'knowledge/ is maintained by the AI knowledge base and is read-only here. ' +
  'Verify the concept, or ask the agent to revise it.';

function guardHumanWrite(path: string): void {
  if (isKnowledgePath(path)) throw new Error(READ_ONLY_KNOWLEDGE);
}

export async function saveNote(_vault: string, path: string, body: string): Promise<void> {
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
    return;
  }
  const { yaml } = splitFrontmatter(mustGet(path));
  files.set(path, yaml !== null ? `---\n${yaml}\n---\n\n${body}` : body);
  touch(path);
}

export async function updateFrontmatter(
  _vault: string,
  path: string,
  patch: Record<string, unknown>,
): Promise<void> {
  // Parity with update_frontmatter in write.rs (M29.23): mermaid's config
  // header IS valid YAML, so patching a .mmd would merge into the diagram's
  // own header and reserialize it. There is no frontmatter here to update.
  if (path.endsWith('.mmd')) {
    throw new Error(`${path}: a .mmd is raw diagram source and has no frontmatter to update`);
  }
  if (isKnowledgePath(path)) {
    // The valve's frontmatter half, with the SAME hard refusals as Rust:
    // provenance stamps are never a human patch, and alias removal has no
    // v1 event.
    for (const key of Object.keys(patch)) {
      if (key === 'generated' || key === 'verified') {
        throw new Error(`provenance forgery: the ${key} stamp is never a human edit — refused`);
      }
    }
    if ('aliases' in patch) {
      const { yaml } = splitFrontmatter(mustGet(path));
      const doc: Document = YAML.parseDocument(yaml ?? '');
      const existing = (doc.toJS() as Record<string, unknown> | null)?.aliases;
      const before = Array.isArray(existing) ? existing.map(String) : [];
      const after = Array.isArray(patch.aliases) ? patch.aliases.map(String) : [];
      if (before.some((a) => !after.includes(a))) {
        throw new Error(
          'unsupported_alias_removal: alias removal has no v1 event — keep the alias or wait ' +
            'for the maintenance channel',
        );
      }
    }
  }
  return writeFrontmatter(path, patch);
}

/** The one sanctioned human write into the bundle: `verified` and nothing
 * else. Scoping lives here so it cannot become a general-purpose bypass. */
export async function verifyConcept(
  _vault: string,
  path: string,
  patch: Record<string, unknown>,
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
  return writeFrontmatter(path, patch);
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
    return;
  }
  if (kind === 'structured') {
    const fields = (request.fields ?? []) as Record<string, unknown>[];
    const aliases = (request.alias_adds ?? []) as string[];
    if (fields.length === 0 && aliases.length === 0) {
      throw new Error('an empty capture request captures nothing');
    }
    for (const edit of fields) validateFieldPath(String(edit.field_path ?? ''));
    applyCaptureOps(path, fields);
    if (aliases.length > 0) {
      const { yaml } = splitFrontmatter(mustGet(path));
      const doc: Document = YAML.parseDocument(yaml ?? '');
      const existing = (doc.get('aliases') as string[] | undefined) ?? [];
      await writeFrontmatter(path, { aliases: [...existing, ...aliases] });
    }
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
  files.set(path, `---\n${doc.toString()}---\n${body}`);
  touch(path);
}

export async function createNote(
  _vault: string,
  folder: string,
  slug: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<string> {
  guardHumanWrite(folder);
  // '' means the vault root — no separator, or the path grows a leading '/'
  // (parity with unique_rel_path in write.rs).
  const prefix = folder === '' ? '' : `${folder}/`;
  let finalSlug = slug;
  for (let n = 2; files.has(`${prefix}${finalSlug}.md`); n++) finalSlug = `${slug}-${n}`;
  const path = `${prefix}${finalSlug}.md`;
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
  return path;
}

export async function setNoteTitle(_vault: string, path: string, title: string): Promise<void> {
  guardHumanWrite(path);
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

/** Nearest ancestor folder holding a collection.yml — parity with write.rs. */
function collectionOf(path: string): string | null {
  const markers = new Set(
    [...files.keys()]
      .filter((p) => p === COLLECTION_MARKER || p.endsWith(`/${COLLECTION_MARKER}`))
      .map(dirOf),
  );
  let dir = dirOf(path);
  for (;;) {
    if (markers.has(dir)) return dir;
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

export async function saveView(
  _vault: string,
  id: string,
  yaml: string,
  folder: string | null = null,
): Promise<void> {
  const path = folder === null ? `views/${id}.yml` : `${folder}/views/${id}.yml`;
  files.set(path, yaml);
  touch(path);
}

export async function listCollections(_vault: string): Promise<{ folder: string; yaml: string }[]> {
  return [...files.keys()]
    .filter((p) => p === COLLECTION_MARKER || p.endsWith(`/${COLLECTION_MARKER}`))
    .map((p) => ({ folder: dirOf(p), yaml: files.get(p) ?? '' }))
    .sort((a, b) => a.folder.localeCompare(b.folder));
}

export async function saveCollection(_vault: string, folder: string, yaml: string): Promise<void> {
  if (folder === '') throw new Error('the vault root is not a collection');
  const path = `${folder}/${COLLECTION_MARKER}`;
  files.set(path, yaml);
  touch(path);
}

export async function saveList(
  _vault: string,
  folder: string,
  id: string,
  yaml: string,
): Promise<void> {
  const path = folder === '' ? `${id}${LIST_SUFFIX}` : `${folder}/${id}${LIST_SUFFIX}`;
  files.set(path, yaml);
  touch(path);
}

export async function startWatcher(_vault: string): Promise<void> {
  // No-op: the mock has no file watcher; writers trigger rescans directly.
}

// The browser mock has no ledger (M21.7): the tamper-evident chain is a Rust
// substrate, and mirroring it here would be guard logic the mock must not
// grow. Parity is only that the command exists on both sides.
export async function ledgerHead(_vault: string): Promise<null> {
  return null;
}

/** No ledger, no reconciliation: the mock's mode is never open, so the
 * exits are unreachable — parity is the command existing on both sides. */
export async function resolveReconciliation(_vault: string, _action: string): Promise<void> {
  throw new Error('no ledger in the browser — reconciliation is a Tauri-only surface');
}

/** Fixed no-ledger status (M21.8): the browser mock has no ledger, and the
 * parity test asserts only that the command exists on both sides. */
export async function ledgerStatus(_vault: string): Promise<{
  verdict: string;
  detail: string;
  head: null;
  seq: null;
  segments: number;
  anomalies: number;
  reconciliation_open: boolean;
  divergences: string[];
}> {
  return {
    verdict: 'no-ledger',
    detail: 'no ledger exists here yet',
    head: null,
    seq: null,
    segments: 0,
    anomalies: 0,
    reconciliation_open: false,
    divergences: [],
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

// --- Vault format v2 file operations (M2 Task 3) ---

export async function createFolder(_vault: string, path: string): Promise<void> {
  guardHumanWrite(path);
  folders.add(path);
}

/** Move a note — or a whole folder prefix — within the vault. */
export async function renameNote(_vault: string, from: string, to: string): Promise<void> {
  // Refused from both sides: out would strip the boundary, in would smuggle
  // human content into the agent's corpus.
  guardHumanWrite(from);
  guardHumanWrite(to);
  if (files.has(to) || folders.has(to)) throw new Error(`target already exists: ${to}`);
  if (files.has(from)) {
    files.set(to, files.get(from)!);
    files.delete(from);
    const t = times.get(from);
    if (t) {
      times.set(to, t);
      times.delete(from);
    }
    touch(to);
    return;
  }
  // Folder move: rewrite every key under the prefix.
  const prefix = `${from}/`;
  const moved = [...files.keys()].filter((p) => p.startsWith(prefix));
  if (moved.length === 0 && !folders.has(from)) throw new Error(`Note not found: ${from}`);
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
}

/** Delete a note or folder (the real backend moves it to the OS trash). */
export async function deleteNote(_vault: string, path: string): Promise<void> {
  // Mirrors lib.rs delete_note (M17.1). This was the one write path with no
  // guard on either backend — parity here is the point of this file.
  guardHumanWrite(path);
  const prefix = `${path}/`;
  const hadFile = files.delete(path);
  times.delete(path);
  let hadChildren = false;
  for (const p of [...files.keys()]) {
    if (p.startsWith(prefix)) {
      files.delete(p);
      times.delete(p);
      hadChildren = true;
    }
  }
  const hadFolder = folders.delete(path);
  if (!hadFile && !hadChildren && !hadFolder) throw new Error(`Note not found: ${path}`);
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
      return rel;
    }
  }
}

/**
 * Mirror of `vault::write::write_text_file` (M29.22): same knowledge guard,
 * same `.mmd`-only extension allowlist, same stem dedupe, and the same
 * vault containment `safe_join` enforces (no absolute paths, no `..`, no
 * empty path). Returns the vault-relative path actually written.
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
  let actual = path;
  for (let n = 2; files.has(actual); n += 1) actual = `${stem}-${n}.${ext}`;
  files.set(actual, content);
  touch(actual);
  return actual;
}

/** All directories in the vault (derived from file paths + explicit folders). */
export async function listFolders(_vault: string): Promise<string[]> {
  const skipped = /(^|\/)(views|attachments|\.[^/]*)(\/|$)/;
  const dirs = new Set<string>(folders);
  for (const p of files.keys()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }
  return [...dirs].filter((d) => !skipped.test(d)).sort();
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
   * mapping `(kind, summary)` to "coverage unassessed" on this side would be
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
  /** "ci_status at implemented", or null for the contradiction lane, whose
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

/** One thing that moved (M26 convergence, read aloud by M27.8). */
export interface ChangeLine {
  text: string;
  belief_id: string | null;
  entity_id: string | null;
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
      'This is the browser mock. Asking the base needs a real ledger and a real CLI run, and a ' +
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
  proposals_submitted: number;
  applied: number;
  rejected: number;
  /** M34.3's hop lineage (M41): the run this one was spawned FROM; null is
   * a root. Mirrors fleet.rs — the parity the mock owes the wire. */
  parent_run_id: string | null;
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

/**
 * One run and its governance joins.
 *
 * `cost_components: null` means NOT RECORDED — pre-M31.6, or a path M31.6
 * does not cover. An empty array would mean "measured, and it cost nothing",
 * which is a different fact; the UI must not render either as $0.
 */
export interface FleetRunDetail {
  run: FleetRun;
  cost_components: FleetCostComponent[] | null;
  assembly: FleetAssemblyMetrics | null;
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

export async function fleetRunDetail(runId: string): Promise<FleetRunDetail> {
  if (!fleetAvailable) throw fleetUnavailable();
  const detail = fleetDetails[runId];
  // Refused, not null — the same way Rust refuses. A typo and a run that
  // recorded nothing must not look the same.
  if (detail === undefined) throw new Error(`no run with id ${runId}`);
  return detail;
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
