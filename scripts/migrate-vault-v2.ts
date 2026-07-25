// One-off migration: vault format v1 (spaces + flat items/ linked by
// `project: [[slug]]`) -> v2 (projects as folders, containment membership,
// statuses on types/work-item.md with per-project overrides).
//
// Run: pnpm tsx scripts/migrate-vault-v2.ts /path/to/vault
//
// Idempotent by refusal: if the vault already contains any */project.md it is
// v2 and the script exits without touching anything. No released users exist —
// this covers dev vaults created during M1 only. Files are MOVED (git-friendly
// renames); nothing is deleted except the spaces/ notes, which are folded into
// type/project statuses first and then removed.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

interface Note {
  rel: string;
  yaml: Record<string, unknown>;
  raw: string;
}

function walk(dir: string, root: string, out: string[] = []): string[] {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue;
    const abs = join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === 'views' || item.name === 'attachments') continue;
      walk(abs, root, out);
    } else if (item.name.endsWith('.md')) {
      out.push(abs.slice(root.length + 1).split('\\').join('/'));
    }
  }
  return out;
}

function readNote(vault: string, rel: string): Note {
  const raw = readFileSync(join(vault, rel), 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/.exec(raw);
  let yaml: Record<string, unknown> = {};
  if (m !== null) {
    try {
      const parsed: unknown = YAML.parse(m[1]);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        yaml = parsed as Record<string, unknown>;
      }
    } catch {
      // unparseable frontmatter: treat as a plain doc, migrate by location only
    }
  }
  return { rel, yaml, raw };
}

const wikilinkTarget = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const m = /\[\[([^\]|]+)(\|[^\]]*)?\]\]/.exec(v);
  return m !== null ? m[1].trim() : null;
};

const stem = (rel: string) => (rel.split('/').pop() ?? rel).replace(/\.md$/, '');

function main(): void {
  const vault = resolve(process.argv[2] ?? '');
  if (process.argv[2] === undefined || !existsSync(vault)) {
    console.error('Usage: pnpm tsx scripts/migrate-vault-v2.ts /path/to/vault');
    process.exit(1);
  }

  const all = walk(vault, vault).sort();
  if (all.some((rel) => rel === 'project.md' || rel.endsWith('/project.md'))) {
    console.log('Vault already contains a project.md — looks like v2, nothing to do.');
    return;
  }

  const notes = all.map((rel) => readNote(vault, rel));
  const spaces = notes.filter((n) => n.yaml.type === 'Space');
  const projects = notes.filter((n) => n.yaml.type === 'Project');
  const moved: string[] = [];
  const warnings: string[] = [];

  const move = (from: string, to: string) => {
    const dest = join(vault, to);
    mkdirSync(join(dest, '..'), { recursive: true });
    renameSync(join(vault, from), dest);
    moved.push(`${from} -> ${to}`);
  };

  // 1. Statuses: the most common space set becomes the vault default on the
  //    Work item Type doc; projects in other spaces get an override later.
  const spaceBySlug = new Map(spaces.map((s) => [stem(s.rel), s]));
  const setOf = (s: Note | undefined) => JSON.stringify(s?.yaml.statuses ?? null);
  const counts = new Map<string, number>();
  for (const p of projects) {
    const slug = wikilinkTarget(p.yaml.space);
    const set = setOf(slug !== null ? spaceBySlug.get(slug) : undefined);
    counts.set(set, (counts.get(set) ?? 0) + 1);
  }
  const defaultSet = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'null';

  const typeDoc = notes.find((n) => n.yaml.type === 'Type' && /work.item/i.test(stem(n.rel)));
  if (typeDoc !== undefined && defaultSet !== 'null') {
    const raw = readFileSync(join(vault, typeDoc.rel), 'utf8');
    const m = /^---\r?\n([\s\S]*?)\r?\n---([ \t]*\r?\n[\s\S]*)$/.exec(raw);
    if (m !== null) {
      const doc = YAML.parseDocument(m[1]);
      doc.set('statuses', JSON.parse(defaultSet));
      writeFileSync(join(vault, typeDoc.rel), `---\n${doc.toString()}---${m[2]}`, 'utf8');
      moved.push(`${typeDoc.rel}: vault-default statuses written`);
    }
  } else if (typeDoc === undefined) {
    warnings.push('no Work item Type doc found — vault-default statuses not written');
  }

  // 2. Projects: projects/<slug>.md -> projects/<slug>/project.md, dropping
  //    `space:` and adding a `statuses:` override where the space differed.
  for (const p of projects) {
    const slug = stem(p.rel);
    const spaceSlug = wikilinkTarget(p.yaml.space);
    const space = spaceSlug !== null ? spaceBySlug.get(spaceSlug) : undefined;
    const raw = readFileSync(join(vault, p.rel), 'utf8');
    const m = /^---\r?\n([\s\S]*?)\r?\n---([ \t]*\r?\n[\s\S]*)$/.exec(raw);
    let content = raw;
    if (m !== null) {
      const doc = YAML.parseDocument(m[1]);
      doc.delete('space');
      if (space !== undefined && setOf(space) !== defaultSet && space.yaml.statuses !== undefined) {
        doc.set('statuses', space.yaml.statuses);
      }
      content = `---\n${doc.toString()}---${m[2]}`;
    }
    mkdirSync(join(vault, 'projects', slug), { recursive: true });
    writeFileSync(join(vault, 'projects', slug, 'project.md'), content, 'utf8');
    rmSync(join(vault, p.rel));
    moved.push(`${p.rel} -> projects/${slug}/project.md`);
  }

  // 3. Items: move into their project's items/ folder by the `project:` link;
  //    drop the link line. Unresolvable items land in inbox/.
  const projectSlugs = new Set(projects.map((p) => stem(p.rel)));
  for (const n of notes) {
    if (n.yaml.type !== 'Work item') continue;
    const target = wikilinkTarget(n.yaml.project);
    const raw = readFileSync(join(vault, n.rel), 'utf8');
    const m = /^---\r?\n([\s\S]*?)\r?\n---([ \t]*\r?\n[\s\S]*)$/.exec(raw);
    let content = raw;
    if (m !== null) {
      const doc = YAML.parseDocument(m[1]);
      doc.delete('project');
      content = `---\n${doc.toString()}---${m[2]}`;
    }
    const dest =
      target !== null && projectSlugs.has(target)
        ? `projects/${target}/items/${n.rel.split('/').pop()}`
        : `inbox/${n.rel.split('/').pop()}`;
    if (dest.startsWith('inbox/')) warnings.push(`${n.rel}: no resolvable project — moved to inbox/`);
    mkdirSync(join(vault, dest, '..'), { recursive: true });
    writeFileSync(join(vault, dest), content, 'utf8');
    rmSync(join(vault, n.rel));
    moved.push(`${n.rel} -> ${dest}`);
  }

  // 4. Spaces: folded into steps 1-2; remove the notes.
  for (const s of spaces) {
    rmSync(join(vault, s.rel));
    moved.push(`${s.rel}: removed (statuses folded into type/project docs)`);
  }
  void move; // reserved for future steps that relocate without rewriting

  console.log(moved.map((l) => `  ${l}`).join('\n'));
  if (warnings.length > 0) {
    console.log('\nWarnings:');
    console.log(warnings.map((l) => `  ${l}`).join('\n'));
  }
  console.log(`\nMigrated ${moved.length} files. Review with git status / your diff tool.`);
}

main();
