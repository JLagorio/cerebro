// In-memory IPC backend for browser dev, vitest, and Playwright. The whole
// "disk" is a Map<vault-relative path, raw file content>, seeded at module
// load from the committed demo-vault/ and mutated by the write commands.
// The map is exposed as window.__cerebroMockFs so Playwright can assert on
// "disk" state. 'vault-changed' has no equivalent here: startWatcher is a
// no-op and writers trigger rescans directly (see vaultStore).
import YAML, { type Document } from 'yaml';
import type { Entry } from '@/engine/types';
import { firstH1LineIndex, humanize, parseNote, splitFrontmatter } from './mockParse';

const SEED_TIME = '2026-07-24T00:00:00.000Z';

const seededNotes = import.meta.glob('/demo-vault/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const seededViews = import.meta.glob('/demo-vault/views/*.yml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const files = new Map<string, string>();
const times = new Map<string, { createdAt: string; modifiedAt: string }>();
// Directories created explicitly (create_folder) — the file map alone can't
// represent an empty folder. Parity with real dirs on disk.
const folders = new Set<string>();

/** Re-seed the mock filesystem from demo-vault/. Exported for test isolation. */
export function resetMockFs(): void {
  files.clear();
  times.clear();
  folders.clear();
  for (const [absPath, raw] of Object.entries({ ...seededNotes, ...seededViews })) {
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

export async function getLastVault(): Promise<string | null> {
  return '/demo-vault';
}

export async function scanVault(_vault: string): Promise<Entry[]> {
  // Parity with scan.rs: views/ and attachments/ and dot-dirs are skipped at
  // any depth (v2 project folders carry their own views/).
  const skipped = /(^|\/)(views|attachments|\.[^/]*)\//;
  const paths = [...files.keys()]
    .filter((p) => p.endsWith('.md') && !skipped.test(p))
    .sort();
  const entries = paths.map((p) => {
    const t = times.get(p) ?? { createdAt: SEED_TIME, modifiedAt: SEED_TIME };
    return parseNote(p, files.get(p) ?? '', t.createdAt, t.modifiedAt);
  });
  return assignProjects(entries);
}

export async function readNote(_vault: string, path: string): Promise<string> {
  return splitFrontmatter(mustGet(path)).body.replace(/^\n+/, '');
}

export async function saveNote(_vault: string, path: string, body: string): Promise<void> {
  const { yaml } = splitFrontmatter(mustGet(path));
  files.set(path, yaml !== null ? `---\n${yaml}\n---\n\n${body}` : body);
  touch(path);
}

export async function updateFrontmatter(
  _vault: string,
  path: string,
  patch: Record<string, unknown>,
): Promise<void> {
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
  let finalSlug = slug;
  for (let n = 2; files.has(`${folder}/${finalSlug}.md`); n++) finalSlug = `${slug}-${n}`;
  const path = `${folder}/${finalSlug}.md`;
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

export async function listViews(
  _vault: string,
): Promise<{ id: string; yaml: string; project: string | null }[]> {
  // Parity with write.rs list_views: root views/ is global; a views/ dir next
  // to a project.md is scoped to that project. Sorted by (project, id).
  const projectDirs = [...files.keys()]
    .filter((p) => p.endsWith('/project.md'))
    .map((p) => p.slice(0, -'/project.md'.length));
  const views: { id: string; yaml: string; project: string | null }[] = [];
  for (const p of [...files.keys()].sort()) {
    if (!p.endsWith('.yml')) continue;
    if (p.startsWith('views/') && !p.slice('views/'.length).includes('/')) {
      views.push({ id: p.slice('views/'.length, -'.yml'.length), yaml: files.get(p) ?? '', project: null });
      continue;
    }
    const dir = projectDirs.find((d) => p.startsWith(`${d}/views/`) && !p.slice(`${d}/views/`.length).includes('/'));
    if (dir !== undefined) {
      views.push({
        id: p.slice(`${dir}/views/`.length, -'.yml'.length),
        yaml: files.get(p) ?? '',
        project: `${dir}/project.md`,
      });
    }
  }
  views.sort((a, b) => (a.project ?? '').localeCompare(b.project ?? '') || a.id.localeCompare(b.id));
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

export async function startWatcher(_vault: string): Promise<void> {
  // No-op: the mock has no file watcher; writers trigger rescans directly.
}

// --- Vault format v2 file operations (M2 Task 3) ---

export async function createFolder(_vault: string, path: string): Promise<void> {
  folders.add(path);
}

/** Move a note — or a whole folder prefix — within the vault. */
export async function renameNote(_vault: string, from: string, to: string): Promise<void> {
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
