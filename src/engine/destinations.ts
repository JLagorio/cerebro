import { listTypes, typeViews } from './typeCatalog';
import type { Entry, Schema, Selection } from './types';

/**
 * The app's places, in one table (M59.1).
 *
 * Four hand-kept lists used to name them: the sidebar's rows and doors, ⌘K's
 * Go to rows, placeLabel and resolveSurface, and the navigate tool's
 * description. They drifted — ⌘K said Pulse where the nav said History, a
 * thread anchored on Work was stored as "Workspace", and the agent could only
 * say four words, every other one landing Home. Every reader now takes its
 * label, icon and words from this table, and `destinations.test.ts` holds
 * `tools.v1.json`'s navigate `to` enum to its ids.
 *
 * Engine code, not app code: placeLabel and resolveSurface read it, and the
 * engine may not import `app/` (M53.20).
 */

/** The kinds that name a SUBJECT — a page, a database, a container. They
 * carry a path or a name, so they are reached by name, never from a table. */
export type SubjectKind = 'doc' | 'diagram' | 'file' | 'collection' | 'list' | 'type';

/** Every other Selection kind is a place in this table. A kind added to
 * Selection fails `ROWS`'s `satisfies` until it is classified here or above. */
export type DestinationKind = Exclude<Selection['kind'], SubjectKind>;

/**
 * Where a destination sits in the nav column: a standalone `row`, a
 * `section` whose ↗ door opens it, the `footer`, or `none` (reached from ⌘K,
 * the agent and other surfaces only).
 */
export type NavSlot = 'row' | 'section' | 'footer' | 'none';

interface Row<K extends DestinationKind> {
  /** navigate's word for it: always the label lower-cased, spaces as `_`. */
  id: string;
  /** Where it goes: the bare selection, no lens. */
  selection: Extract<Selection, { kind: K }>;
  label: string;
  /** The second key after g, shared by the shell and command catalog. */
  go: string;
  icon: string;
  /** Extra words ⌘K matches, beyond the label — the ones people reach for. */
  aliases: string;
  nav: NavSlot;
  /** A section's ↗ action name. */
  door?: string;
  /** The selection kinds that mark its nav row current. */
  lights: readonly Selection['kind'][];
  /** Its count wants acting on: cortex ink, not the quiet gray (M43). */
  hot?: boolean;
  /** Hidden unless the setting it names is on. */
  gate?: 'inbox';
  /** One editor queue or workspace for the whole window. */
  single?: true;
}

export interface Destination extends Row<DestinationKind> {
  kind: DestinationKind;
}

