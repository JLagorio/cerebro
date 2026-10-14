/**
 * Scan golden replay (M53.22): the parser's parity rail. Rust is the
 * reference — src-tauri/src/vault/scan.rs writes conformance/scan/entries.json
 * from its own scan of demo-vault/ and its own build_entry over a few
 * fixtures, and the mock backend must produce the same entries from the same
 * bytes. A divergence moves the TS side.
 *
 * Two fields are not part of the contract: the timestamps are a checkout's
 * file times (the golden leaves them out), and `parseError` compares by
 * presence, because its text is each YAML library's own prose.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { KNOWLEDGE_DIR, RESERVED_FILENAMES } from '@/engine/okf';
import { splitFrontmatter } from '@/engine/frontmatter';
import type { Entry } from '@/engine/types';
import { parseWikilinks } from '@/engine/wikilink';
import { resetMockFs, scanVault } from './mockIpc';
import { parseNote } from './mockParse';

const REPO = join(__dirname, '../..');

type GoldenEntry = Omit<Entry, 'createdAt' | 'modifiedAt'>;

interface Golden {
  description: string;
  demo_vault: GoldenEntry[];
  fixtures: { path: string; content: string; entry: GoldenEntry }[];
}

const golden = JSON.parse(
  readFileSync(join(REPO, 'conformance/scan/entries.json'), 'utf8'),
) as Golden;

/** The fields both sides owe each other: no timestamps, and an error by
 * presence rather than by its prose. */
function comparable(entry: GoldenEntry | Entry): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...entry, parseError: entry.parseError !== null };
  delete fields.createdAt;
  delete fields.modifiedAt;
  return fields;
}

const byPath = (entries: GoldenEntry[]) => entries.map((e) => [e.path, e] as const);

describe('the mock scan of demo-vault equals the Rust golden', () => {
  let scanned = new Map<string, Entry>();
  let order: string[] = [];

  beforeAll(async () => {
    resetMockFs();
    const entries = await scanVault('/demo-vault');
    scanned = new Map(entries.map((e) => [e.path, e]));
    order = entries.map((e) => e.path);
  });

  it('lists the same notes in the same order', () => {
    expect(order).toEqual(golden.demo_vault.map((e) => e.path));
  });

  it.each(byPath(golden.demo_vault))('%s', (path, expected) => {
    const ours = scanned.get(path);
    expect(ours, `the mock scan has no ${path}`).toBeDefined();
    if (ours !== undefined) expect(comparable(ours)).toEqual(comparable(expected));
  });
});

describe('the golden fixtures parse identically through parseNote', () => {
  it.each(golden.fixtures.map((f) => [f.path, f] as const))('%s', (path, fixture) => {
    expect(comparable(parseNote(path, fixture.content, '', ''))).toEqual(comparable(fixture.entry));
  });
});

// engine/wikilink is the app's own scanner, kept apart from mockParse's on
// purpose; this holds it to Rust directly rather than through the mock.
describe('engine/wikilink reads every link Rust reads', () => {
  const notes = golden.demo_vault.filter((e) => e.path.endsWith('.md') && e.parseError === null);

  it.each(byPath(notes))('%s', (path, expected) => {
    const { yaml, body } = splitFrontmatter(readFileSync(join(REPO, 'demo-vault', path), 'utf8'));
    const mapping = (yaml === null ? null : YAML.parse(yaml)) as Record<string, unknown> | null;
    const relationships: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(mapping ?? {})) {
      if (key === 'type') continue;
      const targets = parseWikilinks(value);
      if (targets !== null) relationships[key] = targets;
    }
    expect(relationships).toEqual(expected.relationships);
    expect([...new Set(parseWikilinks(body) ?? [])]).toEqual(expected.outgoingLinks);
  });
});

describe('the golden is the real corpus', () => {
  it('holds the demo vault, a diagram, a concept and a contained note', () => {
    const paths = golden.demo_vault.map((e) => e.path);
    expect(paths.length).toBeGreaterThanOrEqual(130);
    expect(paths).toContain('diagrams/pipeline.mmd');
    const concept = (e: GoldenEntry) =>
      e.path.startsWith(`${KNOWLEDGE_DIR}/`) && !RESERVED_FILENAMES.includes(e.filename);
    expect(golden.demo_vault.some(concept)).toBe(true);
    expect(golden.demo_vault.some((e) => e.project !== null)).toBe(true);
  });

  it('carries a malformed note, so parseError is compared at all', () => {
    expect(golden.fixtures.some((f) => f.entry.parseError !== null)).toBe(true);
  });
});
