import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The twin registry in `shared/policy/README.md` (M60.3, the D3 ruling): a
 * rule Rust and TS both hold is listed there, held by one artifact or case
 * file that both suites replay. This holds every row to the tree: its paths
 * exist, each replay file names what holds the twin, and no twin is listed
 * twice. A twin that was renamed or dropped fixes its row, never this test.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const README = 'shared/policy/README.md';
const SECTION = '## Twins (D3): one rule, two readers, shared cases';
const HEADER = '| Twin | Rust replay | TS replay | Held by | Since |';
const CODE_SPAN = /`([^`\n]+)`/g;

interface Twin {
  name: string;
  rust: string[];
  ts: string[];
  heldBy: string[];
}

const spans = (cell: string): string[] => [...cell.matchAll(CODE_SPAN)].map((m) => m[1]);

function registry(): Twin[] {
  const text = readFileSync(join(REPO, README), 'utf8');
  const start = text.indexOf(SECTION);
  expect(start, `${README} has the section "${SECTION}"`).toBeGreaterThan(-1);
  const section = text.slice(start + SECTION.length).split(/\n## /)[0];
  const lines = section.split('\n');
  const header = lines.indexOf(HEADER);
  expect(header, `the section holds the table "${HEADER}"`).toBeGreaterThan(-1);
  const rows: Twin[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    expect(cells, line).toHaveLength(5);
    rows.push({
      name: cells[0],
      rust: spans(cells[1]),
      ts: spans(cells[2]),
      heldBy: spans(cells[3]),
    });
  }
  return rows;
}

/** What a replay file must say to show it reads the twin: the held-by
 * file's basename or its directory's name, with or without `.json`. */
function namesOf(path: string): string[] {
  const base = basename(path.replace(/\/$/, ''));
  return [base, base.replace(/\.json$/, '')];
}

describe('the twin registry', () => {
  const rows = registry();

  it('lists the twins', () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it('every listed twin replays its cases in both suites', () => {
    const problems: string[] = [];
    for (const row of rows) {
      if (row.rust.length === 0 || row.ts.length === 0 || row.heldBy.length === 0) {
        problems.push(`${row.name}: every column names a path`);
        continue;
      }
      for (const path of [...row.rust, ...row.ts, ...row.heldBy]) {
        if (!existsSync(join(REPO, path))) problems.push(`${row.name}: ${path} does not exist`);
      }
      const names = row.heldBy.flatMap(namesOf);
      for (const replay of [...row.rust, ...row.ts]) {
        const file = join(REPO, replay);
        if (!existsSync(file)) continue;
        const text = readFileSync(file, 'utf8');
        if (!names.some((n) => text.includes(n))) {
          problems.push(`${row.name}: ${replay} names none of ${row.heldBy.join(', ')}`);
        }
      }
      for (const path of row.rust) {
        if (!path.endsWith('.rs')) problems.push(`${row.name}: ${path} is not a Rust file`);
      }
      for (const path of row.ts) {
        if (!/\.test\.tsx?$/.test(path)) problems.push(`${row.name}: ${path} is not a vitest file`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('no twin is listed twice', () => {
    const seen = new Map<string, string>();
    const repeats: string[] = [];
    for (const row of rows) {
      for (const key of [row.name, ...row.heldBy]) {
        const earlier = seen.get(key);
        if (earlier !== undefined) repeats.push(`${key} (${earlier} and ${row.name})`);
        seen.set(key, row.name);
      }
    }
    expect(repeats).toEqual([]);
  });
});
