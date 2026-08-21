import type { CollectionFile, Entry, ListFile, Selection } from '@/engine/types';

/**
 * Where a conversation happened (M17.5).
 *
 * A conversation is anchored to a PLACE so that a thread can be found again by
 * what it was about, and so a turn's context can be frozen against the thread
 * rather than recomputed from wherever the user's feet happen to be. Without
 * this, resuming last week's thread about Delivery re-injects today's surface
 * as "what the user is looking at" — the agent is then answering about one
 * thing while being told it is looking at another.
 *
 * ## A place is a SUBJECT, not a lens
 *
 * The rule that decides every case below, and the reason it is written down
 * (the plan called this out as a decision, not a detail):
 *
 * - **Subject** — the List, the type, the doc, the Collection, an entity
 *   dossier. Change it and you are working on something else.
 * - **Lens** — which view tab is open, which knowledge filter is selected,
 *   which record is expanded in the detail panel. Change it and you are
 *   looking at the same thing differently.
 *
 * So `list:delivery` is one place whether the board tab or the table tab is
 * open, and Knowledge's all/review/log tabs collapse to one place while a
 * section or an entity dossier does not — a dossier IS a subject.
 *
 * ## Why the open record is deliberately NOT part of the place
 *
 * The agent opens records constantly: `open_note` is how it shows you what it
 * is talking about. If the open record moved the place, the assistant's own
 * answer would re-anchor the thread it was answering in — the M17.2 bug class
 * exactly, one layer up. The open record is CONTEXT (M17.6's chip), which is
 * removable and visible; a place is where you stand, and only the user moves
 * that.
 */

/** The place-bearing part of a Selection: the same value with every lens
 * stripped, so a place round-trips back to a navigable selection for free. */
export type Place = Selection;

/**
 * The subject of a selection — the selection with its lenses removed.
 *
 * Returns a Selection so that "go back to where this thread happened" is
 * `navigate(place)` and nothing has to be parsed back out of a key.
 */
export function placeOf(selection: Selection): Place {
  switch (selection.kind) {
    case 'list': {
      // `view` dropped: a tab is a lens. `collection` normalized to null so
      // that an omitted and an explicitly-null collection are one place —
      // ListPage resolves lists the same way (ids are unique per folder).
      const { id, collection } = selection;
      return { kind: 'list', id, collection: collection ?? null };
    }
    case 'type':
      return { kind: 'type', name: selection.name };
    case 'knowledge': {
      // `path` dropped for the same reason the detail panel is: it deep-links
      // one concept beside your work, it does not move you. The filter tabs
      // (all/review/log) are lenses over one corpus; a section or an entity
      // dossier names a subject and keeps its own thread.
      const nav = selection.nav;
      if (nav !== undefined && (nav.tab === 'section' || nav.tab === 'entity')) {
        return { kind: 'knowledge', nav };
      }
      return { kind: 'knowledge' };
    }
    case 'doc':
      return { kind: 'doc', path: selection.path };
    // A standalone diagram is a subject the same way a doc is (M29.21).
    case 'diagram':
      return { kind: 'diagram', path: selection.path };
    case 'collection':
      return { kind: 'collection', folder: selection.folder };
    default:
      return { kind: selection.kind };
  }
}

/**
 * A stable string for equality and grouping.
 *
 * Built by an explicit switch rather than `JSON.stringify`, for the reason
 * `navStore.sameSelection` gives: a stringify compare makes the answer depend
 * on key order, and two equal places would then disagree.
 *
 * The `list` key concatenates collection and id with a slash and is
 * unambiguous BECAUSE an id is a filename stem and can never contain one —
 * `a/b` + `c` and `a` + `b/c` cannot both be real keys.
 */
export function placeKey(place: Place): string {
  switch (place.kind) {
    case 'doc':
      return `doc:${place.path}`;
    case 'diagram':
      return `diagram:${place.path}`;
    case 'collection':
      return `collection:${place.folder}`;
    case 'list':
      return `list:${place.collection ?? ''}/${place.id}`;
    case 'type':
      return `type:${place.name}`;
    case 'knowledge': {
      const nav = place.nav;
      if (nav?.tab === 'section') return `knowledge:section:${nav.folder}`;
      if (nav?.tab === 'entity') return `knowledge:entity:${nav.key}`;
      return 'knowledge';
    }
    default:
      return place.kind;
  }
}

