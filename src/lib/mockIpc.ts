// In-memory IPC backend for browser dev, vitest, and Playwright. The whole
// "disk" is a Map<vault-relative path, raw file content>, seeded at module
// load from the committed demo-vault/ and mutated by the write commands.
// The map is exposed as window.__cerebroMockFs so Playwright can assert on
// "disk" state. 'vault-changed' has no equivalent here: startWatcher is a
// no-op and writers trigger rescans directly (see vaultStore).
import YAML, { type Document } from 'yaml';
import { isKnowledgePath } from '@/engine/okf';
import type { Entry } from '@/engine/types';
import { firstH1LineIndex, humanize, parseNote, splitFrontmatter } from './mockParse';

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

/** Re-seed the mock filesystem from demo-vault/. Exported for test isolation. */
export function resetMockFs(): void {
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
resetMockFs();

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
  guardHumanWrite(path);
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
  guardHumanWrite(path);
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
 * same `.mmd`-only extension allowlist, same stem dedupe. Returns the
 * vault-relative path actually written.
 */
export async function writeTextFile(
  _vault: string,
  path: string,
  content: string,
): Promise<string> {
  guardHumanWrite(path);
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
