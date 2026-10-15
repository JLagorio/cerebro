import {
  createContext,
  createElement,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { commandDef, scopesOf, type CommandDef } from '@/app/commands';
import { APP_SCOPE, bind, type ScopeRef } from './registry';
import { installKeyRoot, ROOT_PAGE_ID } from './root';

/**
 * The keymap's React face (M65.1): hold the root, mark a scope, bind a
 * command.
 *
 * Bindings land in a layout effect, so a key pressed in the commit that
 * mounted a surface already reaches it, and the handlers live in refs, so a
 * re-render never re-binds — re-binding would move a binding to the top of
 * its scope and reorder the eclipse.
 */

/** The scopes around a component, innermost first; `app` is implied. */
const KeyScopeContext = createContext<readonly ScopeRef[]>([]);

/** Hold the one capture-phase listener for as long as the caller is mounted. */
export function useKeyRoot(): void {
  useLayoutEffect(() => installKeyRoot(), []);
}

export interface KeyScope extends ScopeRef {
  /** Spread on the scope's root element. */
  props: Record<string, string>;
  /** Wrap the scope's children, so `useCommand` below binds here. */
  Provider: (props: { children?: ReactNode }) => ReactNode;
}

/**
 * Mark a region as a key scope. `page: true` also makes it the fallback
 * scope when focus and the last pointer are nowhere scoped.
 */
export function useKeyScope(name: string, options: { page?: boolean } = {}): KeyScope {
  const id = `${name}${useId()}`;
  const parent = useContext(KeyScopeContext);
  const value = useMemo(() => [{ id, name }, ...parent], [id, name, parent]);
  const latest = useRef(value);
  latest.current = value;
  // One component for the life of the scope: a new component type each
  // render would remount everything inside it.
  const [Provider] = useState(
    () =>
      function KeyScopeProvider({ children }: { children?: ReactNode }) {
        return createElement(KeyScopeContext.Provider, { value: latest.current }, children);
      },
  );
  const props: Record<string, string> = { 'data-key-scope': name, 'data-key-scope-id': id };
  if (options.page) props['data-key-scope-page'] = '';
  return { id, name, props, Provider };
}

/** The scope a command binds in from here: the nearest one around the caller
 * that the command lists. A page command rendered outside any page (a page in
 * a component test) binds in the root's fallback page. */
function scopeFor(around: readonly ScopeRef[], def: CommandDef): ScopeRef {
  const names = scopesOf(def);
  const near = around.find((s) => names.includes(s.name));
  if (near !== undefined) return near;
  if (names.includes('app')) return APP_SCOPE;
  if (names.includes('page') && !around.some((s) => s.name === 'page')) {
    return { id: ROOT_PAGE_ID, name: 'page' };
  }
  // Nothing fits: `bind` throws, naming the command and the scope.
  return around[0] ?? APP_SCOPE;
}

export interface CommandBinding {
  id: string;
  /** Gets the keystroke when a key ran it, and nothing from the palette. */
  run: (event?: KeyboardEvent) => void;
  when?: () => boolean;
}

export interface BindOptions {
  /** Bind in this scope instead of the nearest one around the caller. */
  scope?: ScopeRef;
}

/** Bind several commands. The list may change; only a change in its ids (or
 * in the scope) re-binds. */
export function useCommands(list: readonly CommandBinding[], options: BindOptions = {}): void {
  const around = useContext(KeyScopeContext);
  const handlers = useRef(new Map<string, CommandBinding>());
  handlers.current = new Map(list.map((c) => [c.id, c]));
  const ids = list.map((c) => c.id).join('\n');
  const explicit = options.scope;
  const where = explicit !== undefined ? `=${explicit.id}` : around.map((s) => s.id).join('>');
  const scopes = useRef({ explicit, around });
  scopes.current = { explicit, around };

  useLayoutEffect(() => {
    if (ids === '') return;
    const disposers = ids.split('\n').map((id) => {
      const { explicit: pinned, around: near } = scopes.current;
      const scope = pinned ?? scopeFor(near, commandDef(id));
      return bind(scope, id, {
        run: (event) => handlers.current.get(id)?.run(event),
        when: () => {
          const h = handlers.current.get(id);
          return h !== undefined && (h.when === undefined || h.when());
        },
      });
    });
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [ids, where]);
}

/** Bind one command. */
export function useCommand(
  id: string,
  run: (event?: KeyboardEvent) => void,
  options: BindOptions & { when?: () => boolean } = {},
): void {
  useCommands([{ id, run, when: options.when }], { scope: options.scope });
}
