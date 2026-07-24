// Generates the committed demo-vault/ from the prototype seed data in
// docs/cerebro-with-teams/. Deterministic: sorted iteration and fixed
// frontmatter key order, so a re-run over unchanged seeds diffs cleanly.
//
// Run: pnpm tsx scripts/build-demo-vault.ts

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SEED_DIR = join(ROOT, 'docs', 'cerebro-with-teams');
const OUT_DIR = join(ROOT, 'demo-vault');

// ---------------------------------------------------------------------------
// Seed loading. The seed files declare plain data as top-level
// `export const X = ...` with no imports and no browser globals (verified by
// inspection of both files). Stripping the `export ` keyword turns each file
// into a plain script we can evaluate in a node:vm sandbox; a collector
// callback appended to the script harvests the constants we need.
// ---------------------------------------------------------------------------
export function loadSeedModule(filePath: string, names: string[]): Record<string, unknown> {
  const source = readFileSync(filePath, 'utf8');
  const script = source.replace(/^export\s+/gm, '');
  const collected: Record<string, unknown> = {};
  const context = vm.createContext({
    __collect: (bag: Record<string, unknown>) => Object.assign(collected, bag),
  });
  vm.runInContext(`${script}\n__collect({ ${names.join(', ')} });`, context, {
    filename: filePath,
  });
  return collected;
}

// Token -> hex, transcribed from docs/Cerebro Design System/tokens/colors.css.
// The vault is standalone markdown, so seed `var(--token)` colors are baked
// to hex at generation time.
export const TOKEN_HEX: Record<string, string> = {
  'n-400': '#A8AFC2',
  'n-500': '#7E8699',
  'n-700': '#3F4657',
  'cortex-400': '#6580EC',
  'cortex-500': '#3D5BDE',
  'success-500': '#1F9D61',
  'warn-500': '#DE8F0A',
  'danger-500': '#DE3B4E',
  'swatch-amber': '#EFB428',
  'swatch-blue': '#3D8BE8',
  'swatch-teal': '#14B8A6',
  'swatch-green': '#34B764',
  'swatch-violet': '#8250DC',
  'swatch-magenta': '#D8569E',
  'swatch-vermilion': '#E0562E',
  'swatch-sky': '#38BDF8',
};

