import { pruneLayout, readStoredLayouts, toStored, type StoredLayout } from '@/engine/paneLayout';
import type { PaneLayout } from '@/engine/panes';
import { missingFiles } from './filePresence';
export const PANE_LAYOUT_KEY = 'cerebro.panes';
export function readPaneLayout(vault: string): StoredLayout | null {
  try {
    return readStoredLayouts(window.localStorage.getItem(PANE_LAYOUT_KEY))[vault] ?? null;
  } catch {
    return null;
  }
}
/** Convenience only: storage failures leave the current session intact. The
 * restore host is the sole caller, after this vault's startup choice lands. */
export function writePaneLayout(vault: string, layout: PaneLayout): void {
  try {
    const raw = window.localStorage.getItem(PANE_LAYOUT_KEY);
    const layouts = readStoredLayouts(raw);
    const missing = missingFiles(vault);
    const stored = pruneLayout(
      toStored(layout),
      (place) => place.kind !== 'file' || !missing.includes(place.path),
    );
    if (stored === null) delete layouts[vault];
    else layouts[vault] = stored;
    const next = JSON.stringify(layouts);
    // Scroll/search state lives in the session slots, not on disk. A store
    // update that changes no persisted place must not synchronously rewrite storage.
    if (next !== raw) window.localStorage.setItem(PANE_LAYOUT_KEY, next);
  } catch {
    /* A local preference can never block working in the vault. */
  }
}