const ROWS = {
  // The capture queue (M4). Hot: its count is work waiting on you. Gated on
  // the inbox workflow, so ⌘K hides it exactly when the nav does.
  inbox: {
    // The capture queue holds one selected editor.
    single: true,
    id: 'inbox',
    go: 'i',
    selection: { kind: 'inbox' },
    label: 'Inbox',
    icon: 'inbox',
    aliases: 'capture queue',
    nav: 'row',
    lights: ['inbox'],
    hot: true,
    gate: 'inbox',
  },
  // Home is current on Home alone (M52). M15 lit it on every Collection, List
  // and Type screen as the item world's front door, which was true while
  // those rows lived in a sidebar of Home's own; in the one column they are
  // rows of their own, so on the Epic table Home and Epic were both current.
  // Home lanes are pull-only (M64.4, D9 b): this row never carries a count.
  home: {
    id: 'home',
    go: 'h',
    selection: { kind: 'home' },
    label: 'Home',
    icon: 'house',
    aliases: 'my tasks',
    nav: 'row',
    lights: ['home'],
  },
  // M43 — open work across every database. Its quiet count is the page's own
  // membership rule (engine/myWork), never a promise the page cannot keep.
  mywork: {
    id: 'my_work',
    go: 'm',
    selection: { kind: 'mywork' },
    label: 'My work',
    icon: 'circle-check',
    aliases: 'open work tasks assigned',
    nav: 'row',
    lights: ['mywork'],
  },
  // M43.10 — Studio and History are standalone rows: neither carries nested
  // subjects (a prototype is reachable from Studio's own bench).
  studio: {
    id: 'studio',
    go: 's',
    selection: { kind: 'studio' },
    label: 'Studio',
    icon: 'pencil-ruler',
    aliases: 'prototypes bench',
    nav: 'row',
    lights: ['studio'],
  },
  // M9.4 — the vault's history, and the two git surfaces share its one slot:
  // it lights on Changes too. No badge: a count of commits is chrome. The
  // footer SyncBadge speaks instead, and only when something needs doing.
  pulse: {
    id: 'history',
    go: 'y',
    selection: { kind: 'pulse' },
    label: 'History',
    icon: 'activity',
    aliases: 'git commits log',
    nav: 'row',
    lights: ['pulse', 'changes'],
  },
  // A place you work — agents, skills, blocks — not a dial you set (M43 moved
  // it up from the footer). `blocks`, not `library`: Pages already owns the
  // book glyph, and two rows drawn identically is the nav failing at the one
  // job it has. Its shelves are aliases rather than rows, because "skills"
  // and "agents" are what people type (M18).
  library: {
    id: 'library',
    go: 'l',
    selection: { kind: 'library' },
    label: 'Library',
    icon: 'blocks',
    aliases: 'skills agents templates automations',
    nav: 'row',
    lights: ['library'],
  },
  // M30 — mounted repositories, a section since M43.10: each mounted folder
  // is a row, and the ↗ is the door to the Work surface. The label is the
  // locked name (M37.2); the kind keeps its old word.
  workspace: {
    // Mounted repositories already own their editor groups.
    single: true,
    id: 'work',
    go: 'w',
    selection: { kind: 'workspace' },
    label: 'Work',
    icon: 'folder-tree',
    aliases: 'repositories repos code mounted',
    nav: 'section',
    door: 'Open all repositories',
    lights: [],
  },
  // M5's corpus, named Knowledge in M50.5. Its rows are the bundle's folders
  // and the review queue (M51); the ↗ opens every concept.
  knowledge: {
    id: 'knowledge',
    go: 'k',
    selection: { kind: 'knowledge' },
    label: 'Knowledge',
    icon: 'brain',
    aliases: 'concepts base review',
    nav: 'section',
    door: 'Open Knowledge',
    lights: [],
  },
  // M43 — a roster of subjects, so a section; the ↗ is the fleet surface the
  // M41 destination row used to be.
  agents: {
    id: 'agents',
    go: 'a',
    selection: { kind: 'agents' },
    label: 'Agents',
    icon: 'bot',
    aliases: 'fleet runs roster',
    nav: 'section',
    door: 'Open all agents',
    lights: [],
  },
  // The uncommitted working tree. No row of its own: History lights for it,
  // and SyncBadge and ⌘K reach it.
  changes: {
    id: 'changes',
    go: 'c',
    selection: { kind: 'changes' },
    label: 'Changes',
    icon: 'file-diff',
    aliases: 'git uncommitted diff',
    nav: 'none',
    lights: [],
  },
  // Below the fold: where you go to change how the app works, not somewhere
  // you work (M43).
  settings: {
    id: 'settings',
    go: ',',
    selection: { kind: 'settings' },
    label: 'Settings',
    icon: 'settings',
    aliases: 'preferences',
    nav: 'footer',
    lights: ['settings'],
  },
} satisfies { [K in DestinationKind]: Row<K> };

/** Table order: the nav's rows top to bottom, then the sections, then the
 * rest. ⌘K's Go to rows and navigate's `to` enum keep it. */
const ORDER: readonly DestinationKind[] = [
  'inbox',
  'home',
  'mywork',
  'studio',
  'pulse',
  'library',
  'workspace',
  'knowledge',
  'agents',
  'changes',
  'settings',
];