export function cssColor(value: string): string {
  const m = /^var\(--([a-z0-9-]+)\)$/i.exec(value);
  if (m === null) return value;
  const hex = TOKEN_HEX[m[1]];
  if (hex === undefined) throw new Error(`No hex mapping for token --${m[1]}`);
  return hex;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Seed dueN encodes month*100+day on a 2026 calendar (e.g. 918 -> Sep 18).
export function dueIso(dueN: number): string {
  const month = Math.floor(dueN / 100);
  const day = dueN % 100;
  return `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// --- seed shapes (only the fields this generator reads) ---------------------
interface SeedStatus {
  id: string;
  group: string;
  color: string;
  hollow?: boolean;
}
interface SeedSpace {
  id: string;
  name: string;
  swatch: string;
  description?: string;
  statuses: SeedStatus[];
}
interface SeedProject {
  id: string;
  spaceId: string;
  key: string;
  name: string;
  state: string;
  description?: string;
}
export interface SeedWorkItem {
  id: string;
  key: string;
  name: string;
  type: string;
  status: string;
  priority: string;
  assignee: string;
  dueN: number;
  estimate: string;
  projectId?: string;
  listId?: string;
  description?: string;
}
interface SeedUser {
  id: string;
  name: string;
  role: string;
  team: string;
}

// Pure mapping: one seed work item -> item note frontmatter (unit-tested).
// Returns null for items that should not be generated (work-list items).
export function seedItemToFrontmatter(
  item: SeedWorkItem,
  projectSlugById: Map<string, string>,
): Record<string, unknown> | null {
  // Seed items carry either projectId or listId; work lists are not M1.
  if (item.projectId === undefined) return null;
  const projectSlug = projectSlugById.get(item.projectId);
  if (projectSlug === undefined) return null;
  return {
    type: 'Work item',
    key: item.key,
    project: `[[${projectSlug}]]`,
    status: item.status,
    priority: item.priority,
    assignee: `[[${slugify(item.assignee)}]]`,
    due: dueIso(item.dueN),
    estimate: item.estimate,
  };
}

function note(frontmatter: Record<string, unknown>, title: string, body?: string): string {
  const fm = YAML.stringify(frontmatter, { lineWidth: 0 });
  return `---\n${fm}---\n\n# ${title}\n${
    body !== undefined && body !== '' ? `\n${body.trim()}\n` : ''
  }`;
}

// ---------------------------------------------------------------------------
// Type notes. Fields blocks follow the spec examples verbatim (hand-written,
// not derived from the seed); select-option hexes are baked from DS tokens
// (project states mirror the seed PROJECT_STATES colors).
// ---------------------------------------------------------------------------
const TYPE_NOTES: Record<string, string> = {
  'type/work-item.md': `---
type: Type
icon: check-square
color: '#3D8BE8'
fields:
  status: { kind: status }
  priority:
    kind: select
    options:
      - { id: urgent, color: '#DE3B4E' }
      - { id: high, color: '#DE8F0A' }
      - { id: medium, color: '#3D8BE8' }
      - { id: low, color: '#A8AFC2' }
      - { id: none, color: '#7E8699' }
  assignee: { kind: person }
  due: { kind: date }
  estimate:
    kind: select
    options:
      - { id: XS }
      - { id: S }
      - { id: M }
      - { id: L }
      - { id: XL }
  project: { kind: relation, target: Project }
---

# Work item

Work items are the unit of delivery: tasks, bugs, and milestones tracked on project boards.
`,
  'type/space.md': `---
type: Type
icon: layers
color: '#8250DC'
---

# Space

Spaces group related projects and declare the status workflow their items move through.
`,
  'type/project.md': `---
type: Type
icon: folder-kanban
color: '#14B8A6'
fields:
  key: { kind: text }
  state:
    kind: select
    options:
      - { id: draft, color: '#A8AFC2', hollow: true }
      - { id: planning, color: '#6580EC' }
      - { id: execution, color: '#DE8F0A' }
      - { id: monitoring, color: '#38BDF8' }
      - { id: completed, color: '#1F9D61' }
  space: { kind: relation, target: Space }
---

# Project

Projects belong to a space, carry an uppercase item-key prefix, and collect work items.
`,
  'type/person.md': `---
type: Type
icon: user
color: '#38BDF8'
fields:
  role: { kind: text }
  team: { kind: text }
---

# Person

People are assignees and leads. Person notes are referenced by wikilink from work items.
`,
};

export function buildVault(): Map<string, string> {
  const work = loadSeedModule(join(SEED_DIR, 'cerebro-work-data.js'), [
    'SPACES',
    'PROJECTS',
    'WORK_ITEMS',
  ]) as unknown as { SPACES: SeedSpace[]; PROJECTS: SeedProject[]; WORK_ITEMS: SeedWorkItem[] };
  const org = loadSeedModule(join(SEED_DIR, 'cerebro-data.js'), ['USERS']) as unknown as {
    USERS: SeedUser[];
  };

  const files = new Map<string, string>();
  for (const [path, content] of Object.entries(TYPE_NOTES)) files.set(path, content);

  const spaceSlugById = new Map(work.SPACES.map((s) => [s.id, slugify(s.name)]));
  const projectSlugById = new Map(work.PROJECTS.map((p) => [p.id, slugify(p.name)]));

  const bySlug = <T>(slugOf: (x: T) => string) => (a: T, b: T) =>
    slugOf(a).localeCompare(slugOf(b));

  // Spaces: statuses mapped to { id, group, color, hollow? } with hex colors.
  for (const space of [...work.SPACES].sort(bySlug((s) => slugify(s.name)))) {
    const statuses = space.statuses.map((st) => ({
      id: st.id,
      group: st.group,
      color: cssColor(st.color),
      ...(st.hollow === true ? { hollow: true } : {}),
    }));
    files.set(
      `spaces/${slugify(space.name)}.md`,
      note({ type: 'Space', color: cssColor(space.swatch), statuses }, space.name, space.description),
    );
  }

  // Projects: key, space wikilink, state.
  for (const project of [...work.PROJECTS].sort(bySlug((p) => slugify(p.name)))) {
    const spaceSlug = spaceSlugById.get(project.spaceId);
    if (spaceSlug === undefined) throw new Error(`Unknown spaceId ${project.spaceId}`);
    files.set(
      `projects/${slugify(project.name)}.md`,
      note(
        { type: 'Project', key: project.key, space: `[[${spaceSlug}]]`, state: project.state },
        project.name,
        project.description,
      ),
    );
  }

  // Work items: skip list-attached items; body from seed description.
  for (const item of [...work.WORK_ITEMS].sort(bySlug((i) => slugify(i.key)))) {
    const fm = seedItemToFrontmatter(item, projectSlugById);
    if (fm === null) continue;
    files.set(`items/${slugify(item.key)}.md`, note(fm, item.name, item.description));
  }

  // People.
  for (const user of [...org.USERS].sort(bySlug((u) => slugify(u.name)))) {
    files.set(
      `people/${slugify(user.name)}.md`,
      note({ type: 'Person', role: user.role, team: user.team }, user.name),
    );
  }

  return files;
}

function main(): void {
  const files = buildVault();
  rmSync(OUT_DIR, { recursive: true, force: true });
  for (const path of [...files.keys()].sort()) {
    const abs = join(OUT_DIR, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, files.get(path) ?? '', 'utf8');
  }
  console.log(`demo-vault: wrote ${files.size} files`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
