/**
 * Which keystrokes a mermaid text field has to swallow, and which it must let
 * past (M29.53).
 *
 * Both source boxes — the document block's and the canvas code panel's — used
 * to call `e.stopPropagation()` on EVERY keydown, with one stated reason:
 * BlockNote's hotkeys (and the canvas's Delete-deletes-node) must not fire
 * while someone is typing mermaid. React's synthetic `stopPropagation` also
 * stops the NATIVE event at the React root, so that blanket guard starved
 * `window.addEventListener('keydown', …)` in App.tsx as well — MEASURED: with
 * the source box focused, a document-capture probe saw `Meta+k` and the window
 * probe saw nothing, so ⌘K, ⌘J and ⌘⇧L were all dead inside a diagram while
 * the header still advertised "⌘K" on screen.
 *
 * The guard only ever needed the keys the surrounding EDITOR claims:
 *
 *   - anything unmodified — typing, Enter, Backspace, Delete, the arrows —
 *     which is what BlockNote's own keymap and the canvas's delete handler
 *     read, and which no app-level shortcut uses;
 *   - the modified handful that means something inside a rich-text editor:
 *     history (⌘Z/⌘⇧Z/⌘Y), the three marks (⌘B/⌘I/⌘U), select-all (⌘A) and
 *     ⌘Enter.
 *
 * Everything else with a modifier belongs to the app. Deliberately expressed
 * as what the EDITOR takes rather than as a copy of App.tsx's shortcut list:
 * a new global shortcut then works inside a source box the day it is added,
 * instead of silently not working until someone remembers this file.
 */
const EDITOR_MOD_KEYS = new Set(['z', 'y', 'b', 'i', 'u', 'a', 'enter']);

export function claimedByHostEditor(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  if (!e.metaKey && !e.ctrlKey) return true;
  return EDITOR_MOD_KEYS.has(e.key.toLowerCase());
}
