import { slugify } from '@/lib/slug';
import type { Entry } from './types';

/**
 * All wikilink targets in a string: `[[target]]` and `[[target|alias]]`.
 * The span scanner's targets deliberately match
 * `wikilinkTargets` in src/lib/mockParse.ts and `wikilink_targets` in
 * src-tauri/src/vault/parse.rs: the target is the text before the first
 * `|`, trimmed; empty targets and targets containing brackets are
 * rejected. The two TS scanners stay separate — do not merge them; the scan
 * golden in conformance/scan holds both to parse.rs.
 */
function extractTargets(text: string): string[] {
  return wikilinkSpans(text).map((span) => span.target);
}

/** A valid wikilink and its trimmed target; every offset is end-exclusive. */
export interface WikilinkSpan {
  start: number;
  end: number;
  target: string;
  targetStart: number;
  targetEnd: number;
}

/**
 * The scanner shared by link readers and byte-preserving rewrites (M60.10).
 * The target ends at the first pipe; its surrounding whitespace and the
 * alias remain outside targetStart/targetEnd. Invalid spans are consumed in
 * the same order as the vault's scanner, so nested brackets never gain a
 * second interpretation during a rename.
 */
export function wikilinkSpans(text: string): WikilinkSpan[] {
  const out: WikilinkSpan[] = [];
  let cursor = 0;
  for (;;) {
    const start = text.indexOf('[[', cursor);
    if (start === -1) break;
    const innerStart = start + 2;
    const close = text.indexOf(']]', innerStart);
    if (close === -1) break;
    const inner = text.slice(innerStart, close);
    const rawTarget = inner.split('|')[0] ?? '';
    const target = rawTarget.trim();
    if (target !== '' && !target.includes('[') && !target.includes(']')) {
      const targetStart = innerStart + rawTarget.length - rawTarget.trimStart().length;
      out.push({
        start,
        end: close + 2,
        target,
        targetStart,
        targetEnd: targetStart + target.length,
      });
    }
    cursor = close + 2;
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

/** An entry's filename stem as a link matches it: the filename minus a
 * trailing `.md` (any case), lowercased. */
function stemOf(entry: Entry): string {
  return entry.filename.replace(/\.md$/i, '').toLowerCase();
}

/** The last segment of a folder path: `projects/atlas` is `atlas`. */
function lastSegment(folder: string): string {
  return folder.slice(folder.lastIndexOf('/') + 1);
}

/** An item key's shape: PREFIX-N, every segment ASCII alphanumeric, the tail digits. */
const ITEM_KEY = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-[0-9]+$/;

/** Rust's `is_ascii_whitespace` at either end: space, tab, LF, FF, CR (no VT). */
const ASCII_EDGE_SPACE = /^[ \t\n\f\r]+|[ \t\n\f\r]+$/g;

/** `properties.key` as written, ASCII-trimmed, when it has the PREFIX-N shape. */
function writtenKeyOf(entry: Entry): string | null {
  const raw = entry.properties.key;
  if (typeof raw !== 'string') return null;
  const key = raw.replace(ASCII_EDGE_SPACE, '');
  return ITEM_KEY.test(key) ? key : null;
}

/**
 * An entry's item key as a link names it (M60.9), or null: `properties.key`
 * when it is a string, ASCII-trimmed, shaped PREFIX-N (`FLD-13`,
 * `MY-TEAM-12`), and lowercased. A project's own `key: FLD`, `C++-5`, `FLD-`,
 * a number and a list are none. Twinned by `item_key` in
 * src-tauri/src/vault/link.rs, ASCII-only so the two languages agree.
 */
export function itemKeyOf(entry: Entry): string | null {
  return writtenKeyOf(entry)?.toLowerCase() ?? null;
}

/**
 * The resolution rule, prepared once for a corpus (M60.9). A name is four
 * ordered passes: filename stem, then a project.md's folder, then an item key
 * (`key: FLD-13`), then exact title; all case-insensitive and trimmed, and
 * each takes the FIRST entry in corpus order that matches. So four first-wins
 * maps tried in that order answer as the scans did, in constant time.
 *
 * The folder pass exists because a project IS its folder: every project's file
 * is named `project.md`, so a stem match can never name one and `[[atlas]]`
 * would dangle against `projects/atlas/project.md`. The folder and key passes
 * sit above the title pass because they are identifiers and a title is prose.
 *
 * Twinned by `TargetIndex` in src-tauri/src/vault/link.rs; both replay
 * src-tauri/fixtures/wikilink-targets.json.
 */
export interface TargetIndex {
  /** The entry one name reaches, or null. An empty name reaches nothing. */
  resolveName(name: string): Entry | null;
  /** The page and section a whole wikilink target reaches (see `resolveLink`). */
  resolveLink(target: string): ResolvedLink | null;
}

/** One pass over `entries`, in order, into the four first-wins maps. */
export function buildTargetIndex(entries: readonly Entry[]): TargetIndex {
  const stems = new Map<string, Entry>();
  const folders = new Map<string, Entry>();
  const keys = new Map<string, Entry>();
  const titles = new Map<string, Entry>();
  const first = (map: Map<string, Entry>, key: string, entry: Entry) => {
    if (!map.has(key)) map.set(key, entry);
  };
  for (const entry of entries) {
    first(stems, stemOf(entry), entry);
    if (entry.filename.toLowerCase() === 'project.md') {
      first(folders, lastSegment(entry.folder).toLowerCase(), entry);
    }
    const key = itemKeyOf(entry);
    if (key !== null) first(keys, key, entry);
    first(titles, entry.title.toLowerCase(), entry);
  }
  const resolveName = (name: string): Entry | null => {
    const needle = name.trim().toLowerCase();
    if (needle === '') return null;
    return (
      stems.get(needle) ?? folders.get(needle) ?? keys.get(needle) ?? titles.get(needle) ?? null
    );
  };
  return {
    resolveName,
    resolveLink(target) {
      const whole = resolveName(target);
      if (whole !== null) return { entry: whole, section: null };
      if (!target.includes('#')) return null;
      const { page, section } = parseLinkTarget(target);
      const entry = resolveName(page);
      return entry === null ? null : { entry, section };
    },
  };
}

/** One index per entries array, with the length it was built at. */
const targetIndexes = new WeakMap<readonly Entry[], { length: number; index: TargetIndex }>();

/**
 * The target index for `entries`, built once per array (M60.9): every
 * resolver call against the same array reads one index, so resolving every
 * link in the vault is O(links), not O(links x notes).
 *
 * Keyed on the array's identity, so an entries array is a snapshot: never
 * mutate one after resolving against it. The store always replaces its array;
 * a length change (a push or a pop) rebuilds, and nothing else is detected.
 */
export function targetIndexFor(entries: readonly Entry[]): TargetIndex {
  const memo = targetIndexes.get(entries);
  if (memo !== undefined && memo.length === entries.length) return memo.index;
  const index = buildTargetIndex(entries);
  targetIndexes.set(entries, { length: entries.length, index });
  return index;
}

/** A link target read as a page and a section (M55.8). */
export interface LinkTarget {
  /** The text before the first `#`, trimmed; the whole target when it has none. */
  page: string;
  /** The text after the first `#`, trimmed; null when there is none or it is empty. */
  section: string | null;
}

/**
 * Split a target at its FIRST `#`: `notes#Risks` is the page `notes` and the
 * section `Risks`, and `notes#A#B` keeps `A#B` as the section. Both halves are
 * trimmed, and an empty section is none. `#Risks` names a section of the page
 * the link sits in, so its page is empty.
 */
export function parseLinkTarget(target: string): LinkTarget {
  const cut = target.indexOf('#');
  if (cut === -1) return { page: target.trim(), section: null };
  const section = target.slice(cut + 1).trim();
  return { page: target.slice(0, cut).trim(), section: section === '' ? null : section };
}

/** What a link reaches: the page, and the section inside it it points at. */
export interface ResolvedLink {
  entry: Entry;
  section: string | null;
}

/**
 * Resolve a wikilink target (M55.8): the whole target first, and only when
 * that names nothing and the target holds a `#`, the page before its first
 * `#`, keeping the rest as the section.
 *
 * The whole target goes first so that nothing that resolved before section
 * links changes: a page titled `C# notes` is still reached by `[[C# notes]]`,
 * as a title link with no section. The fragment is never cut from the file
 * or from `outgoingLinks`; this is the only place it is read.
 *
 * Reads `targetIndexFor(entries)`. Twinned by `TargetIndex::resolve` in
 * src-tauri/src/vault/link.rs; both replay
 * src-tauri/fixtures/wikilink-targets.json.
 */
export function resolveLink(target: string, entries: readonly Entry[]): ResolvedLink | null {
  return targetIndexFor(entries).resolveLink(target);
}

/**
 * The page a wikilink target names: `resolveLink`'s entry. A section link
 * (`[[page#Heading]]`) resolves to its page, so backlinks, relations, the
 * knowledge bundle and the agent's context all read one.
 */
export function resolveTarget(target: string, entries: readonly Entry[]): Entry | null {
  return resolveLink(target, entries)?.entry ?? null;
}

/**
 * A stem for a new page called `title` that no link answers to yet (M55.7):
 * `slugify(title)`, or `page` when nothing of the title survives, then `-2`,
 * `-3`… until `resolveTarget` finds nothing by that name.
 *
 * Checked across the whole vault, not just the folder the page lands in.
 * `resolveTarget`'s stem pass is vault-wide and first-wins, so a stem unique
 * only in its own folder could point the new page's link at an older page.
 * And because a stem match outranks a project folder, an item key and a
 * title, a stem equal to any of them would take over every link that already
 * reaches them.
 */
export function freshStem(title: string, entries: Entry[]): string {
  const base = slugify(title) || 'page';
  let stem = base;
  for (let n = 2; resolveTarget(stem, entries) !== null; n += 1) stem = `${base}-${n}`;
  return stem;
}

/**
 * The name a link to the page at `path` writes (M60.9): a `project.md`'s
 * folder, else the filename minus a trailing `.md` in any case. Case is kept,
 * and a `.mmd` keeps its extension, because the stem pass reads a filename
 * that way. It may still be another page's name: `linkTargetsFor` checks.
 */
export function linkTargetOfPath(path: string): string {
  const slash = path.lastIndexOf('/');
  const filename = path.slice(slash + 1);
  if (filename.toLowerCase() === 'project.md' && slash !== -1) {
    return lastSegment(path.slice(0, slash));
  }
  return filename.replace(/\.md$/i, '');
}

/** The name a link to `entry` writes: `linkTargetOfPath` of its path. */
export function linkTargetOf(entry: Entry): string {
  return linkTargetOfPath(entry.path);
}

/**
 * The name a new link to a page is written with, or null when no name reaches
 * it. `section`, when given, is the heading the link points into.
 */
export type LinkTargetOf = (entry: Entry, section?: string | null) => string | null;

/** A name the scanners read whole: no bracket, `|` or line break, no edge space. */
function writable(name: string): boolean {
  return name !== '' && name === name.trim() && !/[[\]|\n]/.test(name);
}

/**
 * What a link to a page should name, over `entries` (M55.14): the first of
 * `linkTargetOf(entry)`, a project's own `project` stem, its item key as
 * written and its title that the target index reads back as THAT page, or
 * null when none does.
 *
 * The first name is not enough on its own. The stem pass is vault-wide and
 * first-wins, so two `meetings/kickoff.md` files share `[[kickoff]]` and only
 * the first is reached by it; the rest are written by key or title. A page
 * whose every name belongs to another is not offered: a link to it would land
 * somewhere else. Reads `targetIndexFor(entries)`, so the `[[` menu can ask
 * for every page without a vault scan per row.
 */
export function linkTargetsFor(entries: readonly Entry[]): LinkTargetOf {
  const index = targetIndexFor(entries);
  return (entry, section = null) => {
    const own = linkTargetOf(entry);
    const stem = entry.filename.replace(/\.md$/i, '');
    const key = writtenKeyOf(entry);
    const names = [
      own,
      ...(stem !== own ? [stem] : []),
      ...(key !== null ? [key] : []),
      entry.title,
    ];
    for (const name of names) {
      if (!writable(name) || index.resolveName(name) !== entry) continue;
      if (section === null) return name;
      // `name#section` resolves whole first, then at its FIRST `#`: the whole
      // must name nothing, and the name must hold no `#` of its own.
      const target = `${name}#${section}`;
      if (!name.includes('#') && writable(target) && index.resolveName(target) === null) {
        return target;
      }
    }
    return null;
  };
}
