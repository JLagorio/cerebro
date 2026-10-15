/**
 * The page card (M55.14): a block that shows one other page, live.
 *
 * On disk it is a ```cerebro-page fence holding ONE wikilink, `[[target]]` or
 * `[[target|alias]]`, after the database fence (M47.2): a pointer, never a
 * copy of the page. An unset card, which is the picker, is the empty fence.
 * Both scanners read wikilinks inside fences, so the target's backlinks count
 * the card.
 *
 * Pure: no DOM, no store. The block, the paste and the picker read these.
 */

import { isTemplate } from '@/lib/templates';
import type { Entry, FieldDef, Schema } from './types';
import { resolveTarget } from './wikilink';

/** The fence language a page card is written in. */
export const PAGE_CARD_FENCE = 'cerebro-page';

/** What a card points at. `alias` is '' when the link has none. */
export interface PageRef {
  target: string;
  alias: string;
}

/** The card nobody has pointed yet: the picker, and the empty fence. */
export const UNSET: Readonly<PageRef> = Object.freeze({ target: '', alias: '' });

/**
 * One wikilink, alone. The target holds no bracket, `|` or line break, and the
 * alias no bracket or line break: the rules the scanners read a link by, so
 * the card and the backlink always agree on what it names.
 */
const ONE_LINK = /^\[\[([^[\]|\n]+)(?:\|([^[\]\n]+))?\]\]$/;

/**
 * The single link `text` is, or null. The target and the alias are kept
 * exactly as written — the fence is written back from them, byte for byte —
 * so a link whose target is only spaces is not one.
 */
export function pageLinkOf(text: string): PageRef | null {
  const m = ONE_LINK.exec(text.trim());
  if (m === null || m[1].trim() === '') return null;
  return { target: m[1], alias: m[2] ?? '' };
}

/**
 * A card fence's body: UNSET when it is empty, the link when it is exactly
 * one, and null otherwise — so a fence holding anything more stays the code
 * block it is and no word anyone typed is replaced.
 */
export function parsePageRef(body: string): PageRef | null {
  if (body.trim() === '') return { ...UNSET };
  return pageLinkOf(body);
}

/** The fence body for `ref`: '' when unset, else its one link. */
export function serializePageRef(ref: PageRef): string {
  if (ref.target === '') return '';
  return ref.alias === '' ? `[[${ref.target}]]` : `[[${ref.target}|${ref.alias}]]`;
}

/**
 * The page `ref` reaches, or null for an unset or dangling card. A section
 * link (`[[page#Heading]]`) reaches its page: `resolveTarget` cuts the
 * fragment (M55.8), and the pointer itself keeps it.
 */
export function resolvePageRef(ref: PageRef, entries: Entry[]): Entry | null {
  if (ref.target.trim() === '') return null;
  return resolveTarget(ref.target, entries);
}

/**
 * Whether `entry` is a page a link may name: a markdown file that is neither
 * the schema (a Type doc) nor stationery (a template). A `.mmd` is diagram
 * source with no page to show. The `[[` menu and the card picker both read
 * this, so they offer the same pages.
 */
export function isLinkablePage(entry: Entry): boolean {
  return /\.md$/i.test(entry.filename) && entry.type !== 'Type' && !isTemplate(entry);
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
 * its filename stem and its title — a `project.md` tries its folder before
 * both — that `resolveTarget` reads back as THAT page, or null when none does.
 *
 * A stem is not enough on its own. `resolveTarget`'s stem pass is vault-wide
 * and first-wins, so two `meetings/kickoff.md` files share `[[kickoff]]` and
 * only the first is reached by it; the rest are written by title. A page
 * whose every name belongs to another is not offered: a link to it would land
 * somewhere else.
 *
 * Built once per vault: one pass records who each name resolves to, in
 * `resolveName`'s order (stem, then project folder, then title, each
 * first-wins), so the `[[` menu can ask for every page without a vault scan
 * per row. The test replays `resolveLink` over the result.
 */
export function linkTargetsFor(entries: Entry[]): LinkTargetOf {
  const byStem = new Map<string, Entry>();
  const byFolder = new Map<string, Entry>();
  const byTitle = new Map<string, Entry>();
  const first = (map: Map<string, Entry>, key: string, entry: Entry) => {
    if (key !== '' && !map.has(key)) map.set(key, entry);
  };
  for (const entry of entries) {
    first(byStem, entry.filename.replace(/\.md$/i, '').toLowerCase(), entry);
    if (entry.filename.toLowerCase() === 'project.md') {
      first(byFolder, entry.folder.slice(entry.folder.lastIndexOf('/') + 1).toLowerCase(), entry);
    }
    first(byTitle, entry.title.toLowerCase(), entry);
  }
  // Who a whole name reaches, exactly as `resolveName` ranks the passes.
  const reaches = (name: string): Entry | null => {
    const key = name.trim().toLowerCase();
    return byStem.get(key) ?? byFolder.get(key) ?? byTitle.get(key) ?? null;
  };
  return (entry, section = null) => {
    const stem = entry.filename.replace(/\.md$/i, '');
    const folder = entry.folder.slice(entry.folder.lastIndexOf('/') + 1);
    // A project goes by its folder first: `project` is every project's stem.
    const names =
      stem.toLowerCase() === 'project' ? [folder, stem, entry.title] : [stem, entry.title];
    for (const name of names) {
      if (!writable(name) || reaches(name) !== entry) continue;
      if (section === null) return name;
      // `name#section` resolves whole first, then at its FIRST `#`: the whole
      // must name nothing, and the name must hold no `#` of its own.
      const target = `${name}#${section}`;
      if (!name.includes('#') && writable(target) && reaches(target) === null) return target;
    }
    return null;
  };
}

/** What a link to `entry` names among `entries`: `linkTargetsFor`, for one page. */
export function linkTargetOf(entry: Entry, entries: Entry[]): string | null {
  return linkTargetsFor(entries)(entry);
}

/**
 * The first status-kind field on `entry`'s type, or null. A capability, never
 * a type name (CV-08): any type that declares a status gets its chip, and an
 * untyped doc has none.
 */
export function statusFieldOf(entry: Entry, schema: Pick<Schema, 'types'>): FieldDef | null {
  if (entry.type === null) return null;
  return schema.types.get(entry.type)?.fields.find((f) => f.kind === 'status') ?? null;
}