/** The key of the place a selection is in — `placeKey(placeOf(sel))`. */
export function selectionKey(selection: Selection): string {
  return placeKey(placeOf(selection));
}

export function samePlace(a: Place | null | undefined, b: Place | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return placeKey(a) === placeKey(b);
}

/** Basename without its extension — the fallback name for anything unresolved. */
function stem(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.replace(/\.(md|mmd)$/, '');
}

/**
 * What to call a place on screen.
 *
 * Resolved against the vault when it can be, and degraded to the path's own
 * name when it cannot: a thread anchored to a List that has since been deleted
 * still has to render, and "roadmap" is a better answer than blank.
 */
export function placeLabel(
  place: Place,
  lookup: { entries?: Entry[]; views?: ListFile[]; collections?: CollectionFile[] } = {},
): string {
  const { entries = [], views = [], collections = [] } = lookup;
  switch (place.kind) {
    case 'home':
      return 'Home';
    case 'inbox':
      return 'Inbox';
    case 'changes':
      return 'Changes';
    case 'pulse':
      return 'Pulse';
    case 'library':
      return 'Library';
    // M30 — one place, not one per file. `placeOf` already strips `root` and
    // `path` through its default, which is the doctrine above applied
    // unchanged: the open file is a lens, exactly like the open record.
    case 'workspace':
      return 'Workspace';
    case 'settings':
      return 'Settings';
    case 'knowledge': {
      const nav = place.nav;
      if (nav?.tab === 'section') return `Knowledge / ${stem(nav.folder)}`;
      if (nav?.tab === 'entity') return `Knowledge / ${nav.key}`;
      return 'Knowledge';
    }
    case 'doc':
    case 'diagram':
      return entries.find((e) => e.path === place.path)?.title ?? stem(place.path);
    case 'collection': {
      const found = collections.find((c) => c.folder === place.folder);
      // An undeclared Collection has no stored name — its folder IS its name.
      return found?.declared === true ? found.definition.name : stem(place.folder);
    }
    case 'list': {
      const found = views.find(
        (v) => v.id === place.id && v.collection === (place.collection ?? null),
      );
      return found?.definition.name ?? place.id;
    }
    case 'type':
      return place.name;
  }
}

/**
 * Loader guard for a persisted place (M17.5).
 *
 * A conversation is stored in localStorage, so its place is whatever was
 * written there — including by an older build with a Selection shape this one
 * no longer has. Anything that does not narrow to a place this build can key
 * and label is dropped to null, which reads as "not anchored" and renders as
 * nothing. Structural, not exhaustive: it checks the fields `placeKey` and
 * `placeLabel` actually read.
 */
export function isPlace(raw: unknown): raw is Place {
  if (typeof raw !== 'object' || raw === null) return false;
  const p = raw as Record<string, unknown>;
  // 'docs' is deliberately not among the bare kinds (M38.3): the surface is
  // gone, so a thread persisted against it fails the guard and loses its
  // anchor rather than round-tripping into a selection nothing can render.
  switch (p.kind) {
    case 'home':
    case 'inbox':
    case 'changes':
    case 'pulse':
    case 'review':
    case 'library':
    case 'settings':
      return true;
    case 'knowledge': {
      if (p.nav === undefined) return true;
      if (typeof p.nav !== 'object' || p.nav === null) return false;
      const nav = p.nav as Record<string, unknown>;
      if (nav.tab === 'section') return typeof nav.folder === 'string';
      if (nav.tab === 'entity') return typeof nav.key === 'string';
      return nav.tab === 'all' || nav.tab === 'review' || nav.tab === 'log';
    }
    case 'doc':
    case 'diagram':
      return typeof p.path === 'string';
    case 'collection':
      return typeof p.folder === 'string';
    case 'list':
      return (
        typeof p.id === 'string' && (p.collection === null || typeof p.collection === 'string')
      );
    case 'type':
      return typeof p.name === 'string';
    default:
      return false;
  }
}
