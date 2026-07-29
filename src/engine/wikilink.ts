import type { Entry } from './types';

/**
 * All wikilink targets in a string: `[[target]]` and `[[target|alias]]`.
 * Scanner (not a regex) whose semantics deliberately match
 * `wikilinkTargets` in src/lib/mockParse.ts and `wikilink_targets` in
 * src-tauri/src/vault/parse.rs: the target is the text before the first
 * `|`, trimmed; empty targets and targets containing brackets are
 * rejected. (mockParse stays self-contained by design — do not merge.)
 */
function extractTargets(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  for (;;) {
    const start = rest.indexOf('[[');
    if (start === -1) break;
    const innerStart = start + 2;
    const endRel = rest.indexOf(']]', innerStart);
    if (endRel === -1) break;
    const inner = rest.slice(innerStart, endRel);
    const target = (inner.split('|')[0] ?? '').trim();
    if (target !== '' && !target.includes('[') && !target.includes(']')) {
      out.push(target);
    }
    rest = rest.slice(endRel + 2);
  }
  return out;
}

/** Collect string content from a frontmatter value (strings and nested
 * arrays of strings — parity with `collect_targets` in entry.rs). */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
}

/** Returns wikilink targets found in a frontmatter value, or null if it contains none. */
export function parseWikilinks(value: unknown): string[] | null {
  const texts: string[] = [];
  collectStrings(value, texts);
  const targets = texts.flatMap(extractTargets);
  return targets.length > 0 ? targets : null;
}

export function formatWikilink(target: string): string {
  return `[[${target}]]`;
}

/**
 * Filename-stem match first, then project folder, then exact title; all
 * case-insensitive (Tolaria rule).
 *
 * The folder pass exists because a project IS its folder: every project's file
 * is named `project.md`, so a stem match can never name one and `[[atlas]]`
 * would dangle against `projects/atlas/project.md`. It sits above the title
 * pass because a folder name is an identifier and a title is prose.
 */
export function resolveTarget(target: string, entries: Entry[]): Entry | null {
  const needle = target.trim().toLowerCase();
  if (needle === '') return null;
  for (const entry of entries) {
    const stem = entry.filename.replace(/\.md$/i, '').toLowerCase();
    if (stem === needle) return entry;
  }
  for (const entry of entries) {
    if (entry.filename.toLowerCase() !== 'project.md') continue;
    const folder = entry.folder.slice(entry.folder.lastIndexOf('/') + 1).toLowerCase();
    if (folder === needle) return entry;
  }
  for (const entry of entries) {
    if (entry.title.toLowerCase() === needle) return entry;
  }
  return null;
}
