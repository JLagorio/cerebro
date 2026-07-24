// In-memory IPC backend for browser dev, vitest, and Playwright. The whole
// "disk" is a Map<vault-relative path, raw file content>, seeded at module
// load from the committed demo-vault/ and mutated by the write commands.
// The map is exposed as window.__cerebroMockFs so Playwright can assert on
// "disk" state. 'vault-changed' has no equivalent here: startWatcher is a
// no-op and writers trigger rescans directly (see vaultStore).
import YAML, { type Document } from 'yaml';
import type { Entry } from '@/engine/types';
import { parseNote, splitFrontmatter } from './mockParse';

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

/** Re-seed the mock filesystem from demo-vault/. Exported for test isolation. */
export function resetMockFs(): void {
  files.clear();
  times.clear();
  for (const [absPath, raw] of Object.entries({ ...seededNotes, ...seededViews })) {
    const rel = absPath.replace(/^\/demo-vault\//, '');
    files.set(rel, raw);
    times.set(rel, { createdAt: SEED_TIME, modifiedAt: SEED_TIME });
  }
}
resetMockFs();

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
  const paths = [...files.keys()].filter((p) => p.endsWith('.md')).sort();
  return paths.map((p) => {
    const t = times.get(p) ?? { createdAt: SEED_TIME, modifiedAt: SEED_TIME };
    return parseNote(p, files.get(p) ?? '', t.createdAt, t.modifiedAt);
  });
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
  files.set(path, `---\n${YAML.stringify(frontmatter)}---\n\n${body}`);
  touch(path);
  return path;
}

export async function setNoteTitle(_vault: string, path: string, title: string): Promise<void> {
  const { yaml, body } = splitFrontmatter(mustGet(path));
  const lines = body.split('\n');
  const h1Index = lines.findIndex((line) => /^#\s+/.test(line));
  if (h1Index >= 0) {
    lines[h1Index] = `# ${title}`;
  } else {
    let insertAt = 0;
    while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
    lines.splice(insertAt, 0, `# ${title}`, '');
  }
  const newBody = lines.join('\n');
  files.set(path, yaml !== null ? `---\n${yaml}\n---\n${newBody}` : newBody);
  touch(path);
}

export async function listViews(_vault: string): Promise<{ id: string; yaml: string }[]> {
  return [...files.keys()]
    .filter((p) => p.startsWith('views/') && p.endsWith('.yml'))
    .sort()
    .map((p) => ({ id: p.slice('views/'.length, -'.yml'.length), yaml: files.get(p) ?? '' }));
}

export async function saveView(_vault: string, id: string, yaml: string): Promise<void> {
  files.set(`views/${id}.yml`, yaml);
  touch(`views/${id}.yml`);
}

export async function startWatcher(_vault: string): Promise<void> {
  // No-op: the mock has no file watcher; writers trigger rescans directly.
}
