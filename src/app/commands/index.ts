import { EDITOR_MOD_KEYS } from '@/lib/keys/claims';
import { isLetter, parseKeys, specId } from '@/lib/keys/combo';

/**
 * The command catalog (M65.1): every app command, defined once.
 *
 * A command is a row in a `./<area>.commands.ts` file, loaded below by an
 * eager glob, so a part that adds commands adds a file and never edits this
 * list. The keymap, ⌘K, keycaps and Settings → Keyboard shortcuts all read
 * these rows; a component binds a row's handler with `useCommand`.
 */

/** `app` is the root; `page` and `peek` sit under it; any other name (a
 * `block`, a `viewer`) is an inner scope that nests under page or peek. */
export type ScopeName = string;

export interface CommandDef {
  id: string;
  /** What the palette and Settings call it. */
  label: string;
  /** Specs (`mod+k`, `g h`); empty for a command reached only by name. */
  keys: readonly string[];
  /** The scope, or scopes, the command may be bound in. */
  scope: ScopeName | readonly ScopeName[];
  group: string;
  /** A modifier command that still runs with a text field focused. */
  inEditor?: boolean;
  /** A modifier command that still runs under a modal layer. */
  inModal?: boolean;
  /** Bound only in the desktop app, where the browser gives the key up. */
  desktopOnly?: boolean;
  /** `false` keeps it out of the palette. */
  palette?: boolean;
  aliases?: readonly string[];
  /** The outer commands whose keys this one reuses on purpose. */
  shadows?: readonly string[];
}

/** A `*.commands.ts` file: its rows, and optionally a group of its own. */
export interface CommandModule {
  commands: readonly CommandDef[];
  group?: string;
}

/** Settings' order. A file may declare its own group; those follow these,
 * in file order. */
export const GROUPS: readonly string[] = [
  'General',
  'Go to',
  'Create',
  'Pages',
  'Panes',
  'Lists',
  'Record peek',
  'Home',
  'Inbox',
  'Work',
];

export function scopesOf(def: CommandDef): readonly ScopeName[] {
  return typeof def.scope === 'string' ? [def.scope] : def.scope;
}

/** The scopes a scope sits inside, nearest first. */
function outerScopes(scope: ScopeName): ScopeName[] {
  if (scope === 'app') return [];
  if (scope === 'page' || scope === 'peek') return ['app'];
  return ['page', 'peek', 'app'];
}

/** Whether a spec is a key a text editor keeps (`claims.ts`'s `editor`). */
function isEditorKey(spec: string): boolean {
  const steps = parseKeys(spec);
  if (steps.length !== 1) return false;
  const c = steps[0];
  return (c.mod || c.ctrl) && EDITOR_MOD_KEYS.has(c.key);
}

/**
 * The load check. Throws on a duplicate id, a key that does not parse (any
 * Escape included), a key used twice in one scope, an inner key equal to an
 * outer one without `shadows`, a letter marked inEditor or inModal, and an
 * inEditor command on a key the editor keeps.
 */
export function checkCatalog(defs: readonly CommandDef[]): void {
  const ids = new Set<string>();
  for (const def of defs) {
    if (ids.has(def.id)) throw new Error(`command "${def.id}" is defined twice`);
    ids.add(def.id);
    if (scopesOf(def).length === 0) throw new Error(`command "${def.id}" names no scope`);
    for (const spec of def.keys) {
      parseKeys(spec);
      if (isLetter(spec) && (def.inEditor || def.inModal)) {
        throw new Error(`command "${def.id}": a letter key never runs in an editor or a modal`);
      }
      if (def.inEditor && isEditorKey(spec)) {
        throw new Error(`command "${def.id}": "${spec}" belongs to the editor, so not inEditor`);
      }
    }
  }
  // scope name → spec id → command id
  const byScope = new Map<ScopeName, Map<string, string>>();
  for (const def of defs) {
    for (const scope of scopesOf(def)) {
      const keys = byScope.get(scope) ?? new Map<string, string>();
      byScope.set(scope, keys);
      for (const spec of def.keys) {
        const id = specId(spec);
        const other = keys.get(id);
        if (other !== undefined && other !== def.id) {
          throw new Error(`"${spec}" is bound twice in scope ${scope}: ${other} and ${def.id}`);
        }
        keys.set(id, def.id);
      }
    }
  }
  for (const def of defs) {
    for (const scope of scopesOf(def)) {
      for (const outer of outerScopes(scope)) {
        for (const spec of def.keys) {
          const other = byScope.get(outer)?.get(specId(spec));
          if (other === undefined || other === def.id) continue;
          if (!def.shadows?.includes(other)) {
            throw new Error(
              `command "${def.id}" reuses ${outer}'s "${spec}" (${other}) without shadows`,
            );
          }
        }
      }
    }
  }
}

const modules = import.meta.glob<CommandModule>('./*.commands.ts', { eager: true });
const files = Object.keys(modules).sort();
const CATALOG: readonly CommandDef[] = files.flatMap((f) => modules[f]!.commands);
checkCatalog(CATALOG);
const BY_ID = new Map(CATALOG.map((d) => [d.id, d]));

/** Every row, in file order. */
export function catalog(): readonly CommandDef[] {
  return CATALOG;
}

/** The row for an id. Throws on an id the catalog does not hold. */
export function commandDef(id: string): CommandDef {
  const def = BY_ID.get(id);
  if (def === undefined) throw new Error(`unknown command "${id}"`);
  return def;
}

/** `GROUPS`, then the groups files declare, in file order. */
export function orderGroups(declared: readonly (string | undefined)[]): readonly string[] {
  const extra = declared.filter((g): g is string => g !== undefined && !GROUPS.includes(g));
  return [...GROUPS, ...new Set(extra)];
}

/** Settings' group order for the catalog as loaded. */
export function commandGroups(): readonly string[] {
  return orderGroups(files.map((f) => modules[f]!.group));
}

/** The rows with keys, in group order then file order: what Settings lists. */
export function keyedCommands(): readonly CommandDef[] {
  const order = commandGroups();
  const rank = (g: string) => {
    const at = order.indexOf(g);
    return at === -1 ? order.length : at;
  };
  return CATALOG.filter((d) => d.keys.length > 0)
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d.group) - rank(b.d.group) || a.i - b.i)
    .map(({ d }) => d);
}
