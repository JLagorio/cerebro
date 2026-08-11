import { useEffect } from 'react';
import { activeTab } from '@/engine/editorGroups';
import { useRootsStore } from '@/stores/rootsStore';

/**
 * True inside the Tauri shell, where the app owns its accelerators.
 *
 * Detected the same way `lib/ipc.ts` does it, and duplicated rather than
 * imported so this hook does not drag the IPC module into every test that
 * mounts the workspace.
 */
const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Typing into a field is not a chance to close somebody's tab. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * The workspace's keyboard (M30.24) — VS Code's bindings, minus the ones a
 * browser will not give up.
 *
 * `Cmd+W` and `Cmd+1..9` are BROWSER accelerators: Chrome closes the page and
 * switches its own tabs before a listener ever runs, and `preventDefault` does
 * not reach them. Inside Tauri they are ours, so they are bound there and only
 * there. Binding them unconditionally would mean a developer running
 * `pnpm dev` loses the page every time they reach for "close tab".
 *
 * The rest — split, and previous/next editor — are chords no browser claims,
 * so they work everywhere including e2e.
 */
export function useWorkspaceKeys(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const onKey = (e: KeyboardEvent): void => {
      if (typing(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const store = useRootsStore.getState();

      // Cmd+\ — split the focused pane.
      if (e.key === '\\' && !e.shiftKey) {
        e.preventDefault();
        store.splitEditor();
        return;
      }

      // Cmd+Shift+[ / ] — previous / next tab in the focused pane. VS Code's
      // own macOS binding, and unclaimed by browsers.
      if (e.shiftKey && (e.key === '[' || e.key === '{')) {
        e.preventDefault();
        store.cycleTab(-1);
        return;
      }
      if (e.shiftKey && (e.key === ']' || e.key === '}')) {
        e.preventDefault();
        store.cycleTab(1);
        return;
      }

      if (!inTauri()) return;

      // Cmd+W — close the focused tab.
      if (e.key === 'w' && !e.shiftKey) {
        const open = activeTab(store.layout);
        if (open === null) return;
        e.preventDefault();
        store.closeTab(open);
        return;
      }

      // Cmd+1..9 — focus the nth pane.
      if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        store.focusGroupAt(Number(e.key) - 1);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