/** Every destination, in table order. */
export const DESTINATIONS: readonly Destination[] = ORDER.map((kind) => ({
  kind,
  ...(ROWS[kind] as Row<DestinationKind>),
}));

/** Destination id to its complete go chord. */
export const GO_KEYS: Readonly<Record<string, string>> = Object.fromEntries(
  DESTINATIONS.map((d) => [d.id, `g ${d.go}`]),
);

const BY_KIND = new Map(DESTINATIONS.map((d) => [d.kind, d]));

/** The row for a destination kind. */
export function destination(kind: DestinationKind): Destination {
  // Every kind is in ORDER (destinations.test.ts holds it), so the lookup
  // always finds its row.
  return BY_KIND.get(kind) as Destination;
}

export function isDestinationKind(kind: Selection['kind']): kind is DestinationKind {
  return BY_KIND.has(kind as DestinationKind);
}

/** The destinations the shell offers right now, in table order: Inbox goes
 * when the inbox workflow is off. */
export function visibleDestinations({ inboxEnabled }: { inboxEnabled: boolean }): Destination[] {
  return DESTINATIONS.filter((d) => d.gate !== 'inbox' || inboxEnabled);
}

/** What every surface calls a page that has no `type:` (M59.1). It said
 * "Note" in ⌘K and the record peek while every other surface said page. */
export const UNTYPED_LABEL = 'Page';

/** navigate's word for "open a database", beside the destination ids. */
export const NAVIGATE_VIEW = 'view';

/** navigate's `to` enum: every destination id in table order, then `view`.
 * `tools.v1.json` serves exactly this list (destinations.test.ts). */
export const NAVIGATE_PLACES: readonly string[] = [...DESTINATIONS.map((d) => d.id), NAVIGATE_VIEW];

/** The navigate tool's arguments, as the agent sends them. */
export interface NavigateRequest {
  to: string;
  /** With `to = view`: the database's name. */
  database?: string;
  /** With `to = view`: a saved view, by id or name. */
  view?: string;
}

export type NavigateTarget = { selection: Selection } | { refused: string };

/**
 * Where navigate goes, or why it cannot (M59.1).
 *
 * A destination id gives its row's selection. `view` opens a database: the
 * name as the Databases section lists it, exact first, else the one name that
 * matches ignoring case; then a saved view by id, else by name ignoring case.
 * An unknown view opens the first tab. Anything else is refused in words —
 * nothing goes Home by default, because a move the agent did not mean is
 * worse than none.
 */
export function navigateTarget(
  request: NavigateRequest,
  entries: Entry[],
  schema: Schema,
): NavigateTarget {
  const { to } = request;
  if (to === NAVIGATE_VIEW) {
    const asked = (request.database ?? '').trim();
    if (asked === '') {
      return { refused: 'The assistant asked to open a database without naming it.' };
    }
    const names = listTypes(entries, schema).map((t) => t.name);
    const folded = asked.toLowerCase();
    const loose = names.filter((n) => n.toLowerCase() === folded);
    const name = names.includes(asked) ? asked : loose.length === 1 ? loose[0] : null;
    if (name === null) return { refused: `No database is named "${asked}".` };
    const want = (request.view ?? '').trim();
    const tabs = typeViews(name, schema);
    const found =
      want === ''
        ? undefined
        : (tabs.find((v) => v.id === want) ??
          tabs.find((v) => v.name.toLowerCase() === want.toLowerCase()));
    return {
      selection:
        found === undefined ? { kind: 'type', name } : { kind: 'type', name, view: found.id },
    };
  }
  const place = DESTINATIONS.find((d) => d.id === to);
  if (place !== undefined) return { selection: place.selection };
  return to.trim() === ''
    ? { refused: 'The assistant asked to move the app without naming a place.' }
    : { refused: `Cerebro has no place called "${to}".` };
}
