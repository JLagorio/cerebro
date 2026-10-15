import { commandDef, scopesOf, type CommandDef } from '@/app/commands';

/**
 * Who answers a command right now (M65.1). Module state: one keymap per
 * window.
 *
 * A scope is a named region — `app` (the root), a `page`, the record `peek`,
 * a mermaid `block` — with an id per mounted instance. A component binds a
 * command's handler in one scope; the keymap asks for a binding along a
 * chain of scope ids, innermost first, ending at `app`.
 *
 * - The newest binding of an id in a scope eclipses the older ones until it
 *   is disposed, which hands the id back to the binding under it.
 * - A def binds only in the scopes it lists.
 * - The walk goes innermost first. A binding whose `when` is false passes
 *   the key to the next scope out, never back to a binding it eclipsed.
 */

export interface ScopeRef {
  id: string;
  name: string;
}

export const APP_SCOPE: ScopeRef = { id: 'app', name: 'app' };

/** Scope ids, innermost first, ending at `app`. */
export type Chain = readonly string[];

export interface Handlers {
  /** Gets the keystroke when a key ran it, and nothing from the palette. */
  run: (event?: KeyboardEvent) => void;
  when?: () => boolean;
}

interface Binding extends Handlers {
  seq: number;
  scopeId: string;
  commandId: string;
}

let bindings: Binding[] = [];
let nextSeq = 0;
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** True inside the desktop shell, where the browser's accelerators are ours. */
export function inDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Bind `commandId` in `scope`. Returns the disposer, which is safe to call
 * twice and after `resetKeymap`. Throws on an unknown id or a scope the
 * command does not list.
 */
export function bind(scope: ScopeRef, commandId: string, handlers: Handlers): () => void {
  const def = commandDef(commandId);
  if (!scopesOf(def).includes(scope.name)) {
    throw new Error(
      `command "${commandId}" binds in ${scopesOf(def).join(', ')}, not in scope "${scope.name}"`,
    );
  }
  const binding: Binding = { ...handlers, seq: nextSeq++, scopeId: scope.id, commandId };
  bindings.push(binding);
  changed();
  return () => {
    const at = bindings.indexOf(binding);
    if (at === -1) return;
    bindings.splice(at, 1);
    changed();
  };
}

/** The live binding per id in one scope: the newest of each. */
function liveIn(scopeId: string): Binding[] {
  const seen = new Set<string>();
  const out: Binding[] = [];
  for (let i = bindings.length - 1; i >= 0; i -= 1) {
    const b = bindings[i]!;
    if (b.scopeId !== scopeId || seen.has(b.commandId)) continue;
    seen.add(b.commandId);
    out.push(b);
  }
  return out;
}

export interface Hit {
  def: CommandDef;
  run: (event?: KeyboardEvent) => void;
}

/**
 * The first live binding along `chain` that `accept` takes and whose `when`
 * holds. A false `when` moves on to the next scope out.
 */
export function findBinding(chain: Chain, accept: (def: CommandDef) => boolean): Hit | null {
  for (const scopeId of chain) {
    for (const b of liveIn(scopeId)) {
      const def = commandDef(b.commandId);
      if (!accept(def)) continue;
      if (b.when !== undefined && !b.when()) break;
      return { def, run: b.run };
    }
  }
  return null;
}

/** What could run from here: bound along the chain, `when` true, desktopOnly
 * met, and not kept out of the palette. Innermost first. */
export function availableCommands(chain: Chain): CommandDef[] {
  const out = new Map<string, CommandDef>();
  for (const scopeId of chain) {
    for (const b of liveIn(scopeId)) {
      if (out.has(b.commandId)) continue;
      const def = commandDef(b.commandId);
      if (def.palette === false) continue;
      if (def.desktopOnly && !inDesktop()) continue;
      if (b.when !== undefined && !b.when()) continue;
      out.set(def.id, def);
    }
  }
  return [...out.values()];
}

/** Run `id` from `chain`, re-checking `when`. Returns whether it ran. */
export function runCommand(id: string, chain: Chain): boolean {
  commandDef(id);
  const hit = findBinding(chain, (def) => def.id === id);
  if (hit === null) return false;
  if (hit.def.desktopOnly && !inDesktop()) return false;
  hit.run();
  return true;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Bumped on every bind and dispose. */
export function keymapVersion(): number {
  return version;
}

/** Test seam: the bindings are module state and would leak between cases. */
export function resetKeymap(): void {
  bindings = [];
  changed();
}
